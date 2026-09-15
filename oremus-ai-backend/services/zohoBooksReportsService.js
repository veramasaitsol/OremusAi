'use strict';

/**
 * Zoho Books Reports service
 * ---------------------------------------------------------------
 * Pulls Zoho's /books/v3/reports/* endpoints, caches the response
 * in zb_report_cache (TTL 15 min by default), and transforms the
 * payload into the same { columns, rows, currency } shape the
 * frontend Zoho report viewer already expects.
 *
 * If a report type is unmapped (or unsupported by Zoho), the service
 * throws — the route returns 404 and the frontend falls back to its
 * existing mock generator (so unmapped catalog cards keep rendering).
 */

const crypto = require('crypto');
const axios  = require('axios');
const pool   = require('../config/db');
const { getValidToken } = require('./zohoService');

const API_BASE = process.env.ZOHO_API_BASE || 'https://www.zohoapis.in/books/v3';
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 min

// ─── helpers ──────────────────────────────────────────────────────────────

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

async function getOrgId(userId) {
  const [[row]] = await pool.execute(
    'SELECT org_id FROM zb_tokens WHERE user_id = ?',
    [userId]
  );
  return row?.org_id || null;
}

// Resolve the org's reporting currency (e.g. INR, USD).
// Reads from zb_organizations (populated by the warehouse sync); falls back
// to zb_oauth_organizations.currency_code, then to USD.
async function getOrgCurrency(userId, orgId) {
  try {
    const [[zb]] = await pool.execute(
      'SELECT currency_code FROM zb_organizations WHERE user_id = ? AND org_id = ? LIMIT 1',
      [userId, orgId]
    );
    if (zb?.currency_code) return zb.currency_code;
  } catch (_) {}
  try {
    const [[zo]] = await pool.execute(
      'SELECT currency_code FROM zb_oauth_organizations WHERE user_id = ? AND org_id = ? LIMIT 1',
      [userId, orgId]
    );
    if (zo?.currency_code) return zo.currency_code;
  } catch (_) {}
  return 'USD';
}

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// ─── cache read/write ─────────────────────────────────────────────────────

async function readCache(userId, orgId, reportType, paramsHash) {
  const [rows] = await pool.execute(
    `SELECT id, body, transformed, expires_at, fetched_at, status_code
       FROM zb_report_cache
      WHERE user_id = ? AND org_id = ? AND report_type = ? AND params_hash = ?
      LIMIT 1`,
    [userId, orgId, reportType, paramsHash]
  );
  return rows[0] || null;
}

async function writeCache(userId, orgId, reportType, paramsHash, paramsJson, endpoint, statusCode, body, transformed, ttlMs) {
  const expiresAt = new Date(Date.now() + ttlMs);
  const bodyStr        = body        == null ? null : JSON.stringify(body);
  const transformedStr = transformed == null ? null : JSON.stringify(transformed);
  await pool.execute(
    `INSERT INTO zb_report_cache
       (user_id, org_id, report_type, params_hash, params_json, zoho_endpoint, status_code, body, transformed, fetched_at, expires_at)
     VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
     ON DUPLICATE KEY UPDATE
       params_json   = VALUES(params_json),
       zoho_endpoint = VALUES(zoho_endpoint),
       status_code   = VALUES(status_code),
       body          = VALUES(body),
       transformed   = VALUES(transformed),
       fetched_at    = CURRENT_TIMESTAMP,
       expires_at    = VALUES(expires_at)`,
    [
      userId, orgId, reportType, paramsHash,
      JSON.stringify(paramsJson || {}),
      endpoint, statusCode, bodyStr, transformedStr, expiresAt,
    ]
  );
}

// ─── transformers ─────────────────────────────────────────────────────────
// Each transformer takes Zoho's JSON `body` and the resolved `params`,
// and returns { columns, rows, currency, meta }.
//
// columns: [{ key, label, align }]
// rows:    [{ label, cells: {key: value}, level?, isSubtotal?, isTotal? }]

function pickCurrency(body) {
  // Zoho /reports/* responses don't expose currency at the top-level.
  // fetchReport() injects body._currency from the org metadata before transforming.
  return body?._currency || body?.currency_code || body?.organization?.currency_code || body?.report?.currency || 'USD';
}

// Generic walker for Zoho's recursive section structure (PL, BS, Cash Flow).
// Matches Zoho's UI layout: section header WITHOUT amount on its row, then
// children indented, then "Total for {name}" subtotal row with the amount.
// Leaf accounts emit a single row with the amount.
function flattenZohoSections(nodes, level, out) {
  if (!Array.isArray(nodes)) return;
  nodes.forEach((node) => {
    if (!node || typeof node !== 'object') return;
    const name  = node.name || node.section_name || node.account_group || node.account_name;
    const total = num(node.total ?? node.section_total ?? node.amount ?? node.balance ?? 0);
    const hasChildren = Array.isArray(node.account_transactions) && node.account_transactions.length > 0;

    if (!name && !hasChildren) return;

    if (hasChildren) {
      // Section header row (no amount → cleaner table, like Zoho UI)
      if (name) {
        out.push({
          label: name,
          cells: { amount: null },
          level,
          isHeader: true,
        });
      }
      flattenZohoSections(node.account_transactions, level + (name ? 1 : 0), out);
      // "Total for X" footer row at the bottom of the section
      if (name) {
        out.push({
          label: `Total for ${name}`,
          cells: { amount: total },
          level,
          isSubtotal: true,
        });
      }
    } else if (name) {
      // Leaf account
      out.push({
        label: name,
        cells: { amount: total },
        level,
      });
    }
  });
}

// Zoho nests Operating Income + Cost of Goods Sold *inside* a "Gross Profit"
// container (and Gross Profit + Operating Expense inside "Operating Profit", and
// so on up to "Net Profit/Loss"). Zoho's UI does NOT print these containers as
// top headers — it prints their children first, then the profit figure as a
// single summary line underneath. This walker reproduces that: profit-container
// nodes are unwrapped (children rendered at the container's own level) and the
// profit total is appended afterwards as an emphasised row.
const PROFIT_LINE = /^(gross profit|operating profit|net profit|net loss|net profit\/loss|net profit or loss)$/i;

function flattenPL(nodes, level, out) {
  if (!Array.isArray(nodes)) return;
  nodes.forEach((node) => {
    if (!node || typeof node !== 'object') return;
    const name  = node.name || node.section_name || node.account_group || node.account_name;
    const total = num(node.total ?? node.section_total ?? node.amount ?? node.balance ?? 0);
    const children = Array.isArray(node.account_transactions) ? node.account_transactions : [];
    const hasChildren = children.length > 0;
    if (!name && !hasChildren) return;

    const isProfit = PROFIT_LINE.test(String(name || '').trim());

    if (isProfit && hasChildren) {
      // Unwrap: render children at this level, then the profit summary line.
      flattenPL(children, level, out);
      out.push({
        label: name,
        cells: { amount: total },
        level,
        ...(/(net profit|net loss|net profit\/loss|net profit or loss)/i.test(name)
          ? { isTotal: true } : { isSubtotal: true }),
      });
    } else if (hasChildren) {
      if (name) out.push({ label: name, cells: { amount: null }, level, isHeader: true });
      flattenPL(children, level + (name ? 1 : 0), out);
      if (name) out.push({ label: `Total for ${name}`, cells: { amount: total }, level, isSubtotal: true });
    } else if (name) {
      // Leaf account (or a leaf-shaped profit line in some orgs).
      const row = { label: name, cells: { amount: total }, level };
      if (isProfit) {
        if (/(net profit|net loss|net profit\/loss|net profit or loss)/i.test(name)) row.isTotal = true;
        else row.isSubtotal = true;
      }
      out.push(row);
    }
  });
}

// ── Profit & Loss ──
function transformPL(body) {
  const currency = pickCurrency(body);
  const columns = [
    { key: 'label',  label: 'Account', align: 'left'  },
    { key: 'amount', label: 'Total',   align: 'right' },
  ];
  const rows = [];
  const pl = body?.profit_and_loss || body?.horizontal_profit_and_loss || body?.pnl || body?.report || body;

  if (Array.isArray(pl)) {
    flattenPL(pl, 0, rows);
  } else if (pl && typeof pl === 'object') {
    // Legacy/keyed shape — buckets like operating_income, etc.
    const buckets = [
      ['operating_income',       'Operating Income'],
      ['cost_of_goods_sold',     'Cost of Goods Sold'],
      ['gross_profit',           'Gross Profit'],
      ['operating_expense',      'Operating Expense'],
      ['operating_profit',       'Operating Profit'],
      ['non_operating_income',   'Non-Operating Income'],
      ['non_operating_expense',  'Non-Operating Expense'],
      ['net_profit_loss',        'Net Profit / Loss'],
      ['net_profit',             'Net Profit'],
    ];
    buckets.forEach(([key, label]) => {
      const node = pl[key];
      if (node == null) return;
      if (typeof node === 'object' && !Array.isArray(node)) {
        rows.push({ label, cells: { amount: num(node.total ?? node.amount ?? 0) }, isSubtotal: true });
        (node.account_transactions || []).forEach((acc) => {
          rows.push({
            label: acc.account_name || acc.name || '—',
            cells: { amount: num(acc.total ?? acc.amount ?? 0) },
            level: 1,
          });
        });
      } else {
        rows.push({ label, cells: { amount: num(node) }, isTotal: /net_profit/.test(key) });
      }
    });
  }

  return { columns, rows, currency };
}

