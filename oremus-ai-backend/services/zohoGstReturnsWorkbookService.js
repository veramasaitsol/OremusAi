'use strict';

/**
 * GST Returns Workbook — Zoho Books' "GSTR-3B Summary".
 * ---------------------------------------------------------------------------
 * The return as GSTN lays it out, so it is a workbook of numbered sections
 * rather than one table:
 *
 *   3.1   Outward supplies and inward supplies liable to reverse charge
 *   3.1.1 Supplies notified under sub-section (5) of section 9
 *   3.2   Of 3.1(a), inter-State supplies to unregistered / composition / UIN
 *   4     Eligible ITC
 *   5     Exempt, nil-rated and non-GST inward supplies
 *
 * Each section is emitted as `{ no, title, columns, rows }` for the workbook
 * viewer, which draws the tinted "1 2 3 …" column-number row underneath the
 * headings the way the portal does.
 *
 * Inter-state versus intra-state is decided by the tax charged, not by any
 * address: IGST is a single inter-state levy, while Zoho's GST groups are
 * intra-state and are reported as their halves, central and state. The tax is
 * rounded once per document per levy and then summed — the same rule the Tax
 * Summary uses, so the two reports agree to the paisa.
 *
 * A credit note is a negative sale and nets off the supplies it credits.
 */

const pool = require('../config/db');
const { getBaseCurrency } = require('./zohoChartOfAccountsService');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Half away from zero — an accounting rounding, so a credit note's -383.125
// lands on -383.13 rather than JS's -383.12.
const round2 = (n) => {
  const v = num(n);
  return (v < 0 ? -1 : 1) * Math.round(Math.abs(v) * 100) / 100;
};

// Exports and SEZ supplies are taxed at zero rather than left untaxed, so they
// are their own line in 3.1 rather than part of the nil-rated one.
const ZERO_RATED = new Set(['overseas', 'sez', 'sez_developer', 'deemed_export']);
// Who the supply went to, for 3.2. Zoho's treatment codes.
const UNREGISTERED = new Set(['consumer', 'business_none']);
const COMPOSITION = new Set(['business_reg_comp']);

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
  if (from && to) return { from: String(from).slice(0, 10), to: String(to).slice(0, 10) };
  // Default window: the fiscal year containing today, for the per-platform
  // start month (Settings → params.fy_start_month; defaults to 4 = 1 April).
  const { fyWindow, fyMonth } = require('./reportContext');
  const _fy = fyWindow(fyMonth(params.fy_start_month));
  return { from: from || _fy.from, to: to || _fy.to };
}

const bucket = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });

/**
 * Add one document's worth of a single tax to a bucket, split into the levies
 * it is actually reported under and rounded levy by levy.
 */
function addTax(b, { taxName, taxType, pct, taxable }) {
  b.taxable = round2(b.taxable + taxable);
  if (!pct) return;
  if (String(taxType) === 'tax_group' && !/^IGST/i.test(taxName || '')) {
    const half = round2(taxable * (pct / 2) / 100);
    b.cgst = round2(b.cgst + half);
    b.sgst = round2(b.sgst + half);
  } else {
    b.igst = round2(b.igst + round2(taxable * pct / 100));
  }
}

/**
 * Where each bill's supply came from and went to, and whether its tax is
 * payable by us under reverse charge. Zoho puts all three on the document but
 * the warehouse does not persist them, so they are read back off the stored
 * bill detail response.
 */
