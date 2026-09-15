'use strict';

/**
 * TDS Summary — Zoho Books' "TDS Summary".
 * ---------------------------------------------------------------------------
 * Tax deducted at source on purchases, one row per section of the Income Tax
 * Act under which it was withheld:
 *
 *   TDS Section | TDS Section Description | Total | Total After TDS Deduction
 *               | Tax Deducted at Source
 *
 * Total is the amount the deduction was taken from, so the three money columns
 * read across as they do on the challan: Total less the tax deducted leaves
 * what was actually paid to the vendor.
 *
 * The deduction itself is warehoused per bill line (zb_bill_line_items.tds_tax_*),
 * which is the only place it survives as a per-section figure — the bill header
 * columns are not populated by the sync. The section CODE, however, exists only
 * on Zoho's bill detail payload, so it is read back out of the stored response
 * and matched to the line by the tax's name.
 *
 * Zoho builds this off its own tds_tax_name/tds_tax_amount/tds_tax_percentage
 * bill-line fields, which neither QuickBooks' nor Xero's bill API exposes
 * (checked both sync paths — neither writes to those columns). But both
 * platforms DO post the deduction itself to a real "TDS Payable" liability
 * account in the shared ledger (account_transactions) — every credit to that
 * account, net of remittances to the tax authority (which debit it instead),
 * is a genuine withholding event — so for QuickBooks/Xero the report is
 * reconstructed from there instead of shown as unavailable:
 *   - grouped by the posting's own transaction_details (vendor name, or a
 *     payroll memo for salary-TDS) since neither platform carries a section
 *     code for us to read back — the "TDS Section" column is left blank;
 *   - the pretax "Total" a deduction was taken from is only knowable when the
 *     same document also posted an expense-account line (true for clean
 *     Bill/ManualJournal-sourced entries, false for bare 2-line
 *     ACCPAY/ACCPAYCREDIT-style postings) — where it can't be traced, Total
 *     and Total After TDS Deduction are left blank (null) rather than guessed;
 *     the TDS amount itself is always exact either way, straight off the
 *     ledger. xero-recon plugs are excluded (not real withholding events).
 */

const pool = require('../config/db');
const { getBaseCurrency } = require('./zohoChartOfAccountsService');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function getOrgId(userId) {
  const [[zb]] = await pool.execute('SELECT org_id FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1', [userId]);
  if (zb?.org_id) return zb.org_id;
  const [[xero]] = await pool.execute('SELECT tenant_id FROM xero_tokens WHERE user_id = ? LIMIT 1', [userId]);
  if (xero?.tenant_id) return xero.tenant_id;
  const [[qbo]] = await pool.execute('SELECT realm_id FROM qbo_tokens WHERE user_id = ? LIMIT 1', [userId]);
  if (qbo?.realm_id) return qbo.realm_id;
  return null;
}

function resolveRange(params) {
  const from = params.from_date || params.from || null;
  const to = params.to_date || params.to || null;
  if (from && to) return { from, to };
  // Default window: the fiscal year containing today, for the per-platform
  // start month (Settings → params.fy_start_month; defaults to 4 = 1 April).
  const { fyWindow, fyMonth } = require('./reportContext');
  const _fy = fyWindow(fyMonth(params.fy_start_month));
  return { from: from || _fy.from, to: to || _fy.to };
}

/**
 * Section code by TDS tax name, e.g. "Professional Fees" → "194J".
 *
 * Zoho puts the section on the bill, not on the line, and the warehouse keeps
 * only the tax's name against the line — so the two are joined on that name,
 * which Zoho's TDS master holds one-to-one with a section. The header spells
 * the name with its rate ("Professional Fees (10%)"), which is trimmed off.
 *
 * An enrichment, not a dependency: without it the report still lists every
 * deduction, just without its code.
 */