// ── Balance Sheet ──
function transformBS(body) {
  const currency = pickCurrency(body);
  const columns = [
    { key: 'label',  label: 'Account', align: 'left'  },
    { key: 'amount', label: 'Total',   align: 'right' },
  ];
  const rows = [];
  const bs = body?.balance_sheet || body?.horizontal_balance_sheet || body?.report || body;
  if (Array.isArray(bs)) {
    flattenZohoSections(bs, 0, rows);
  } else if (bs && typeof bs === 'object') {
    // Try common keyed shape
    ['assets', 'liabilities', 'equity'].forEach((side) => {
      const node = bs[side];
      if (!node) return;
      if (Array.isArray(node)) flattenZohoSections(node, 0, rows);
      else if (typeof node === 'object') flattenZohoSections([node], 0, rows);
    });
  }
  return { columns, rows, currency };
}

// ── Trial Balance ──
// Zoho returns: { trialbalance: [{ account_transactions: [
//   { account_type: 'asset', account_transactions: [
//     { name, account_id, net_debit_total, net_credit_total }, ...
//   ] }, ... ] }] }
//
// We emit it Zoho-UI style:
//   • Per-section header (Assets / Liabilities / Equities / Income / Expense)
//   • Within each section, every account row (with its dr/cr)
//   • Per-section "Total for {section}" subtotal at the bottom
//   • Grand Total at the very bottom
function transformTB(body) {
  const currency = pickCurrency(body);
  const columns = [
    { key: 'label',  label: 'Account',    align: 'left'  },
    { key: 'debit',  label: 'Net Debit',  align: 'right' },
    { key: 'credit', label: 'Net Credit', align: 'right' },
  ];
  const rows = [];

  // Pretty section names (Zoho returns lowercase account_type).
  const SECTION_LABEL = {
    asset:     'Assets',
    liability: 'Liabilities',
    equity:    'Equities',
    income:    'Income',
    expense:   'Expense',
  };

  // The TB tree is: root[0].account_transactions = sections; each section.account_transactions = leaves.
  const tb = body?.trialbalance ?? body?.trial_balance ?? body?.report ?? body;
  const root = Array.isArray(tb) && tb[0] ? tb[0] : null;
  const sections = root?.account_transactions || [];

  let grandDebit = 0;
  let grandCredit = 0;

  sections.forEach((sec) => {
    const sectionType = (sec.account_type || sec.name || '').toLowerCase();
    const sectionLabel = SECTION_LABEL[sectionType] || sec.name || sectionType;
    const sectionAccounts = sec.account_transactions || [];

    // Filter: only emit accounts with non-zero debit OR credit (matches Zoho UI default).
    const nonZero = sectionAccounts.filter((a) => {
      const d = num(a.net_debit_total ?? a.debit_total ?? 0);
      const c = num(a.net_credit_total ?? a.credit_total ?? 0);
      return d !== 0 || c !== 0;
    });
    if (nonZero.length === 0) return;

    // Section header row
    rows.push({
      label: sectionLabel,
      cells: { debit: null, credit: null },
      level: 0,
      isHeader: true,
    });

    let sectionDebit = 0;
    let sectionCredit = 0;
    nonZero.forEach((a) => {
      const debit  = num(a.net_debit_total  ?? a.debit_total  ?? 0);
      const credit = num(a.net_credit_total ?? a.credit_total ?? 0);
      rows.push({
        label: a.name || a.account_name || '—',
        cells: { debit, credit },
        level: 1,
      });
      sectionDebit  += debit;
      sectionCredit += credit;
    });

    // Section subtotal
    rows.push({
      label: `Total for ${sectionLabel}`,
      cells: { debit: sectionDebit, credit: sectionCredit },
      level: 0,
      isSubtotal: true,
    });

    grandDebit  += sectionDebit;
    grandCredit += sectionCredit;
  });

  // Grand total
  rows.push({
    label: 'Total',
    cells: { debit: grandDebit, credit: grandCredit },
    isTotal: true,
  });

  return { columns, rows, currency };
}

// ── Cash Flow ──
// Cash Flow Statement — lay out exactly like Zoho Books' web report.
// Zoho's /reports/cashflow (with is_hierarchy_report=true) returns:
//   [ "Beginning Cash Balance" (leaf),
//     "Net Change in cash" { children: [ Operating, Investing, Financing ] },
//     "Ending Cash Balance" (leaf) ]
// where each activity section carries its subtotal in `total_label`
// ("Net cash provided by Operating Activities"). We render each activity as a
// "Cash Flow from … Activities" header → its accounts → the subtotal row, then
// emit "Net Change in cash" as a bottom summary and the Ending Cash Balance.
function cfNum(node) { return num(node.total ?? node.amount ?? node.balance ?? 0); }

// Render a non-section account node (leaf, or a nested account group).
function renderCFAccount(node, level, out) {
  if (!node || typeof node !== 'object') return;
  const name = node.name || node.total_label || node.account_name || '';
  const kids = Array.isArray(node.account_transactions) ? node.account_transactions : [];
  if (kids.length) {
    if (name) out.push({ label: name, cells: { amount: null }, level, isHeader: true });
    kids.forEach((c) => renderCFAccount(c, level + (name ? 1 : 0), out));
    if (name) out.push({ label: `Total for ${name}`, cells: { amount: cfNum(node) }, level, isSubtotal: true });
  } else if (name) {
    out.push({ label: name, cells: { amount: cfNum(node) }, level });
  }
}

// Render an activity section: header ("Cash Flow from … Activities") → accounts → subtotal.
function renderCFActivity(node, out) {
  const footerLabel = node.total_label || node.name || '';
  // Derive the section header Zoho prints at the top from the subtotal label.
  const headerLabel = footerLabel.replace(/^Net cash (?:provided by|used in) /i, 'Cash Flow from ');
  out.push({ label: headerLabel, cells: { amount: null }, level: 0, isHeader: true });
  (node.account_transactions || []).forEach((c) => renderCFAccount(c, 1, out));
  out.push({ label: footerLabel, cells: { amount: cfNum(node) }, level: 0, isSubtotal: true });
}

function transformCF(body) {
  const currency = pickCurrency(body);
  const columns = [
    { key: 'label',  label: 'Account', align: 'left'  },
    { key: 'amount', label: 'Total',   align: 'right' },
  ];
  const rows = [];
  const cf = body?.cash_flow || body?.report || body;
  const list = Array.isArray(cf) ? cf : (cf && typeof cf === 'object' ? [cf] : []);

  list.forEach((node) => {
    if (!node || typeof node !== 'object') return;
    const kids = Array.isArray(node.account_transactions) ? node.account_transactions : [];
    const label = node.total_label || node.name || '';
    if (!kids.length) {
      // Beginning / Ending Cash Balance — bold summary line.
      rows.push({ label, cells: { amount: cfNum(node) }, level: 0, isTotal: true });
      return;
    }
    // "Net Change in cash" wrapper → render the activity sections, then the
    // net-change summary line beneath them (matches Zoho's layout).
    kids.forEach((act) => renderCFActivity(act, rows));
    rows.push({ label, cells: { amount: cfNum(node) }, level: 0, isSubtotal: true });
  });

  return { columns, rows, currency };
}

// ── AR / AP Aging summary ──
// Zoho shape: { invoice|bills: { total, intervals:[{interval, amount}], group_list: [
//   { name, intervals[], group_list: [ {name, account_name, total, intervals[]} ] }
// ] } }
function transformAging(body, _params) {
  const currency = pickCurrency(body);
  const root = body?.invoice || body?.bills || body?.aging_summary || body?.report;
  const isAP = !!body?.bills;

  // Discover the bucket keys (Zoho returns interval keys like "days_1-15", "days_16-30", etc.)
  let intervalKeys = [];
  function findFirstIntervals(node) {
    if (!node || intervalKeys.length) return;
    if (Array.isArray(node.intervals) && node.intervals.length) {
      intervalKeys = node.intervals.map((iv) => ({
        key: String(iv.interval || iv.interval_formatted || ''),
        label: iv.interval_formatted || iv.interval || '',
      }));
      return;
    }
    (node.group_list || []).forEach(findFirstIntervals);
  }
  findFirstIntervals(root);

  const columns = [
    { key: 'label', label: isAP ? 'Vendor' : 'Customer', align: 'left' },
    ...intervalKeys.map((iv) => ({ key: iv.key, label: iv.label, align: 'right' })),
    { key: 'total', label: 'Total', align: 'right' },
  ];
  const rows = [];

  function cellsFor(node) {
    const cells = {};
    intervalKeys.forEach((iv) => { cells[iv.key] = 0; });
    (node.intervals || []).forEach((it) => {
      const k = String(it.interval || it.interval_formatted || '');
      cells[k] = num(it.amount ?? 0);
    });
    cells.total = num(node.total ?? 0);
    return cells;
  }

  // Walk the group tree and emit one row per leaf. An aging summary is grouped
  // by contact (customer / vendor). Zoho (v3 India) wraps the contacts in a
  // single top-level group whose own `name` is the placeholder "none"; each
  // child group is a contact whose name lives on `node.name` (with
  // entity="vendor"/"customer" and account_name=""). We therefore:
  //   - treat the literal "none"/empty as no name (so the wrapper never leaks),
  //   - prefer the leaf's own contact name over any inherited ancestor name,
  //   - still carry a real ancestor contact name down as a fallback in case a
  //     leaf only carries a GL account label.
  const clean = (v) => {
    const s = (v == null ? '' : String(v)).trim();
    return s && s.toLowerCase() !== 'none' ? s : null;
  };
  const contactOf = (n) =>
    clean(n.customer_name) || clean(n.vendor_name) || clean(n.contact_name) || clean(n.name);

  function walk(node, depth, inheritedName) {
    if (!node) return;
    const groups = node.group_list || [];
    if (groups.length === 0) {
      const label =
        clean(node.customer_name) ||
        clean(node.vendor_name) ||
        clean(node.contact_name) ||
        clean(node.name) ||
        inheritedName ||
        clean(node.account_name) ||
        '—';
      rows.push({ label, cells: cellsFor(node), level: depth });
      return;
    }
    const selfName = contactOf(node);
    groups.forEach((g) => walk(g, depth, selfName || inheritedName));
  }

  const topGroups = root?.group_list || [];
  if (topGroups.length) {
    topGroups.forEach((g) => walk(g, 0, null));
  } else if (root) {
    // No grouping — intervals sit directly on the root node.
    const label = root.customer_name || root.vendor_name || root.name || '—';
    rows.push({ label, cells: cellsFor(root), level: 0 });
  }

  // total row
  const tot = { total: 0 };
  intervalKeys.forEach((iv) => { tot[iv.key] = 0; });
  rows.forEach((r) => Object.keys(tot).forEach((k) => { tot[k] += r.cells[k] || 0; }));
  rows.push({ label: 'Total', cells: tot, isTotal: true });

  return { columns, rows, currency };
}

