'use strict';

/**
 * Tax Liability — Zoho Books' "Tax Summary" (GST Summary).
 * ---------------------------------------------------------------------------
 * One row per tax rate actually charged in the period:
 *
 *   Tax ID | Tax Name | Tax Percentage | Status | Transaction Amount | Tax Amount
 *
 * followed by a single Total of the tax collected, which is the layout Zoho
 * prints and exports.
 *
 * The taxable amount comes from the invoice line items, which carry the tax the
 * line was charged at. Zoho reports India's intra-state GST the way the law
 * levies it — as two equal halves, central and state — so a line taxed at the
 * GST18 group is reported as CGST9 plus SGST9, each on the full taxable amount.
 * Inter-state IGST is a single levy and stays whole.
 *
 * This is a net-liability report, not a sales-only one: Zoho's own Tax Summary
 * nets output tax collected on invoices against input tax paid on bills for the
 * same rate, so a bill contributes to the same CGST9/SGST9/IGST18 bucket as a
 * negative amount (drilling into a rate that was only ever paid on purchases,
 * never charged on a sale, shows a negative Total for that row — confirmed
 * against Zoho's own live "SGST2.5 - Transactions" drill, 15 Bills netting to
 * -2,394.67). Reverse-charge bills carry no tax_id/tax_name on the bill itself
 * in Zoho (the tax is self-assessed, declared elsewhere) so they fall out of
 * this query on their own, the same way a credit note nets off an invoice.
 *
 * Tax is charged and rounded once per document per levy, then summed — never
 * re-derived from the period's total. That is what makes these figures tie to
 * Zoho's to the paisa, and it is not merely a convention: rounding CGST and
 * SGST separately is why an 18% invoice can carry a tax total a paisa away from
 * 18% of its base. Reproducing it exactly was verified against every taxed
 * invoice in the warehouse.
 *
 * QuickBooks/Xero have no tax_id/tax_name fields on their synced invoice
 * lines, but both still carry the GST actually charged — just in a different
 * place, so each is reconstructed from where it actually lives:
 *   - QuickBooks (India) models GST as ordinary invoice LINE ITEMS named
 *     "Output CGST"/"Output SGST"/"Output IGST" (optionally prefixed
 *     "Liability:") sitting alongside the revenue lines on the same invoice —
 *     the line's own item_total IS the tax charged, and the invoice's other,
 *     non-GST lines sum to the taxable base it was charged on, so the rate is
 *     derived (tax / base × 100) and grouped exactly like Zoho's CGST/SGST
 *     buckets.
 *   - Xero posts the same three GST accounts, but only as periodic rollup
 *     ManualJournals (no per-invoice ACCREC postings touch them in this data),
 *     so there is no sibling revenue line to trace a base or rate from for a
 *     given credit — the tax collected per account is still real and exact,
 *     it is only the Transaction Amount/Tax Percentage that are unknowable,
 *     and are left blank (null) rather than guessed.
 */

const pool = require('../config/db');
const { getBaseCurrency } = require('./zohoChartOfAccountsService');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Half away from zero, the way an accounting system rounds. JS's Math.round
// breaks ties towards +Infinity, which would turn a credit note's -383.125
// into -383.12 where Zoho prints -383.13.
const round2 = (n) => {
  const v = num(n);
  return (v < 0 ? -1 : 1) * Math.round(Math.abs(v) * 100) / 100;
};

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
  const from = params.from_date || params.date_start || params.from || null;
  const to = params.to_date || params.date_end || params.to || null;
  if (from && to) return { from: String(from).slice(0, 10), to: String(to).slice(0, 10) };
  // Default window: the fiscal year containing today, for the per-platform
  // start month (Settings → params.fy_start_month; defaults to 4 = 1 April).
  const { fyWindow, fyMonth } = require('./reportContext');
  const _fy = fyWindow(fyMonth(params.fy_start_month));
  return { from: from || _fy.from, to: to || _fy.to };
}

// 9 → "9", 2.5 → "2.5" — the way Zoho names a tax after its rate.
const rateSuffix = (pct) => String(round2(pct)).replace(/\.0+$/, '');