async function tdsSections(userId, orgId) {
  const map = new Map();
  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT
              JSON_UNQUOTE(JSON_EXTRACT(response_body, '$.bill.tds_section'))  AS section,
              JSON_UNQUOTE(JSON_EXTRACT(response_body, '$.bill.tds_tax_name')) AS tax_name
         FROM zb_raw_payloads
        WHERE user_id = ? AND org_id = ? AND endpoint LIKE '/bills/%'
          AND response_status = 200`,
      [userId, orgId]
    );
    for (const r of rows) {
      if (!r.section || !r.tax_name) continue;
      map.set(String(r.tax_name).replace(/\s*\([^)]*\)\s*$/, '').trim(), r.section);
    }
  } catch {
    // A malformed or missing payload log must not take the report down.
  }
  return map;
}

/**
 * QuickBooks/Xero reconstruction — dynamic and party-grouped.
 *
 * Reads every credit to a "TDS Payable" account (the deduction side; debits
 * to it are remittances to the tax authority and are excluded). Neither
 * platform carries a TDS section code, so rows are grouped by the PARTY the
 * tax was withheld from — the name riding on the posting's own
 * transaction_details. A manual journal whose memo merely narrates (salary
 * TDS batches, TDS adjustments, internal transfers, interest) names no party,
 * so it is kept only when its details match a real vendor/contact name from
 * the synced masters (bills.vendor_name, vendors.contact_name/company_name);
 * document postings (bills, credit notes, expenses, spend money) always
 * count. This adapts to any future client: whatever names a vendor is
 * captured, journal memos never pollute the report.
 *
 * The pretax base a deduction was taken from is only knowable when the same
 * document also posted an expense-account line (true for bills/journals that
 * carry the full entry, false for bare 2-line AP-adjustment postings) — where
 * it can't be traced, Total and Total After TDS Deduction are left blank
 * (null) rather than guessed. The TDS amount itself is always exact, straight
 * off the ledger. xero-recon plugs are excluded (not real withholding events).
 */
async function buildLedgerTdsSummary(userId, orgId, from, to) {
  const [rows] = await pool.execute(
    `SELECT transaction_id, transaction_details, source_type, credit
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND account_name LIKE '%TDS Payable%'
        AND account_name NOT LIKE '%Receivable%'
        AND credit > 0
        AND transaction_date BETWEEN ? AND ?
        AND transaction_id NOT LIKE 'xero-recon:%'`,
    [userId, orgId, from, to]
  );

  // Pretax base per transaction: the debit side that was posted to an expense
  // account on the SAME document. Present on salary JVs and bill/expense
  // postings; absent on bare AP-adjustment credit notes. Computed for EVERY
  // candidate row (not just the kept ones) so `keep` can use it below.
  const baseByTxn = new Map();
  {
    const allIds = [...new Set(rows.map((r) => r.transaction_id))];
    if (allIds.length) {
      const [baseRows] = await pool.execute(
        `SELECT transaction_id, SUM(debit) AS base
           FROM account_transactions
          WHERE user_id = ? AND org_id = ? AND account_group = 'expense'
            AND transaction_id IN (${allIds.map(() => '?').join(',')})
          GROUP BY transaction_id`,
        [userId, orgId, ...allIds]
      );
      for (const b of baseRows) baseByTxn.set(b.transaction_id, round2(b.base));
    }
  }

  // Vendor/contact names known to the books — a narrating journal memo is
  // only kept when it names one of them (exact match); a misspelt master
  // must not take the report down, so failure just skips name matching.
  const partyNames = new Set();
  try {
    const [names] = await pool.execute(
      `SELECT vendor_name AS n FROM bills
        WHERE user_id = ? AND org_id = ? AND vendor_name IS NOT NULL AND vendor_name <> ''
        UNION
       SELECT contact_name FROM vendors
        WHERE user_id = ? AND org_id = ? AND contact_name IS NOT NULL AND contact_name <> ''
        UNION
       SELECT company_name FROM vendors
        WHERE user_id = ? AND org_id = ? AND company_name IS NOT NULL AND company_name <> ''`,
      [userId, orgId, userId, orgId, userId, orgId]
    );
    for (const r of names) partyNames.add(String(r.n).trim().toLowerCase());
  } catch { /* name matching is an enhancement, not a dependency */ }

  // A bill's real counterparty is the name on its Accounts-Payable line. Some
  // QuickBooks TDS-Payable postings carry a line description ("CGST",
  // "Credits Applied", "TDS Payable", …) in transaction_details instead of the
  // vendor — for those, recover the party from the same document's AP line so
  // the deduction rolls up under the vendor rather than a stray label. Rows
  // that already name a real party are left untouched (Xero, most of QBO), so
  // this can only merge junk labels into real vendors, never move a good row.
  const partyByTxn = new Map();
  try {
    const allIds = [...new Set(rows.map((r) => r.transaction_id))];
    if (allIds.length) {
      const [apRows] = await pool.execute(
        `SELECT transaction_id, transaction_details,
                ABS(debit) + ABS(credit) AS mag
           FROM account_transactions
          WHERE user_id = ? AND org_id = ? AND account_type_code = 'accounts_payable'
            AND COALESCE(transaction_details, '') <> ''
            AND transaction_id IN (${allIds.map(() => '?').join(',')})`,
        [userId, orgId, ...allIds]
      );
      const best = new Map();
      for (const a of apRows) {
        const cur = best.get(a.transaction_id);
        if (!cur || Number(a.mag) > cur.mag) {
          best.set(a.transaction_id, { name: String(a.transaction_details).trim(), mag: Number(a.mag) });
        }
      }
      for (const [tid, v] of best) partyByTxn.set(tid, v.name);
    }
  } catch { /* AP-line lookup is an enrichment, not a dependency */ }

  // The party a TDS row belongs to: its own detail when that is a recognised
  // name, else the document's AP-line vendor, else whatever was on the row.
  const partyOf = (r) => {
    const own = String(r.transaction_details || '').trim();
    if (own && partyNames.has(own.toLowerCase())) return own;
    const viaAp = partyByTxn.get(r.transaction_id);
    if (viaAp && partyNames.has(viaAp.toLowerCase())) return viaAp;
    return own || 'Not Specified';
  };

  const keep = (r) => {
    if (!/journal/i.test(String(r.source_type || ''))) return true; // document posting
    const d = String(r.transaction_details || '').trim().toLowerCase();
    return d !== '' && partyNames.has(d); // journal only when it names a party
  };
  const tdsRows = rows.filter(keep);

  if (!tdsRows.length) {
    return {
      columns: [{ key: 'label', label: '', align: 'left' }],
      rows: [],
      empty: true,
      unavailable: true,
      emptyReason: 'unavailable',
      message: 'No TDS Payable postings were found in the ledger for this period.',
      meta: { title: 'TDS Summary', basis: 'Accrual', from, to, source: 'none' },
    };
  }

  const grouped = new Map();
  for (const r of tdsRows) {
    const key = partyOf(r);
    const g = grouped.get(key) || { total: 0, hasBase: false, tds: 0 };
    const base = baseByTxn.get(r.transaction_id);
    if (base > 0) {
      g.total = round2(g.total + base);
      g.hasBase = true;
    }
    g.tds = round2(g.tds + Number(r.credit || 0));
    grouped.set(key, g);
  }

  // Fallback "Total" for a party whose TDS came only from bare AP-adjustment
  // credit notes (no expense leg on the document, so no base above): the sum of
  // that vendor's bills in the period — the amount the deduction was taken from.
  // Keeps "Total" / "Total After TDS Deduction" populated for QuickBooks/Xero,
  // whose TDS credit notes don't carry the gross.
  {
    const [billRows] = await pool.execute(
      `SELECT vendor_name AS n, SUM(total) AS t
         FROM bills
        WHERE user_id = ? AND org_id = ?
          AND COALESCE(is_deleted, 0) = 0
          AND date BETWEEN ? AND ?
          AND vendor_name IS NOT NULL AND vendor_name <> ''
        GROUP BY vendor_name`,
      [userId, orgId, from, to]
    );
    const billTotalByVendor = new Map();
    for (const b of billRows) billTotalByVendor.set(String(b.n).trim().toLowerCase(), round2(b.t));
    for (const [party, g] of grouped) {
      if (g.hasBase) continue;
      const bt = billTotalByVendor.get(party.toLowerCase());
      if (bt > 0) { g.total = bt; g.hasBase = true; }
    }
  }

  const currency = await getBaseCurrency(orgId);
  // Same column set and order as the Zoho warehouse path so the report reads
  // identically on every platform:
  //   TDS Section | TDS Section Description | Total | Total After TDS Deduction | Tax Deducted at Source
  // QuickBooks/Xero carry no TDS section code, so the party the tax was withheld
  // from sits in "TDS Section" and "TDS Section Description" is left blank — no
  // figure changes, only the layout.
  const columns = [
    { key: 'label',       label: 'TDS Section',               align: 'left'  },
    { key: 'description',  label: 'TDS Section Description',    align: 'left'  },
    { key: 'total',        label: 'Total',                     align: 'right', money: true },
    { key: 'afterTds',     label: 'Total After TDS Deduction', align: 'right', money: true },
    { key: 'tds',          label: 'Tax Deducted at Source',    align: 'right', money: true },
  ];

  const ordered = [...grouped.entries()]
    .map(([party, g]) => ({
      party,
      total: g.hasBase ? g.total : null,
      afterTds: g.hasBase ? round2(g.total - g.tds) : null,
      tds: g.tds,
    }))
    .sort((a, b) => a.party.localeCompare(b.party));

  const out = ordered.map((r) => ({
    label: r.party,
    level: 0,
    cells: { description: '', tds: r.tds, total: r.total, afterTds: r.afterTds },
  }));

  const grand = ordered.reduce(
    (acc, r) => ({
      total: r.total == null ? acc.total : round2(acc.total + r.total),
      afterTds: r.afterTds == null ? acc.afterTds : round2(acc.afterTds + r.afterTds),
      tds: round2(acc.tds + r.tds),
      hasBase: acc.hasBase || r.total != null,
    }),
    { total: 0, afterTds: 0, tds: 0, hasBase: false }
  );

  out.push({
    label: 'Total',
    isTotal: true,
    level: 0,
    cells: {
      description: '',
      tds: grand.tds,
      total: grand.hasBase ? grand.total : null,
      afterTds: grand.hasBase ? grand.afterTds : null,
    },
  });

  return {
    columns,
    rows: out,
    currency,
    meta: { title: 'TDS Summary', from, to, basis: 'Accrual', source: 'ledger' },
  };
}

async function buildTdsSummary(userId, params = {}) {
  const { from, to } = resolveRange(params);

  if (params.platform && params.platform !== 'zoho') {
    const orgId = params.org_id || (await getOrgId(userId));
    if (!orgId) {
      const err = new Error('Not connected (no org_id)');
      err.code = 'NOT_CONNECTED';
      throw err;
    }
    return buildLedgerTdsSummary(userId, orgId, from, to);
  }

  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Zoho not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const [rows] = await pool.execute(
    `SELECT li.tds_tax_name AS tax_name,
            SUM(li.item_total) AS gross,
            SUM(li.tds_tax_amount) AS tds
       FROM zb_bill_line_items li
       JOIN bills b
         ON b.zoho_id = li.zoho_bill_id AND b.org_id = li.org_id AND b.user_id = li.user_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND COALESCE(b.is_deleted, 0) = 0
        AND b.date BETWEEN ? AND ?
        AND li.tds_tax_amount > 0
        AND li.tds_tax_name IS NOT NULL AND li.tds_tax_name <> ''
      GROUP BY li.tds_tax_name`,
    [userId, orgId, from, to]
  );

  const sections = await tdsSections(userId, orgId);
  const currency = await getBaseCurrency(orgId);

  const columns = [
    { key: 'label',       label: 'TDS Section',               align: 'left'  },
    { key: 'description', label: 'TDS Section Description',   align: 'left'  },
    { key: 'total',       label: 'Total',                     align: 'right', money: true },
    { key: 'afterTds',    label: 'Total After TDS Deduction', align: 'right', money: true },
    { key: 'tds',         label: 'Tax Deducted at Source',    align: 'right', money: true },
  ];

  const ordered = rows
    .map((r) => ({
      section: sections.get(String(r.tax_name).trim()) || '',
      description: r.tax_name,
      total: round2(r.gross),
      tds: round2(r.tds),
    }))
    .sort((a, b) => a.section.localeCompare(b.section) || a.description.localeCompare(b.description));

  const out = [];
  const grand = { total: 0, afterTds: 0, tds: 0 };
  for (const r of ordered) {
    const afterTds = round2(r.total - r.tds);
    out.push({
      label: r.section,
      level: 0,
      cells: { description: r.description, total: r.total, afterTds, tds: r.tds },
    });
    grand.total = round2(grand.total + r.total);
    grand.afterTds = round2(grand.afterTds + afterTds);
    grand.tds = round2(grand.tds + r.tds);
  }

  if (out.length) {
    out.push({ label: 'Total', isTotal: true, level: 0, cells: { ...grand } });
  }

  return {
    columns,
    rows: out,
    currency,
    zoho: {
      module: 'Taxes',
      title: 'TDS Summary',
      basis: 'Accrual',
      groupBy: 'None',
    },
    meta: { title: 'TDS Summary', from, to, basis: 'Accrual', source: 'warehouse' },
  };
}

module.exports = { buildTdsSummary };