// ── Sales / Purchases by … ──
// Zoho `salesbycustomer`/`salesbyitem` response: { sales: [ { customer_name|item_name,
//   count, sales, sales_with_tax, ... } ] }
function transformGroupedAmount(label, body, opts) {
  opts = opts || {};
  const currency = pickCurrency(body);
  const columns = [
    { key: 'label',    label,                           align: 'left'  },
    { key: 'quantity', label: opts.quantityLabel || 'Quantity', align: 'right' },
    { key: 'amount',   label: `Amount (${currency})`,   align: 'right' },
  ];
  const rows = [];
  const list = body?.sales || body?.purchases || body?.report || [];
  const data = Array.isArray(list) ? list : [];
  data.forEach((r) => {
    rows.push({
      label: r.customer_name || r.vendor_name || r.item_name || r.salesperson_name || r.name || r.account_name || '—',
      cells: {
        quantity: num(r.quantity_sold ?? r.quantity ?? r.count ?? 0),
        amount:   num(r.sales_with_tax ?? r.sales ?? r.total ?? r.amount ?? r.purchase_amount ?? 0),
      },
    });
  });
  const totalAmount = rows.reduce((s, r) => s + (r.cells.amount   || 0), 0);
  const totalQty    = rows.reduce((s, r) => s + (r.cells.quantity || 0), 0);
  rows.push({ label: 'Total', cells: { quantity: totalQty, amount: totalAmount }, isTotal: true });
  return { columns, rows, currency };
}

const transformSalesByCustomer    = (body) => transformGroupedAmount('Customer',    body, { quantityLabel: 'Count' });
const transformSalesByItem        = (body) => transformGroupedAmount('Item',        body);
const transformSalesBySalesperson = (body) => transformGroupedAmount('Salesperson', body, { quantityLabel: 'Count' });
const transformPurchaseByVendor   = (body) => transformGroupedAmount('Vendor',      body, { quantityLabel: 'Count' });
const transformPurchaseByItem     = (body) => transformGroupedAmount('Item',        body);

// ── Customer / Vendor Balances ──
// Zoho `customerbalances`/`vendorbalances` returns an array of rows with
// fields: { customer_name|vendor_name, invoice_balance|bill_balance,
//   available_credits|excess_payment, fcy_balance, bcy_balance, credit_limit }
function transformBalances(body) {
  const currency = pickCurrency(body);
  const list = body?.customerbalances || body?.vendorbalances || body?.balances || body?.report || [];
  const isVendor = !!body?.vendorbalances;
  const columns = [
    { key: 'label',     label: isVendor ? 'Vendor' : 'Customer',         align: 'left'  },
    { key: 'invoice',   label: isVendor ? 'Bill Balance' : 'Invoice Balance', align: 'right' },
    { key: 'credits',   label: isVendor ? 'Excess Payment' : 'Available Credits', align: 'right' },
    { key: 'balance',   label: `Balance (${currency})`,                  align: 'right' },
  ];
  const rows = [];
  (Array.isArray(list) ? list : []).forEach((r) => {
    rows.push({
      label: r.customer_name || r.vendor_name || r.contact_name || '—',
      cells: {
        invoice: num(r.invoice_balance ?? r.bill_balance ?? 0),
        credits: num(r.available_credits ?? r.excess_payment ?? 0),
        balance: num(r.bcy_balance ?? r.fcy_balance ?? r.balance ?? 0),
      },
    });
  });
  const tot = { invoice: 0, credits: 0, balance: 0 };
  rows.forEach((r) => Object.keys(tot).forEach((k) => { tot[k] += r.cells[k] || 0; }));
  rows.push({ label: 'Total', cells: tot, isTotal: true });
  return { columns, rows, currency };
}

// ── Generic detail-list transformer ───────────────────────────────────────
// Builds a flat table with explicit columns from a Zoho detail-report payload.
// Used for invoicedetails, billdetails, creditnotedetails, vendorcreditdetails,
// purchaseorderdetails, estimatedetails, salesorderdetails, deliverychallandetails,
// recurringinvoicedetails, refundhistory.
function detailListTransform({ rootKeys, innerKey, columns, mapRow, totalsFor = [] }) {
  return (body) => {
    const currency = pickCurrency(body);
    let arr = [];
    for (const k of rootKeys) {
      const v = body?.[k];
      if (Array.isArray(v) && v.length) {
        // Some Zoho detail endpoints wrap data: [{ <innerKey>: [...] }]
        if (innerKey && v[0] && Array.isArray(v[0][innerKey])) {
          arr = v[0][innerKey];
        } else {
          arr = v;
        }
        break;
      }
      if (v && typeof v === 'object' && innerKey && Array.isArray(v[innerKey])) { arr = v[innerKey]; break; }
    }
    const rows = arr.map(mapRow);
    if (totalsFor.length) {
      const tot = {};
      totalsFor.forEach((k) => { tot[k] = rows.reduce((s, r) => s + (Number(r.cells?.[k]) || 0), 0); });
      rows.push({ label: 'Total', cells: tot, isTotal: true });
    }
    return { columns, rows, currency };
  };
}

const transformInvoiceDetails = detailListTransform({
  rootKeys: ['invoice_details'], innerKey: 'invoices',
  columns: [
    { key: 'date',          label: 'Date',        align: 'left'  },
    { key: 'invoice_number',label: 'Invoice #',   align: 'left'  },
    { key: 'label',         label: 'Customer',    align: 'left'  },
    { key: 'status',        label: 'Status',      align: 'left'  },
    { key: 'due_date',      label: 'Due Date',    align: 'left'  },
    { key: 'total',         label: 'Total',       align: 'right' },
    { key: 'balance',       label: 'Balance',     align: 'right' },
  ],
  mapRow: (r) => ({
    label: r.customer_name || '—',
    cells: {
      date: r.date || '', invoice_number: r.invoice_number || '',
      status: r.status || '', due_date: r.due_date || '',
      total: num(r.bcy_total ?? r.total ?? 0),
      balance: num(r.bcy_balance ?? r.balance ?? 0),
    },
  }),
  totalsFor: ['total', 'balance'],
});

const transformCreditNoteDetails = detailListTransform({
  rootKeys: ['creditnote_details'], innerKey: 'creditnotes',
  columns: [
    { key: 'date',              label: 'Date',           align: 'left'  },
    { key: 'creditnote_number', label: 'Credit Note #',  align: 'left'  },
    { key: 'label',             label: 'Customer',       align: 'left'  },
    { key: 'status',            label: 'Status',         align: 'left'  },
    { key: 'total',             label: 'Total',          align: 'right' },
    { key: 'balance',           label: 'Balance',        align: 'right' },
  ],
  mapRow: (r) => ({
    label: r.customer_name || '—',
    cells: {
      date: r.date || '', creditnote_number: r.creditnote_number || r.credit_note_number || '',
      status: r.status || '',
      total: num(r.bcy_total ?? r.total ?? 0),
      balance: num(r.bcy_balance ?? r.balance ?? 0),
    },
  }),
  totalsFor: ['total', 'balance'],
});

const transformBillDetails = detailListTransform({
  rootKeys: ['bill_details'], innerKey: 'bills',
  columns: [
    { key: 'date',        label: 'Date',     align: 'left'  },
    { key: 'bill_number', label: 'Bill #',   align: 'left'  },
    { key: 'label',       label: 'Vendor',   align: 'left'  },
    { key: 'status',      label: 'Status',   align: 'left'  },
    { key: 'due_date',    label: 'Due Date', align: 'left'  },
    { key: 'total',       label: 'Total',    align: 'right' },
    { key: 'balance',     label: 'Balance',  align: 'right' },
  ],
  mapRow: (r) => ({
    label: r.vendor_name || '—',
    cells: {
      date: r.date || '', bill_number: r.bill_number || '',
      status: r.status || '', due_date: r.due_date || '',
      total: num(r.bcy_total ?? r.total ?? 0),
      balance: num(r.bcy_balance ?? r.balance ?? 0),
    },
  }),
  totalsFor: ['total', 'balance'],
});

const transformVendorCreditDetails = detailListTransform({
  rootKeys: ['vendorcredit_details'], innerKey: 'vendor_credits',
  columns: [
    { key: 'date',              label: 'Date',           align: 'left'  },
    { key: 'vendorcredit_number',label: 'Vendor Credit #', align: 'left' },
    { key: 'label',             label: 'Vendor',         align: 'left'  },
    { key: 'status',            label: 'Status',         align: 'left'  },
    { key: 'total',             label: 'Total',          align: 'right' },
    { key: 'balance',           label: 'Balance',        align: 'right' },
  ],
  mapRow: (r) => ({
    label: r.vendor_name || '—',
    cells: {
      date: r.date || '', vendorcredit_number: r.vendor_credit_number || r.vendorcredit_number || '',
      status: r.status || '',
      total: num(r.bcy_total ?? r.total ?? 0),
      balance: num(r.bcy_balance ?? r.balance ?? 0),
    },
  }),
  totalsFor: ['total', 'balance'],
});

