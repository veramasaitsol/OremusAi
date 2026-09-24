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

// India GST slab used to reconstruct a reverse-charge bill's taxable value
// from its self-assessed tax amount (the bill's own line never carries a
// rate — see the RCM reconstruction below). CGST/SGST are half of the 18%
// slab, IGST the whole — the same assumption zohoTaxLiabilityService.js uses
// and discloses via meta.taxRateAssumed.
const GST_SLAB_RATE = { CGST: 9, SGST: 9, IGST: 18 };

async function getOrgId(userId) {
  const [[zb]] = await pool.execute('SELECT org_id FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1', [userId]);
  if (zb?.org_id) return zb.org_id;
  const [[xero]] = await pool.execute('SELECT tenant_id FROM xero_tokens WHERE user_id = ? LIMIT 1', [userId]);
  if (xero?.tenant_id) return xero.tenant_id;
  const [[qbo]] = await pool.execute('SELECT realm_id FROM qbo_tokens WHERE user_id = ? LIMIT 1', [userId]);
  if (qbo?.realm_id) return qbo.realm_id;
  return null;
}

// The org's own GST home-state code (first 2 digits of its GSTIN), used as the
// "destination" side of Section 5's inter/intra-state test whenever a bill's
// own destination_of_supply is missing — see the classification in Section 5
// below. Falls back to any invoice/bill that does carry one, then a default.
async function getOrgGstState(userId, orgId) {
  try {
    const [[inv]] = await pool.execute(
      `SELECT COALESCE(destination_of_supply, place_of_supply) AS pos
         FROM invoices
        WHERE user_id = ? AND org_id = ? AND (destination_of_supply IS NOT NULL OR place_of_supply IS NOT NULL)
        LIMIT 1`,
      [userId, orgId]
    ).catch(() => [[]]);
    if (inv?.pos) return String(inv.pos).trim().slice(0, 2);

    const [[b]] = await pool.execute(
      `SELECT destination_of_supply AS dst FROM bills
        WHERE user_id = ? AND org_id = ? AND destination_of_supply IS NOT NULL
        LIMIT 1`,
      [userId, orgId]
    ).catch(() => [[]]);
    if (b?.dst) return String(b.dst).trim().slice(0, 2);

    return '36'; // Default Telangana code
  } catch {
    return '36';
  }
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

const bucket = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, breakdown: [] });

/**
 * Add one document's worth of a single tax to a bucket, split into the levies
 * it is actually reported under and rounded levy by levy. When `doc` is given
 * (the document's own name/ref/date/type), also records a breakdown entry
 * carrying that one document's contribution to every column of the bucket —
 * this is what lets the viewer answer "how was this figure calculated" by
 * listing the exact invoices/bills/credit notes that sum into it.
 */
function addTax(b, { taxName, taxType, pct, taxable }, doc) {
  const taxableR = round2(taxable);
  b.taxable = round2(b.taxable + taxableR);
  let igstAdd = 0;
  let cgstAdd = 0;
  let sgstAdd = 0;
  if (pct) {
    if (String(taxType) === 'tax_group' && !/^IGST/i.test(taxName || '')) {
      const half = round2(taxable * (pct / 2) / 100);
      cgstAdd = half;
      sgstAdd = half;
      b.cgst = round2(b.cgst + half);
      b.sgst = round2(b.sgst + half);
    } else {
      igstAdd = round2(taxable * pct / 100);
      b.igst = round2(b.igst + igstAdd);
    }
  }
  if (doc) {
    b.breakdown.push({
      name: doc.name || null,
      ref: doc.ref || null,
      date: doc.date || null,
      type: doc.type || null,
      taxable: taxableR,
      igst: igstAdd,
      cgst: cgstAdd,
      sgst: sgstAdd,
      cess: 0,
    });
  }
}