async function billGstFacts(userId, orgId) {
  const map = new Map();
  try {
    const [rows] = await pool.execute(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(response_body, '$.bill.bill_id'))                 AS bill_id,
              JSON_UNQUOTE(JSON_EXTRACT(response_body, '$.bill.source_of_supply'))        AS src,
              JSON_UNQUOTE(JSON_EXTRACT(response_body, '$.bill.destination_of_supply'))   AS dst,
              JSON_UNQUOTE(JSON_EXTRACT(response_body, '$.bill.is_reverse_charge_applied')) AS rc
         FROM zb_raw_payloads
        WHERE user_id = ? AND org_id = ? AND endpoint LIKE '/bills/%'
          AND response_status = 200`,
      [userId, orgId]
    );
    for (const r of rows) {
      if (!r.bill_id) continue;
      map.set(String(r.bill_id), {
        interState: !!(r.src && r.dst && r.src !== r.dst),
        reverseCharge: r.rc === 'true' || r.rc === '1',
      });
    }
  } catch {
    // A malformed or missing payload log must not take the return down.
  }
  return map;
}

/**
 * Ledger-based GSTR-3B for Xero / QuickBooks.
 * Reads Output/Input CGST/SGST/IGST from account_transactions and builds
 * the same workbook sections as the Zoho path.
 */
// GSTR-3B is a document-level return: 3.1 reports the GST *charged on outward
// supplies* raised in the period and 4 the GST *paid on inward supplies*. The
// synced ledger only carries the Output/Input CGST-SGST-IGST control accounts,
// whose balances are also moved by GST payments to the government, ITC set-offs
// and reclassification journals. So we take the gross posting from sales-origin
// rows for 3.1 and from purchase-origin rows for 4, and only fall back to the
// journal / net movement for a levy that a platform booked entirely through
// journals (which some Xero tenants do). A levy answered by that fallback marks
// the whole workbook `approximated` so the viewer can say the figures may not
// tie to the platform's own return.
const OUT_LIKE = "(LOWER(account_name) LIKE 'output cgst%' OR LOWER(account_name) LIKE 'output sgst%' OR LOWER(account_name) LIKE 'output igst%')";
const IN_LIKE = "(LOWER(account_name) LIKE 'input cgst%' OR LOWER(account_name) LIKE 'input sgst%' OR LOWER(account_name) LIKE 'input igst%')";
const LEVY_OF = "CASE WHEN LOWER(account_name) LIKE '%cgst%' THEN 'cgst' WHEN LOWER(account_name) LIKE '%sgst%' THEN 'sgst' ELSE 'igst' END";
// Provider labels for the same document kinds — QuickBooks / Xero / Zoho.
const SALES_TYPES = "('Invoice','ACCREC','invoice','ACCRECCREDIT','Credit Note','Credit Memo','credit_note','creditnote')";
const BILL_TYPES = "('Bill','ACCPAY','bill','ACCPAYCREDIT','Vendor Credit','Bill Credit','vendor_credit','Debit Note')";
const JRNL_TYPES = "('ManualJournal','Manual Journal','journal','Journal Entry','JournalEntry')";

async function buildLedgerGstReturns(userId, orgId, from, to, platform) {
  const [outputRows] = await pool.execute(
    `SELECT ${LEVY_OF} AS levy,
            ROUND(SUM(CASE WHEN transaction_type IN ${SALES_TYPES} THEN credit - debit ELSE 0 END), 2) AS origin_tax,
            ROUND(SUM(CASE WHEN transaction_type IN ${JRNL_TYPES}  THEN credit - debit ELSE 0 END), 2) AS jrnl_tax,
            ROUND(SUM(credit - debit), 2) AS net_tax
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND ${OUT_LIKE}
        AND transaction_date BETWEEN ? AND ?
        AND transaction_id NOT LIKE 'xero-recon:%'
      GROUP BY levy`,
    [userId, orgId, from, to]
  );

  const [inputRows] = await pool.execute(
    `SELECT ${LEVY_OF} AS levy,
            ROUND(SUM(CASE WHEN transaction_type IN ${BILL_TYPES} THEN debit - credit ELSE 0 END), 2) AS origin_tax,
            ROUND(SUM(CASE WHEN transaction_type IN ${JRNL_TYPES} THEN debit ELSE 0 END), 2) AS jrnl_tax,
            ROUND(SUM(debit - credit), 2) AS net_tax
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND ${IN_LIKE}
        AND transaction_date BETWEEN ? AND ?
        AND transaction_id NOT LIKE 'xero-recon:%'
      GROUP BY levy`,
    [userId, orgId, from, to]
  );

  let approximated = false;
  const pick = (r) => {
    if (Math.abs(num(r.origin_tax)) > 0.005) return round2(Math.max(0, num(r.origin_tax)));
    const j = Math.abs(num(r.jrnl_tax)) > 0.005 ? num(r.jrnl_tax) : num(r.net_tax);
    if (Math.abs(j) > 0.005) approximated = true;
    return round2(Math.max(0, j));
  };
  const output = {};
  for (const r of outputRows) if (r.levy) output[r.levy] = pick(r);
  const input = {};
  for (const r of inputRows) if (r.levy) input[r.levy] = pick(r);

  const currency = await getBaseCurrency(orgId);

  const sections = [
    {
      no: '3.1',
      title: 'Details of Outward Supplies and inward supplies liable to reverse charge',
      tint: 'blue',
      columns: ['Nature of Supply', 'Taxable Value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'],
      rows: [
        { cells: ['(a) Outward taxable supplies (other than zero rated, nil rated and exempted)', null, output.igst || null, output.cgst || null, output.sgst || null, null] },
        { cells: ['(b) Outward taxable supplies (zero rated)', null, null, null, null, null] },
        { cells: ['(c) Other outward supplies (Nil rated, exempted)', null, null, null, null, null] },
        { cells: ['(d) Inward supplies (liable to reverse charge)', null, null, null, null, null] },
        { cells: ['(e) Non-GST outward supplies', null, null, null, null, null] },
        { cells: ['Total Value', null, output.igst || null, output.cgst || null, output.sgst || null, null], bold: true },
      ],
    },
    {
      no: '3.1.1',
      title: 'Details of supplies notified under sub-section (5) of section 9',
      tint: 'blue',
      columns: ['Description', 'Taxable Value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'],
      rows: [
        { cells: ['(i) Taxable supplies on which e-commerce operator pays tax', 0, 0, 0, 0, 0] },
        { cells: ['(ii) Taxable supplies made through e-commerce operator', 0, null, null, null, null] },
      ],
    },
    {
      no: '3.2',
      title: 'Of the supplies shown in 3.1 (a) above, inter-State supplies to unregistered persons etc.',
      tint: 'blue',
      columns: ['', 'Place of Supply', 'Taxable Value', 'Integrated Tax'],
      rows: [
        { subhead: 'Supplies made to Unregistered Persons' },
        { cells: ['', '', null, null] },
        { subhead: 'Supplies made to Composition Taxable Persons' },
        { cells: ['', '', null, null] },
        { subhead: 'Supplies made to UIN holders' },
        { fullNote: 'Data not available from ledger' },
      ],
    },
    {
      no: '4',
      title: 'Eligible ITC',
      tint: 'orange',
      columns: ['Details', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'],
      rows: [
        { subhead: '(A) ITC Available (whether in full or part)' },
        { cells: ['(1) Import of Goods', 0, null, null, 0] },
        { cells: ['(2) Import of Services', 0, null, null, 0] },
        { cells: ['(3) Inward supplies liable to reverse charge', null, null, null, null] },
        { label: '(4) Inward supplies from ISD', spanNote: '- - -Not applicable- - -' },
        { cells: ['(5) All other ITC', input.igst || null, input.cgst || null, input.sgst || null, null] },
      ],
    },
    {
      no: '5',
      title: 'Values of exempt, nil-rated and non-GST inward supplies',
      tint: 'orange',
      columns: ['Nature of Supply', 'Inter-State Supplies', 'Intra-State Supplies'],
      rows: [
        { cells: ['Composition Scheme, Exempted, Nil Rated', null, null] },
        { cells: ['Non-GST supply', 0, 0] },
      ],
    },
  ];

  return {
    workbook: true,
    title: 'GSTR-3B Summary',
    sections,
    currency,
    meta: {
      title: 'GSTR-3B Summary',
      from,
      to,
      source: 'ledger',
      platform,
      approximated,
      ...(approximated
        ? { note: `${platform === 'xero' ? 'Xero' : 'QuickBooks'} did not sync GST at the invoice/bill line level for every levy — those figures are reconstructed from journal postings on the tax control accounts and may not tie to the platform's own GSTR-3B.` }
        : {}),
    },
  };
}