const transformPODetails = detailListTransform({
  rootKeys: ['purchaseorder_details'], innerKey: 'purchaseorders',
  columns: [
    { key: 'date',        label: 'Date',        align: 'left'  },
    { key: 'po_number',   label: 'PO #',        align: 'left'  },
    { key: 'label',       label: 'Vendor',      align: 'left'  },
    { key: 'status',      label: 'Status',      align: 'left'  },
    { key: 'total',       label: 'Total',       align: 'right' },
  ],
  mapRow: (r) => ({
    label: r.vendor_name || '—',
    cells: {
      date: r.date || '',
      po_number: r.purchaseorder_number || '',
      status: r.status || '',
      total: num(r.bcy_total ?? r.total ?? 0),
    },
  }),
  totalsFor: ['total'],
});

const transformSODetails = detailListTransform({
  rootKeys: ['salesorder_details'], innerKey: 'salesorders',
  columns: [
    { key: 'date',        label: 'Date',     align: 'left'  },
    { key: 'so_number',   label: 'SO #',     align: 'left'  },
    { key: 'label',       label: 'Customer', align: 'left'  },
    { key: 'status',      label: 'Status',   align: 'left'  },
    { key: 'total',       label: 'Total',    align: 'right' },
  ],
  mapRow: (r) => ({
    label: r.customer_name || '—',
    cells: {
      date: r.date || '',
      so_number: r.salesorder_number || '',
      status: r.status || '',
      total: num(r.bcy_total ?? r.total ?? 0),
    },
  }),
  totalsFor: ['total'],
});

const transformEstimateDetails = detailListTransform({
  rootKeys: ['estimate_details'], innerKey: 'estimates',
  columns: [
    { key: 'date',              label: 'Date',         align: 'left'  },
    { key: 'estimate_number',   label: 'Estimate #',   align: 'left'  },
    { key: 'label',             label: 'Customer',     align: 'left'  },
    { key: 'status',            label: 'Status',       align: 'left'  },
    { key: 'total',             label: 'Total',        align: 'right' },
  ],
  mapRow: (r) => ({
    label: r.customer_name || '—',
    cells: {
      date: r.date || '',
      estimate_number: r.estimate_number || '',
      status: r.status || '',
      total: num(r.bcy_total ?? r.total ?? 0),
    },
  }),
  totalsFor: ['total'],
});

const transformDCDetails = detailListTransform({
  rootKeys: ['delivery_challan_details'], innerKey: 'deliverychallans',
  columns: [
    { key: 'date',              label: 'Date',                 align: 'left'  },
    { key: 'dc_number',         label: 'Delivery Challan #',   align: 'left'  },
    { key: 'label',             label: 'Customer',             align: 'left'  },
    { key: 'status',            label: 'Status',               align: 'left'  },
    { key: 'total',             label: 'Total',                align: 'right' },
  ],
  mapRow: (r) => ({
    label: r.customer_name || '—',
    cells: {
      date: r.date || '',
      dc_number: r.deliverychallan_number || r.delivery_challan_number || '',
      status: r.status || '',
      total: num(r.bcy_total ?? r.total ?? 0),
    },
  }),
  totalsFor: ['total'],
});

const transformRecurringInvoiceDetails = detailListTransform({
  rootKeys: ['recurring_invoice_details'], innerKey: 'recurring_invoices',
  columns: [
    { key: 'label',          label: 'Customer',         align: 'left'  },
    { key: 'name',           label: 'Profile',          align: 'left'  },
    { key: 'frequency',      label: 'Frequency',        align: 'left'  },
    { key: 'start_date',     label: 'Start',            align: 'left'  },
    { key: 'next_date',      label: 'Next Invoice',     align: 'left'  },
    { key: 'status',         label: 'Status',           align: 'left'  },
    { key: 'amount',         label: 'Amount',           align: 'right' },
  ],
  mapRow: (r) => ({
    label: r.customer_name || '—',
    cells: {
      name: r.recurrence_name || r.profile_name || '',
      frequency: r.recurrence_frequency || '',
      start_date: r.start_date || '',
      next_date: r.next_invoice_date || '',
      status: r.status || '',
      amount: num(r.bcy_total ?? r.total ?? 0),
    },
  }),
  totalsFor: ['amount'],
});

const transformRefundHistory = detailListTransform({
  rootKeys: ['refund_history'],
  columns: [
    { key: 'date',          label: 'Date',          align: 'left'  },
    { key: 'reference',     label: 'Reference',     align: 'left'  },
    { key: 'label',         label: 'Contact',       align: 'left'  },
    { key: 'mode',          label: 'Mode',          align: 'left'  },
    { key: 'description',   label: 'Description',   align: 'left'  },
    { key: 'amount',        label: 'Amount',        align: 'right' },
  ],
  mapRow: (r) => ({
    label: r.customer_name || r.vendor_name || '—',
    cells: {
      date: r.date || '',
      reference: r.reference_number || r.refund_number || '',
      mode: r.refund_mode || r.payment_mode || '',
      description: r.description || '',
      amount: num(r.bcy_amount ?? r.amount ?? 0),
    },
  }),
  totalsFor: ['amount'],
});

// ── Expenses by category / employee / project ──
const transformExpensesByCategory = (body) => {
  const currency = pickCurrency(body);
  const rows = (body?.expense || body?.expenses || []).map((r) => ({
    label: r.account_name || r.category_name || '—',
    cells: {
      amount: num(r.amount ?? 0),
      amount_with_tax: num(r.amount_with_tax ?? r.amount ?? 0),
    },
  }));
  const tot = rows.reduce((s, r) => s + (r.cells.amount || 0), 0);
  const totWith = rows.reduce((s, r) => s + (r.cells.amount_with_tax || 0), 0);
  rows.push({ label: 'Total', cells: { amount: tot, amount_with_tax: totWith }, isTotal: true });
  return {
    columns: [
      { key: 'label',           label: 'Category',         align: 'left'  },
      { key: 'amount',          label: 'Amount',           align: 'right' },
      { key: 'amount_with_tax', label: 'Amount with Tax',  align: 'right' },
    ],
    rows, currency,
  };
};

const transformExpensesByEmployee = (body) => {
  const currency = pickCurrency(body);
  const rows = (body?.expenses || []).map((r) => ({
    label: r.user_name || r.employee_name || '—',
    cells: { amount: num(r.amount ?? r.total ?? 0) },
  }));
  const tot = rows.reduce((s, r) => s + (r.cells.amount || 0), 0);
  rows.push({ label: 'Total', cells: { amount: tot }, isTotal: true });
  return {
    columns: [
      { key: 'label',  label: 'Employee', align: 'left'  },
      { key: 'amount', label: 'Amount',   align: 'right' },
    ],
    rows, currency,
  };
};

const transformExpensesByProject = (body) => {
  const currency = pickCurrency(body);
  const rows = (body?.expenses_by_projects || body?.expenses || []).map((r) => ({
    label: r.project_name || '—',
    cells: { amount: num(r.amount ?? r.total ?? 0) },
  }));
  const tot = rows.reduce((s, r) => s + (r.cells.amount || 0), 0);
  rows.push({ label: 'Total', cells: { amount: tot }, isTotal: true });
  return {
    columns: [
      { key: 'label',  label: 'Project', align: 'left'  },
      { key: 'amount', label: 'Amount',  align: 'right' },
    ],
    rows, currency,
  };
};

// ── Customer / Vendor balance summary ──
const transformBalanceSummary = (body) => {
  const currency = pickCurrency(body);
  const list = body?.customerbalancesummary || body?.vendorbalancesummary || [];
  const isVendor = !!body?.vendorbalancesummary;
  const rows = (Array.isArray(list) ? list : []).map((r) => ({
    label: r.customer_name || r.vendor_name || '—',
    cells: {
      invoiced: num(r.invoiced_amount ?? r.billed_amount ?? 0),
      received: num(r.amount_received ?? r.amount_paid ?? 0),
      closing:  num(r.closing_balance ?? r.bcy_balance ?? 0),
    },
  }));
  const tot = { invoiced: 0, received: 0, closing: 0 };
  rows.forEach((r) => Object.keys(tot).forEach((k) => { tot[k] += r.cells[k] || 0; }));
  rows.push({ label: 'Total', cells: tot, isTotal: true });
  return {
    columns: [
      { key: 'label',    label: isVendor ? 'Vendor' : 'Customer',          align: 'left'  },
      { key: 'invoiced', label: isVendor ? 'Billed' : 'Invoiced',          align: 'right' },
      { key: 'received', label: isVendor ? 'Paid'   : 'Received',          align: 'right' },
      { key: 'closing',  label: 'Closing Balance',                          align: 'right' },
    ],
    rows, currency,
  };
};

// ── Project summary / Timesheet details ──
const transformProjectSummary = (body) => {
  const currency = pickCurrency(body);
  const rows = (body?.projects || []).map((r) => ({
    label: r.project_name || '—',
    cells: {
      customer: r.customer_name || '',
      status:   r.status || '',
      hours:    num(r.total_hours ?? 0),
      billed:   num(r.billed_amount ?? r.total_billed ?? 0),
      unbilled: num(r.un_billed_amount ?? r.unbilled_amount ?? 0),
    },
  }));
  return {
    columns: [
      { key: 'label',    label: 'Project',  align: 'left'  },
      { key: 'customer', label: 'Customer', align: 'left'  },
      { key: 'status',   label: 'Status',   align: 'left'  },
      { key: 'hours',    label: 'Hours',    align: 'right' },
      { key: 'billed',   label: 'Billed',   align: 'right' },
      { key: 'unbilled', label: 'Unbilled', align: 'right' },
    ],
    rows, currency,
  };
};

