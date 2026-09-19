'use strict';

/**
 * General-ledger-derived reports: Balance Sheet, Trial Balance, General Ledger.
 * -------------------------------------------------------------------------
 * Computed directly from `account_transactions` — the full, balanced
 * double-entry general ledger already synced into our database (every posting
 * classified by account_group asset/liability/equity/income/expense with debit
 * & credit). This keeps these reports working WITHOUT spending Zoho's
 * 1,000-calls/day-per-org quota and WITHOUT depending on a live OAuth token.
 *
 * Each builder returns the same { columns, rows, currency } shape the frontend
 * report viewer (ReportTable) already renders, identical to the live Zoho
 * transforms (transformBS / transformTB / transformGL), so no UI change.
 *
 * When the org has NO ledger rows (never synced), the builder returns the
 * sentinel { _noLocalData: true } so the route transparently falls back to the
 * live Zoho fetch — no empty reports, no regression.
 *
 * Sign conventions (verified against the live data, GL is balanced ΣDr==ΣCr):
 *  - asset:   debit-normal  → balance = Σdebit − Σcredit
 *  - liability/equity: credit-normal → balance = Σcredit − Σdebit
 *  - income:  credit-normal, expense: debit-normal → Net Income folds into
 *    equity as "Current Year Earnings" so Assets == Liabilities + Equity.
 */

const pool = require('../config/db');
// Reuse the exact period logic (interval splitting + compare period/year) the
// P&L builder uses, so the Balance Sheet's "Display columns by" / "Compare to"
// columns line up identically.
const { buildPeriods } = require('./zohoLedgerReportsService');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function r2(n) {
  return Math.round(num(n) * 100) / 100;
}

// Cross-platform Retained-Earnings-family label matcher — common synonyms
// covered explicitly (Zoho/QuickBooks/Xero all differ here), matched as a
// PREFIX (not anchored at the end) so a synced account with a dedup suffix
// ("Retained Earnings9", from a platform renaming a clashing account name)
// still matches. account_type_code carries no finer subtype than a flat
// 'equity' in any connected platform's synced chart today, so the label is
// the only reliable signal available — `entry.isRetainedEarnings` is checked
// first so a future platform adapter can supply a real metadata flag (an
// account-level tag, a parent/child hierarchy walk, …) without this matcher
// changing shape.
const RETAINED_EARNINGS_RE = /^(retained\s+earnings?|accumulated\s+(earnings?|profits?|surplus)|retained\s+(profits?|surplus))/i;
function isRetainedEarningsAccount(entry) {
  if (entry && entry.isRetainedEarnings) return true;
  return RETAINED_EARNINGS_RE.test(String((entry && entry.name) || '').trim());
}

// Resolve the org to report on: an explicit org (X-Org-Id switcher) wins,
// otherwise fall back to the connection's primary org.
async function resolveOrgId(userId, params) {
  if (params.org_id) return params.org_id;
  // Check Zoho (zb_tokens.org_id), Xero (xero_tokens.tenant_id),
  // QuickBooks (qbo_tokens.realm_id) — in that order.
  const [[zb]] = await pool.execute(
    'SELECT org_id FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1',
    [userId]
  );
  if (zb?.org_id) return zb.org_id;
  const [[xt]] = await pool.execute(
    'SELECT tenant_id AS org_id FROM xero_tokens WHERE user_id = ? AND tenant_id IS NOT NULL LIMIT 1',
    [userId]
  );
  if (xt?.org_id) return xt.org_id;
  const [[qt]] = await pool.execute(
    'SELECT realm_id AS org_id FROM qbo_tokens WHERE user_id = ? AND realm_id IS NOT NULL LIMIT 1',
    [userId]
  );
  return qt?.org_id || null;
}

// The platform this report is scoped to ('zoho' | 'quickbooks' | 'xero'),
// matching the static lowercase `platform` column on account_transactions.
// Passed → every query also filters by platform; absent → org_id scoping alone
// (identical to prior behavior, so no existing flow breaks).
function resolvePlatform(params) {
  return params.platform ? String(params.platform).toLowerCase() : null;
}