/**
 * The organisation's tax master, for each tax's live status. Zoho's tax list is
 * captured during the sync but not warehoused in a table of its own, so it is
 * read back out of the stored response. It is an enrichment, not a dependency:
 * without it the report still lists every tax that was actually charged.
 */
async function taxStatuses(userId, orgId) {
  const map = new Map();
  try {
    const [[row]] = await pool.execute(
      `SELECT response_body FROM zb_raw_payloads
        WHERE user_id = ? AND org_id = ? AND endpoint = '/settings/taxes'
          AND response_status = 200
        ORDER BY fetched_at DESC LIMIT 1`,
      [userId, orgId]
    );
    if (!row) return map;
    const body = typeof row.response_body === 'string' ? JSON.parse(row.response_body) : row.response_body;
    for (const t of body?.taxes || []) {
      if (t?.tax_id) map.set(String(t.tax_id), t.status || (t.is_inactive ? 'Inactive' : 'Active'));
    }
  } catch {
    // A malformed or missing payload log must not take the report down.
  }
  return map;
}

// CGST2.5, CGST9, IGST5, IGST18, SGST2.5, SGST9 — by levy, then by rate; a
// levy whose rate can't be traced sorts after its known-rate siblings.
const family = (n) => String(n).replace(/[\d.]+$/, '');

// Shared row/Total rendering for every platform's levy map — each entry is
// { taxId, name, pct, taxable, tax }, with pct/taxable nullable where the
// figure genuinely can't be traced (renders blank, never a guess).
function renderLevies(levies, { currency, from, to, source, statuses, othersAmount = 0 }) {
  const ordered = [...levies.values()].sort(
    (a, b) => family(a.name).localeCompare(family(b.name)) || (a.pct ?? Infinity) - (b.pct ?? Infinity)
  );

  const columns = [
    { key: 'label',      label: 'Tax ID',             align: 'left'  },
    { key: 'taxName',    label: 'Tax Name',           align: 'left'  },
    { key: 'taxPercent', label: 'Tax Percentage',     align: 'right' },
    { key: 'status',     label: 'Status',             align: 'left'  },
    { key: 'taxable',    label: 'Transaction Amount', align: 'right', money: true },
    { key: 'taxAmount',  label: 'Tax Amount',         align: 'right', money: true },
  ];

  const rows = [];
  let total = 0;
  for (const lv of ordered) {
    total = round2(total + lv.tax);
    // Newest first — matches Zoho's own "<Tax> - Transactions" drill-down order.
    const breakdown = lv.breakdown && lv.breakdown.length
      ? [...lv.breakdown].sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      : undefined;
    rows.push({
      label: lv.taxId || '',
      cells: {
        taxName: lv.name,
        // Zoho prints the bare rate — 9, not 9.00, and 2.5, not 2.50.
        taxPercent: lv.pct != null ? rateSuffix(lv.pct) : '',
        // Zoho carries a per-tax status from its tax master; QuickBooks/Xero
        // don't sync one, so a tax that was actually charged in the period is
        // shown Active (it can't be a disabled tax if it produced a posting).
        status: statuses ? (statuses.get(String(lv.taxId)) || 'Active') : (lv.name ? 'Active' : ''),
        taxable: lv.taxable,
        taxAmount: lv.tax,
      },
      breakdown,
      breakdownCount: breakdown ? breakdown.length : undefined,
    });
  }
  rows.sort((a, b) => (b.cells.taxName || '').localeCompare(a.cells.taxName || ''));
  // Add "Others" row if non-zero (manual transactions in Tax Payable account)
  if (Math.abs(othersAmount) > 0.005) {
    rows.push({
      label: '',
      cells: {
        taxName: 'Others (Manual transactions in Tax Payable account)',
        taxPercent: '',
        status: '',
        taxable: null,
        taxAmount: othersAmount,
      },
    });
    total = round2(total + othersAmount);
  }

  if (rows.length) {
    // Totals the tax collected only — the taxable amounts belong to
    // different levies on the same sale, so adding them would double-count.
    rows.push({ label: 'Total', isTotal: true, cells: { taxAmount: total } });
  }

  return {
    columns,
    rows,
    currency,
    zoho: { module: 'Taxes', title: 'Tax Summary', basis: 'Accrual', groupBy: 'None' },
    meta: { title: 'Tax Liability', from, to, basis: 'Accrual', source },
  };
}