const transformTimesheetDetails = (body) => {
  const currency = pickCurrency(body);
  const rows = (body?.time_entries || []).map((r) => ({
    label: r.user_name || r.staff_name || '—',
    cells: {
      project: r.project_name || '',
      task:    r.task_name || '',
      date:    r.log_date || r.date || '',
      hours:   num(r.log_time ?? r.hours ?? 0),
      billable:r.is_billable ? 'Yes' : 'No',
      amount:  num(r.bcy_amount ?? r.amount ?? 0),
    },
  }));
  return {
    columns: [
      { key: 'label',   label: 'User',     align: 'left'  },
      { key: 'project', label: 'Project',  align: 'left'  },
      { key: 'task',    label: 'Task',     align: 'left'  },
      { key: 'date',    label: 'Date',     align: 'left'  },
      { key: 'hours',   label: 'Hours',    align: 'right' },
      { key: 'billable',label: 'Billable', align: 'left'  },
      { key: 'amount',  label: 'Amount',   align: 'right' },
    ],
    rows, currency,
  };
};

// ── Inventory summary ──
const transformInventorySummary = (body) => {
  const currency = pickCurrency(body);
  const rows = (body?.inventory || []).map((r) => ({
    label: r.name || r.item_name || '—',
    cells: {
      sku: r.sku || '',
      opening: num(r.opening_stock ?? 0),
      purchased: num(r.purchased ?? r.purchases ?? 0),
      sold: num(r.sold ?? r.sales ?? 0),
      closing: num(r.closing_stock ?? r.stock_on_hand ?? 0),
      value: num(r.stock_value ?? r.value ?? 0),
    },
  }));
  return {
    columns: [
      { key: 'label',     label: 'Item',     align: 'left'  },
      { key: 'sku',       label: 'SKU',      align: 'left'  },
      { key: 'opening',   label: 'Opening',  align: 'right' },
      { key: 'purchased', label: 'Purchased',align: 'right' },
      { key: 'sold',      label: 'Sold',     align: 'right' },
      { key: 'closing',   label: 'Closing',  align: 'right' },
      { key: 'value',     label: 'Value',    align: 'right' },
    ],
    rows, currency,
  };
};

// ── Horizontal P&L ──
// Zoho's UI lays Income on the right column and Expense on the left.
// We render it as a single table with `side` discriminator so the frontend can
// either show two columns or interleave. Default: vertical with side hint.
function transformHorizontalPL(body) {
  const currency = pickCurrency(body);
  const root = body?.horizontal_profit_and_loss || body?.profit_and_loss || [];

  // Find the Expense and Income super-sections at the top level.
  let expenseNode = null;
  let incomeNode  = null;
  (Array.isArray(root) ? root : []).forEach((n) => {
    const nm = (n?.name || '').toLowerCase();
    if (nm.includes('expense') || nm === 'expenses') expenseNode = n;
    else if (nm.includes('income') || nm === 'revenue') incomeNode = n;
  });

  // Fallback: if shape mirrors plain PL, derive both sides from PL buckets.
  if (!expenseNode && !incomeNode && Array.isArray(root)) {
    const incomes = [];
    const expenses = [];
    function walk(nodes) {
      (nodes || []).forEach((n) => {
        const nm = (n?.name || '').toLowerCase();
        if (nm === 'operating income' || nm === 'non operating income') incomes.push(n);
        else if (nm === 'operating expense' || nm === 'non operating expense' || nm === 'cost of goods sold') expenses.push(n);
        if (Array.isArray(n.account_transactions)) walk(n.account_transactions);
      });
    }
    walk(root);
    incomeNode  = { name: 'Income',  account_transactions: incomes };
    expenseNode = { name: 'Expense', account_transactions: expenses };
  }

  // Build each side from its top-level sections (Operating Income / COGS / …).
  // flattenZohoSections renders: section header → leaf accounts → "Total for X".
  const incomeSections  = Array.isArray(incomeNode?.account_transactions)  ? incomeNode.account_transactions  : [];
  const expenseSections = Array.isArray(expenseNode?.account_transactions) ? expenseNode.account_transactions : [];

  const incRows = [];
  const expRows = [];
  flattenZohoSections(incomeSections, 0, incRows);
  flattenZohoSections(expenseSections, 0, expRows);

  // Per-side totals from the section totals (matches Zoho's column totals).
  const sumTotals = (arr) => arr.reduce(
    (t, n) => t + num(n?.total ?? n?.section_total ?? n?.amount ?? n?.balance ?? 0), 0
  );
  const incomeTotal  = sumTotals(incomeSections);
  const expenseTotal = sumTotals(expenseSections);
  const netProfit    = incomeTotal - expenseTotal;
  // In a T-format P&L both columns balance: the profit sits on the Expense side
  // (or a loss on the Income side), so each column totals the same grand figure.
  const grandTotal   = Math.max(incomeTotal, expenseTotal);

  if (netProfit >= 0) {
    expRows.push({ label: 'Net Profit/Loss', cells: { amount: netProfit }, level: 0, isSubtotal: true });
  } else {
    incRows.push({ label: 'Net Profit/Loss', cells: { amount: -netProfit }, level: 0, isSubtotal: true });
  }

  // Tag each row with side (kept for any consumer using the flat `rows`).
  incRows.forEach((r) => { r.side = 'income';  });
  expRows.forEach((r) => { r.side = 'expense'; });

  return {
    columns: [
      { key: 'label',  label: 'Account', align: 'left'  },
      { key: 'amount', label: 'Total',   align: 'right' },
    ],
    // Structured T-format payload — the frontend renders two side-by-side columns.
    layout: 'horizontal',
    horizontal: {
      income:  { title: 'Income',  rows: incRows, total: grandTotal },
      expense: { title: 'Expense', rows: expRows, total: grandTotal },
      netProfit,
    },
    // Backward-compatible flat fallback (single column) for any older consumer.
    rows: [
      { label: 'Income',  cells: { amount: null }, isHeader: true, level: 0 },
      ...incRows.map((r) => ({ ...r, level: (r.level ?? 0) + 1 })),
      { label: 'Expense', cells: { amount: null }, isHeader: true, level: 0 },
      ...expRows.map((r) => ({ ...r, level: (r.level ?? 0) + 1 })),
    ],
    currency,
  };
}

// ── Schedule III Profit and Loss (Indian Companies Act 2013 layout) ──
// Buckets standard P&L data into the prescribed Schedule III sections:
//   I.  Revenue from operations
//   II. Other Income
//   III. Total Revenue (I + II)
//   IV. Expenses (1. Cost of materials, 2. Purchases of stock-in-trade,
//                 3. Changes in inventories, 4. Employee benefits,
//                 5. Finance costs, 6. Depreciation, 7. Other expenses)
//   V.  Profit before tax (III - IV)
function transformPLScheduleIII(body) {
  const currency = pickCurrency(body);

  // Collect leaf accounts grouped by parent section name.
  const buckets = {};
  function collect(nodes, sectionName) {
    (nodes || []).forEach((n) => {
      const hasChildren = Array.isArray(n.account_transactions) && n.account_transactions.length > 0;
      const isLeaf     = !hasChildren && (n.name || n.account_name);
      if (isLeaf) {
        if (!buckets[sectionName]) buckets[sectionName] = [];
        buckets[sectionName].push({
          name: n.name || n.account_name,
          amount: num(n.total ?? 0),
        });
      } else if (hasChildren) {
        const next = n.name || sectionName;
        collect(n.account_transactions, next);
      }
    });
  }
  collect(body?.profit_and_loss || [], 'root');

  const opIncome   = buckets['Operating Income']     || [];
  const otherInc   = buckets['Non Operating Income'] || [];
  const cogs       = buckets['Cost of Goods Sold']   || [];
  const opExpense  = buckets['Operating Expense']    || [];
  const nonOpExp   = buckets['Non Operating Expense']|| [];

  const sumOf = (arr) => arr.reduce((s, x) => s + (x.amount || 0), 0);

  // Build Schedule III rows
  const rows = [];
  const totalRevenue   = sumOf(opIncome);
  const totalOtherInc  = sumOf(otherInc);
  const grandRevenue   = totalRevenue + totalOtherInc;

  // Employee-benefit-like keywords help us bucket expense leaves.
  const isEmployee = (n) => /salar|wage|bonus|pf |esi|gratuity|leave|recruit|staff/i.test(n);
  const isFinance  = (n) => /interest|bank charge|loan|finance|processing/i.test(n);
  const isDeprec   = (n) => /deprec|amortis|amortiz/i.test(n);
  const isInvChg   = (n) => /change in inv|stock in trade/i.test(n);
  const isMaterial = (n) => /raw material|materials? consum/i.test(n);
  const isPurchase = (n) => /purchase of stock|stock-in-trade|merchandise/i.test(n);

  const employeeExp   = opExpense.filter((x) => isEmployee(x.name));
  const financeExp    = [...opExpense, ...nonOpExp].filter((x) => isFinance(x.name));
  const deprecExp     = [...opExpense, ...nonOpExp].filter((x) => isDeprec(x.name));
  const invChgExp     = cogs.filter((x) => isInvChg(x.name));
  const materialExp   = cogs.filter((x) => isMaterial(x.name));
  const purchaseExp   = cogs.filter((x) => isPurchase(x.name));
  const usedNames = new Set([
    ...employeeExp, ...financeExp, ...deprecExp, ...invChgExp, ...materialExp, ...purchaseExp,
  ].map((x) => x.name));
  const otherExp = [...opExpense, ...nonOpExp].filter((x) => !usedNames.has(x.name) && !isEmployee(x.name) && !isFinance(x.name) && !isDeprec(x.name));

  const sec = (label, amount, level, isSubtotal) =>
    rows.push({ label, cells: { amount }, level, isSubtotal: !!isSubtotal });

  // I. Revenue from operations
  rows.push({ label: 'I. Revenue from operations', cells: { amount: totalRevenue }, level: 0, isHeader: true });
  // II. Other Income
  rows.push({ label: 'II. Other Income', cells: { amount: totalOtherInc }, level: 0, isHeader: true });
  // III. Total Revenue
  sec('III. Total Revenue (I + II)', grandRevenue, 0, true);
  // IV. Expenses (header)
  rows.push({ label: 'IV. Expenses', cells: { amount: null }, level: 0, isHeader: true });
  const exp1 = sumOf(materialExp);
  const exp2 = sumOf(purchaseExp);
  const exp3 = sumOf(invChgExp);
  const exp4 = sumOf(employeeExp);
  const exp5 = sumOf(financeExp);
  const exp6 = sumOf(deprecExp);
  const exp7 = sumOf(otherExp);
  sec('  1. Cost of materials consumed',                                        exp1, 1);
  sec('  2. Purchases of stock in trade',                                       exp2, 1);
  sec('  3. Changes in Inventories of finished goods / work-in-progress',       exp3, 1);
  sec('  4. Employee benefits expense',                                         exp4, 1);
  sec('  5. Finance Costs',                                                     exp5, 1);
  sec('  6. Depreciation And Amortization Expense',                             exp6, 1);
  sec('  7. Other Expenses',                                                    exp7, 1);
  const totalExp = exp1 + exp2 + exp3 + exp4 + exp5 + exp6 + exp7;
  sec('Total Expenses', totalExp, 0, true);

  // V. Profit before tax
  sec('V. Profit before tax (III - IV)', grandRevenue - totalExp, 0, true);
  // VI. Tax expense (approximated as income tax expense bucket if present)
  const taxExp = otherExp.filter((x) => /tax/i.test(x.name)).reduce((s, x) => s + x.amount, 0);
  sec('VI. Tax expense', taxExp, 0);
  // VII. Profit/(Loss) for the period
  sec('VII. Profit / (Loss) for the period', grandRevenue - totalExp - taxExp, 0, true);

  return {
    columns: [
      { key: 'label',  label: 'Particulars', align: 'left'  },
      { key: 'amount', label: 'Amount',      align: 'right' },
    ],
    rows,
    currency,
    layout: 'scheduleiii',
  };
}