// As-of date for cumulative reports (BS / TB). Mirrors the warehouse aging
// helpers: explicit as_of_date wins, else the period's To date, else today.
function resolveAsOf(params) {
  const cand = params.as_of_date || params.to_date || params.date_end;
  if (cand && !Number.isNaN(Date.parse(cand))) return String(cand).slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

// Fiscal-year start month (1..12) for this request. Comes from the per-platform
// Settings feature via `params.fy_start_month`; defaults to 4 (1 April).
function fyMonthOf(params) {
  const n = Number(params && params.fy_start_month);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 4;
}

// Period window for the General Ledger (default: the fiscal year containing today
// for the configured start month).
function resolveRange(params) {
  const to = params.to_date || params.date_end || null;
  const from = params.from_date || params.date_start || null;
  if (from && to) return { from, to };
  const m = fyMonthOf(params);
  const now = new Date();
  const y = (now.getMonth() + 1) >= m ? now.getFullYear() : now.getFullYear() - 1;
  const fyFrom = `${y}-${String(m).padStart(2, '0')}-01`;
  const fyTo = m === 1
    ? `${y}-12-31`
    : `${y + 1}-${String(m - 1).padStart(2, '0')}-${String(new Date(y + 1, m - 1, 0).getDate()).padStart(2, '0')}`;
  return { from: from || fyFrom, to: to || fyTo };
}

// Resolve the org and confirm it has ledger rows; null → caller returns the
// _noLocalData sentinel so the route falls back to the live Zoho report.
async function orgWithLedger(userId, params) {
  const orgId = await resolveOrgId(userId, params);
  if (!orgId) return null;
  const platform = resolvePlatform(params);
  const platClause = platform ? ' AND platform = ?' : '';
  const args = platform ? [userId, orgId, platform] : [userId, orgId];
  const [[c]] = await pool.execute(
    `SELECT COUNT(*) AS n FROM account_transactions WHERE user_id = ? AND org_id = ?${platClause}`,
    args
  );
  return num(c?.n) > 0 ? orgId : null;
}

const NO_LOCAL = { _noLocalData: true };

// ── Trial Balance ───────────────────────────────────────────────────────────
// Every ledger account in the layout the platforms export, one flat list:
//
//   Account Code | Account | Account Type
//                | Opening Balance | Debit - Year to date | Credit - Year to date
//                | Closing Balance
//
// Opening Balance is the account's cumulative balance the day before the
// period. The two year-to-date columns carry the period's NET movement on
// whichever side it lands — an expense account that was net credited for the
// year prints in the Credit column, exactly as Xero shows it — so the two
// columns always total to the same figure. Closing Balance is the opening plus
// that movement.
//
// Every balance is debit-positive, so credit-side accounts (revenue,
// liabilities, equity) read negative and the report closes at zero.
//
// Accounts are listed the way the platforms list them: profit and loss first
// (income, then expenses), then the balance sheet (assets, liabilities,
// equity), each ordered by account code.
//
// Xero's Trial-Balance true-up plugs are cumulative corrections of everything
// posted before the ledger's last day, not activity of the period they happen
// to be dated in, so they count towards the opening balance. That leaves the
// year-to-date columns showing the period's real trading and the closing
// balance still equal to the figure Xero itself reports. The plugs balance
// among themselves, so moving them keeps the report closing at zero.

// Account code / type come from whichever chart the connected platform syncs;
// QuickBooks syncs none, so its accounts fall back to what the ledger records.
const { accountMeta, getBaseCurrency, prettyEnum } = require('./zohoChartOfAccountsService');

const TB_GROUP_ORDER = ['income', 'expense', 'asset', 'liability', 'equity'];

// Codes are strings but read as numbers ("707.10" sits between 707 and 708),
// and an account without a code leads its section, as the platforms print it.
function byAccountCode(a, b) {
  const ca = (a.code || '').trim();
  const cb = (b.code || '').trim();
  if (ca && cb) {
    const na = Number(ca);
    const nb = Number(cb);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    const cmp = ca.localeCompare(cb, undefined, { numeric: true });
    if (cmp !== 0) return cmp;
  } else if (ca !== cb) {
    return ca ? 1 : -1;
  }
  return String(a.name || '').localeCompare(String(b.name || ''));
}

// One day before `dateStr` ('YYYY-MM-DD'), UTC-safe.
function dayBeforeISO(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function buildTrialBalance(userId, params = {}) {
  const orgId = await orgWithLedger(userId, params);
  if (!orgId) return NO_LOCAL;
  const platform = resolvePlatform(params);
  const asOf = resolveAsOf(params);
  // "Year to date" runs from the start of the requested period, or from the
  // start of the fiscal year the as-of date falls in when none was requested.
  let from = params.from_date || params.date_start || fyStartFor(asOf, fyMonthOf(params));
  // Guard against an inverted range (from > asOf) — not something the app's
  // own UI constructs, but a caller could pass one by mistake. A zero-length
  // window (opening snapshot == closing snapshot, so every account's
  // movement is 0) is the only sane degenerate reading of "from after to".
  const inverted = from > asOf;
  if (inverted) from = asOf;
  const fyStartMonth = fyMonthOf(params);

  // Opening and closing balances come from aggregateBS — the SAME point-in-
  // time engine the Balance Sheet report and the Key Ratios engine use, so a
  // Trial Balance can never quietly disagree with either about what an
  // account's balance was on a given date (this used to be a separate,
  // hand-rolled query here). `earningsFrom: from` on the closing call splits
  // each P&L account's activity into "up to `from`" (prior, zeroed below —
  // platforms reset P&L accounts each fiscal year) and "from `from` to
  // `asOf`" (the YTD movement this report shows).
  const currencyCode = params.currency_code ? String(params.currency_code).toUpperCase() : null;
  const [closing, opening] = await Promise.all([
    aggregateBS(userId, orgId, platform, asOf, from, fyStartMonth, currencyCode),
    aggregateBS(userId, orgId, platform, inverted ? asOf : dayBeforeISO(from), null, fyStartMonth, currencyCode),
  ]);

  const meta = await accountMeta(userId, orgId).catch(() => new Map());
  const currency = await getBaseCurrency(orgId);

  // An account with no opening balance and no movement has nothing to report.
  // Skip unless an include-zeros param is set (matches QBO/Zero-balance format).
  // Accepts every key the UI/backends emit: include_zero (the frontend's),
  // include_zero_balance / show_zeros (older API callers).
  const showZeros = params.include_zero_balance || params.show_zeros
    || params.include_zero === '1' || params.include_zero === 1 || params.include_zero === true || false;

  const accounts = [];

  // Balance Sheet accounts (asset / liability / equity). aggregateBS signs
  // assets debit-positive (dr−cr), matching this report's own convention as-
  // is; liabilities and equity are credit-positive (cr−dr) there, so negate
  // them back. Synthetic lines aggregateBS adds when the ledger itself
  // doesn't carry a Retained Earnings account, or to plug a genuine data
  // imbalance, use non-numeric ids ("__…") and are skipped — this report only
  // ever lists real synced accounts, same as before this change. Their
  // amount (if any) is still reflected in the grand total below via
  // `priorEarningsTotal`, exactly like the old plOpeningSum adjustment did.
  const BS_GROUPS = [
    ['asset', closing.assets, opening.assets, 1],
    ['liability', closing.liabilities, opening.liabilities, -1],
    ['equity', closing.equity, opening.equity, -1],
  ];
  for (const [groupName, closeMap, openMap, sign] of BS_GROUPS) {
    const ids = new Set([...closeMap.keys(), ...openMap.keys()]);
    for (const id of ids) {
      if (String(id).startsWith('__')) continue;
      const c = closeMap.get(id);
      const o = openMap.get(id);
      const closingBal = r2(sign * (c ? c.amount : 0));
      const openingBal = r2(sign * (o ? o.amount : 0));
      const movement = r2(closingBal - openingBal);
      if (!showZeros && openingBal === 0 && movement === 0 && closingBal === 0) continue;
      const typeCode = (c || o)?.typeCode || null;
      const name = (c || o)?.name;
      const m = meta.get(String(id).toLowerCase());
      accounts.push({
        ref: id,
        code: m?.code || '',
        name: m?.name || name || '(Unnamed)',
        type: m?.type || prettyEnum(typeCode),
        typeCode,
        groupRaw: groupName,
        group: m?.group || groupName,
        opening: openingBal,
        debit: movement > 0 ? movement : 0,
        credit: movement < 0 ? -movement : 0,
        closing: closingBal,
        isPL: false,
      });
    }
  }

  // P&L accounts (income / expense). Opening is always 0 — platforms reset
  // P&L accounts at the start of each fiscal year, so a Trial Balance never
  // carries an opening balance for them, only the YTD movement — sourced
  // from a dedicated query, NOT aggregateBS's pnl map. aggregateBS always
  // includes Xero's trial-balance true-up "recon" plugs regardless of date
  // (correct for a point-in-time Balance Sheet — they're a real balance
  // correction — but wrong here, since a plug isn't a real transaction
  // within this period and would leak into the YTD movement column). This
  // mirrors exactly what the previous single-query implementation did for
  // P&L accounts: movement excludes recon rows; the pre-`from` portion
  // (recon rows included, same as an account's real opening balance would)
  // is tracked so the grand total below still balances.
  const platClause = platform ? ' AND platform = ?' : '';
  const currClause = currencyCode ? ' AND currency_code = ?' : '';
  const plScope = platform ? [userId, orgId, platform] : [userId, orgId];
  // For the degenerate inverted-range case, `openingBoundary` matches asOf
  // inclusively (`<=`) rather than `from` exclusively (`<`) — with `from`
  // already clamped to `asOf`, an exclusive bound would drop same-day
  // transactions from the "prior" total, subtly unbalancing the grand total
  // below purely as an artifact of the clamp, not a real gap in the data.
  const [plRows] = await pool.execute(
    `SELECT account_id,
            MAX(account_name)      AS name,
            account_group, account_type_code,
            SUM(CASE WHEN transaction_date IS NULL
                          OR transaction_date ${inverted ? '<=' : '<'} ?
                          OR transaction_id LIKE 'xero-recon:%'
                     THEN debit - credit ELSE 0 END) AS opening_raw,
            SUM(CASE WHEN transaction_date BETWEEN ? AND ?
                      AND transaction_id NOT LIKE 'xero-recon:%'
                     THEN debit  ELSE 0 END) AS d,
            SUM(CASE WHEN transaction_date BETWEEN ? AND ?
                      AND transaction_id NOT LIKE 'xero-recon:%'
                     THEN credit ELSE 0 END) AS c
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?${platClause}
        AND account_group IN ('income', 'expense')
        AND (transaction_date IS NULL OR transaction_date <= ?
             OR transaction_id LIKE 'xero-recon:%')${currClause}
      GROUP BY account_id, account_group, account_type_code`,
    [from, from, asOf, from, asOf, ...plScope, asOf, ...(currencyCode ? [currencyCode] : [])]
  );

  let plOpeningSum = 0; // running sum of zeroed-out P&L openings — restores grand-total balance below
  for (const a of plRows) {
    const rawOpening = r2(a.opening_raw);
    plOpeningSum += rawOpening;
    // Inverted range → zero-length window by definition (see the BS-side
    // opening snapshot above, which now equals the closing snapshot exactly).
    const movement = inverted ? 0 : r2(num(a.d) - num(a.c));
    if (!showZeros && movement === 0) continue;
    const m = meta.get(String(a.account_id).toLowerCase());
    accounts.push({
      ref: a.account_id,
      code: m?.code || '',
      name: m?.name || a.name || '(Unnamed)',
      type: m?.type || prettyEnum(a.account_type_code),
      typeCode: a.account_type_code || null,
      groupRaw: a.account_group,
      group: m?.group || a.account_group,
      opening: 0,
      debit: movement > 0 ? movement : 0,
      credit: movement < 0 ? -movement : 0,
      closing: movement,
      isPL: true,
    });
  }

  accounts.sort((a, b) => {
    const ga = TB_GROUP_ORDER.indexOf(a.group);
    const gb = TB_GROUP_ORDER.indexOf(b.group);
    if (ga !== gb) return (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb);
    return byAccountCode(a, b);
  });

  // Only Xero numbers its chart; Zoho and QuickBooks leave codes blank and
  // print no code column on their own trial balances, so neither do we.
  const hasCodes = accounts.some((a) => a.code);

  const columns = [
    ...(hasCodes
      ? [{ key: 'label',   label: 'Account Code', align: 'left' },
         { key: 'account', label: 'Account',      align: 'left' }]
      : [{ key: 'label',   label: 'Account',      align: 'left' }]),
    { key: 'type',    label: 'Account Type',          align: 'left'  },
    { key: 'opening', label: 'Opening Balance',       align: 'right' },
    { key: 'debit',   label: 'Debit - Year to date',  align: 'right' },
    { key: 'credit',  label: 'Credit - Year to date', align: 'right' },
    { key: 'closing', label: 'Closing Balance',       align: 'right' },
  ];

  const rows = [];
  let totalD = 0;
  let totalC = 0;
  let totalClose = 0;
  for (const a of accounts) {
    rows.push({
      label: hasCodes ? a.code : a.name,
      level: 1,
      accountRef: a.ref,
      accountName: a.name,
      cells: {
        account: a.name,
        type: a.type,
        opening: a.opening,
        debit: a.debit || null,
        credit: a.credit || null,
        closing: a.closing,
      },
    });
    totalD += a.debit;
    totalC += a.credit;
    totalClose += a.closing;
  }

  // The closing column on P&L rows was zeroed (opening removed), so the
  // grand total no longer nets to zero.  The gap equals the P&L opening sum
  // that was absorbed into Retained Earnings by the platforms' own year-end
  // close.  We show a balanced total by adding it back as an invisible
  // adjustment so the TB renders as balanced (matching the platforms).
  const adjClose = r2(totalClose + plOpeningSum);

  rows.push({
    label: 'Total',
    isTotal: true,
    level: 0,
    cells: { debit: r2(totalD), credit: r2(totalC), closing: adjClose },
  });

  return {
    columns,
    rows,
    currency,
    // Flat, pre-format account list so other builders (Budget Summary) can
    // reshape the exact same account set + balances without re-querying the
    // ledger. Each entry: { ref, code, name, type, group, opening, debit,
    // credit, closing } — closing is debit-positive; for P&L accounts it is the
    // period's net movement (opening zeroed), for BS accounts the cumulative
    // balance as of `asOf`.
    accounts,
    meta: { title: 'Trial Balance', from, to: asOf, asOf, basis: 'Accrual', source: 'ledger' },
  };
}

// ── Balance Sheet ─────────────────────────────────────────────────────────
// Cumulative account balances as of a date. Assets (debit-normal) vs
// Liabilities + Equity (credit-normal), with current-year earnings (net income
// to date) folded into Equity so the sheet balances. Matches transformBS:
// cols [label, amount], sections with headers + leaf accounts + subtotals.
//
// A Balance Sheet is point-in-time, so the viewer's "Display columns by"
// (interval) and "Compare to" (previous period / year) controls map to one
// column per period END date — each column is the cumulative balance as of that
// period's `to`. With neither control the output is the original single
// "Total" column, byte-identical to before.

// Fiscal-year start for the year containing `asOf`, for the configured start
// month (default 4 = 1 April). Income/expense before this date is prior-year
// accumulated earnings (rolled into Retained Earnings); on/after it is the
// current-year Net Income.
function fyStartFor(asOf, fyStartMonth = 4) {
  const m = Number.isInteger(fyStartMonth) && fyStartMonth >= 1 && fyStartMonth <= 12 ? fyStartMonth : 4;
  const d = new Date(asOf);
  const y = (d.getMonth() + 1) >= m ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

// Cumulative balances for one as-of date, bucketed into asset/liability/equity
// account maps (id → {name, amount}) plus the current-year net income.
//
// Income/expense are split at the fiscal-year boundary from the raw debit/credit
// rows: the prior-year portion is folded into Retained Earnings (matching how
// QuickBooks/Xero roll closed years forward), and only the current fiscal year's
// income − expense remains as `netIncome` (the "Current Year Earnings" line).
async function aggregateBS(userId, orgId, platform, asOf, earningsFrom = null, fyStartMonth = 4, currencyCode = null) {
  // A Balance Sheet is a POSITION, not a movement: every posting on/before `asOf`
  // counts and the Xero trial-balance true-up plugs (transaction_id LIKE
  // 'xero-recon:%') are always included — they are the opening baseline that
  // makes the banks reconcile to Xero and keeps the ledger self-balancing. This
  // is true for ANY date range, so the account balances never depend on a
  // "From" date.
  //
  // `earningsFrom` (the optional From date) only moves the split point between
  // Current Year Earnings (P&L in [earningsFrom, asOf]) and Retained/Prior Year
  // Earnings (P&L before earningsFrom). The two always sum to total accumulated
  // earnings, so the sheet balances (Assets = Liabilities + Equity) whatever the
  // From date is. Defaults to the fiscal-year start of the as-of date.
  const splitAt = earningsFrom || fyStartFor(asOf, fyStartMonth);
  const platClause = platform ? ' AND platform = ?' : '';
  // Optional per-transaction currency filter (multi-currency orgs only — a
  // no-op for every single-currency org, which is 100% of local test data).
  // Purely additive: every existing caller passes nothing, so this can never
  // change behavior for them.
  const currClause = currencyCode ? ' AND currency_code = ?' : '';
  const args = platform
    ? [splitAt, splitAt, userId, orgId, platform, asOf]
    : [splitAt, splitAt, userId, orgId, asOf];
  if (currencyCode) args.push(currencyCode);
  const [accts] = await pool.execute(
    `SELECT account_id,
            MAX(account_name) AS account_name,
            account_group, account_type_code,
            SUM(debit)  AS d,
            SUM(credit) AS c,
            SUM(CASE WHEN transaction_date < ? THEN debit  ELSE 0 END) AS d_prior,
            SUM(CASE WHEN transaction_date < ? THEN credit ELSE 0 END) AS c_prior
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?${platClause}
        AND (transaction_date <= ?
             OR transaction_id LIKE 'xero-recon:%')${currClause}
      GROUP BY account_id, account_group, account_type_code
      ORDER BY account_name ASC`,
    args
  );
  const assets = new Map();
  const liabilities = new Map();
  const equity = new Map();

  // One line per account, as the platforms print it. The query groups by type
  // code as well as account, and an account can carry more than one — Xero
  // files some of its Accounts Payable postings under `other_current_liability`
  // — so a second row must ADD to the account, never replace it, or the balance
  // is reported short by whatever the other row held.
  const put = (map, a, bal) => {
    const id = String(a.account_id);
    const cur = map.get(id);
    if (cur) { cur.amount = r2(cur.amount + bal); return; }
    map.set(id, {
      accountId: a.account_id,
      name: a.account_name,
      amount: r2(bal),
      typeCode: a.account_type_code || null,
    });
  };

  let currentYearEarnings = 0; // current-FY income (cr−dr) − expense (dr−cr)
  let priorEarnings = 0;       // pre-FY income − expense → Retained Earnings

  // Per-account P&L detail so the synthetic equity lines (Current Year Earnings,
  // Retained / Prior Year Earnings) can be broken down to the income/expense
  // accounts that make them up — purely for the report's drill-down, it does not
  // affect any figure. `current` / `prior` are signed as they land in earnings
  // (income adds, expense subtracts).
  const pnl = new Map();
  const addPnl = (a, current, prior) => {
    const id = String(a.account_id);
    const cur = pnl.get(id);
    if (cur) { cur.current = r2(cur.current + current); cur.prior = r2(cur.prior + prior); return; }
    pnl.set(id, {
      accountId: a.account_id,
      name: a.account_name,
      group: a.account_group,
      typeCode: a.account_type_code || null,
      current: r2(current),
      prior: r2(prior),
    });
  };

  for (const a of accts) {
    const dr = num(a.d);
    const cr = num(a.c);
    const drPrior = num(a.d_prior);
    const crPrior = num(a.c_prior);
    if (a.account_group === 'asset') {
      put(assets, a, dr - cr);
    } else if (a.account_group === 'liability') {
      put(liabilities, a, cr - dr);
    } else if (a.account_group === 'equity') {
      put(equity, a, cr - dr);
    } else if (a.account_group === 'income') {
      const prior = crPrior - drPrior;
      const current = (cr - dr) - prior;
      priorEarnings += prior;
      currentYearEarnings += current;
      addPnl(a, current, prior);
    } else if (a.account_group === 'expense') {
      const prior = drPrior - crPrior;
      const current = (dr - cr) - prior;
      priorEarnings -= prior;
      currentYearEarnings -= current;
      addPnl(a, -current, -prior);
    }
  }

  // "Xero Payments Clearing" is a synthetic account the posting engine uses to
  // park invoice/bill settlement cash (Xero won't disclose the paying bank).
  // Xero's own Balance Sheet has no such account, and the trial-balance true-up
  // already corrects the real bank balances, so it must never surface here.
  // Drop it whatever its balance — at the current as-of the true-up nets it to
  // ~0 — and fold any residual into retained earnings so Assets = L + E holds.
  let clearingResidual = 0;
  for (const map of [assets, liabilities, equity]) {
    for (const [id, v] of map) {
      if (String(id) === 'XERO-CLEARING' || /xero payments clearing/i.test(v.name || '')) {
        clearingResidual += (map === assets ? v.amount : -v.amount);
        map.delete(id);
      }
    }
  }
  if (clearingResidual) priorEarnings = r2(priorEarnings + clearingResidual);

  // An account that nets to nothing is not printed, as before.
  for (const map of [assets, liabilities, equity]) {
    for (const [id, v] of map) if (v.amount === 0) map.delete(id);
  }

  // Retained Earnings — accumulated, not-yet-distributed prior-year P&L — is
  // derived the SAME way for every platform; nothing here branches on which
  // one this org is connected to:
  //   1. Find every equity account that IS a Retained-Earnings-family account
  //      (see isRetainedEarningsAccount — label match today, extensible to a
  //      platform-supplied metadata flag). A chart of accounts can carry more
  //      than one (a renamed/duplicated account, e.g. Xero's "Retained
  //      Earnings" + "Retained Earnings9") — merge them into ONE combined
  //      balance instead of printing each as its own row.
  //   2. Add `priorEarnings` (the ORGANIC pre-FY P&L not yet booked to any
  //      equity account — true-up/reconciliation plugs excluded, see the query
  //      above) on top. This never double-counts against step 1: a genuine
  //      prior-years closing/opening-balance entry and the organic P&L for
  //      LATER, still-unclosed years are non-overlapping periods by
  //      construction — the platform simply hasn't posted a closing entry for
  //      the later years yet.
  //   3. Exactly one real match → fold the combined total into IT, keeping its
  //      real account id (so Trial Balance / General Ledger keep showing that
  //      same ledger account, unaffected by this merge). Multiple matches
  //      collapse into the first (alphabetically, since accounts are queried
  //      ordered by name) and the rest are dropped from the map. No match at
  //      all → a synthetic "Retained Earnings" line, as before.
  priorEarnings = r2(priorEarnings);
  const reMatches = [...equity.entries()].filter(([, v]) => isRetainedEarningsAccount(v));
  const reOwnBalance = r2(reMatches.reduce((s, [, v]) => s + v.amount, 0));
  const retainedEarnings = r2(reOwnBalance + priorEarnings);
  if (reMatches.length > 0 || priorEarnings !== 0) {
    for (const [id] of reMatches) equity.delete(id);
    if (retainedEarnings !== 0) {
      const [firstId, firstEntry] = reMatches[0] || [];
      equity.set(firstEntry ? firstId : '__retained_earnings__', {
        accountId: firstEntry ? firstEntry.accountId : null,
        name: 'Retained Earnings',
        amount: retainedEarnings,
        typeCode: 'equity',
      });
    }
  }

  // ── Balance Correction ─────────────────────────────────────────────────
  // Dynamically detect any BS imbalance (Assets ≠ Liab+Eq+CYE) and absorb
  // it as a "Ledger Correction" line in equity.  This handles:
  //  • ACCREC invoice tax lines wrongly posted to GST Payable (sync bug)
  //  • Deleted/corrected entries that broke double-entry balance
  //  • Any other ledger data inconsistency
  // The correction is computed after ALL sections are assembled so it
  // automatically adapts to future data changes.
  const totalAssets = [...assets.values()].reduce((s, v) => s + v.amount, 0);
  const totalLiab  = [...liabilities.values()].reduce((s, v) => s + v.amount, 0);
  const totalEq    = [...equity.values()].reduce((s, v) => s + v.amount, 0);
  const imbalance  = r2(totalAssets - totalLiab - totalEq - r2(currentYearEarnings));
  if (imbalance !== 0) {
    equity.set('__ledger_correction__', {
      accountId: null, name: 'Ledger Correction', amount: imbalance, typeCode: 'equity',
    });
  }

  return { assets, liabilities, equity, netIncome: r2(currentYearEarnings), pnl };
}

// Xero-style Balance Sheet sub-groups: each section's accounts are bucketed by
// their account_type_code (identical codes across Zoho/QuickBooks/Xero synced
// ledgers) into ordered sub-categories, each with its own sub-total. Any code
// not listed lands in a trailing "Other <Section>" bucket so nothing is lost.
const BS_SUBGROUPS = {
  assets: [
    { key: 'bank',       label: 'Bank',               codes: ['bank', 'cash'] },
    { key: 'current',    label: 'Current Assets',     codes: ['accounts_receivable', 'other_current_asset'] },
    { key: 'fixed',      label: 'Fixed Assets',       codes: ['fixed_asset'] },
    { key: 'noncurrent', label: 'Non-current Assets', codes: ['other_asset'] },
  ],
  liabilities: [
    { key: 'current',    label: 'Current Liabilities',     codes: ['accounts_payable', 'other_current_liability'] },
    { key: 'noncurrent', label: 'Non-current Liabilities', codes: ['long_term_liability'] },
  ],
};

async function buildBalanceSheet(userId, params = {}) {
  const orgId = await orgWithLedger(userId, params);
  if (!orgId) return NO_LOCAL;
  const platform = resolvePlatform(params);

  // Period END dates drive the as-of for each column. Default single period's
  // end == resolveAsOf, so the single-column output is unchanged.
  const { from, to } = resolveRange(params);
  const periods = buildPeriods(from, to, params);
  const asOfList = periods.map((p) => p.to);
  // For the single-column case keep the original as-of semantics exactly.
  const singleAsOf = resolveAsOf(params);
  if (periods.length === 1) asOfList[0] = singleAsOf;

  // Optional "From" date. The Balance Sheet stays a cumulative position as of the
  // To date whatever the From is — so the balances and totals are identical to
  // the "as of" view and always balance for ANY date range. The From only moves
  // the Current-Year-Earnings / Retained-Earnings split point in Equity. Only
  // honoured when it's a valid YYYY-MM-DD earlier than the as-of.
  const rawFrom = params.bs_from || params.balance_from || null;
  const bsFrom = (rawFrom && /^\d{4}-\d{2}-\d{2}$/.test(String(rawFrom).slice(0, 10)))
    ? String(rawFrom).slice(0, 10)
    : null;

  const fyM = fyMonthOf(params);
  // Optional currency filter — scopes the report to one transaction currency
  // for multi-currency orgs (a no-op, `null`, for every single-currency org).
  const currencyCode = params.currency_code ? String(params.currency_code).toUpperCase() : null;
  const perPeriod = await Promise.all(
    asOfList.map((asOf) =>
      aggregateBS(userId, orgId, platform, asOf, bsFrom && bsFrom < asOf ? bsFrom : null, fyM, currencyCode))
  );
  const multi = periods.length > 1;
  const colKey = (i) => (multi ? `c${i}` : 'amount');
  const cellsFrom = (fn) => {
    const cells = {};
    periods.forEach((_, i) => { cells[colKey(i)] = fn(i); });
    return cells;
  };

  // Multi-period (e.g. "Compare Previous Year"): one column per period only —
  // no trailing "Total" column. That column used to show the Trial-Balance
  // Closing Balance (cells.closing, still computed below for anything else
  // that reads it), but next to two period columns it reads as a confusing
  // third value rather than a sum of them, so it's dropped from the rendered/
  // exported column set here.
  const columns = multi
    ? [{ key: 'label', label: 'Account', align: 'left' },
       ...periods.map((p, i) => ({ key: colKey(i), label: p.label, align: 'right' }))]
    : [{ key: 'label', label: 'Account', align: 'left' },
       // Single value column, labelled "Total": the standard balance-sheet
       // presentation (assets, liabilities and equity all shown positive).
       { key: 'amount', label: 'Total', align: 'right' }];

  const rows = [];
  const amt = (mapKey, id, i) => num(perPeriod[i][mapKey].get(id)?.amount);

  // ── Closing Balance column (Trial Balance parity) ─────────────────────
  // Computed with the Trial Balance's own logic and sign convention
  // (debit-positive: assets dr−cr, liabilities/equity dr−cr), as of the LAST
  // period end — the same figure the Trial Balance prints in its Closing
  // Balance column for every account the two reports share. The Balance
  // Sheet's own "Total" column keeps its credit-normal display untouched;
  // this column is purely additive. Because aggregateBS already sums every
  // posted line (recon plugs included) up to the as-of date, the raw
  // cumulative per account IS the TB closing — no extra query needed.
  const lastIdx = periods.length - 1;
  const closingOf = (mapKey, id) => {
    const a = num(perPeriod[lastIdx][mapKey].get(id)?.amount);
    return mapKey === 'assets' ? r2(a) : r2(-a);
  };

  // Union of account ids appearing in a section across all periods, preserving
  // first-seen order + their name/ref/typeCode metadata.
  const collect = (mapKey) => {
    const order = [];
    const seen = new Set();
    const meta = {};
    for (const pp of perPeriod) {
      for (const [id, info] of pp[mapKey]) {
        if (!seen.has(id)) { seen.add(id); order.push(id); meta[id] = info; }
      }
    }
    return { order, meta };
  };

  // Render one Balance Sheet section (Xero style). When `subgroupDefs` is given
  // (Assets / Liabilities) the accounts are bucketed by account_type_code into
  // sub-categories each with a sub-total; otherwise (Equity) the accounts are
  // listed flat. Current-year earnings folds into Equity as a synthetic line so
  // the sheet balances. Returns the per-period section totals.
  // levelOffset lets a section nest under a parent group (e.g. Liabilities and
  // Equity inside "LIABILITIES AND EQUITY"): every row's level shifts by it so
  // the report table's collapse logic (a level-L header hides rows with
  // level > L) keeps working at any depth.
  // A drill-down "breakdown" is attached to every non-leaf line (sub-totals,
  // section totals, the synthetic earnings/correction lines and the grand
  // total) so each figure can be traced to the accounts that make it up — the
  // report viewer renders it as an expandable Component | Amount table and each
  // component with an `accountRef` opens that account's ledger. It is purely
  // additive metadata; no printed figure changes.
  const bd = (items) => items
    .map((x) => ({ label: x.label, amount: r2(x.amount), ...(x.accountRef ? { accountRef: String(x.accountRef) } : {}) }))
    .filter((x) => x.amount !== 0 || x.keepZero);
  const lastPnl = () => (perPeriod[lastIdx] && perPeriod[lastIdx].pnl) || new Map();

  const pushSection = (title, mapKey, subgroupDefs = null, withEarnings = false, levelOffset = 0) => {
    const { order, meta } = collect(mapKey);
    rows.push({ label: title, isHeader: true, level: levelOffset });
    const sectionTotals = periods.map(() => 0);

    // Breakdown for the synthetic equity lines aggregateBS injects (Retained /
    // Prior Year Earnings from pre-split P&L; Ledger Correction = the residual
    // imbalance). Keyed by the placeholder ids aggregateBS uses.
    const syntheticBreakdown = (id) => {
      if (id === '__retained_earnings__' || id === '__prior_earnings__') {
        return bd([...lastPnl().values()]
          .filter((p) => r2(p.prior) !== 0)
          .sort((a, b) => Math.abs(b.prior) - Math.abs(a.prior))
          .map((p) => ({ label: p.name, amount: p.prior, accountRef: p.accountId })));
      }
      if (id === '__ledger_correction__') {
        const pp = perPeriod[lastIdx];
        const ta = [...pp.assets.values()].reduce((s, v) => s + v.amount, 0);
        const tl = [...pp.liabilities.values()].reduce((s, v) => s + v.amount, 0);
        const corr = num(meta[id] && meta[id].amount);
        const teExcl = [...pp.equity.values()].reduce((s, v) => s + v.amount, 0) - corr;
        return bd([
          { label: 'Total Assets', amount: ta, keepZero: true },
          { label: 'less Total Liabilities', amount: -tl, keepZero: true },
          { label: 'less Total Equity (excl. this line)', amount: -teExcl, keepZero: true },
          { label: 'less Current Year Earnings', amount: -num(pp.netIncome), keepZero: true },
          { label: '= Ledger Correction (unexplained imbalance)', amount: corr, keepZero: true },
        ]);
      }
      return undefined;
    };

    const emitLeaves = (ids, level) => {
      for (const id of ids) {
        const synthetic = String(id).startsWith('__') ? syntheticBreakdown(id) : undefined;
        rows.push({
          label: meta[id].name,
          level,
          accountRef: meta[id].accountId || undefined,
          accountName: meta[id].name,
          ...(synthetic && synthetic.length ? { breakdown: synthetic } : {}),
          cells: { ...cellsFrom((i) => amt(mapKey, id, i)), closing: closingOf(mapKey, id) },
        });
      }
    };

    // Component list for a sub-total / section-total row: the leaf accounts it
    // sums (last period's amount, the same basis as the printed column, so the
    // breakdown visibly adds up to the total), each linking to its ledger.
    const leafComponents = (ids) => bd(ids.map((id) => ({
      label: meta[id].name,
      amount: amt(mapKey, id, lastIdx),
      accountRef: meta[id].accountId,
    })));

    if (subgroupDefs && subgroupDefs.length) {
      const codeToGroup = {};
      subgroupDefs.forEach((g) => g.codes.forEach((c) => { codeToGroup[c] = g.key; }));
      const buckets = new Map();
      const groupLabel = {};
      subgroupDefs.forEach((g) => { buckets.set(g.key, []); groupLabel[g.key] = g.label; });
      for (const id of order) {
        const gk = codeToGroup[meta[id].typeCode] || '__other__';
        if (!buckets.has(gk)) { buckets.set(gk, []); groupLabel[gk] = `Other ${title}`; }
        buckets.get(gk).push(id);
      }
      for (const [gk, ids] of buckets) {
        if (!ids.length) continue;
        rows.push({ label: groupLabel[gk], isHeader: true, level: 1 + levelOffset });
        emitLeaves(ids, 2 + levelOffset);
        const subTotals = periods.map((_, i) => r2(ids.reduce((s, id) => s + amt(mapKey, id, i), 0)));
        const subClosing = r2(ids.reduce((s, id) => s + closingOf(mapKey, id), 0));
        rows.push({
          label: `Total ${groupLabel[gk]}`,
          isSubtotal: true,
          level: 1 + levelOffset,
          breakdown: leafComponents(ids),
          cells: { ...cellsFrom((i) => subTotals[i]), closing: subClosing },
        });
        periods.forEach((_, i) => { sectionTotals[i] += subTotals[i]; });
      }
    } else {
      emitLeaves(order, 1 + levelOffset);
      periods.forEach((_, i) => { sectionTotals[i] += order.reduce((s, id) => s + amt(mapKey, id, i), 0); });
    }

    if (withEarnings) {
      const earnings = periods.map((_, i) => perPeriod[i].netIncome);
      if (earnings.some((v) => r2(v) !== 0)) {
        // Current Year Earnings is a credit-normal equity figure, so its TB-parity
        // closing is the negated net income (TB prints equity debit-positive).
        const cyeBreakdown = bd([...lastPnl().values()]
          .filter((p) => r2(p.current) !== 0)
          .sort((a, b) => Math.abs(b.current) - Math.abs(a.current))
          .map((p) => ({ label: p.name, amount: p.current, accountRef: p.accountId })));
        rows.push({
          label: 'Current Year Earnings',
          level: 1 + levelOffset,
          ...(cyeBreakdown.length ? { breakdown: cyeBreakdown } : {}),
          cells: { ...cellsFrom((i) => earnings[i]), closing: r2(-earnings[lastIdx]) },
        });
        periods.forEach((_, i) => { sectionTotals[i] += earnings[i]; });
      }
    }

    // Section total (Total Assets / Total Liabilities / Total Equity): its
    // components are every leaf in the section, plus Current Year Earnings for
    // the equity section.
    const totalComponents = leafComponents(order);
    if (withEarnings && r2(perPeriod[lastIdx].netIncome) !== 0) {
      totalComponents.push({ label: 'Current Year Earnings', amount: r2(perPeriod[lastIdx].netIncome) });
    }
    const totals = sectionTotals.map(r2);
    rows.push({
      label: `Total ${title}`,
      isSubtotal: true,
      level: levelOffset,
      ...(totalComponents.length ? { breakdown: totalComponents } : {}),
      cells: { ...cellsFrom((i) => totals[i]), closing: r2(mapKey === 'assets' ? totals[lastIdx] : -totals[lastIdx]) },
    });
    return totals;
  };

  const totalAssets = pushSection('Assets', 'assets', BS_SUBGROUPS.assets);
  // Liabilities + Equity nested under ONE parent group (QuickBooks export
  // style): "LIABILITIES AND EQUITY" wraps the Liabilities section, the Equity
  // section and the grand total. Assets stays a separate top-level section.
  rows.push({ label: 'LIABILITIES AND EQUITY', isHeader: true, level: 0 });
  const totalLiab = pushSection('Liabilities', 'liabilities', BS_SUBGROUPS.liabilities, false, 1);
  const totalEquity = pushSection('Equity', 'equity', null, true, 1);
  // Grand total (QuickBooks style): Total Liabilities + Total Equity, which ties
  // back to Total Assets when the ledger balances. Same layout for all 3
  // platforms. Level 1 so it lives inside the parent group.
  rows.push({
    label: 'Total Liabilities and Equity',
    isTotal: true,
    level: 1,
    breakdown: [
      { label: 'Total Liabilities', amount: r2(totalLiab[lastIdx]) },
      { label: 'Total Equity', amount: r2(totalEquity[lastIdx]) },
    ].filter((x) => x.amount !== 0),
    cells: { ...cellsFrom((i) => r2(totalLiab[i] + totalEquity[i])), closing: r2(-(totalLiab[lastIdx] + totalEquity[lastIdx])) },
  });

  return {
    columns,
    rows,
    currency: 'INR',
    meta: {
      title: 'Balance Sheet',
      asOf: asOfList[asOfList.length - 1],
      // The From date, when set, only shifts the Current-Year-Earnings split
      // point; balances stay cumulative as of the To date.
      ...(bsFrom ? { earningsFrom: bsFrom } : {}),
      // The ledger stores accrual postings with no cash-settlement flag, so a
      // cash-basis sheet can't be derived here. Report the basis actually used
      // alongside the one requested (same contract as the P&L) so the viewer
      // never labels accrual figures "Cash basis".
      basis: 'Accrual',
      basisRequested: String(params.accounting_basis || params.basis || '').toLowerCase() === 'cash' ? 'Cash' : 'Accrual',
      source: 'ledger',
      totalAssets: totalAssets[0],
      periods: periods.map((p, i) => ({ label: p.label, asOf: asOfList[i] })),
    },
  };
}

// ── General Ledger ──────────────────────────────────────────────────────────
// Every posting line grouped under its account, in each platform's own General
// Ledger layout:
//
//   Date | Transaction Type | Num | Name | Memo/Description | Split | Amount | Balance
//
// Balance-sheet accounts open with a "Beginning Balance" row (their cumulative
// balance the day before the period); profit-and-loss accounts start at zero, as
// every platform's General Ledger does. Each section closes with
// "Total for <account>" carrying the period movement and the closing balance.
//
// Amount is signed by the account's normal side (assets/expenses debit-normal,
// everything else credit-normal), so ordinary activity reads positive in every
// section and the running Balance moves the way the platform shows it.

const GL_DEBIT_NORMAL = new Set(['asset', 'expense']);

// The order the platforms list accounts in — chart-of-accounts order, not
// alphabetical.
const GL_GROUP_ORDER = ['asset', 'liability', 'equity', 'income', 'expense'];

// Each platform's own transaction vocabulary → the label it prints on its
// General Ledger. QuickBooks already stores its printed labels ("Bill Payment
// (Check)", "Journal Entry", …), so only Zoho's enums and Xero's document types
// need translating.
const GL_TYPE_LABEL = {
  // Zoho
  invoice: 'Invoice', bill: 'Bill', expense: 'Expense', journal: 'Journal Entry',
  customer_payment: 'Payment', vendor_payment: 'Bill Payment',
  credit_note: 'Credit Note', vendor_credit: 'Vendor Credit',
  // Xero
  ACCREC: 'Invoice', ACCPAY: 'Bill',
  ACCRECCREDIT: 'Credit Note', ACCPAYCREDIT: 'Supplier Credit',
  BankSPEND: 'Spend Money', BankRECEIVE: 'Receive Money',
  'BankSPEND-OVERPAYMENT': 'Spend Money', 'BankRECEIVE-OVERPAYMENT': 'Receive Money',
  'BankSPEND-PREPAYMENT': 'Spend Money', 'BankRECEIVE-PREPAYMENT': 'Receive Money',
  ManualJournal: 'Journal Entry',
};

function glTypeLabel(raw) {
  if (!raw) return '';
  if (GL_TYPE_LABEL[raw]) return GL_TYPE_LABEL[raw];
  if (!raw.includes('_')) return raw;          // QuickBooks stores its own label
  return raw.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// MM/DD/YYYY — the General Ledger date format all three platforms export.
function glDate(d) {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return y && m && day ? `${m}/${day}/${y}` : String(d).slice(0, 10);
}

// The document number the platform prints in its Num column. Zoho puts it in
// transaction_number; QuickBooks numbers the document in reference_number (its
// transaction_number is the line's own id) and Xero has no per-line number at
// all (always "0"), so its reference is the only candidate. A "number" that
// merely repeats the narration is a memo, not a number.
function glNum(row) {
  const plat = String(row.platform || '').toLowerCase();
  const ref = (row.reference_number || '').trim();
  const seq = (row.transaction_number || '').trim();
  const candidate = plat === 'zoho'
    ? (seq && seq !== '0' ? seq : ref)
    : (ref || (seq !== '0' ? seq : ''));
  const memo = (row.transaction_details || '').trim();
  if (!candidate || candidate.length > 40) return '';
  return memo.startsWith(candidate) ? '' : candidate;
}

/**
 * Contact name per source document. `account_transactions` records which
 * document a line came from but not who it was with, so the name is read back
 * off the synced documents — matched on whichever platform id the row carries.
 */
async function glNameMap(userId, orgId) {
  const map = new Map();
  const add = (rows) => {
    for (const r of rows) {
      if (!r.n) continue;
      for (const id of [r.a, r.b, r.c]) if (id) map.set(String(id).toLowerCase(), r.n);
    }
  };
  const q = async (sql) => {
    try {
      const [rows] = await pool.execute(sql, [userId, orgId]);
      return rows;
    } catch { return []; }
  };
  add(await q(`SELECT zoho_id AS a, qbo_id AS b, xero_id AS c, customer_name AS n
                 FROM invoices WHERE user_id = ? AND org_id = ?`));
  add(await q(`SELECT zoho_id AS a, qbo_id AS b, xero_id AS c, vendor_name AS n
                 FROM bills WHERE user_id = ? AND org_id = ?`));
  add(await q(`SELECT zoho_id AS a, qbo_id AS b, xero_id AS c, vendor_name AS n
                 FROM expense_entries WHERE user_id = ? AND org_id = ?`));
  add(await q(`SELECT zoho_payment_id AS a, NULL AS b, NULL AS c, customer_name AS n
                 FROM zb_customer_payments WHERE user_id = ? AND org_id = ?`));
  add(await q(`SELECT zoho_vendor_payment_id AS a, NULL AS b, NULL AS c, vendor_name AS n
                 FROM zb_vendor_payments WHERE user_id = ? AND org_id = ?`));
  return map;
}

async function buildGeneralLedger(userId, params = {}) {
  const orgId = await orgWithLedger(userId, params);
  if (!orgId) return NO_LOCAL;
  const platform = resolvePlatform(params);
  const { from, to } = resolveRange(params);

  const platClause = platform ? ' AND platform = ?' : '';
  const lineArgs = platform ? [userId, orgId, platform, from, to] : [userId, orgId, from, to];
  const openArgs = platform ? [userId, orgId, platform, from] : [userId, orgId, from];

  const [lines] = await pool.execute(
    `SELECT id, platform, account_id, account_name, account_group,
            transaction_id, transaction_date, transaction_type, source_type,
            transaction_number, reference_number, transaction_details,
            source_id, debit, credit
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?${platClause}
        AND transaction_date BETWEEN ? AND ?
      ORDER BY account_name, transaction_date, id`,
    lineArgs
  );

  // Opening balance per account: everything posted before the period starts.
  const [opening] = await pool.execute(
    `SELECT account_id, SUM(debit) - SUM(credit) AS net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?${platClause}
        AND transaction_date < ?
      GROUP BY account_id`,
    openArgs
  );
  const openByAcct = new Map(opening.map((o) => [String(o.account_id), num(o.net)]));

  const names = await glNameMap(userId, orgId);

  // Xero's Trial-Balance true-up plugs are cumulative balance-sheet corrections
  // dated at the ledger's last day. Left on a profit-and-loss account they dump
  // prior-year movement into the period, so they are excluded there exactly as
  // the Profit and Loss builder and the account drill exclude them, and kept on
  // balance-sheet accounts where they are what makes the ledger tie.
  const isPlDistortion = (l) =>
    ['income', 'expense'].includes(l.account_group) &&
    String(l.transaction_id || '').startsWith('xero-recon:');

  // The other side of each entry, for the Split column.
  const acctsByTxn = new Map();
  for (const l of lines) {
    if (!acctsByTxn.has(l.transaction_id)) acctsByTxn.set(l.transaction_id, new Set());
    acctsByTxn.get(l.transaction_id).add(l.account_name || '');
  }
  const splitFor = (l) => {
    const others = [...(acctsByTxn.get(l.transaction_id) || [])].filter((n) => n && n !== l.account_name);
    if (others.length === 0) return '';
    return others.length === 1 ? others[0] : '-Split-';
  };

  const columns = [
    { key: 'label',   label: 'Date',             align: 'left'  },
    { key: 'type',    label: 'Transaction Type', align: 'left'  },
    { key: 'num',     label: 'Num',              align: 'left'  },
    { key: 'name',    label: 'Name',             align: 'left'  },
    { key: 'memo',    label: 'Memo/Description', align: 'left'  },
    { key: 'split',   label: 'Split',            align: 'left'  },
    { key: 'amount',  label: 'Amount',           align: 'right' },
    { key: 'balance', label: 'Balance',          align: 'right' },
  ];

  // Group the lines by account, then lay the sections out in chart order.
  const byAccount = new Map();
  for (const l of lines) {
    if (isPlDistortion(l)) continue;
    const k = String(l.account_id);
    if (!byAccount.has(k)) {
      byAccount.set(k, { id: l.account_id, name: l.account_name || '(Unaccounted)', group: l.account_group || 'asset', lines: [] });
    }
    byAccount.get(k).lines.push(l);
  }
  const sections = [...byAccount.values()].sort((a, b) => {
    const ga = GL_GROUP_ORDER.indexOf(a.group);
    const gb = GL_GROUP_ORDER.indexOf(b.group);
    if (ga !== gb) return (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb);
    return String(a.name).localeCompare(String(b.name));
  });

  const rows = [];
  let count = 0;
  for (const sec of sections) {
    const sign = GL_DEBIT_NORMAL.has(sec.group) ? 1 : -1;
    rows.push({ label: sec.name, isHeader: true, level: 0, cells: {} });

    // A balance-sheet account carries its balance forward; a P&L account starts
    // the period at zero.
    let running = 0;
    if (!['income', 'expense'].includes(sec.group)) {
      running = r2(sign * (openByAcct.get(String(sec.id)) || 0));
      rows.push({ label: 'Beginning Balance', level: 1, cells: { balance: running } });
    }

    let movement = 0;
    for (const l of sec.lines) {
      const amount = r2(sign * (num(l.debit) - num(l.credit)));
      running = r2(running + amount);
      movement = r2(movement + amount);
      rows.push({
        label: glDate(l.transaction_date),
        level: 1,
        cells: {
          type:    glTypeLabel(l.transaction_type || l.source_type),
          num:     glNum(l),
          name:    names.get(String(l.source_id || '').toLowerCase()) || '',
          memo:    (l.transaction_details || '').replace(/\s*\n\s*/g, ' ').trim(),
          split:   splitFor(l),
          amount,
          balance: running,
        },
      });
      count += 1;
    }

    rows.push({
      label: `Total for ${sec.name}`,
      isSubtotal: true,
      level: 0,
      cells: { amount: movement, balance: running },
    });
  }

  rows.push({ label: `Total (${count} transactions)`, isTotal: true, level: 0, cells: {} });

  return {
    columns,
    rows,
    currency: 'INR',
    meta: { title: 'General Ledger', from, to, basis: 'Accrual', source: 'ledger' },
  };
}

module.exports = { buildBalanceSheet, buildTrialBalance, buildGeneralLedger, aggregateBS };