// "Liability:Output SGST" / "Output CGST" / "Input CGST" / … → "CGST"/"SGST"/"IGST", the
// levy a GST line/account actually is, regardless of naming variant.
// Matches both Output (tax collected on sales) and Input (ITC claimed on purchases).
function gstLevyName(name) {
  const m = /(?:output|input)\s*(cgst|sgst|igst)/i.exec(String(name || ''));
  return m ? m[1].toUpperCase() : null;
}

// India GST slab used to present a rate on ITC rows reconstructed from the
// ledger (where the bill's own rate can't be traced). CGST/SGST are half of
// the 18 % slab, IGST the whole. Disclosed via meta.taxRateAssumed.
const GST_SLAB_RATE = { CGST: 9, SGST: 9, IGST: 18 };

// Provider labels for a purchase document — the origin of an input-tax-credit
// posting, as opposed to a GST payment or a set-off journal that also moves
// the Input control accounts.
const BILL_TXN_TYPES = "('Bill','ACCPAY','bill','ACCPAYCREDIT','Vendor Credit','Bill Credit','vendor_credit','Debit Note')";

/**
 * QuickBooks (India) — GST is modelled as ordinary invoice line items named
 * "Output CGST"/"Output SGST"/"Output IGST" sitting alongside the revenue
 * lines on the same invoice. The GST line's own item_total is the tax
 * charged; the invoice's other lines sum to the base it was charged on, so
 * the rate is derived per invoice and pooled into the same CGST/SGST/IGST
 * buckets Zoho uses.
 *
 * Zoho's Tax Summary is a NET report — output tax collected on sales less
 * input tax paid on purchases for the same levy. QuickBooks bill line items
 * carry no normalised tax name/rate (the description is free-text
 * vendor-invoice wording), so the ITC side is read from the posted ledger:
 * purchase-origin movement on the Input CGST/SGST/IGST control accounts,
 * netted against the same levy as a negative amount. Rate can't be traced
 * from the ledger so ITC rows are shown on the 18 % slab.
 */