// ── Schedule III Balance Sheet (Indian Companies Act 2013 layout) ──
//   I.  EQUITY AND LIABILITIES
//        (1) Shareholders' funds   (2) Non-current liabilities   (3) Current liabilities
//   II. ASSETS
//        (1) Non-current assets    (2) Current assets
function transformBSScheduleIII(body) {
  const currency = pickCurrency(body);
  const buckets = {};
  function collect(nodes, section) {
    (nodes || []).forEach((n) => {
      const hasChildren = Array.isArray(n.account_transactions) && n.account_transactions.length > 0;
      if (hasChildren) {
        const next = n.name || section;
        if (!buckets[next]) buckets[next] = 0;
        if (typeof n.total === 'number') buckets[next] += n.total;
        collect(n.account_transactions, next);
      } else if (n.name) {
        const key = section;
        if (!buckets[key]) buckets[key] = 0;
        buckets[key] += num(n.total ?? 0);
      }
    });
  }
  collect(body?.balance_sheet || [], 'root');

  const get = (k) => buckets[k] || 0;
  const rows = [];

  rows.push({ label: 'I. EQUITY AND LIABILITIES', cells: { amount: null }, level: 0, isHeader: true });
  rows.push({ label: "  (1) Shareholders' Funds", cells: { amount: get('Equities') || get('Equity') }, level: 1, isSubtotal: true });
  rows.push({ label: '  (2) Non-Current Liabilities', cells: { amount: get('Non Current Liabilities') + get('Other Liabilities') }, level: 1, isSubtotal: true });
  rows.push({ label: '  (3) Current Liabilities', cells: { amount: get('Current Liabilities') }, level: 1, isSubtotal: true });
  const totalEqLi = get('Equities') + get('Equity') + get('Non Current Liabilities') + get('Other Liabilities') + get('Current Liabilities');
  rows.push({ label: 'Total Equity & Liabilities', cells: { amount: totalEqLi }, level: 0, isTotal: true });

  rows.push({ label: 'II. ASSETS', cells: { amount: null }, level: 0, isHeader: true });
  rows.push({ label: '  (1) Non-Current Assets', cells: { amount: get('Non Current Assets') + get('Fixed Assets') + get('Other Assets') }, level: 1, isSubtotal: true });
  rows.push({ label: '  (2) Current Assets', cells: { amount: get('Current Assets') }, level: 1, isSubtotal: true });
  const totalAssets = get('Non Current Assets') + get('Fixed Assets') + get('Other Assets') + get('Current Assets');
  rows.push({ label: 'Total Assets', cells: { amount: totalAssets }, level: 0, isTotal: true });

  return {
    columns: [
      { key: 'label',  label: 'Particulars', align: 'left'  },
      { key: 'amount', label: 'Amount',      align: 'right' },
    ],
    rows,
    currency,
    layout: 'scheduleiii',
  };
}

// ── Movement of Equity (nested) ──
const transformMovementOfEquity = (body) => {
  const currency = pickCurrency(body);
  const rows = [];
  function walk(node, level) {
    if (!node || typeof node !== 'object') return;
    const name = node.node_name || node.name;
    const value = (node.values && node.values[0] && (node.values[0].total ?? node.values[0].amount)) ?? null;
    if (name) {
      rows.push({
        label: name,
        cells: { amount: value == null ? null : num(value) },
        level,
        isHeader: Array.isArray(node.account_transactions) && node.account_transactions.length > 0,
        isSubtotal: !!node.has_total,
      });
    }
    (node.account_transactions || []).forEach((c) => walk(c, level + 1));
  }
  const root = body?.movement_of_equity;
  if (root) walk(root, 0);
  return {
    columns: [
      { key: 'label',  label: 'Account', align: 'left'  },
      { key: 'amount', label: 'Total',   align: 'right' },
    ],
    rows, currency,
  };
};

// ── Payments Received ──
function transformPayments(body) {
  const currency = pickCurrency(body);
  const columns = [
    { key: 'label',  label: 'Customer',                  align: 'left'  },
    { key: 'mode',   label: 'Mode',                      align: 'left'  },
    { key: 'amount', label: `Amount (${currency})`,      align: 'right' },
  ];
  const rows = [];
  const list = body?.payments_received || body?.payments || body?.report || [];
  const data = Array.isArray(list) ? list : (list.account_transactions || list.entities || []);
  data.forEach((r) => {
    rows.push({
      label: r.customer_name || r.contact_name || '—',
      cells: { mode: r.payment_mode || '', amount: num(r.amount ?? r.total ?? 0) },
    });
  });
  const tot = rows.reduce((s, r) => s + (r.cells.amount || 0), 0);
  rows.push({ label: 'Total', cells: { mode: '', amount: tot }, isTotal: true });
  return { columns, rows, currency };
}

// ── Tax Summary ──
// Zoho returns: { tax: [ { tax_name, tax_percentage, transaction_amount, tax_amount, ... } ] }
function transformTaxSummary(body) {
  const currency = pickCurrency(body);
  const columns = [
    { key: 'label',      label: 'Tax',           align: 'left'  },
    { key: 'rate',       label: 'Rate (%)',      align: 'right' },
    { key: 'taxable',    label: 'Taxable',       align: 'right' },
    { key: 'tax_amount', label: 'Tax Amount',    align: 'right' },
  ];
  const rows = [];
  const list = body?.tax || body?.tax_summary || body?.taxes || body?.report || [];
  (Array.isArray(list) ? list : []).forEach((r) => {
    rows.push({
      label: r.tax_name || r.name || '—',
      cells: {
        rate:       num(r.tax_percentage ?? r.percentage ?? 0),
        taxable:    num(r.transaction_amount ?? r.taxable_amount ?? r.net_taxable_amount ?? 0),
        tax_amount: num(r.tax_amount ?? r.amount ?? r.total ?? 0),
      },
    });
  });
  const totTax     = rows.reduce((s, r) => s + (r.cells.tax_amount || 0), 0);
  const totTaxable = rows.reduce((s, r) => s + (r.cells.taxable    || 0), 0);
  rows.push({ label: 'Total', cells: { rate: 0, taxable: totTaxable, tax_amount: totTax }, isTotal: true });
  return { columns, rows, currency };
}

// ── General Ledger ──
// Zoho returns: { generalledger: [ { name, account_id, debit_total, credit_total, balance } ] }
function transformGL(body) {
  const currency = pickCurrency(body);
  const columns = [
    { key: 'label',   label: 'Account', align: 'left'  },
    { key: 'debit',   label: 'Debit',   align: 'right' },
    { key: 'credit',  label: 'Credit',  align: 'right' },
    { key: 'balance', label: 'Balance', align: 'right' },
  ];
  const rows = [];
  const list = body?.generalledger || body?.general_ledger || body?.report || [];
  (Array.isArray(list) ? list : []).forEach((acc) => {
    rows.push({
      label: acc.name || acc.account_name || '—',
      cells: {
        debit:   num(acc.debit_total  ?? acc.debit  ?? 0),
        credit:  num(acc.credit_total ?? acc.credit ?? 0),
        balance: num(acc.balance ?? 0),
      },
    });
  });
  const totD = rows.reduce((s, r) => s + (r.cells.debit  || 0), 0);
  const totC = rows.reduce((s, r) => s + (r.cells.credit || 0), 0);
  const totB = rows.reduce((s, r) => s + (r.cells.balance || 0), 0);
  rows.push({ label: 'Total', cells: { debit: totD, credit: totC, balance: totB }, isTotal: true });
  return { columns, rows, currency };
}

