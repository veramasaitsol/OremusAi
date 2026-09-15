'use strict';

/**
 * Xero Cash Flow Statement (indirect method).
 * ---------------------------------------------------------------------------
 * Xero's JSON Accounting API has no Cash Flow report, and this app's Xero orgs
 * sync no general ledger, so — unlike Zoho, which builds cash flow from the
 * local bank_transactions ledger — we derive it the standard accounting way from
 * the two Xero reports that ARE available:
 *
 *   • ProfitAndLoss for the period  → Net Profit/(Loss)
 *   • BalanceSheet at the opening and closing dates → working-capital, investing
 *     and financing movements (end − start of each account)
 *
 * Layout (indirect method):
 *   Operating Activities
 *     Net Profit/(Loss)
 *     (Increase)/decrease in <operating assets>     [AR, prepaid, GST input, …]
 *     Increase/(decrease) in <operating liabilities> [AP, GST output, TDS, …]
 *     Net Cash from Operating Activities
 *   Investing Activities
 *     (Purchase)/sale of <non-current assets>
 *     Net Cash from Investing Activities
 *   Financing Activities
 *     <long-term borrowings / equity contributions>
 *     Net Cash from Financing Activities
 *   Net Increase/(Decrease) in Cash
 *   Cash and cash equivalents at beginning of period
 *   Cash and cash equivalents at end of period
 *
 * Sign convention: cash inflows positive, outflows negative. Closing cash is
 * opening cash + the derived net change (indirect method), so the statement is
 * always internally consistent.
 *
 * Returns the canonical { columns, rows, currency, meta } shape — rendered by the
 * common report viewer (no UI changes).
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Default to the current Indian fiscal year (Apr–Mar) when no dates are sent.
function resolveRange(params) {
  const from = params.from_date || params.from || params.date_start || null;
  const to = params.to_date || params.to || params.date_end || null;
  if (from && to) return { from, to };
  // Default window: the fiscal year containing today, for the per-platform
  // start month (Settings → params.fy_start_month; defaults to 4 = 1 April).
  const { fyWindow, fyMonth } = require('./reportContext');
  const _fy = fyWindow(fyMonth(params.fy_start_month));
  return { from: from || _fy.from, to: to || _fy.to };
}

// The day before `from` — the balance-sheet "opening" snapshot date.
function dayBefore(dateStr) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - 1);
  return ymd(d);
}

const CASH_RE = /\b(cash|bank|petty\s*cash|cash\s*equivalents?|current\s*account|savings)\b/i;
const EARNINGS_RE = /\b(current year earnings|retained earnings|net (profit|loss|income)|profit & loss|reserves?)\b/i;

// Walk a transformed Balance Sheet into { name → { value, bucket } } leaf map.
// bucket ∈ cash | opAsset | invAsset | opLiab | finLiab | finEquity | skip.
function classifyBalanceSheet(report) {
  const valKey = (report?.columns || []).find((c, i) => i > 0)?.key || 'c1';
  const out = new Map();
  let side = null; // asset | liab | equity
  let sub = null; // currentAsset | fixedAsset | currentLiab | longLiab | equity
  for (const row of report?.rows || []) {
    if (row.isHeader) {
      const l = String(row.label || '').toLowerCase();
      if (/^assets?$/.test(l)) { side = 'asset'; sub = 'currentAsset'; }
      else if (/^liabilit/.test(l)) { side = 'liab'; sub = 'currentLiab'; }
      else if (/equity/.test(l)) { side = 'equity'; sub = 'equity'; }
      else if (/current asset/.test(l)) { side = 'asset'; sub = 'currentAsset'; }
      else if (/(fixed|non.?current|other) asset/.test(l)) { side = 'asset'; sub = 'fixedAsset'; }
      else if (/current liab/.test(l)) { side = 'liab'; sub = 'currentLiab'; }
      else if (/(non.?current|term|long.?term) liab/.test(l)) { side = 'liab'; sub = 'longLiab'; }
      continue;
    }
    if (row.isTotal || row.isSubtotal) continue; // section totals — recomputed
    if ((row.level || 0) < 1) continue; // level-0 plain rows ("Net Assets") — skip
    if (!side) continue;
    const name = row.label;
    const value = num(row.cells?.[valKey]);
    let bucket;
    if (side === 'asset') {
      if (CASH_RE.test(name)) bucket = 'cash';
      else if (sub === 'fixedAsset') bucket = 'invAsset';
      else bucket = 'opAsset';
    } else if (side === 'liab') {
      bucket = sub === 'longLiab' ? 'finLiab' : 'opLiab';
    } else { // equity
      bucket = EARNINGS_RE.test(name) ? 'skip' : 'finEquity';
    }
    out.set(name, { value, bucket });
  }
  return out;
}

// Net Profit/(Loss) for the period from the P&L "Net Profit" line (level-0 plain
// row in Xero's payload), falling back to income − cost of sales − expenses.
function extractNetProfit(pl) {
  const valKey = (pl?.columns || []).find((c, i) => i > 0)?.key || 'c1';
  for (const row of pl?.rows || []) {
    if (/^net (profit|loss|income)/i.test(String(row.label || '')) && row.cells && row.cells[valKey] != null) {
      return num(row.cells[valKey]);
    }
  }
  // Fallback: sum section leaves.
  let income = 0; let cos = 0; let exp = 0; let section = null;
  for (const row of pl?.rows || []) {
    if (row.isHeader) {
      const s = String(row.label || '').toLowerCase();
      if (s.includes('cost of sales') || s.includes('cost of goods')) section = 'cos';
      else if (s.includes('expense')) section = 'exp';
      else if (s.includes('income') || s.includes('revenue')) section = 'income';
      else section = section; // keep
      continue;
    }
    if (row.isTotal || row.isSubtotal || (row.level || 0) < 1 || !section) continue;
    const v = num(row.cells?.[valKey]);
    if (section === 'income') income += v;
    else if (section === 'cos') cos += v;
    else exp += v;
  }
  return income - cos - exp;
}

async function buildXeroCashFlow(userId, params = {}) {
  const xeroReports = require('./xeroReportsService'); // lazy: avoids require cycle

  const { from, to } = resolveRange(params);
  const openingDate = dayBefore(from);

  const [pl, bsOpen, bsClose] = await Promise.all([
    xeroReports.fetchReport(userId, 'profitandloss', { from_date: from, to_date: to }),
    xeroReports.fetchReport(userId, 'balancesheet', { to_date: openingDate }),
    xeroReports.fetchReport(userId, 'balancesheet', { to_date: to }),
  ]);

  const currency = pl.currency || bsClose.currency || 'USD';
  const netProfit = extractNetProfit(pl);

  const startMap = classifyBalanceSheet(bsOpen);
  const endMap = classifyBalanceSheet(bsClose);

  // Per-account delta (end − start), tagged with its (closing) bucket.
  const names = new Set([...startMap.keys(), ...endMap.keys()]);
  const deltas = []; // { name, bucket, delta }
  for (const name of names) {
    const s = startMap.get(name);
    const e = endMap.get(name);
    const bucket = e?.bucket || s?.bucket || 'skip';
    const delta = num(e?.value) - num(s?.value);
    if (delta !== 0) deltas.push({ name, bucket, delta });
  }

  const cashFlowOf = (bucket, delta) => {
    // Asset increases consume cash (negative); liability/equity increases provide cash (positive).
    if (bucket === 'opAsset' || bucket === 'invAsset') return -delta;
    if (bucket === 'opLiab' || bucket === 'finLiab' || bucket === 'finEquity') return delta;
    return 0;
  };

  const cashOpening = [...startMap.values()].filter((v) => v.bucket === 'cash').reduce((s, v) => s + v.value, 0);

  const rows = [];
  const c1 = (v) => ({ c1: v });

  // ── Operating ──
  rows.push({ label: 'Cash Flows from Operating Activities', isHeader: true, level: 0 });
  rows.push({ label: 'Net Profit/(Loss)', level: 1, cells: c1(netProfit) });
  let operating = netProfit;
  const opMoves = deltas
    .filter((d) => d.bucket === 'opAsset' || d.bucket === 'opLiab')
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const d of opMoves) {
    const cf = cashFlowOf(d.bucket, d.delta);
    operating += cf;
    const verb = d.bucket === 'opAsset' ? '(Increase)/decrease in' : 'Increase/(decrease) in';
    rows.push({ label: `${verb} ${d.name}`, level: 1, cells: c1(cf) });
  }
  rows.push({ label: 'Net Cash from Operating Activities', isSubtotal: true, level: 0, cells: c1(operating) });

  // ── Investing ──
  const invMoves = deltas.filter((d) => d.bucket === 'invAsset').sort((a, b) => a.name.localeCompare(b.name));
  let investing = 0;
  if (invMoves.length) {
    rows.push({ label: 'Cash Flows from Investing Activities', isHeader: true, level: 0 });
    for (const d of invMoves) {
      const cf = cashFlowOf(d.bucket, d.delta);
      investing += cf;
      rows.push({ label: `(Purchase)/sale of ${d.name}`, level: 1, cells: c1(cf) });
    }
    rows.push({ label: 'Net Cash from Investing Activities', isSubtotal: true, level: 0, cells: c1(investing) });
  }

  // ── Financing ──
  const finMoves = deltas
    .filter((d) => d.bucket === 'finLiab' || d.bucket === 'finEquity')
    .sort((a, b) => a.name.localeCompare(b.name));
  let financing = 0;
  if (finMoves.length) {
    rows.push({ label: 'Cash Flows from Financing Activities', isHeader: true, level: 0 });
    for (const d of finMoves) {
      const cf = cashFlowOf(d.bucket, d.delta);
      financing += cf;
      rows.push({ label: d.name, level: 1, cells: c1(cf) });
    }
    rows.push({ label: 'Net Cash from Financing Activities', isSubtotal: true, level: 0, cells: c1(financing) });
  }

  const netChange = operating + investing + financing;
  rows.push({ label: 'Net Increase/(Decrease) in Cash', isTotal: true, level: 0, cells: c1(netChange) });
  rows.push({ label: 'Cash and cash equivalents at beginning of period', level: 1, cells: c1(cashOpening) });
  rows.push({ label: 'Cash and cash equivalents at end of period', isSubtotal: true, level: 0, cells: c1(cashOpening + netChange) });

  const columns = [
    { key: 'label', label: '', align: 'left' },
    { key: 'c1', label: 'Total', align: 'right' },
  ];

  return {
    columns,
    rows,
    currency,
    meta: {
      title: 'Cash Flow Statement',
      basis: 'Accrual (indirect method)',
      from,
      to,
      source: 'xero-pnl-bs',
    },
  };
}

module.exports = { buildXeroCashFlow };