async function buildQuickbooksTaxLiability(userId, orgId, from, to) {
  const [lines] = await pool.execute(
    `SELECT li.zoho_invoice_id AS doc_id, li.item_name, li.item_total,
            i.invoice_number AS doc_number, i.date AS doc_date
       FROM zb_invoice_line_items li
       JOIN invoices i
         ON i.zoho_id = li.zoho_invoice_id AND i.org_id = li.org_id AND i.user_id = li.user_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND COALESCE(i.is_deleted, 0) = 0
        AND i.status NOT IN ('draft', 'void')
        AND i.date BETWEEN ? AND ?`,
    [userId, orgId, from, to]
  );

  const byDoc = new Map();
  for (const l of lines) {
    let d = byDoc.get(l.doc_id);
    if (!d) { d = { base: 0, gst: [], docNumber: l.doc_number, docDate: l.doc_date }; byDoc.set(l.doc_id, d); }
    const levyName = gstLevyName(l.item_name);
    if (levyName) d.gst.push({ levyName, amount: num(l.item_total) });
    else d.base = round2(d.base + num(l.item_total));
  }

  const levies = new Map();
  for (const [docId, d] of byDoc) {
    for (const g of d.gst) {
      const pct = d.base > 0 ? round2((g.amount / d.base) * 100) : null;
      const key = `${g.levyName}|${pct ?? 'na'}`;
      let levy = levies.get(key);
      if (!levy) {
        levy = { taxId: '', name: pct != null ? `${g.levyName}${rateSuffix(pct)}` : g.levyName, pct, taxable: pct != null ? 0 : null, tax: 0, breakdown: [] };
        levies.set(key, levy);
      }
      if (pct != null) levy.taxable = round2(levy.taxable + d.base);
      levy.tax = round2(levy.tax + g.amount);
      levy.breakdown.push({
        date: d.docDate ? String(d.docDate).slice(0, 10) : null,
        ref: d.docNumber || docId,
        type: 'Invoice',
        txnAmount: pct != null ? round2(d.base) : null,
        amount: round2(g.amount),
      });
    }
  }

  // ── Input tax credit (ITC), netted like Zoho's Tax Summary ────────────────
  // Purchase-origin movement (debit − credit) on the Input GST control
  // accounts. GST payments to the government and ITC set-off journals also
  // touch these accounts, so they are excluded by the transaction-type filter.
  // Fetched per-row (not pre-aggregated) so each contributing bill can be
  // listed in the row's drill-down, the same as the output side above.
  const [itcRows] = await pool.execute(
    `SELECT CASE WHEN LOWER(account_name) LIKE 'input cgst%' THEN 'CGST'
                 WHEN LOWER(account_name) LIKE 'input sgst%' THEN 'SGST'
                 WHEN LOWER(account_name) LIKE 'input igst%' THEN 'IGST' END AS levy,
            transaction_date, reference_number, transaction_number, transaction_type, source_id,
            debit, credit
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND (LOWER(account_name) LIKE 'input cgst%'
          OR LOWER(account_name) LIKE 'input sgst%'
          OR LOWER(account_name) LIKE 'input igst%')
        AND transaction_type IN ${BILL_TXN_TYPES}
        AND transaction_date BETWEEN ? AND ?
        AND transaction_id NOT LIKE 'xero-recon:%'`,
    [userId, orgId, from, to]
  );
  const itcByLevy = new Map();
  for (const r of itcRows) {
    if (!r.levy) continue;
    let e = itcByLevy.get(r.levy);
    if (!e) { e = { itc: 0, rows: [] }; itcByLevy.set(r.levy, e); }
    const rowNet = num(r.debit) - num(r.credit);
    e.itc = round2(e.itc + rowNet);
    e.rows.push({
      date: r.transaction_date ? String(r.transaction_date).slice(0, 10) : null,
      ref: r.reference_number || r.transaction_number || r.source_id,
      type: r.transaction_type || 'Bill',
      tax: round2(-rowNet),
    });
  }
  let anyItc = false;
  for (const [levyName, e] of itcByLevy) {
    const itc = round2(e.itc);
    if (itc === 0) continue;
    anyItc = true;
    const pct = GST_SLAB_RATE[levyName];
    levies.set(`input|${levyName}`, {
      taxId: '',
      name: `${levyName}${rateSuffix(pct)} (Input)`,
      pct,
      taxable: round2(-itc / (pct / 100)),
      tax: -itc,
      breakdown: e.rows.map((r) => ({
        date: r.date, ref: r.ref, type: r.type,
        txnAmount: round2(r.tax / (pct / 100)),
        amount: r.tax,
      })),
    });
  }

  const currency = await getBaseCurrency(orgId);
  const out = renderLevies(levies, { currency, from, to, source: 'ledger' });
  if (anyItc) {
    out.meta.taxRateAssumed = 'ITC rows on 18% slab (CGST/SGST 9%, IGST 18%)';
  }
  return out;
}

// Xero posts GST only through generic "Output CGST/SGST/IGST" accounts (no rate
// on the account, no sibling revenue line), so the exact per-invoice rate and
// base can't be traced. India's GST is levied on the 18% slab in the
// overwhelming majority of B2B supplies, so we present the rate on that basis —
// CGST/SGST at 9%, IGST at 18% — and back-compute the Transaction Amount as
// tax ÷ rate. This ties out to the same figure QuickBooks derives from its
// invoice lines; a small share of 5%/12% supplies would make the base read
// slightly high, which is disclosed by `meta.taxRateAssumed`.
const XERO_GST_RATE = { CGST: 9, SGST: 9, IGST: 18 };

/**
 * Xero — the three GST liability accounts, credited by periodic rollup
 * ManualJournals. Tax collected per account is exact off the ledger; rate and
 * Transaction Amount are derived on the 18% GST slab (see XERO_GST_RATE).
 */