// ─── report definitions ───────────────────────────────────────────────────

// Note: only endpoints below are confirmed to exist in Zoho Books v3 India region.
// Unknown / region-restricted reports (purchase reports, payments received, aging details)
// fall through to the frontend mock generator via the 404 path.
// Default to current Indian fiscal year (April 1 → today) for date-required reports.
function defaultFiscalRange() {
  const today = new Date();
  const ymd = (d) => d.toISOString().slice(0, 10);
  const m = today.getMonth(); // 0 = Jan
  const fyStartYear = m >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  return {
    from_date: ymd(new Date(fyStartYear, 3, 1)), // Apr 1
    to_date:   ymd(today),
  };
}

const REPORT_DEFS = {
  // ── Business Overview ──
  // PL / CF / Movement of Equity are period reports; BS / Horizontal BS are
  // point-in-time (Zoho honours to_date via the implicit Today filter, so no
  // override needed there).
  profitandloss:           { endpoint: '/reports/profitandloss',           transform: transformPL,                    requiresDates: true, allRowsByDefault: true, filterByField: 'TransactionDate' },
  // Zoho has no standalone /reports/horizontalprofitandloss endpoint — "horizontal"
  // is a display layout (the web UI uses profitandloss-tformat). Reuse the proven
  // /reports/profitandloss endpoint; transformHorizontalPL re-lays it into T-format.
  // reuseRawFrom: serve from the base P&L's cached raw body (no extra Zoho call →
  // also works when the org has hit Zoho's daily rate limit but P&L is cached).
  horizontalprofitandloss: { endpoint: '/reports/profitandloss',           transform: transformHorizontalPL,          requiresDates: true, allRowsByDefault: true, filterByField: 'TransactionDate', reuseRawFrom: 'profitandloss' },
  profitandlossscheduleiii:{ endpoint: '/reports/profitandloss',           transform: transformPLScheduleIII,         requiresDates: true, allRowsByDefault: true, filterByField: 'TransactionDate' },
  balancesheet:            { endpoint: '/reports/balancesheet',            transform: transformBS,                    requiresDates: true, allRowsByDefault: true },
  // Same as above — no standalone horizontal endpoint exists; reuse /reports/balancesheet.
  horizontalbalancesheet:  { endpoint: '/reports/balancesheet',            transform: transformBS,                    requiresDates: true, allRowsByDefault: true, reuseRawFrom: 'balancesheet' },
  balancesheetscheduleiii: { endpoint: '/reports/balancesheet',            transform: transformBSScheduleIII,         requiresDates: true, allRowsByDefault: true },
  cashflow:                { endpoint: '/reports/cashflow',                transform: transformCF,                    requiresDates: true, allRowsByDefault: true, filterByField: 'TransactionDate', baseParams: { is_hierarchy_report: 'true' } },
  movementofequity:        { endpoint: '/reports/movementofequity',        transform: transformMovementOfEquity,      requiresDates: true, allRowsByDefault: true, filterByField: 'TransactionDate' },

  // ── Accountant ──
  trialbalance:            { endpoint: '/reports/trialbalance',            transform: transformTB,                    requiresDates: true, dateRangeMode: true },
  generalledger:           { endpoint: '/reports/generalledger',           transform: transformGL,                    requiresDates: true, filterByField: 'TransactionDate' },

  // ── Sales ──
  salesbycustomer:         { endpoint: '/reports/salesbycustomer',         transform: transformSalesByCustomer,       requiresDates: true, filterByField: 'TransactionDate' },
  salesbyitem:             { endpoint: '/reports/salesbyitem',             transform: transformSalesByItem,           requiresDates: true, filterByField: 'TransactionDate' },
  salesbysalesperson:      { endpoint: '/reports/salesbysalesperson',      transform: transformSalesBySalesperson,    requiresDates: true, filterByField: 'TransactionDate' },
  invoicedetails:          { endpoint: '/reports/invoicedetails',          transform: transformInvoiceDetails,        requiresDates: true, filterByField: 'InvoiceDate' },
  estimatedetails:         { endpoint: '/reports/estimatedetails',         transform: transformEstimateDetails,       requiresDates: true, filterByField: 'EstimateDate' },
  salesorderdetails:       { endpoint: '/reports/salesorderdetails',       transform: transformSODetails,             requiresDates: true, filterByField: 'SalesOrderDate' },
  deliverychallandetails:  { endpoint: '/reports/deliverychallandetails',  transform: transformDCDetails,             requiresDates: true, filterByField: 'ChallanDate' },

  // ── Receivables ──
  customerbalance:         { endpoint: '/reports/customerbalances',        transform: transformBalances },
  customerbalancesummary:  { endpoint: '/reports/customerbalancesummary',  transform: transformBalanceSummary },
  aragingsummary:          { endpoint: '/reports/aragingsummary',          transform: transformAging },
  creditnotedetails:       { endpoint: '/reports/creditnotedetails',       transform: transformCreditNoteDetails,     requiresDates: true, filterByField: 'CreditNotesDate' },

  // ── Payments ──
  refundhistory:           { endpoint: '/reports/refundhistory',           transform: transformRefundHistory,         requiresDates: true, filterByField: 'RefundDate' },

  // ── Recurring ──
  recurringinvoicedetails: { endpoint: '/reports/recurringinvoicedetails', transform: transformRecurringInvoiceDetails },

  // ── Payables ──
  vendorbalance:           { endpoint: '/reports/vendorbalances',          transform: transformBalances },
  vendorbalancesummary:    { endpoint: '/reports/vendorbalancesummary',    transform: transformBalanceSummary },
  apagingsummary:          { endpoint: '/reports/apagingsummary',          transform: transformAging },
  billdetails:             { endpoint: '/reports/billdetails',             transform: transformBillDetails,           requiresDates: true, filterByField: 'BillDate' },
  vendorcreditdetails:     { endpoint: '/reports/vendorcreditdetails',     transform: transformVendorCreditDetails,   requiresDates: true, filterByField: 'VendorCreditDate' },

  // ── Purchases & Expenses ──
  purchaseorderdetails:    { endpoint: '/reports/purchaseorderdetails',    transform: transformPODetails,             requiresDates: true, filterByField: 'PODate' },
  expensesbycategory:      { endpoint: '/reports/expensesbycategory',      transform: transformExpensesByCategory,    requiresDates: true, filterByField: 'TransactionDate' },
  expensesbyemployee:      { endpoint: '/reports/expensesbyemployee',      transform: transformExpensesByEmployee,    requiresDates: true, filterByField: 'ExpenseDate' },
  expensesbyproject:       { endpoint: '/reports/expensesbyproject',       transform: transformExpensesByProject,     requiresDates: true, filterByField: 'ExpenseDate' },

  // ── Taxes ──
  taxsummary:              { endpoint: '/reports/taxsummary',              transform: transformTaxSummary,            requiresDates: true, filterByField: 'TransactionDate' },

  // ── Projects & Timesheet ──
  projectsummary:          { endpoint: '/reports/projectsummary',          transform: transformProjectSummary,        requiresDates: true },
  timesheetdetails:        { endpoint: '/reports/timesheetdetails',        transform: transformTimesheetDetails,      requiresDates: true, filterByField: 'Date' },

  // ── Inventory ──
  inventorysummary:        { endpoint: '/reports/inventorysummary',        transform: transformInventorySummary,      requiresDates: true },
};

function listReportTypes() {
  return Object.keys(REPORT_DEFS).map((k) => ({
    type: k,
    endpoint: REPORT_DEFS[k].endpoint,
    baseParams: REPORT_DEFS[k].baseParams || {},
  }));
}

// ─── orchestrator ─────────────────────────────────────────────────────────

