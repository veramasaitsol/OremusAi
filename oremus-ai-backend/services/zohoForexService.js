'use strict';

/**
 * Foreign-exchange reports — modelled on Zoho Books' currency reports.
 * ---------------------------------------------------------------------------
 *   buildForexGainsLosses  → "Foreign Currency Gains and Losses"
 *   buildRealisedForex     → "Realised FX Gain or Loss"
 *
 * FX gains/losses only arise on transactions denominated in a currency other
 * than the organisation's base currency. For each foreign currency we read the
 * documents (invoices/bills) and their settling payments from the synced Zoho
 * warehouse and value the exchange-rate movement:
 *
 *   - Realised FX gain/loss is recognised when a foreign-currency document is
 *     settled by a payment booked at a different exchange rate than the
 *     document. realised = settled_foreign_amount × (payment_rate − doc_rate),
 *     signed so a stronger settlement rate on a receivable is a gain.
 *   - Unrealised FX gain/loss is the revaluation of the still-open balance at
 *     the period-end rate (Zoho's reporting rate). We do not store a daily rate
 *     table, so unrealised is reported only when a period-end rate is supplied.
 *
 * When every transaction is in the base currency (the common case for a purely
 * domestic book) both reports are correctly empty.
 */

const pool = require('../config/db');
const { fetchUnallocatedVendorCredits, attachAsOfBillBalances } = require('./zohoApAgingDetailService');
const { attachAsOfBalances } = require('./salesArFromInvoicesService');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function getOrgId(userId) {
  const [[row]] = await pool.execute('SELECT org_id FROM zb_tokens WHERE user_id = ?', [userId]);
  return row?.org_id || null;
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

// DD/MM/YYYY (matches Zoho's India locale display)
function fmtDate(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${dt.getFullYear()}`;
}

// The org's base (reporting) currency. `orgId` is the Zoho org id, the Xero
// tenant id or the QuickBooks realm id depending on the connection, so each
// provider's organisation table is consulted in turn.
async function getBaseCurrency(orgId) {
  const lookups = [
    ['SELECT currency_code AS c FROM zb_organizations WHERE org_id = ? LIMIT 1', orgId],
    ['SELECT currency AS c FROM xero_organizations WHERE tenant_id = ? LIMIT 1', orgId],
    ['SELECT currency AS c FROM qbo_organizations WHERE realm_id = ? LIMIT 1', orgId],
  ];
  for (const [sql, arg] of lookups) {
    try {
      const [[row]] = await pool.execute(sql, [arg]);
      if (/^[A-Z]{3}$/.test(row?.c || '')) return row.c;
    } catch { /* table absent on this deployment — try the next provider */ }
  }
  return 'INR';
}

/**
 * Realised FX per foreign currency, split by the side of the ledger it was
 * recognised on, because Xero's statement reports receivable and payable
 * exchange differences under their own sections. Returns
 * `{ ar: Map<code, gain>, ap: Map<code, gain> }`.
 *
 * Each payment stores both the foreign amount (`amount`) and the base-currency
 * amount the provider actually booked (`amount_bcy`) along with the rate
 * applied (`exchange_rate`). The realised exchange difference recognised on the
 * settlement is the gap between the booked base amount and the foreign amount
 * converted at the payment's own rate — i.e. the rate adjustment posted when
 * the settlement rate differs from the document rate. Receipts are gains when
 * positive; vendor payments flip sign (a higher payable settlement is a loss).
 */
async function realisedSplit(userId, orgId, base, from, to) {
  const ar = new Map();
  const ap = new Map();

  const pull = async (table, target, sign) => {
    const [res] = await pool.execute(
      `SELECT COALESCE(currency_code, ?) AS code, amount, amount_bcy, exchange_rate
         FROM ${table}
        WHERE user_id = ? AND org_id = ? AND COALESCE(currency_code, ?) <> ?
          AND COALESCE(is_deleted, 0) = 0
          AND date BETWEEN ? AND ?`,
      [base, userId, orgId, base, base, from, to]
    ).catch(() => [[]]);
    for (const r of res) {
      const gain = sign * (num(r.amount_bcy) - num(r.amount) * num(r.exchange_rate));
      target.set(r.code, (target.get(r.code) || 0) + gain);
    }
  };

  await pull('zb_customer_payments', ar, 1);
  await pull('zb_vendor_payments', ap, -1);
  return { ar, ap };
}

/**
 * Open document balances per currency as at `asOf`, in both the document's own
 * currency and the base currency. `invoices` → receivables, `bills` → payables.
 *
 * Reconstructs each document's balance AS OF the date via the same engines
 * AR/AP Aging use (attachAsOfBalances / attachAsOfBillBalances) instead of a
 * raw `SUM(balance)` over `WHERE balance <> 0` — that pattern read TODAY's
 * live balance regardless of `asOf` and silently excluded any document
 * that's since been fully settled, even if it carried a real balance on the
 * as-of date (the same bug already found and fixed in AP Aging / Vendor
 * Balance Detail). Reusing the same functions means this can never
 * independently drift from those reports for the same as-of date.
 */
async function openByCurrency(table, userId, orgId, base, asOf, excludedStatuses) {
  const asOfDate = asOf instanceof Date ? asOf : new Date(asOf);
  const placeholders = excludedStatuses.map(() => '?').join(', ');
  const selectCols = table === 'invoices'
    ? 'invoice_number, date, total, balance, currency_code, exchange_rate'
    : 'bill_number, vendor_name, date, total, balance, currency_code, exchange_rate';
  const [rows] = await pool.execute(
    `SELECT ${selectCols}
       FROM ${table}
      WHERE user_id = ? AND org_id = ?
        AND LOWER(COALESCE(status, '')) NOT IN (${placeholders})`,
    [userId, orgId, ...excludedStatuses]
  ).catch(() => [[]]);

  if (table === 'invoices') await attachAsOfBalances(rows, userId, orgId, asOfDate);
  else await attachAsOfBillBalances(rows, userId, orgId, asOfDate);

  const byCode = new Map();
  for (const r of rows) {
    if (r.date && new Date(r.date) > asOfDate) continue; // didn't exist yet
    const bal = num(r._balanceAsOf);
    if (bal === 0) continue;
    const code = r.currency_code || base;
    const rate = num(r.exchange_rate) || 1;
    const g = byCode.get(code) || { bal: 0, baseBal: 0 };
    g.bal += bal;
    g.baseBal += bal * rate;
    byCode.set(code, g);
  }
  return [...byCode.entries()].map(([code, g]) => ({ code, bal: g.bal, baseBal: g.baseBal }));
}

/**
 * Bank/cash account balances as at `asOf`, straight off the shared ledger.
 * `account_type_code = 'bank'` is how every provider's chart of accounts marks
 * a bank account once synced, so this is provider-agnostic.
 */
async function bankBalances(userId, orgId, base, asOf) {
  const [rows] = await pool.execute(
    `SELECT account_id,
            MAX(account_name) AS name,
            COALESCE(MAX(currency_code), ?) AS code,
            SUM(debit) - SUM(credit) AS net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_type_code = 'bank'
        AND (transaction_date IS NULL OR transaction_date <= ?)
      GROUP BY account_id`,
    [base, userId, orgId, asOf]
  ).catch(() => [[]]);
  return rows
    .map((r) => ({ name: r.name || 'Bank Account', code: r.code, net: round2(r.net) }))
    // An account holding nothing carries no exposure, so the provider's own
    // statement leaves it out.
    .filter((r) => r.net !== 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Realised FX straight from the provider's own exchange-difference account.
 * ---------------------------------------------------------------------------
 * Every platform books the realised difference to a dedicated P&L account when
 * it settles a foreign-currency document — Xero "Realised Currency Gains",
 * QuickBooks and Zoho "Exchange Gain or Loss" — and our sync mirrors those
 * postings into the shared ledger. Reading them back is therefore
 * provider-native (it is the number the platform's own report shows) and
 * provider-agnostic (one query serves all three), and it is the only source
 * that works for QuickBooks and Xero, whose syncs do not populate the
 * zb_*_payments tables the settlement-derived path relies on.
 *
 * A credit to the gain account is a gain, a debit a loss, so `gain = credit −
 * debit`. Unrealised revaluation accounts are excluded — they are not realised.
 */
const FX_ACCOUNT_LIKE = [
  '%exchange gain%', '%exchange loss%', '%currency gain%',
  '%currency loss%', '%forex%', '%foreign exchange%',
];
const isUnrealisedAccount = (name) => /unrealis|unrealiz/i.test(name || '');
const isPayableSide = (t) => /accpay|bill|vendor|supplier|purchase|payable/i.test(t || '');

async function realisedFromLedger(userId, orgId, base, from, to) {
  const where = FX_ACCOUNT_LIKE.map(() => 'LOWER(account_name) LIKE ?').join(' OR ');
  const [lines] = await pool.execute(
    `SELECT transaction_date, transaction_type, source_type, source_id,
            account_name, currency_code,
            COALESCE(base_debit, debit) AS debit, COALESCE(base_credit, credit) AS credit
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND transaction_date BETWEEN ? AND ?
        AND transaction_id NOT LIKE 'xero-recon:%'
        AND COALESCE(source_type, '') <> 'AccountBalance'
        AND (${where})`,
    [userId, orgId, from, to, ...FX_ACCOUNT_LIKE]
  ).catch(() => [[]]);

  const rows = lines
    .filter((l) => !isUnrealisedAccount(l.account_name) && (num(l.debit) || num(l.credit)))
    .map((l) => ({
      date: l.transaction_date,
      type: l.transaction_type || l.source_type || 'Exchange Difference',
      currency: l.currency_code && l.currency_code !== base ? l.currency_code : base,
      rate: null,
      amount: null,
      gainloss: num(l.credit) - num(l.debit),
      side: isPayableSide(l.source_type || l.transaction_type) ? 'ap' : 'ar',
      sourceId: l.source_id,
    }));

  // Fill Currency / Exchange Rate / Realized Amount from the document the
  // difference was recognised on, when we hold it.
  const ids = [...new Set(rows.map((r) => r.sourceId).filter(Boolean))];
  if (ids.length) {
    const ph = ids.map(() => '?').join(', ');
    const docs = new Map();
    for (const table of ['invoices', 'bills']) {
      const [found] = await pool.execute(
        `SELECT xero_id, qbo_id, zoho_id, currency_code, exchange_rate, total
           FROM ${table}
          WHERE user_id = ? AND org_id = ?
            AND (xero_id IN (${ph}) OR qbo_id IN (${ph}) OR zoho_id IN (${ph}))`,
        [userId, orgId, ...ids, ...ids, ...ids]
      ).catch(() => [[]]);
      for (const d of found) {
        for (const key of [d.xero_id, d.qbo_id, d.zoho_id]) if (key) docs.set(String(key), d);
      }
    }
    for (const r of rows) {
      const d = docs.get(String(r.sourceId));
      if (!d) continue;
      if (d.currency_code) r.currency = d.currency_code;
      r.rate = num(d.exchange_rate) || null;
      r.amount = num(d.total) || null;
    }
  }

  rows.forEach((r) => { delete r.sourceId; });
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return rows;
}

/**
 * Realised FX per currency, split AR/AP. Settled payments carry the exchange
 * rate they were booked at, so they are the richer source and win when present;
 * the provider's own gain account answers for the rest (all of QuickBooks and
 * Xero, whose syncs write no zb_*_payments rows). Only one source is ever used
 * so a Zoho settlement is never counted twice.
 */
async function resolveRealisedSplit(userId, orgId, base, from, to) {
  const split = await realisedSplit(userId, orgId, base, from, to);
  if (split.ar.size || split.ap.size) return split;

  const ledger = await realisedFromLedger(userId, orgId, base, from, to);
  for (const r of ledger) {
    const target = r.side === 'ap' ? split.ap : split.ar;
    target.set(r.currency, (target.get(r.currency) || 0) + r.gainloss);
  }
  return split;
}

/**
 * Every foreign-currency settlement in the period, one row per transaction:
 *
 *   Date | Transaction Type | Currency | Exchange Rate | Realized Amount | Gain or Loss
 *
 * "Realized Amount" is the settled amount in the transaction's own currency and
 * "Gain or Loss" the exchange difference recognised in the base currency, so the
 * footer sums to the period's realised FX result.
 */
async function realisedTransactions(userId, orgId, base, from, to) {
  const rows = [];

  const pull = async (sql, type, sign) => {
    const [res] = await pool.execute(sql, [userId, orgId, base, base, from, to]).catch(() => [[]]);
    for (const r of res) {
      const booked = num(r.amount_bcy);
      const atRate = num(r.amount) * num(r.exchange_rate);
      rows.push({
        date: r.date,
        type,
        currency: r.code || base,
        rate: num(r.exchange_rate),
        amount: num(r.amount),
        gainloss: sign * (booked - atRate),
      });
    }
  };

  // A payment with no currency of its own was booked in the base currency, so
  // COALESCE keeps domestic settlements out of an FX report.
  await pull(
    `SELECT date, currency_code AS code, amount, amount_bcy, exchange_rate
       FROM zb_customer_payments
      WHERE user_id = ? AND org_id = ? AND COALESCE(currency_code, ?) <> ?
        AND COALESCE(is_deleted, 0) = 0
        AND date BETWEEN ? AND ?`,
    'Customer Payment', 1
  );
  // A vendor settlement flips sign — paying more base currency than the bill was
  // booked at is a loss.
  await pull(
    `SELECT date, currency_code AS code, amount, amount_bcy, exchange_rate
       FROM zb_vendor_payments
      WHERE user_id = ? AND org_id = ? AND COALESCE(currency_code, ?) <> ?
        AND COALESCE(is_deleted, 0) = 0
        AND date BETWEEN ? AND ?`,
    'Vendor Payment', -1
  );

  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return rows;
}

async function buildRealisedForex(userId, params = {}) {
  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Provider not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const { from, to } = resolveRange(params);
  const base = await getBaseCurrency(orgId);
  // Settlements carry the rate they were booked at, so they are the richer
  // source; where a provider's sync stores none (QuickBooks, Xero) the
  // platform's own exchange-difference account answers instead. Exactly one
  // source is used, so a settlement is never reported twice.
  let data = await realisedTransactions(userId, orgId, base, from, to);
  if (!data.length) data = await realisedFromLedger(userId, orgId, base, from, to);

  const columns = [
    { key: 'label',    label: 'Date',             align: 'left'  },
    { key: 'type',     label: 'Transaction Type', align: 'left'  },
    { key: 'currency', label: 'Currency',         align: 'left'  },
    { key: 'rate',     label: 'Exchange Rate',    align: 'right' },
    { key: 'amount',   label: 'Realized Amount',  align: 'right' },
    { key: 'gainloss', label: 'Gain or Loss',     align: 'right', money: true },
  ];

  const out = [];
  let grand = 0;
  for (const r of data) {
    out.push({
      label: fmtDate(r.date),
      level: 0,
      cells: {
        type: r.type,
        currency: r.currency,
        // A gain read off the ledger may not name the rate it was struck at;
        // leave the cell empty rather than claim a rate of zero.
        rate: r.rate == null ? null : round2(r.rate),
        amount: r.amount == null ? null : round2(r.amount),
        gainloss: round2(r.gainloss),
      },
    });
    grand += r.gainloss;
  }

  // The total is always shown — a book with no foreign-currency settlement has a
  // realised gain of zero, which is itself the report's answer.
  out.push({
    label: `Total Realized Gain (${base})`,
    isTotal: true,
    level: 0,
    cells: { gainloss: round2(grand) },
  });

  return {
    columns,
    rows: out,
    currency: base,
    zoho: {
      module: 'Currency',
      title: 'Realised Gain or Loss',
      totalCount: data.length,
    },
    meta: {
      title: 'Realised Gain or Loss',
      from, to, source: 'warehouse',
      note: data.length ? undefined : `No foreign-currency settlements in the period (base currency ${base}).`,
    },
  };
}

/**
 * "Foreign Currency Gains and Losses" — Xero's statement layout:
 *
 *   <blank> | Balance | Balance <BASE> | Realised Gain | Unrealised Gain
 *           | Realised Gain YTD | Unrealised Gain YTD | FX Exposure
 *
 * grouped as Accounts Receivable / Accounts Payable (one row per currency, then
 * a section total), a Total Gain (Loss) line, Bank Accounts (one row per bank
 * account) and a closing FX Exposure line.
 *
 * Balances are point-in-time as at the To date; gains are the realised exchange
 * differences recognised in the period, with the YTD columns measured from the
 * start of the financial year. Unrealised revaluation needs a period-end rate
 * table, which we do not store, so unrealised (and therefore FX Exposure) is
 * reported as zero — correct for a single-currency book, which is exactly what
 * the provider itself shows.
 */
async function buildForexGainsLosses(userId, params = {}) {
  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Provider not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const { from, to } = resolveRange(params);
  const base = await getBaseCurrency(orgId);

  // Financial-year start of the To date, for the YTD columns.
  const toDate = new Date(to);
  const fyYear = toDate.getMonth() + 1 >= 4 ? toDate.getFullYear() : toDate.getFullYear() - 1;
  const ytdFrom = `${fyYear}-04-01`;

  const [period, ytd, arOpen, apOpen, credits, banks] = await Promise.all([
    resolveRealisedSplit(userId, orgId, base, from, to),
    resolveRealisedSplit(userId, orgId, base, ytdFrom, to),
    openByCurrency('invoices', userId, orgId, base, to, ['draft', 'void', 'voided', 'deleted']),
    openByCurrency('bills', userId, orgId, base, to, ['draft', 'submitted', 'void', 'voided', 'deleted']),
    fetchUnallocatedVendorCredits(userId, orgId, toDate).catch(() => []),
    bankBalances(userId, orgId, base, to),
  ]);

  // Unapplied vendor credits reduce the payable, exactly as they do in A/P
  // Aging and Vendor Balance Detail, so the section total keeps footing to them.
  const creditTotal = credits.reduce((s, c) => s + num(c.amount), 0);
  if (creditTotal) {
    const row = apOpen.find((r) => r.code === base);
    if (row) { row.bal += creditTotal; row.baseBal += creditTotal; }
    else apOpen.push({ code: base, bal: creditTotal, baseBal: creditTotal });
  }

  const columns = [
    { key: 'label',         label: '',                    align: 'left'  },
    { key: 'balance',       label: 'Balance',             align: 'right' },
    { key: 'balanceBase',   label: `Balance ${base}`,     align: 'right', money: true },
    { key: 'realised',      label: 'Realised Gain',       align: 'right', money: true },
    { key: 'unrealised',    label: 'Unrealised Gain',     align: 'right', money: true },
    { key: 'realisedYtd',   label: 'Realised Gain YTD',   align: 'right', money: true },
    { key: 'unrealisedYtd', label: 'Unrealised Gain YTD', align: 'right', money: true },
    { key: 'fxExposure',    label: 'FX Exposure',         align: 'right', money: true },
  ];

  const rows = [];
  const totals = { realised: 0, unrealised: 0, realisedYtd: 0, unrealisedYtd: 0, fxExposure: 0 };

  // One Accounts Receivable / Accounts Payable section, listing every currency
  // that has either an open balance or a realised difference in the period.
  const section = (title, open, periodGains, ytdGains) => {
    const codes = new Set([...open.map((r) => r.code), ...periodGains.keys(), ...ytdGains.keys()]);
    const sum = { baseBal: 0, realised: 0, unrealised: 0, realisedYtd: 0, unrealisedYtd: 0, fxExposure: 0 };
    rows.push({ label: title, isHeader: true, level: 0, cells: {} });
    for (const code of [...codes].sort((a, b) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)))) {
      const o = open.find((r) => r.code === code) || { bal: 0, baseBal: 0 };
      const cell = {
        balance: round2(o.bal),
        ccy: code,
        balanceBase: round2(o.baseBal),
        realised: round2(periodGains.get(code) || 0),
        // No stored period-end rate table → nothing to revalue the open balance at.
        unrealised: 0,
        realisedYtd: round2(ytdGains.get(code) || 0),
        unrealisedYtd: 0,
        fxExposure: 0,
      };
      rows.push({ label: code, level: 1, cells: cell });
      sum.baseBal += cell.balanceBase;
      sum.realised += cell.realised;
      sum.realisedYtd += cell.realisedYtd;
    }
    rows.push({
      label: `Total ${title}`,
      isSubtotal: true,
      level: 0,
      cells: {
        balanceBase: round2(sum.baseBal),
        realised: round2(sum.realised),
        unrealised: 0,
        realisedYtd: round2(sum.realisedYtd),
        unrealisedYtd: 0,
        fxExposure: 0,
      },
    });
    totals.realised += sum.realised;
    totals.realisedYtd += sum.realisedYtd;
  };

  section('Accounts Receivable', arOpen, period.ar, ytd.ar);
  section('Accounts Payable', apOpen, period.ap, ytd.ap);

  rows.push({
    label: 'Total Gain (Loss)',
    isTotal: true,
    level: 0,
    cells: {
      realised: round2(totals.realised),
      unrealised: round2(totals.unrealised),
      realisedYtd: round2(totals.realisedYtd),
      unrealisedYtd: round2(totals.unrealisedYtd),
      fxExposure: round2(totals.fxExposure),
    },
  });

  // Bank accounts carry no realised difference of their own — only the
  // revaluation of the balance held, so Xero shows just the unrealised columns.
  if (banks.length) {
    rows.push({ label: 'Bank Accounts', isHeader: true, level: 0, cells: {} });
    let bankBase = 0;
    for (const b of banks) {
      rows.push({
        label: b.name,
        level: 1,
        cells: {
          balance: round2(b.net), ccy: b.code, balanceBase: round2(b.net),
          unrealised: 0, unrealisedYtd: 0, fxExposure: 0,
        },
      });
      bankBase += b.net;
    }
    rows.push({
      label: 'Total Bank Accounts',
      isSubtotal: true,
      level: 0,
      cells: { balanceBase: round2(bankBase), unrealised: 0, unrealisedYtd: 0, fxExposure: 0 },
    });
  }

  rows.push({
    label: 'FX Exposure',
    isTotal: true,
    level: 0,
    cells: { fxExposure: round2(totals.fxExposure) },
  });

  const foreign = rows.some((r) => r.level === 1 && r.cells?.ccy && r.cells.ccy !== base);
  return {
    columns,
    rows,
    currency: base,
    meta: {
      title: 'Foreign Currency Gains and Losses',
      from, to, ytdFrom, source: 'warehouse',
      note: foreign ? undefined : `No foreign-currency transactions in the period (base currency ${base}).`,
    },
  };
}

module.exports = { buildForexGainsLosses, buildRealisedForex };