// One row's `cellBreakdown` — a bucket's `breakdown` entries reshaped per
// numeric column so each cell's drill-down shows exactly the figure that
// cell displays (clicking "Central Tax" lists CGST contributions, not the
// taxable value). `fields` is parallel to the row's numeric cells: the bucket
// field each column reads from, or null for a column this bucket never fills.
function cellBreakdown(b, fields) {
  if (!b?.breakdown?.length) return fields.map(() => null);
  return fields.map((f) => {
    if (!f) return null;
    const entries = b.breakdown
      .filter((e) => Math.abs(e[f]) > 0.004)
      .map((e) => ({ name: e.name, ref: e.ref, date: e.date, type: e.type, amount: e[f] }));
    return entries.length ? entries : null;
  });
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
              JSON_UNQUOTE(JSON_EXTRACT(response_body, '$.bill.place_of_supply'))         AS pos,
              JSON_UNQUOTE(JSON_EXTRACT(response_body, '$.bill.billing_address.state_code')) AS state_code,
              JSON_UNQUOTE(JSON_EXTRACT(response_body, '$.bill.is_reverse_charge_applied')) AS rc
         FROM zb_raw_payloads
        WHERE user_id = ? AND org_id = ? AND endpoint LIKE '/bills/%'
          AND response_status = 200`,
      [userId, orgId]
    );
    for (const r of rows) {
      if (!r.bill_id) continue;
      const src = r.src && String(r.src).trim() ? String(r.src).trim() : null;
      const dst = r.dst && String(r.dst).trim() ? String(r.dst).trim() : null;
      const pos = r.pos && String(r.pos).trim() ? String(r.pos).trim() : null;
      const stateCode = r.state_code && String(r.state_code).trim() ? String(r.state_code).trim() : null;
      map.set(String(r.bill_id), {
        interState: !!(src && dst && src !== dst),
        reverseCharge: r.rc === 'true' || r.rc === '1',
        src,
        dst,
        pos,
        stateCode,
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

  // Per-posting breakdown — the individual ledger lines that sum into each
  // Output/Input CGST/SGST/IGST figure above, so the viewer can show exactly
  // which invoices/bills/journals a levy is made of. `likeClause` mirrors
  // OUT_LIKE/IN_LIKE; `typesClause` restricts to the same document kinds
  // `pick()` actually used (falls back to every posting when a levy came from
  // the journal/net fallback, i.e. when `approximated` is set for it).
  async function levyBreakdown(likeClause, typesClause) {
    const [rows] = await pool.execute(
      `SELECT ${LEVY_OF} AS levy, transaction_number, reference_number, transaction_date,
              transaction_type, source_type, credit, debit,
              (transaction_type IN ${typesClause}) AS is_origin
         FROM account_transactions
        WHERE user_id = ? AND org_id = ? AND ${likeClause}
          AND transaction_date BETWEEN ? AND ?
          AND transaction_id NOT LIKE 'xero-recon:%'
        ORDER BY transaction_date`,
      [userId, orgId, from, to]
    );
    const byLevy = { cgst: [], sgst: [], igst: [] };
    for (const r of rows) {
      if (!r.levy || !byLevy[r.levy]) continue;
      byLevy[r.levy].push({ ...r, isOrigin: !!r.is_origin });
    }
    const out = {};
    // Match pick()'s own choice of source per levy: origin-typed postings
    // (invoices/bills) when there are any, every posting (journals included)
    // only when the levy was entirely journal-booked — so the breakdown
    // always sums to the same figure the cell shows.
    for (const levy of ['cgst', 'sgst', 'igst']) {
      const originOnly = byLevy[levy].filter((r) => r.isOrigin);
      const useRows = originOnly.length ? originOnly : byLevy[levy];
      out[levy] = useRows
        .map((r) => ({
          name: null,
          ref: r.reference_number || r.transaction_number || null,
          date: r.transaction_date ? String(r.transaction_date).slice(0, 10) : null,
          type: r.transaction_type || r.source_type || null,
          amount: round2(num(r.credit) - num(r.debit)),
        }))
        .filter((e) => Math.abs(e.amount) > 0.004);
    }
    return out;
  }
  const outputBreakdown = await levyBreakdown(OUT_LIKE, SALES_TYPES);
  const inputBreakdownRaw = await levyBreakdown(IN_LIKE, BILL_TYPES);
  // Input postings are debit-normal (ITC is a debit balance); levyBreakdown
  // above computed credit-debit like the output side, so flip the sign here
  // to match `input`'s own debit-credit convention.
  const inputBreakdown = {};
  for (const levy of ['cgst', 'sgst', 'igst']) {
    inputBreakdown[levy] = inputBreakdownRaw[levy].map((e) => ({ ...e, amount: round2(-e.amount) }));
  }

  const currency = await getBaseCurrency(orgId);

  const sections = [
    {
      no: '3.1',
      title: 'Details of Outward Supplies and inward supplies liable to reverse charge',
      tint: 'blue',
      columns: ['Nature of Supply', 'Taxable Value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'],
      rows: [
        {
          cells: ['(a) Outward taxable supplies (other than zero rated, nil rated and exempted)', null, output.igst || null, output.cgst || null, output.sgst || null, null],
          cellBreakdown: [null, null, outputBreakdown.igst.length ? outputBreakdown.igst : null, outputBreakdown.cgst.length ? outputBreakdown.cgst : null, outputBreakdown.sgst.length ? outputBreakdown.sgst : null, null],
        },
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
        {
          cells: ['(5) All other ITC', input.igst || null, input.cgst || null, input.sgst || null, null],
          cellBreakdown: [null, inputBreakdown.igst.length ? inputBreakdown.igst : null, inputBreakdown.cgst.length ? inputBreakdown.cgst : null, inputBreakdown.sgst.length ? inputBreakdown.sgst : null, null],
        },
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
  // rounded the way it was charged. name/ref/date are carried through purely
  // so each contributing document can be traced back from the workbook.
  const [invoiceDocs] = await pool.execute(
    `SELECT li.tax_name, li.tax_type, MAX(li.tax_percentage) AS pct,
            SUM(li.item_total) AS taxable,
            i.gst_treatment AS treatment, i.place_of_supply AS pos,
            i.invoice_number AS ref, i.customer_name AS name, i.date AS doc_date
       FROM zb_invoice_line_items li
       JOIN invoices i
         ON i.zoho_id = li.zoho_invoice_id AND i.org_id = li.org_id AND i.user_id = li.user_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND COALESCE(i.is_deleted, 0) = 0
        AND i.status NOT IN ('draft', 'void')
        AND i.date BETWEEN ? AND ?
      GROUP BY li.zoho_invoice_id, li.tax_name, li.tax_type, i.gst_treatment, i.place_of_supply,
               i.invoice_number, i.customer_name, i.date`,
    args
  );

  const [creditDocs] = await pool.execute(
    `SELECT li.tax_name, li.tax_type, MAX(li.tax_percentage) AS pct,
            -SUM(li.item_total) AS taxable,
            c.gst_treatment AS treatment, c.place_of_supply AS pos,
            c.creditnote_number AS ref, c.customer_name AS name, c.date AS doc_date
       FROM zb_credit_note_line_items li
       JOIN zb_credit_notes c
         ON c.zoho_creditnote_id = li.zoho_creditnote_id
        AND c.org_id = li.org_id AND c.user_id = li.user_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND LOWER(COALESCE(c.status, '')) NOT IN ('draft', 'void')
        AND c.date BETWEEN ? AND ?
      GROUP BY li.zoho_creditnote_id, li.tax_name, li.tax_type, c.gst_treatment, c.place_of_supply,
               c.creditnote_number, c.customer_name, c.date`,
    args
  );

  // Inward supplies — the ITC side. gst_treatment/gst_no/source_of_supply/
  // destination_of_supply/place_of_supply/billing_address_json/
  // is_reverse_charge_applied feed Section 5's exempt/non-GST classification
  // and inter- vs intra-state test below.
  const [billDocs] = await pool.execute(
    `SELECT li.zoho_bill_id AS doc_id, li.tax_name, li.tax_type,
            MAX(li.tax_percentage) AS pct, SUM(li.item_total) AS taxable,
            b.bill_number AS ref, b.vendor_name AS name, b.date AS doc_date,
            b.gst_treatment, b.gst_no, b.source_of_supply, b.destination_of_supply,
            b.place_of_supply, b.billing_address_json, b.is_reverse_charge_applied
       FROM zb_bill_line_items li
       JOIN bills b
         ON b.zoho_id = li.zoho_bill_id AND b.org_id = li.org_id AND b.user_id = li.user_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND COALESCE(b.is_deleted, 0) = 0
        AND b.date BETWEEN ? AND ?
      GROUP BY li.zoho_bill_id, li.tax_name, li.tax_type, b.bill_number, b.vendor_name, b.date,
               b.gst_treatment, b.gst_no, b.source_of_supply, b.destination_of_supply,
               b.place_of_supply, b.billing_address_json, b.is_reverse_charge_applied`,
    args
  );

  // A vendor credit is a negative purchase — it reduces the ITC claimed on the
  // bill(s) it offsets, the same way a credit note nets off an invoice's
  // outward tax. Left out, "All other ITC" is overstated by exactly the
  // vendor credit's own tax (confirmed against real data: 3 vendor-credit
  // lines at 18% tax_group overstated CGST/SGST by ₹10,777.37 each).
  const [vendorCreditDocs] = await pool.execute(
    `SELECT li.tax_name, li.tax_type, MAX(li.tax_percentage) AS pct,
            -SUM(li.item_total) AS taxable,
            vc.vendor_credit_number AS ref, vc.vendor_name AS name, vc.date AS doc_date
       FROM zb_vendor_credit_line_items li
       JOIN zb_vendor_credits vc
         ON vc.zoho_vendor_credit_id = li.zoho_vendor_credit_id
        AND vc.org_id = li.org_id AND vc.user_id = li.user_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND LOWER(COALESCE(vc.status, '')) NOT IN ('draft', 'void')
        AND vc.date BETWEEN ? AND ?
      GROUP BY li.zoho_vendor_credit_id, li.tax_name, li.tax_type,
               vc.vendor_credit_number, vc.vendor_name, vc.date`,
    args
  );

  const facts = await billGstFacts(userId, orgId);
  const orgGstState = await getOrgGstState(userId, orgId);
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

  for (const raw of [...invoiceDocs, ...creditDocs]) {
    const d = raw;
    const tax = { taxName: d.tax_name, taxType: d.tax_type, pct: num(d.pct), taxable: num(d.taxable) };
    const doc = {
      name: d.name,
      ref: d.ref,
      date: d.doc_date ? String(d.doc_date).slice(0, 10) : null,
      type: num(d.taxable) < 0 ? 'Credit Note' : 'Invoice',
    };
    if (ZERO_RATED.has(String(d.treatment))) addTax(zeroRated, tax, doc);
    else if (tax.pct > 0) addTax(taxed, tax, doc);
    else addTax(nilRated, tax, doc);

    if (!/^IGST/i.test(d.tax_name || '') || !tax.pct) continue;
    const pool_ = UNREGISTERED.has(String(d.treatment)) ? toUnregistered
      : COMPOSITION.has(String(d.treatment)) ? toComposition
        : null;
    if (!pool_) continue;
    const pos = d.pos || '';
    if (!pool_.has(pos)) pool_.set(pos, bucket());
    addTax(pool_.get(pos), tax, doc);
  }

  // ── 4 eligible ITC ────────────────────────────────────────────────────────
  const otherItc = bucket();
  for (const d of billDocs) {
    const tax = { taxName: d.tax_name, taxType: d.tax_type, pct: num(d.pct), taxable: num(d.taxable) };
    const f = facts.get(String(d.doc_id));
    const docDate = d.doc_date ? String(d.doc_date).slice(0, 10) : null;
    if (f?.reverseCharge) {
      // The bill's own line carries no tax fields for a reverse-charge
      // purchase (see the RCM reconstruction below), so only the taxable
      // value is known here — accumulate it without a breakdown entry; the
      // GL reconstruction below supplies the full entry (taxable + tax) once
      // the real per-levy amount is known.
      reverse.taxable = round2(reverse.taxable + tax.taxable);
    } else if (tax.pct > 0) {
      addTax(otherItc, tax, { name: d.name, ref: d.ref, date: docDate, type: 'Bill' });
    }
  }
  for (const d of vendorCreditDocs) {
    const tax = { taxName: d.tax_name, taxType: d.tax_type, pct: num(d.pct), taxable: num(d.taxable) };
    if (tax.pct > 0) {
      addTax(otherItc, tax, { name: d.name, ref: d.ref, date: d.doc_date ? String(d.doc_date).slice(0, 10) : null, type: 'Vendor Credit' });
    }
  }

  // Reverse-charge (self-assessed) bills carry no tax_id/tax_name/percentage on
  // their own line items — Zoho self-assesses the GST separately, posting it
  // straight to the Output CGST/SGST/IGST liability accounts (offset by a
  // "Reverse Charge Tax Input but not due" asset) rather than taxing the
  // bill's line — so `reverse.taxable` above is correct (from the bill's own
  // item_total) but igst/cgst/sgst are still zero. Reconstruct them off the
  // GL, the same way Tax Liability does (confirmed against real data: exactly
  // matches Zoho's own GSTR-3B — ₹63,385.25 to each of CGST/SGST). RCM tax is
  // fully creditable in the same period it's self-assessed, so the identical
  // amount also feeds section 4(3)'s ITC row via this same `reverse` bucket.
  // Grouped per bill (not just per account) so each contributing bill gets
  // its own breakdown entry rather than one lump ledger total.
  const [rcmTaxRows] = await pool.execute(
    `SELECT at.source_id, at.transaction_number, at.transaction_date, at.account_name,
            SUM(at.credit) - SUM(at.debit) AS amount,
            MAX(b.vendor_name) AS vendor_name, MAX(b.bill_number) AS bill_number
       FROM account_transactions at
       LEFT JOIN bills b ON b.zoho_id = at.source_id COLLATE utf8mb4_unicode_ci
        AND b.org_id COLLATE utf8mb4_unicode_ci = at.org_id AND b.user_id = at.user_id
      WHERE at.user_id = ? AND at.org_id = ?
        AND at.transaction_type = 'bill'
        AND (at.account_name LIKE 'Output CGST%' OR at.account_name LIKE 'Output SGST%' OR at.account_name LIKE 'Output IGST%')
        AND at.transaction_date BETWEEN ? AND ?
        AND at.transaction_id NOT LIKE 'xero-recon:%'
      GROUP BY at.source_id, at.transaction_number, at.transaction_date, at.account_name`,
    args
  );
  for (const r of rcmTaxRows) {
    const amount = round2(num(r.amount));
    if (!amount) continue;
    const n = String(r.account_name || '').toLowerCase();
    const levy = n.includes('cgst') ? 'cgst' : n.includes('sgst') ? 'sgst' : n.includes('igst') ? 'igst' : null;
    if (!levy) continue;
    reverse[levy] = round2(reverse[levy] + amount);
    const rate = GST_SLAB_RATE[levy.toUpperCase()];
    reverse.breakdown.push({
      name: r.vendor_name || null,
      ref: r.bill_number || r.transaction_number || r.source_id,
      date: r.transaction_date ? String(r.transaction_date).slice(0, 10) : null,
      type: 'Bill (Reverse Charge)',
      taxable: rate ? round2(amount / (rate / 100)) : 0,
      igst: levy === 'igst' ? amount : 0,
      cgst: levy === 'cgst' ? amount : 0,
      sgst: levy === 'sgst' ? amount : 0,
      cess: 0,
    });
  }

  // ── 5 exempt / nil-rated inward ───────────────────────────────────────────
  // A pct=0 bill line isn't automatically "exempt" — a registered vendor's
  // (business_gst) line can read pct=0 simply because no tax was ever applied
  // to it (a tax-control-account or customs-duty-account posting, say), not
  // because the purchase itself is GST-exempt. Dumping every zero-tax line
  // into Section 5 overstates it with these unrelated postings — the same
  // root cause traced against a live mismatch (₹74,700 / ₹5,198 / ₹78,288
  // wrongly appearing under Intra-State Supplies). Only a line explicitly
  // tagged exempt/nil/zero-rated, composition, unregistered, or non-GST goes
  // into Section 5; everything else (including an untagged business_gst line)
  // is out of scope for this section and is skipped.
  const exemptInward = { inter: 0, intra: 0, interBreakdown: [], intraBreakdown: [] };
  const nonGstInward = { inter: 0, intra: 0, interBreakdown: [], intraBreakdown: [] };
  for (const d of billDocs) {
    const taxable = num(d.taxable);
    if (taxable <= 0) continue;

    const pct = num(d.pct);
    const treatment = String(d.gst_treatment || '').toLowerCase().trim();
    const isRcm = Boolean(d.is_reverse_charge_applied || facts.get(String(d.doc_id))?.reverseCharge);

    // 1. Reverse charge belongs in 3.1(d)/4(3), not Section 5.
    if (isRcm) continue;

    // 2. Taxable purchases (>0%) belong in Section 4 ITC, not Section 5.
    if (pct > 0) continue;

    // 3. Overseas/imports belong in Section 4, not Section 5.
    if (treatment === 'overseas') continue;

    const taxName = String(d.tax_name || '').toLowerCase().trim();
    const isExplicitZeroTax = /gst0|zero|exempt|nil/i.test(taxName) || treatment === 'business_exempt';
    const isExplicitNonGst = taxName.includes('non-gst') || treatment === 'non_gst';
    const isComposition = treatment === 'business_composition' || treatment === 'business_reg_comp';
    const isUnregistered = ['business_none', 'consumer'].includes(treatment);

    // A registered vendor (business_gst) with no explicit zero-tax/non-GST tag
    // is just an unapplied/out-of-scope purchase, not a Section 5 supply.
    if (treatment === 'business_gst' && !isExplicitZeroTax && !isExplicitNonGst) continue;

    const isSec5Exempt = isComposition || isExplicitZeroTax || isUnregistered;
    if (!isSec5Exempt && !isExplicitNonGst) continue;

    // bills.source_of_supply / billing_address_json are often empty in the
    // warehouse — hydrate from the raw payload (billGstFacts) so the rules
    // below can fire.
    const f = facts.get(String(d.doc_id));
    let placeOfSupply = d.place_of_supply;
    let sourceOfSupply = d.source_of_supply;
    let destinationOfSupply = d.destination_of_supply;
    let billingAddressJson = d.billing_address_json;
    if (f) {
      if (!placeOfSupply && f.pos) placeOfSupply = f.pos;
      if (!sourceOfSupply && f.src) sourceOfSupply = f.src;
      if (!destinationOfSupply && f.dst) destinationOfSupply = f.dst;
      if (!billingAddressJson && f.stateCode) billingAddressJson = { state_code: f.stateCode };
    }

    // 4. Determine inter-State vs intra-State.
    let isInter = false;
    if (/igst/i.test(taxName)) {
      isInter = true;
    } else if (/cgst|sgst/i.test(taxName)) {
      isInter = false;
    } else if (placeOfSupply) {
      const pos = String(placeOfSupply).trim().slice(0, 2);
      const dst = String(destinationOfSupply || orgGstState || '36').trim().slice(0, 2);
      isInter = pos !== dst;
    } else if (sourceOfSupply) {
      const src = String(sourceOfSupply).trim().slice(0, 2);
      const dst = String(destinationOfSupply || orgGstState || '36').trim().slice(0, 2);
      isInter = src !== dst;
    } else if (billingAddressJson) {
      try {
        const addr = typeof billingAddressJson === 'string' ? JSON.parse(billingAddressJson) : billingAddressJson;
        if (addr && addr.state_code) {
          const src = String(addr.state_code).trim().slice(0, 2);
          const dst = String(destinationOfSupply || orgGstState || '36').trim().slice(0, 2);
          isInter = src !== dst;
        } else if (isUnregistered) {
          isInter = false;
        }
      } catch {
        isInter = false;
      }
    } else if (d.gst_no && String(d.gst_no).length >= 2) {
      const src = String(d.gst_no).trim().slice(0, 2);
      const dst = String(destinationOfSupply || orgGstState || '36').trim().slice(0, 2);
      isInter = src !== dst;
    } else if (isUnregistered) {
      isInter = false;
    }

    const side = isInter ? 'inter' : 'intra';
    const amount = round2(taxable);
    const entry = {
      name: d.name || null, ref: d.ref || null,
      date: d.doc_date ? String(d.doc_date).slice(0, 10) : null, type: 'Bill', amount,
    };
    if (isSec5Exempt) {
      exemptInward[side] = round2(exemptInward[side] + amount);
      exemptInward[`${side}Breakdown`].push(entry);
    } else if (isExplicitNonGst) {
      nonGstInward[side] = round2(nonGstInward[side] + amount);
      nonGstInward[`${side}Breakdown`].push(entry);
    }
  }

  const sum = (key) => round2([taxed, zeroRated, nilRated, reverse, nonGst].reduce((a, b) => a + b[key], 0));

  // 3.2 renders one row per place of supply, and Zoho leaves a blank row under
  // a heading with nothing to report rather than dropping the heading.
  const posRows = (m) => (m.size
    ? [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([pos, b]) => ({
        cells: ['', pos, b.taxable, b.igst],
        cellBreakdown: [null, null, ...cellBreakdown(b, ['taxable', 'igst'])],
      }))
    : [{ cells: ['', '', null, null] }]);

  const sections = [
    {
      no: '3.1',
      title: 'Details of Outward Supplies and inward supplies liable to reverse charge',
      tint: 'blue',
      columns: ['Nature of Supply', 'Taxable Value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'],
      rows: [
        {
          cells: ['(a) Outward taxable supplies (other than zero rated, nil rated and exempted)', taxed.taxable, taxed.igst, taxed.cgst, taxed.sgst, taxed.cess],
          cellBreakdown: [null, ...cellBreakdown(taxed, ['taxable', 'igst', 'cgst', 'sgst', 'cess'])],
        },
        {
          cells: ['(b) Outward taxable supplies (zero rated)', zeroRated.taxable, zeroRated.igst, null, null, zeroRated.cess],
          cellBreakdown: [null, ...cellBreakdown(zeroRated, ['taxable', 'igst', null, null, 'cess'])],
        },
        {
          cells: ['(c) Other outward supplies (Nil rated, exempted)', nilRated.taxable, null, null, null, null],
          cellBreakdown: [null, ...cellBreakdown(nilRated, ['taxable', null, null, null, null])],
        },
        {
          cells: ['(d) Inward supplies (liable to reverse charge)', reverse.taxable, reverse.igst, reverse.cgst, reverse.sgst, reverse.cess],
          cellBreakdown: [null, ...cellBreakdown(reverse, ['taxable', 'igst', 'cgst', 'sgst', 'cess'])],
        },
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
        {
          cells: ['(3) Inward supplies liable to reverse charge ( other than 1 & 2 above)', reverse.igst, reverse.cgst, reverse.sgst, reverse.cess],
          cellBreakdown: cellBreakdown(reverse, ['igst', 'cgst', 'sgst', 'cess']),
        },
        { label: '(4) Inward supplies from ISD', spanNote: '- - -We do not support in Zoho Books- - -' },
        {
          cells: ['(5) All other ITC', otherItc.igst, otherItc.cgst, otherItc.sgst, otherItc.cess],
          cellBreakdown: cellBreakdown(otherItc, ['igst', 'cgst', 'sgst', 'cess']),
        },
      ],
    },
    {
      no: '5',
      title: 'Values of exempt, nil-rated and non-GST inward supplies',
      tint: 'orange',
      columns: ['Nature of Supply', 'Inter-State Supplies', 'Intra-State Supplies'],
      rows: [
        {
          cells: ['Composition Scheme, Exempted, Nil Rated', exemptInward.inter, exemptInward.intra],
          cellBreakdown: [
            null,
            exemptInward.interBreakdown.length ? exemptInward.interBreakdown : null,
            exemptInward.intraBreakdown.length ? exemptInward.intraBreakdown : null,
          ],
        },
        {
          cells: ['Non-GST supply', nonGstInward.inter, nonGstInward.intra],
          cellBreakdown: [
            null,
            nonGstInward.interBreakdown.length ? nonGstInward.interBreakdown : null,
            nonGstInward.intraBreakdown.length ? nonGstInward.intraBreakdown : null,
          ],
        },
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