async function fetchReport(userId, type, params = {}, { refresh = false, ttlMs = DEFAULT_TTL_MS, orgId: orgOverride = null } = {}) {
  const def = REPORT_DEFS[type];
  if (!def) {
    const err = new Error(`Unknown report type: ${type}`);
    err.code = 'UNKNOWN_REPORT_TYPE';
    throw err;
  }

  const orgId = orgOverride || await getOrgId(userId);
  if (!orgId) {
    const err = new Error('Zoho not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const allParams = { ...(def.baseParams || {}), ...(params || {}) };
  // Inject sensible defaults so reports that REQUIRE dates never 400 when caller omits them.
  if (def.requiresDates) {
    const def_ = defaultFiscalRange();
    if (!allParams.from_date) allParams.from_date = def_.from_date;
    if (!allParams.to_date)   allParams.to_date   = def_.to_date;
  }
  // Match Zoho UI default: show all rows (including zero-balance accounts) for
  // hierarchical reports. Caller can override with ?show_rows=non_zero.
  if (def.allRowsByDefault && !allParams.show_rows) {
    allParams.show_rows = 'all';
  }
  // Trial Balance defaults to cumulative balances. To match Zoho UI which shows
  // period activity when a date range is picked, force CustomDate filter mode.
  if (def.dateRangeMode && !allParams.filter_by) {
    allParams.filter_by = 'TransactionDate.CustomDate';
  }
  // CRITICAL: Without an explicit filter_by, Zoho IGNORES from_date/to_date and
  // returns "This Month" data instead. Each report uses a different date-field
  // (InvoiceDate, BillDate, …). We map them per-report so the picked period
  // actually drives the response.
  if (def.filterByField && allParams.from_date && allParams.to_date && !allParams.filter_by) {
    allParams.filter_by = `${def.filterByField}.CustomDate`;
  }
  const paramsHash = sha1(stableStringify({ type, ...allParams }));

  // 1. Try cache first
  if (!refresh) {
    const cached = await readCache(userId, orgId, type, paramsHash);
    if (cached && cached.expires_at && new Date(cached.expires_at).getTime() > Date.now()) {
      const transformed = cached.transformed ? JSON.parse(cached.transformed) : null;
      if (transformed) {
        return { ...transformed, _cache: 'hit', fetched_at: cached.fetched_at };
      }
    }
  }

  // 1b. Derived report (e.g. horizontal P&L) — reuse the base report's cached RAW
  // body (same Zoho endpoint + params) so we never spend a second API call. This
  // also keeps it working when the org has hit Zoho's daily rate limit.
  // `acceptStale`: false on the fast path (prefer a live refetch if base is stale),
  // true when used as a last-resort fallback after a live failure.
  const tryReuseRaw = async (acceptStale) => {
    if (!def.reuseRawFrom) return null;
    const baseHash = sha1(stableStringify({ type: def.reuseRawFrom, ...allParams }));
    const base = await readCache(userId, orgId, def.reuseRawFrom, baseHash);
    if (!base || !base.body) return null;
    const fresh = base.expires_at && new Date(base.expires_at).getTime() > Date.now();
    if (!fresh && !acceptStale) return null;
    try {
      const body = typeof base.body === 'string' ? JSON.parse(base.body) : base.body;
      const transformed = def.transform(body, allParams);
      transformed.raw = body;
      try { await writeCache(userId, orgId, type, paramsHash, allParams, def.endpoint, base.status_code || 200, body, transformed, ttlMs); } catch (_) {}
      return { ...transformed, _cache: fresh ? 'derived' : 'derived-stale', fetched_at: base.fetched_at };
    } catch (_) { return null; }
  };
  if (!refresh) {
    const reused = await tryReuseRaw(false);
    if (reused) return reused;
  }

  // 2. Fetch live from Zoho
  const token = await getValidToken(userId);
  if (!token) {
    const err = new Error('Zoho not connected (no token)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const url = `${API_BASE}${def.endpoint}`;
  let status = null;
  let body = null;
  let errMessage = null;
  try {
    const resp = await axios.get(url, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: orgId, ...allParams },
      timeout: 30000,
    });
    status = resp.status;
    body = resp.data;
  } catch (e) {
    // If Zoho fails but we have a stale cache, serve it
    const stale = await readCache(userId, orgId, type, paramsHash);
    if (stale && stale.transformed) {
      const transformed = JSON.parse(stale.transformed);
      return { ...transformed, _cache: 'stale', fetched_at: stale.fetched_at, _error: e.response?.data?.message || e.message };
    }
    // Last resort for derived reports: reuse the base report's (possibly stale)
    // cached body so a rate-limited/failed live call still returns real data.
    const reused = await tryReuseRaw(true);
    if (reused) return { ...reused, _error: e.response?.data?.message || e.message };
    errMessage = e.response?.data?.message || e.message;
    const err = new Error(`Zoho report fetch failed: ${errMessage}`);
    err.code = 'ZOHO_ERROR';
    err.status = e.response?.status || 502;
    throw err;
  }

  // Inject the org's reporting currency so transforms always render in the
  // correct currency (Zoho /reports/* responses omit it).
  try {
    if (body && typeof body === 'object') body._currency = await getOrgCurrency(userId, orgId);
  } catch (_) {}

  // 3. Transform + cache
  let transformed;
  try {
    transformed = def.transform(body, allParams);
  } catch (e) {
    transformed = {
      columns: [{ key: 'label', label: 'Field', align: 'left' }, { key: 'value', label: 'Value', align: 'right' }],
      rows: [{ label: 'Raw payload', cells: { value: '(transform failed: ' + e.message + ')' } }],
      currency: pickCurrency(body),
    };
  }
  transformed.raw = body;

  try {
    await writeCache(userId, orgId, type, paramsHash, allParams, def.endpoint, status, body, transformed, ttlMs);
  } catch (e) {
    // Cache write failure shouldn't block the request
    console.warn('[zb-reports] cache write failed:', e.message);
  }

  return { ...transformed, _cache: 'miss', fetched_at: new Date() };
}

// ─── comparative (multi-period) reports ────────────────────────────────────
// Zoho's "Compare With: Previous Year / Period" shows several period columns
// side-by-side (e.g. APR 2022-MAR 2023 … APR 2025-MAR 2026). The public API
// has no reliable multi-column response, so we fetch each period through the
// already-proven single-period fetchReport (each is cached independently) and
// merge them into one { columns, rows } table.

const MON3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pad2 = (n) => String(n).padStart(2, '0');

// Indian fiscal year start (April). Returns the calendar year the FY began in.
function fyStartYearOf(iso) {
  const [y, m] = String(iso).split('-').map(Number);
  return m >= 4 ? y : y - 1;
}
function ymdUTC(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function prettyShort(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return `${pad2(d)} ${MON3[(m || 1) - 1]} ${y}`;
}

// Build `count` period windows ending at the selected period, newest first.
function buildComparePeriods(baseFrom, baseTo, compareBy, count) {
  const periods = [];
  if (compareBy === 'year') {
    const startY = fyStartYearOf(baseTo || baseFrom);
    for (let i = 0; i < count; i++) {
      const y = startY - i;
      periods.push({
        id: `fy_${y}`,
        label: `APR ${y} - MAR ${y + 1}`,
        from_date: `${y}-04-01`,
        to_date: `${y + 1}-03-31`,
      });
    }
  } else {
    // Step back by the selected window's own length.
    const from = new Date(`${baseFrom}T00:00:00Z`);
    const to   = new Date(`${baseTo}T00:00:00Z`);
    const lenDays = Math.round((to - from) / 86400000) + 1;
    for (let i = 0; i < count; i++) {
      const f = new Date(from); f.setUTCDate(f.getUTCDate() - i * lenDays);
      const t = new Date(to);   t.setUTCDate(t.getUTCDate() - i * lenDays);
      const fStr = ymdUTC(f), tStr = ymdUTC(t);
      periods.push({ id: `p_${i}`, label: `${prettyShort(fStr)} - ${prettyShort(tStr)}`, from_date: fStr, to_date: tStr });
    }
  }
  return periods; // newest-first
}

const rowFlag = (r) => (r.isTotal ? 'T' : r.isSubtotal ? 'S' : r.isHeader ? 'H' : 'L');
const rowKey  = (r) => `${r.level || 0}|${String(r.label || '').toLowerCase().trim()}|${rowFlag(r)}`;

// Merge per-period single-column results (newest-first) into a multi-column table.
function mergeComparative(results, oldestFirst) {
  const display  = oldestFirst ? [...results].reverse() : results;
  const primary  = results[0].data;                 // selected (newest) period drives structure
  const skeleton = primary.rows || [];
  const currency = primary.currency || 'USD';

  const columns = [
    { key: 'label', label: 'Account', align: 'left' },
    ...display.map((r) => ({ key: r.period.id, label: r.period.label, align: 'right' })),
  ];

  // Same chart of accounts + show_rows=all ⇒ identical row order across periods,
  // so we can zip by index. Fall back to key-matching if a period differs.
  const sameShape = results.every((r) => (r.data.rows || []).length === skeleton.length);
  const maps = {};
  if (!sameShape) {
    display.forEach((r) => {
      const m = new Map();
      (r.data.rows || []).forEach((row) => {
        const k = rowKey(row);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(row.cells?.amount ?? null);
      });
      maps[r.period.id] = m;
    });
  }
  const counters = {};

  const rows = skeleton.map((row, i) => {
    const cells = {};
    display.forEach((r) => {
      let amt;
      if (sameShape) {
        amt = r.data.rows[i]?.cells?.amount ?? null;
      } else {
        const k = rowKey(row);
        const ck = `${r.period.id}::${k}`;
        const idx = counters[ck] || 0; counters[ck] = idx + 1;
        amt = (maps[r.period.id].get(k) || [])[idx] ?? null;
      }
      cells[r.period.id] = amt;
    });
    return {
      label: row.label,
      level: row.level,
      isHeader: row.isHeader,
      isSubtotal: row.isSubtotal,
      isTotal: row.isTotal,
      cells,
    };
  });

  return { columns, rows, currency, _compare: true };
}

async function fetchComparativeReport(userId, type, params = {}, opts = {}) {
  const compareBy   = String(params.compare) === 'year' ? 'year' : 'period';
  const count       = Math.min(Math.max(parseInt(params.compare_count, 10) || 1, 1), 6);
  const oldestFirst = String(params.oldest_first) === '1' || String(params.oldest_first) === 'true';

  let baseFrom = params.from_date;
  let baseTo   = params.to_date;
  if (!baseFrom || !baseTo) {
    const d = defaultFiscalRange();
    baseFrom = baseFrom || d.from_date;
    baseTo   = baseTo   || d.to_date;
  }

  const periods = buildComparePeriods(baseFrom, baseTo, compareBy, count);

  // Strip the compare-only keys before forwarding to the single-period fetch.
  const passthrough = { ...params };
  delete passthrough.compare;
  delete passthrough.compare_count;
  delete passthrough.oldest_first;

  const results = [];
  for (const p of periods) {
    const data = await fetchReport(userId, type, { ...passthrough, from_date: p.from_date, to_date: p.to_date }, opts);
    results.push({ period: p, data });
  }
  return mergeComparative(results, oldestFirst);
}

module.exports = {
  fetchReport,
  fetchComparativeReport,
  listReportTypes,
  REPORT_DEFS,
};