// Xero has no sibling sales/purchase document to trace per GST credit (see the
// module doc comment), so a "drill-down" here can only list the raw GL
// postings that make up the account's total — not the underlying invoices —
// scoped to whichever source the header figure above was actually built from
// (`onlyManualJournal`), so the breakdown always sums to the row it expands.
// `side` picks the same field the header total uses: 'credit' for the Output
// accounts (credit − debit), 'debit' for the Input accounts (−debit only,
// credits on an Input account are ignored the same way the header is).
async function xeroAccountBreakdown(userId, orgId, from, to, accountPrefix, side, onlyManualJournal) {
  const [rows] = await pool.execute(
    `SELECT transaction_date, reference_number, transaction_number, source_type, debit, credit
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND account_name LIKE ?
        AND transaction_date BETWEEN ? AND ?
        AND source_type != 'xero-recon'
        ${onlyManualJournal ? "AND source_type = 'ManualJournal'" : ''}`,
    [userId, orgId, `${accountPrefix}%`, from, to]
  );
  return rows
    .map((r) => ({
      date: r.transaction_date ? String(r.transaction_date).slice(0, 10) : null,
      ref: r.reference_number || r.transaction_number || null,
      type: r.source_type || 'GL Posting',
      txnAmount: null,
      amount: side === 'debit' ? round2(-num(r.debit)) : round2(num(r.credit) - num(r.debit)),
    }))
    .filter((r) => r.amount !== 0);
}

async function buildXeroTaxLiability(userId, orgId, from, to) {
  // Xero books its periodic GST as rollup ManualJournals crediting the three
  // Output accounts. The posting engine ALSO synthesises a per-invoice ACCREC
  // posting to the same accounts — a duplicate of that rollup (it inflates
  // Output IGST ~4x in tenants where every invoice is IGST). So take the
  // ManualJournal credit as the liability, and fall back to the raw credit
  // total (no rollup journal) or the setoff-journal debits (old sync bug that
  // posted invoice tax to GST Payable) only when there is no rollup credit.
  //
  // NOTE: Xero stores account names in two variants:
  //   - 'Output CGST' (from ManualJournal)
  //   - 'Output CGST (10071)' (from xero-recon)
  // We use LIKE to match both, but exclude xero-recon entries to avoid
  // double-counting since the reconciliation entries are already reflected
  // in the ManualJournal entries.
  const [rows] = await pool.execute(
    `SELECT account_name,
            SUM(CASE WHEN source_type = 'ManualJournal' THEN credit ELSE 0 END) AS mj_credit,
            SUM(credit) AS credit_total,
            SUM(CASE WHEN source_type = 'ManualJournal' THEN debit ELSE 0 END) AS mj_debit
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND (account_name LIKE 'Output CGST%'
          OR account_name LIKE 'Output SGST%'
          OR account_name LIKE 'Output IGST%')
        AND transaction_date BETWEEN ? AND ?
        AND source_type != 'xero-recon'
      GROUP BY account_name`,
    [userId, orgId, from, to]
  );

  const levies = new Map();
  for (const r of rows) {
    const levyName = gstLevyName(r.account_name);
    if (!levyName) continue;
    // Rollup ManualJournal credit is the authoritative period liability;
    // fall back to the raw credit total, then to setoff-journal debits.
    const usedMj = round2(r.mj_credit || 0) !== 0;
    const tax = round2(r.mj_credit || 0) || round2(r.credit_total || 0) || round2(r.mj_debit || 0);
    if (tax === 0) continue;
    const pct = XERO_GST_RATE[levyName] || null;
    // eslint-disable-next-line no-await-in-loop
    const breakdown = await xeroAccountBreakdown(userId, orgId, from, to, `Output ${levyName}`, 'credit', usedMj);
    levies.set(levyName, {
      taxId: '',
      name: pct != null ? `${levyName}${rateSuffix(pct)}` : levyName,
      pct,
      taxable: pct != null ? round2(tax / (pct / 100)) : null,
      tax,
      breakdown,
    });
  }

  // Also include Input tax accounts as negative rows (ITC claimed)
  const [inputRows] = await pool.execute(
    `SELECT account_name, SUM(debit) AS debit_total
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND (account_name LIKE 'Input CGST%'
          OR account_name LIKE 'Input SGST%'
          OR account_name LIKE 'Input IGST%')
        AND transaction_date BETWEEN ? AND ?
        AND source_type != 'xero-recon'
      GROUP BY account_name`,
    [userId, orgId, from, to]
  );

  for (const r of inputRows) {
    const levyName = gstLevyName(r.account_name);
    if (!levyName || !r.debit_total) continue;
    const key = `input|${levyName}`;
    const pct = XERO_GST_RATE[levyName] || null;
    const tax = -round2(r.debit_total);
    // eslint-disable-next-line no-await-in-loop
    const breakdown = await xeroAccountBreakdown(userId, orgId, from, to, `Input ${levyName}`, 'debit', false);
    levies.set(key, {
      taxId: '',
      name: pct != null ? `${levyName}${rateSuffix(pct)} (Input)` : `${levyName} (Input)`,
      pct,
      taxable: pct != null ? round2(tax / (pct / 100)) : null,
      tax,
      breakdown,
    });
  }

  const currency = await getBaseCurrency(orgId);
  const out = renderLevies(levies, { currency, from, to, source: 'ledger' });
  out.meta.taxRateAssumed = '18% slab (CGST/SGST 9%, IGST 18%)';
  return out;
}