async function buildGstReturnsWorkbook(userId, params = {}) {
  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const { from, to } = resolveRange(params);
  const args = [userId, orgId, from, to];

  // For Xero / QuickBooks — reconstruct GSTR-3B from the shared ledger
  // (account_transactions) instead of Zoho-specific warehouse tables.
  if (params.platform === 'xero' || params.platform === 'quickbooks') {
    return buildLedgerGstReturns(userId, orgId, from, to, params.platform);
  }

  // Outward supplies — one row per document per tax, so each levy can be
  // rounded the way it was charged.
  const [invoiceDocs] = await pool.execute(
    `SELECT li.tax_name, li.tax_type, MAX(li.tax_percentage) AS pct,
            SUM(li.item_total) AS taxable,
            i.gst_treatment AS treatment, i.place_of_supply AS pos
       FROM zb_invoice_line_items li
       JOIN invoices i
         ON i.zoho_id = li.zoho_invoice_id AND i.org_id = li.org_id AND i.user_id = li.user_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND COALESCE(i.is_deleted, 0) = 0
        AND i.status NOT IN ('draft', 'void')
        AND i.date BETWEEN ? AND ?
      GROUP BY li.zoho_invoice_id, li.tax_name, li.tax_type, i.gst_treatment, i.place_of_supply`,
    args
  );

  const [creditDocs] = await pool.execute(
    `SELECT li.tax_name, li.tax_type, MAX(li.tax_percentage) AS pct,
            -SUM(li.item_total) AS taxable,
            c.gst_treatment AS treatment, c.place_of_supply AS pos
       FROM zb_credit_note_line_items li
       JOIN zb_credit_notes c
         ON c.zoho_creditnote_id = li.zoho_creditnote_id
        AND c.org_id = li.org_id AND c.user_id = li.user_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND LOWER(COALESCE(c.status, '')) NOT IN ('draft', 'void')
        AND c.date BETWEEN ? AND ?
      GROUP BY li.zoho_creditnote_id, li.tax_name, li.tax_type, c.gst_treatment, c.place_of_supply`,
    args
  );

  // Inward supplies — the ITC side.
  const [billDocs] = await pool.execute(
    `SELECT li.zoho_bill_id AS doc_id, li.tax_name, li.tax_type,
            MAX(li.tax_percentage) AS pct, SUM(li.item_total) AS taxable
       FROM zb_bill_line_items li
       JOIN bills b
         ON b.zoho_id = li.zoho_bill_id AND b.org_id = li.org_id AND b.user_id = li.user_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND COALESCE(b.is_deleted, 0) = 0
        AND b.date BETWEEN ? AND ?
      GROUP BY li.zoho_bill_id, li.tax_name, li.tax_type`,
    args
  );

  const facts = await billGstFacts(userId, orgId);
  const currency = await getBaseCurrency(orgId);

  // ── 3.1 outward ───────────────────────────────────────────────────────────
  const taxed = bucket();      // (a)
  const zeroRated = bucket();  // (b)
  const nilRated = bucket();   // (c)
  const reverse = bucket();    // (d)
  const nonGst = bucket();     // (e) — nothing in Zoho marks a supply non-GST

  // 3.2 — inter-state supplies to those who cannot claim the credit.
  const toUnregistered = new Map();
  const toComposition = new Map();

  for (const d of [...invoiceDocs, ...creditDocs]) {
    const tax = { taxName: d.tax_name, taxType: d.tax_type, pct: num(d.pct), taxable: num(d.taxable) };
    if (ZERO_RATED.has(String(d.treatment))) addTax(zeroRated, tax);
    else if (tax.pct > 0) addTax(taxed, tax);
    else addTax(nilRated, tax);

    if (!/^IGST/i.test(d.tax_name || '') || !tax.pct) continue;
    const pool_ = UNREGISTERED.has(String(d.treatment)) ? toUnregistered
      : COMPOSITION.has(String(d.treatment)) ? toComposition
        : null;
    if (!pool_) continue;
    const pos = d.pos || '';
    if (!pool_.has(pos)) pool_.set(pos, bucket());
    addTax(pool_.get(pos), tax);
  }

  // ── 4 eligible ITC ────────────────────────────────────────────────────────
  const otherItc = bucket();
  for (const d of billDocs) {
    const tax = { taxName: d.tax_name, taxType: d.tax_type, pct: num(d.pct), taxable: num(d.taxable) };
    const f = facts.get(String(d.doc_id));
    if (f?.reverseCharge) addTax(reverse, tax);
    else if (tax.pct > 0) addTax(otherItc, tax);
  }

  // ── 5 exempt / nil-rated inward ───────────────────────────────────────────
  const exemptInward = { inter: 0, intra: 0 };
  for (const d of billDocs) {
    if (num(d.pct) > 0) continue;
    const f = facts.get(String(d.doc_id));
    // A reverse-charge purchase carries no tax from the supplier but is not
    // exempt — it is already declared in 3.1(d).
    if (f?.reverseCharge) continue;
    const side = f?.interState ? 'inter' : 'intra';
    exemptInward[side] = round2(exemptInward[side] + num(d.taxable));
  }

  const sum = (key) => round2([taxed, zeroRated, nilRated, reverse, nonGst].reduce((a, b) => a + b[key], 0));

  // 3.2 renders one row per place of supply, and Zoho leaves a blank row under
  // a heading with nothing to report rather than dropping the heading.
  const posRows = (m) => (m.size
    ? [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([pos, b]) => ({ cells: ['', pos, b.taxable, b.igst] }))
    : [{ cells: ['', '', null, null] }]);

  const sections = [
    {
      no: '3.1',
      title: 'Details of Outward Supplies and inward supplies liable to reverse charge',
      tint: 'blue',
      columns: ['Nature of Supply', 'Taxable Value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'],
      rows: [
        { cells: ['(a) Outward taxable supplies (other than zero rated, nil rated and exempted)', taxed.taxable, taxed.igst, taxed.cgst, taxed.sgst, taxed.cess] },
        { cells: ['(b) Outward taxable supplies (zero rated)', zeroRated.taxable, zeroRated.igst, null, null, zeroRated.cess] },
        { cells: ['(c) Other outward supplies (Nil rated, exempted)', nilRated.taxable, null, null, null, null] },
        { cells: ['(d) Inward supplies (liable to reverse charge)', reverse.taxable, reverse.igst, reverse.cgst, reverse.sgst, reverse.cess] },
        { cells: ['(e) Non-GST outward supplies', nonGst.taxable, null, null, null, null] },
        { cells: ['Total Value', sum('taxable'), sum('igst'), sum('cgst'), sum('sgst'), sum('cess')], bold: true },
      ],
    },
    {
      // Zoho Books does not record electronic-commerce-operator supplies, and
      // prints this section as filed: nothing to declare on either side.
      no: '3.1.1',
      title: 'Details of supplies notified under sub-section (5) of section 9 of the Central Goods and Services Tax Act',
      tint: 'blue',
      columns: ['Description', 'Taxable Value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'],
      rows: [
        { cells: ['(i) Taxable supplies on which electronic commerce operator pays tax under Sub-section (5) of Section 9 [To be furnished by the electronic commerce operator]', '0', '0', '0', '0', '0'] },
        { cells: ['(ii) Taxable supplies made by the registered person through electronic commerce operator, on which electronic commerce operator is required to pay tax under Sub-section (5) of Section 9 [To be furnished by the registered person making supplies through electronic commerce operator]', 0, null, null, null, null] },
      ],
    },
    {
      no: '3.2',
      title: 'Of the supplies shown in 3.1 (a) above, details of inter-State supplies made to unregistered persons, composition taxable persons and UIN holders',
      tint: 'blue',
      columns: ['', 'Place of Supply', 'Taxable Value', 'Integrated Tax'],
      rows: [
        { subhead: 'Supplies made to Unregistered Persons' },
        ...posRows(toUnregistered),
        { subhead: 'Supplies made to Composition Taxable Persons' },
        ...posRows(toComposition),
        { subhead: 'Supplies made to UIN holders' },
        { fullNote: 'We are not tracking supplies made to UIN holders' },
      ],
    },
    {
      no: '4',
      title: 'Eligible ITC',
      tint: 'orange',
      columns: ['Details', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'],
      rows: [
        { subhead: '(A) ITC Available (whether in full or part)' },
        { cells: ['(1) Import of Goods', 0, null, null, 0] },
        { cells: ['(2) Import of Services', 0, null, null, 0] },
        { cells: ['(3) Inward supplies liable to reverse charge ( other than 1 & 2 above)', reverse.igst, reverse.cgst, reverse.sgst, reverse.cess] },
        { label: '(4) Inward supplies from ISD', spanNote: '- - -We do not support in Zoho Books- - -' },
        { cells: ['(5) All other ITC', otherItc.igst, otherItc.cgst, otherItc.sgst, otherItc.cess] },
      ],
    },
    {
      no: '5',
      title: 'Values of exempt, nil-rated and non-GST inward supplies',
      tint: 'orange',
      columns: ['Nature of Supply', 'Inter-State Supplies', 'Intra-State Supplies'],
      rows: [
        { cells: ['Composition Scheme, Exempted, Nil Rated', exemptInward.inter, exemptInward.intra] },
        { cells: ['Non-GST supply', 0, 0] },
      ],
    },
  ];

  return {
    workbook: true,
    title: 'GSTR-3B Summary',
    sections,
    currency,
    meta: { title: 'GSTR-3B Summary', from, to, source: 'warehouse' },
  };
}

module.exports = { buildGstReturnsWorkbook };