async function buildTaxLiability(userId, params = {}) {
  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const { from, to } = resolveRange(params);

  if (params.platform === 'quickbooks') return buildQuickbooksTaxLiability(userId, orgId, from, to);
  if (params.platform === 'xero') return buildXeroTaxLiability(userId, orgId, from, to);

  // Taxable amount per document per tax, off the posted invoices in the period.
  // Lines with no tax on them are not part of a tax summary. doc_number/doc_date
  // (functionally dependent on doc_id, so MAX() is safe — same convention as
  // tax_percentage above) feed the drill-down breakdown below, not the totals.
  const [docs] = await pool.execute(
    `SELECT li.zoho_invoice_id AS doc_id, li.tax_id, li.tax_name, li.tax_type,
            MAX(li.tax_percentage) AS tax_percentage,
            SUM(li.item_total) AS taxable,
            MAX(i.invoice_number) AS doc_number, MAX(i.date) AS doc_date
       FROM zb_invoice_line_items li
       JOIN invoices i
         ON i.zoho_id = li.zoho_invoice_id AND i.org_id = li.org_id AND i.user_id = li.user_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND COALESCE(i.is_deleted, 0) = 0
        AND i.status NOT IN ('draft', 'void')
        AND i.date BETWEEN ? AND ?
        AND (COALESCE(li.tax_id, '') <> '' OR COALESCE(li.tax_name, '') <> '')
      GROUP BY li.zoho_invoice_id, li.tax_id, li.tax_name, li.tax_type`,
    [userId, orgId, from, to]
  );

  // A credit note is a negative sale: Zoho nets it off the same rate's row,
  // which is what puts a minus sign on a rate that was only ever credited.
  const [creditDocs] = await pool.execute(
    `SELECT li.zoho_creditnote_id AS doc_id, li.tax_id, li.tax_name, li.tax_type,
            MAX(li.tax_percentage) AS tax_percentage,
            -SUM(li.item_total) AS taxable,
            MAX(c.creditnote_number) AS doc_number, MAX(c.date) AS doc_date
       FROM zb_credit_note_line_items li
       JOIN zb_credit_notes c
         ON c.zoho_creditnote_id = li.zoho_creditnote_id
        AND c.org_id = li.org_id AND c.user_id = li.user_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND LOWER(COALESCE(c.status, '')) NOT IN ('draft', 'void')
        AND c.date BETWEEN ? AND ?
        AND (COALESCE(li.tax_id, '') <> '' OR COALESCE(li.tax_name, '') <> '')
      GROUP BY li.zoho_creditnote_id, li.tax_id, li.tax_name, li.tax_type`,
    [userId, orgId, from, to]
  );

  // Input tax on purchases nets off the same rate's row as a negative amount —
  // this is what makes it a Tax Summary (net payable) rather than a sales-only
  // report. A reverse-charge bill has no tax_id/tax_name on its own lines in
  // Zoho, so it is excluded by the same filter as everything else here.
  const [billDocs] = await pool.execute(
    `SELECT li.zoho_bill_id AS doc_id, li.tax_id, li.tax_name, li.tax_type,
            MAX(li.tax_percentage) AS tax_percentage,
            -SUM(li.item_total) AS taxable,
            MAX(b.bill_number) AS doc_number, MAX(b.date) AS doc_date
       FROM zb_bill_line_items li
       JOIN bills b
         ON b.zoho_id = li.zoho_bill_id AND b.org_id = li.org_id AND b.user_id = li.user_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND COALESCE(b.is_deleted, 0) = 0
        AND b.date BETWEEN ? AND ?
        AND (COALESCE(li.tax_id, '') <> '' OR COALESCE(li.tax_name, '') <> '')
      GROUP BY li.zoho_bill_id, li.tax_id, li.tax_name, li.tax_type`,
    [userId, orgId, from, to]
  );

  const statuses = await taxStatuses(userId, orgId);
  const currency = await getBaseCurrency(orgId);

  // Split each charged tax into the levies it is reported under, then pool them:
  // two different groups can both contribute to, say, CGST9. Each document also
  // pushes one drill-down row per levy it contributes to — this is what backs
  // the "<Tax> - Transactions" breakdown a Tax Liability row expands into.
  const taggedDocs = [
    ...docs.map((d) => ({ ...d, docType: 'Invoice' })),
    ...creditDocs.map((d) => ({ ...d, docType: 'Credit Note' })),
    ...billDocs.map((d) => ({ ...d, docType: 'Bill' })),
  ];
  const levies = new Map();
  for (const d of taggedDocs) {
    const pct = num(d.tax_percentage);
    const taxable = num(d.taxable);
    const isGroup = String(d.tax_type) === 'tax_group' && !/^IGST/i.test(d.tax_name || '');
    const parts = isGroup
      ? [`CGST${rateSuffix(pct / 2)}`, `SGST${rateSuffix(pct / 2)}`].map((name) => ({ name, pct: pct / 2 }))
      : [{ name: d.tax_name || `Tax ${rateSuffix(pct)}`, pct }];

    for (const p of parts) {
      const key = `${p.name}|${p.pct}`;
      let levy = levies.get(key);
      if (!levy) {
        // A group's components are not taxes in their own right in Zoho's tax
        // list, so they are identified by the group that levied them.
        levy = { taxId: d.tax_id || '', name: p.name, pct: p.pct, taxable: 0, tax: 0, breakdown: [] };
        levies.set(key, levy);
      }
      const partTax = round2(taxable * p.pct / 100);
      levy.taxable = round2(levy.taxable + taxable);
      levy.tax = round2(levy.tax + partTax);
      levy.breakdown.push({
        date: d.doc_date ? String(d.doc_date).slice(0, 10) : null,
        ref: d.doc_number || d.doc_id,
        type: d.docType,
        txnAmount: round2(taxable),
        amount: partTax,
      });
    }
  }

  // Query for "Others" — manual transactions in Tax Payable accounts
  const [otherTaxRows] = await pool.execute(
    `SELECT ROUND(SUM(credit - debit), 2) AS net_tax
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND (
          LOWER(TRIM(account_name)) IN ('tax payable', 'tax payable account')
          OR account_type_code = 'tax_payable'
          OR (
            (LOWER(account_name) LIKE '%cgst%' 
             OR LOWER(account_name) LIKE '%sgst%' 
             OR LOWER(account_name) LIKE '%igst%')
            AND (source_type = 'journal' OR transaction_type = 'journal')
          )
          OR (
            (source_type = 'bill' OR transaction_type = 'bill')
            AND (LOWER(account_name) LIKE '%input igst%' 
                 OR LOWER(account_name) LIKE '%input cgst%' 
                 OR LOWER(account_name) LIKE '%input sgst%')
            AND transaction_id COLLATE utf8mb4_unicode_ci NOT IN (
              SELECT DISTINCT zoho_bill_id COLLATE utf8mb4_unicode_ci
              FROM zb_bill_line_items 
              WHERE user_id = account_transactions.user_id 
                AND (COALESCE(tax_id, '') <> '' OR COALESCE(tax_name, '') <> '')
            )
          )
        )
        AND transaction_date >= ?
        AND transaction_date <= ?
        AND transaction_id NOT LIKE 'xero-recon:%'`,
    [userId, orgId, from, to + ' 23:59:59']
  );
  const othersAmount = round2(num(otherTaxRows[0]?.net_tax));

  return renderLevies(levies, { currency, from, to, source: 'warehouse', statuses, othersAmount });
}

module.exports = { buildTaxLiability };
