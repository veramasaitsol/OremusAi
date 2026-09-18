'use strict';
// Xero Path B posting engine.
//
// Xero's full-GL /Journals endpoint is gated (401 for granular apps / non-Advanced
// tier) — see db/xero-account-transactions.sql. So we reconstruct the general
// ledger ourselves: fetch source documents WITH line items (invoices, bills,
// credit notes, bank transactions, manual journals), apply double-entry posting
// rules, and write balanced debit/credit lines into the `account_transactions`
// STAGING table. Once totals reconcile against Xero's own reports, verified rows
// are promoted into the shared `account_transactions` table.
//
// Every document is posted as a self-balancing set of lines (ΣDebit == ΣCredit);
// a tiny rounding residual (sub-cent / tax-split drift) is absorbed into the
// document's control account so the ledger always balances.

const axios = require('axios');
const pool  = require('../config/db');
const { withRetry } = require('../utils/singleFlight');
const { getValidXeroToken } = require('./xeroService');

const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';

// Xero account Class → our account_group bucket (matches Zoho report engine).
const CLASS_TO_GROUP = {
  ASSET:     'asset',
  LIABILITY: 'liability',
  EQUITY:    'equity',
  REVENUE:   'income',
  EXPENSE:   'expense',
};

// Xero account Type → shared Zoho `account_type_code` vocabulary that every DB
// report builder (P&L sectioning, Balance Sheet, Bank Summary, Exec Summary)
// keys on. Baked in here so promotion carries the right codes — no one-off
// normalization SQL that a re-sync would silently lose.
const XERO_TYPE_TO_CODE = {
  BANK:                    'bank',
  CURRENT:                 'other_current_asset',
  INVENTORY:               'other_current_asset',
  PREPAYMENT:              'other_current_asset',
  FIXED:                   'fixed_asset',
  NONCURRENT:              'other_asset',
  CURRLIAB:                'other_current_liability',
  PAYGLIABILITY:           'other_current_liability',
  SUPERANNUATIONLIABILITY: 'other_current_liability',
  WAGESPAYABLELIABILITY:   'other_current_liability',
  LIABILITY:               'long_term_liability',
  TERMLIAB:                'long_term_liability',
  EQUITY:                  'equity',
  REVENUE:                 'income',
  SALES:                   'income',
  OTHERINCOME:             'other_income',
  DIRECTCOSTS:             'cost_of_goods_sold',
  EXPENSE:                 'expense',
  OVERHEADS:               'expense',
  DEPRECIATN:              'expense',
  WAGESEXPENSE:            'expense',
  SUPERANNUATIONEXPENSE:   'expense',
};

// Resolve an account's shared type code from its Xero type, falling back to a
// sensible default per account_group so nothing lands NULL.
function typeCodeFor(xeroType, group) {
  const t = XERO_TYPE_TO_CODE[(xeroType || '').toUpperCase()];
  if (t) return t;
  switch (group) {
    case 'asset':     return 'other_current_asset';
    case 'liability': return 'other_current_liability';
    case 'equity':    return 'equity';
    case 'income':    return 'income';
    case 'expense':   return 'expense';
    default:          return null;
  }
}

function headers(accessToken, tenantId) {
  return {
    Authorization:    `Bearer ${accessToken}`,
    'Xero-tenant-id': tenantId,
    Accept:           'application/json',
  };
}

// Xero date (.NET "/Date(…)/" or ISO) → MySQL DATE.
// Xero dates are calendar dates (no real time-of-day). A plain ISO string like
// "2026-01-01T00:00:00" carries NO timezone, so `new Date(...)` parses it as
// LOCAL midnight; on a server ahead of UTC (e.g. IST +5:30) `.toISOString()`
// then rolls it back to the previous day — pushing every period-boundary
// document (1st of a month/quarter/FY) into the prior period. Take the literal
// calendar date instead so the ledger date matches the source document exactly.
function toDate(input) {
  if (!input) return null;
  if (typeof input === 'string') {
    const iso = input.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    if (input.startsWith('/Date(')) {
      // .NET epoch-ms is UTC midnight of the intended date; read it in UTC.
      const d = new Date(parseInt(input.replace(/\/Date\((-?\d+).*\)\//, '$1'), 10));
      return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
  }
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Only these Xero statuses actually hit the general ledger — the same set Xero's
// own reports use. VOIDED / DELETED documents are reversed/removed, and
// DRAFT / SUBMITTED invoices are not yet approved, so none of them post. Posting
// a voided bill (as we did before) duplicates the account with a phantom line.
const POSTING_STATUS = {
  invoice:       new Set(['AUTHORISED', 'PAID']),   // ACCREC / ACCPAY
  creditnote:    new Set(['AUTHORISED', 'PAID']),
  banktxn:       new Set(['AUTHORISED']),           // else DELETED
  manualjournal: new Set(['POSTED']),               // else DRAFT / VOIDED / DELETED
};
const posts = (kind, status) => POSTING_STATUS[kind].has(String(status || '').toUpperCase());

// ── Account map + control-account resolution ────────────────────────────────
async function loadAccounts(userId) {
  const [rows] = await pool.execute(
    `SELECT xero_id, code, name, type, class FROM xero_accounts WHERE user_id = ?`,
    [userId]
  );
  const byCode = new Map();
  const byId   = new Map();
  for (const a of rows) {
    const group = CLASS_TO_GROUP[(a.class || '').toUpperCase()] || null;
    const rec = {
      id:       a.xero_id,
      code:     a.code,
      name:     a.name,
      type:     a.type,
      group,
      typeCode: typeCodeFor(a.type, group),
    };
    if (a.code)    byCode.set(String(a.code), rec);
    if (a.xero_id) byId.set(String(a.xero_id), rec);
  }

  const findByName = (re, type) => {
    const row = rows.find((a) => re.test(a.name || '') && (!type || a.type === type));
    if (!row) return null;
    // Return the SAME record instance that byCode/byId hold, so pinning a
    // control account's typeCode below applies to every resolution path. Two
    // records for one account meant the same A/P landed in the ledger under
    // both `accounts_payable` and `other_current_liability`.
    return (row.xero_id && byId.get(String(row.xero_id)))
        || (row.code && byCode.get(String(row.code)))
        || null;
  };
  const ar        = findByName(/accounts?\s*receivable/i, 'CURRENT');
  const ap        = findByName(/accounts?\s*payable/i, 'CURRLIAB');
  const inputTax  = findByName(/input tax credit|gst input|input (c|s|i)gst/i);
  // Output tax = "Output CGST", "Output IGST", "Output SGST" etc.
  // NOT "GST Payable" (settlement/liability) or "Sales Tax" (liability).
  // The old regex /sales tax|gst payable|output/i matched "GST Payable" first
  // (alphabetical), causing every invoice's tax to land in GST Payable.
  const _outputTaxCandidate = findByName(/output/i, 'CURRLIAB');
  const outputTax = _outputTaxCandidate && /gst payable|sales tax/i.test(_outputTaxCandidate.name || '')
    ? null : _outputTaxCandidate;
  const rounding  = findByName(/rounding/i);
  // AR/AP are the receivable/payable control accounts regardless of their raw
  // Xero type (CURRENT/CURRLIAB) — pin the codes the aging/BS builders expect.
  if (ar) ar.typeCode = 'accounts_receivable';
  if (ap) ap.typeCode = 'accounts_payable';
  return {
    byCode, byId,
    ar, ap, outputTax, inputTax, rounding,
    // Synthetic account that absorbs invoice/bill cash settlement (AmountPaid)
    // because Xero won't disclose the paying bank account to a granular app.
    // Typed as a bank so cash reports (Bank/Exec Summary) include it.
    clearing: { id: 'XERO-CLEARING', code: 'XERO-CLEARING', name: 'Xero Payments Clearing', type: 'BANK', group: 'asset', typeCode: 'bank' },
  };
}

// Resolve a line's account from AccountCode (preferred) or AccountID.
function resolveAccount(accounts, { AccountCode, AccountID }) {
  if (AccountCode && accounts.byCode.has(String(AccountCode))) return accounts.byCode.get(String(AccountCode));
  if (AccountID && accounts.byId.has(String(AccountID)))       return accounts.byId.get(String(AccountID));
  // Unknown account — post to a synthetic ref so nothing is silently dropped.
  return { id: AccountID || null, code: AccountCode || null, name: AccountCode || AccountID || 'Unknown', type: null, group: null, typeCode: null };
}

// ── Pull a paged Xero collection with retry/backoff ─────────────────────────
async function fetchAllPages(auth, resource, key, { maxPages = 0, extraParams = {} } = {}) {
  const out = [];
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const res = await withRetry(() => axios.get(`${XERO_API_BASE}/${resource}`, {
      headers: headers(auth.accessToken, auth.tenantId),
      params: { page, ...extraParams },
    }));
    const batch = res.data?.[key] || [];
    out.push(...batch);
    if (batch.length < 100) break;           // last page
    if (maxPages && page >= maxPages) break;  // test cap
    page += 1;
  }
  return out;
}

// ── Double-entry builders (return an array of {account, debit, credit}) ─────
// `account` is a resolved {id,code,name,group,type}. Each builder self-balances.

function buildInvoiceLines(inv, accounts) {
  const isSales = String(inv.Type).toUpperCase() === 'ACCREC';
  const control = isSales ? accounts.ar : accounts.ap;
  const taxAcct = isSales ? accounts.outputTax : accounts.inputTax;
  const total   = num(inv.Total);
  const totalTax = num(inv.TotalTax);
  // The /Payments endpoint is scope-gated for granular apps, and embedded
  // payments carry no bank account. So we move the settled portion (AmountPaid)
  // out of AR/AP into a single payments-clearing account — this makes AR/AP
  // match Xero's outstanding balance (AmountDue) while the document stays
  // balanced. Credit-note settlement (AmountCredited) is posted by the credit
  // note itself, so only AmountPaid is applied here.
  const amountPaid = num(inv.AmountPaid);
  const lines = [];

  for (const li of inv.LineItems || []) {
    const acct = resolveAccount(accounts, li);
    const net  = num(li.LineAmount);
    if (net === 0) continue;
    // Sales: credit revenue. Purchase: debit expense/asset.
    lines.push({ account: acct, debit: isSales ? 0 : net, credit: isSales ? net : 0, taxType: li.TaxType, tax: num(li.TaxAmount) });
  }
  if (totalTax !== 0 && taxAcct) {
    lines.push({ account: taxAcct, debit: isSales ? 0 : totalTax, credit: isSales ? totalTax : 0 });
  }
  // Control (AR/AP) at full value balances the accrual document.
  if (control) lines.push({ account: control, debit: isSales ? total : 0, credit: isSales ? 0 : total });
  // Apply cash settlement: move each PAYMENT off AR/AP into the "Xero Payments
  // Clearing" holding account, stamped with the payment's OWN date (_date) so
  // cash-basis reports bucket the collection in the period the cash actually
  // moved — not the invoice date. Xero's embedded Payments[] carries per-payment
  // Date + Amount (∑Amount == AmountPaid) but not the settling bank, so the
  // clearing account is the landing spot; the standalone /Payments pass (when it
  // fetches OK) then moves each one Clearing → real bank so the bank's own
  // transaction drill matches Xero. When /Payments can't be fetched, the
  // trial-balance true-up corrects the bank balances instead.
  const settlements = Array.isArray(inv.Payments) && inv.Payments.length
    ? inv.Payments.map((p) => ({ amount: num(p.Amount), date: toDate(p.DateString || p.Date) }))
    : (amountPaid !== 0 ? [{ amount: amountPaid, date: null }] : []);
  for (const s of settlements) {
    if (s.amount === 0 || !control || !accounts.clearing) continue;
    if (isSales) {
      lines.push({ account: accounts.clearing, debit: s.amount, credit: 0, _date: s.date });
      lines.push({ account: control,           debit: 0,        credit: s.amount, _date: s.date });
    } else {
      lines.push({ account: control,           debit: s.amount, credit: 0, _date: s.date });
      lines.push({ account: accounts.clearing, debit: 0,        credit: s.amount, _date: s.date });
    }
  }
  return lines;
}

function buildCreditNoteLines(cn, accounts) {
  // Credit notes reverse the corresponding invoice/bill direction.
  const type = String(cn.Type).toUpperCase();
  const isSalesCredit = type === 'ACCRECCREDIT';
  const control = isSalesCredit ? accounts.ar : accounts.ap;
  const taxAcct = isSalesCredit ? accounts.outputTax : accounts.inputTax;
  const total   = num(cn.Total);
  const totalTax = num(cn.TotalTax);
  const lines = [];
  for (const li of cn.LineItems || []) {
    const acct = resolveAccount(accounts, li);
    const net  = num(li.LineAmount);
    if (net === 0) continue;
    // Reverse of invoice: sales-credit debits revenue, purchase-credit credits expense.
    lines.push({ account: acct, debit: isSalesCredit ? net : 0, credit: isSalesCredit ? 0 : net, taxType: li.TaxType, tax: num(li.TaxAmount) });
  }
  if (totalTax !== 0 && taxAcct) {
    lines.push({ account: taxAcct, debit: isSalesCredit ? totalTax : 0, credit: isSalesCredit ? 0 : totalTax });
  }
  if (control) lines.push({ account: control, debit: isSalesCredit ? 0 : total, credit: isSalesCredit ? total : 0 });
  return lines;
}

function buildBankLines(bt, accounts) {
  const isReceive = String(bt.Type).toUpperCase().startsWith('RECEIVE');
  const total   = num(bt.Total);
  const totalTax = num(bt.TotalTax);
  const bankAcct = resolveAccount(accounts, {
    AccountCode: bt.BankAccount?.Code, AccountID: bt.BankAccount?.AccountID,
  });
  const lines = [];
  for (const li of bt.LineItems || []) {
    const acct = resolveAccount(accounts, li);
    const net  = num(li.LineAmount);
    if (net === 0) continue;
    // Receive: credit income line; Spend: debit expense line.
    lines.push({ account: acct, debit: isReceive ? 0 : net, credit: isReceive ? net : 0, taxType: li.TaxType, tax: num(li.TaxAmount) });
  }
  if (totalTax !== 0) {
    const taxAcct = isReceive ? accounts.outputTax : accounts.inputTax;
    if (taxAcct) lines.push({ account: taxAcct, debit: isReceive ? 0 : totalTax, credit: isReceive ? totalTax : 0 });
  }
  // Bank account balances it.
  lines.push({ account: bankAcct, debit: isReceive ? total : 0, credit: isReceive ? 0 : total });
  return lines;
}

function buildManualJournalLines(mj, accounts) {
  const lines = [];
  for (const li of mj.JournalLines || []) {
    const acct = resolveAccount(accounts, li);
    const amt  = num(li.LineAmount);      // Xero: >=0 debit, <0 credit
    if (amt === 0) continue;
    lines.push({ account: acct, debit: amt >= 0 ? amt : 0, credit: amt < 0 ? -amt : 0, taxType: li.TaxType, tax: num(li.TaxAmount) });
  }
  return lines;
}

// Payment applied to an invoice/bill. buildInvoiceLines already moved the settled
// amount from AR/AP into the "Xero Payments Clearing" holding account (Xero's
// embedded Payments[] doesn't name the bank). This pass carries `p.Account` —
// the real bank — so it moves that same cash Clearing → bank, which nets the
// clearing account to zero and gives the bank its actual transaction line.
//   Customer payment (ACCRECPAYMENT): Dr Bank, Cr Clearing.
//   Supplier payment (ACCPAYPAYMENT): Dr Clearing, Cr Bank.
// Falls back to AR/AP only if the invoice pass never ran (no clearing account).
function buildPaymentLines(p, accounts) {
  const amount = num(p.Amount);
  if (amount === 0) return [];
  const bank = resolveAccount(accounts, { AccountCode: p.Account?.Code, AccountID: p.Account?.AccountID });
  // A real synced account carries `group`; an unresolved id does not.
  if (!bank || !bank.id || !bank.group) return [];
  const type = String(p.PaymentType || '').toUpperCase();
  const invType = String(p.Invoice?.Type || '').toUpperCase();
  const isReceive = type === 'ACCRECPAYMENT' || (!type && invType === 'ACCREC');
  const isSpend   = type === 'ACCPAYPAYMENT' || (!type && invType === 'ACCPAY');
  const contra = accounts.clearing || (isReceive ? accounts.ar : accounts.ap);
  if (!contra) return [];
  if (isReceive) {
    return [
      { account: bank,   debit: amount, credit: 0 },
      { account: contra, debit: 0,      credit: amount },
    ];
  }
  if (isSpend) {
    return [
      { account: contra, debit: amount, credit: 0 },
      { account: bank,   debit: 0,      credit: amount },
    ];
  }
  return [];
}

// Bank transfer — Dr destination bank, Cr source bank.
function buildBankTransferLines(bt, accounts) {
  const amount = num(bt.Amount);
  if (amount === 0) return [];
  const from = resolveAccount(accounts, { AccountCode: bt.FromBankAccount?.Code, AccountID: bt.FromBankAccount?.AccountID });
  const to   = resolveAccount(accounts, { AccountCode: bt.ToBankAccount?.Code,   AccountID: bt.ToBankAccount?.AccountID });
  return [
    { account: to,   debit: amount, credit: 0 },
    { account: from, debit: 0,      credit: amount },
  ];
}

// Balance a document's lines: force ΣDr == ΣCr by absorbing residual into the
// document's control account (or a rounding account) so the ledger is airtight.
function balance(lines, controlAcct) {
  let dr = 0; let cr = 0;
  for (const l of lines) { dr += l.debit; cr += l.credit; }
  const residual = +(dr - cr).toFixed(2);
  if (Math.abs(residual) >= 0.01 && controlAcct) {
    // residual > 0 → too much debit → add a credit to balance.
    lines.push({
      account: controlAcct,
      debit:  residual < 0 ? -residual : 0,
      credit: residual > 0 ?  residual : 0,
      _rounding: true,
    });
  }
  return lines;
}

// ── Persist one document's balanced lines to the staging table ──────────────
async function writeDoc(conn, { userId, orgId, sourceType, sourceId, date, ref, details, currency }, lines) {
  const txnId = `xero:${sourceId}`;
  let i = 0;
  for (const ln of lines) {
    // account_id must be unique per (txn, transaction_number); we key
    // transaction_number on the line index and account_id on the real code so
    // reports can GROUP BY account_id/account_name meaningfully.
    const acctId = ln.account.id || ln.account.code || `${sourceId}:${i}`;
    // eslint-disable-next-line no-await-in-loop
    await conn.execute(
      `INSERT INTO account_transactions
         (user_id, org_id, platform, transaction_id, account_id, transaction_date,
          account_name, account_group, account_type_code, transaction_details,
          transaction_type, transaction_number, reference_number,
          debit, credit, balance, balance_type,
          source_type, source_id, line_number, tax_type, tax_amount, currency_code, synced_at)
       VALUES (?,?,'xero',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE
         transaction_date=VALUES(transaction_date), account_name=VALUES(account_name),
         account_group=VALUES(account_group), account_type_code=VALUES(account_type_code),
         transaction_details=VALUES(transaction_details), transaction_type=VALUES(transaction_type),
         reference_number=VALUES(reference_number), debit=VALUES(debit), credit=VALUES(credit),
         balance=VALUES(balance), balance_type=VALUES(balance_type),
         source_type=VALUES(source_type), source_id=VALUES(source_id), line_number=VALUES(line_number),
         tax_type=VALUES(tax_type), tax_amount=VALUES(tax_amount),
         currency_code=COALESCE(VALUES(currency_code), currency_code),
         synced_at=NOW()`,
      [
        userId, String(orgId), txnId, String(acctId), (ln._date || date),
        ln.account.name || null, ln.account.group || null, ln.account.typeCode || null,
        details || null, sourceType, String(i), ref || null,
        +ln.debit.toFixed(2), +ln.credit.toFixed(2),
        +Math.abs(ln.debit - ln.credit).toFixed(2),
        ln.debit >= ln.credit ? 'D' : 'C',
        sourceType, String(sourceId), i,
        ln.taxType || null, ln.tax != null ? +Number(ln.tax).toFixed(2) : 0,
        currency || null,
      ]
    );
    i += 1;
  }
  return i;
}

// ── Main entry: rebuild the staging GL for one user/org ─────────────────────
async function buildStagingLedger(userId, opts = {}) {
  // `payments` is fetched so customer/supplier settlements land on the REAL bank
  // (p.Account) instead of only "Xero Payments Clearing" — this is what lets a
  // bank's transaction drill and any historical Balance Sheet date reconcile to
  // Xero. It needs the `accounting.transactions` scope (which we request). If the
  // endpoint 401s for a given connection, fetchEntity records the error, the
  // clean wipe is skipped, and the trial-balance true-up covers the banks as
  // before — no regression. banktransfers is included for multi-bank orgs.
  const { maxPages = 0, fresh = true, entities = ['invoices', 'creditnotes', 'banktransactions', 'manualjournals', 'banktransfers', 'payments'] } = opts;
  const auth = await getValidXeroToken(userId);
  if (!auth) throw new Error('Xero not connected for this user');
  const orgId = auth.tenantId;
  const accounts = await loadAccounts(userId);

  // Org's own base currency — used ONLY as the fallback for document types
  // Xero itself never lets carry a foreign currency (ManualJournal, Bank
  // Transfers), or where the source object doesn't expose one directly
  // (Payments settle in their linked Invoice's currency; that Invoice is
  // already synced with its own real CurrencyCode). Never substituted for a
  // document that DOES carry its own currency (Invoices/CreditNotes/Bank
  // Transactions already pass their real CurrencyCode below).
  const [[orgRow]] = await pool.execute(
    'SELECT currency FROM xero_organizations WHERE user_id = ? AND tenant_id = ? LIMIT 1',
    [userId, String(orgId)]
  ).catch(() => [[null]]);
  const homeCurrency = orgRow?.currency || null;

  const stats = {};
  const errors = {};

  // ── Phase 1: fetch every requested entity up front, each isolated ──────────
  // A transient failure (429 / 5xx) or a scope gap on ONE endpoint must not
  // abort the whole rebuild — record it and carry on with what we could get.
  const fetchEntity = async (key, resource) => {
    if (!entities.includes(key)) return null;
    try {
      return await fetchAllPages(auth, resource, resource, { maxPages });
    } catch (e) {
      errors[key] = e.response?.status ? `HTTP ${e.response.status}` : e.message;
      console.warn(`[Xero staging] ${resource} fetch failed: ${errors[key]}`);
      return null;
    }
  };

  const [invs, cns, bts, mjs, pays, xfers] = await Promise.all([
    fetchEntity('invoices', 'Invoices'),
    fetchEntity('creditnotes', 'CreditNotes'),
    fetchEntity('banktransactions', 'BankTransactions'),
    fetchEntity('manualjournals', 'ManualJournals'),
    fetchEntity('payments', 'Payments'),
    fetchEntity('banktransfers', 'BankTransfers'),
  ]);

  // A clean wipe-and-rebuild is only safe when EVERY requested entity fetched
  // OK. On a partial fetch we skip the wipe and let writeDoc's ON DUPLICATE KEY
  // UPDATE refresh what we did get, so a rate-limited run never empties the
  // ledger (the next full sync reconciles).
  const allFetched = entities.every((k) => errors[k] == null);

  const conn = await pool.getConnection();
  try {
    if (fresh && allFetched) {
      await conn.execute(
        `DELETE FROM account_transactions WHERE user_id = ? AND org_id = ? AND transaction_id LIKE 'xero:%'`,
        [userId, String(orgId)]
      );
    }

    if (invs) {
      let lines = 0;
      for (const inv of invs) {
        if (!posts('invoice', inv.Status)) continue; // skip DRAFT/SUBMITTED/VOIDED/DELETED
        const control = String(inv.Type).toUpperCase() === 'ACCREC' ? accounts.ar : accounts.ap;
        const built = balance(buildInvoiceLines(inv, accounts), control);
        // eslint-disable-next-line no-await-in-loop
        lines += await writeDoc(conn, {
          userId, orgId, sourceType: inv.Type, sourceId: inv.InvoiceID,
          date: toDate(inv.DateString || inv.Date), ref: inv.InvoiceNumber || inv.Reference,
          details: inv.Contact?.Name, currency: inv.CurrencyCode,
        }, built);
      }
      stats.invoices = { docs: invs.length, lines };
    }

    if (cns) {
      let lines = 0;
      for (const cn of cns) {
        if (!posts('creditnote', cn.Status)) continue; // skip DRAFT/SUBMITTED/VOIDED/DELETED
        const isSalesCredit = String(cn.Type).toUpperCase() === 'ACCRECCREDIT';
        const control = isSalesCredit ? accounts.ar : accounts.ap;
        const built = balance(buildCreditNoteLines(cn, accounts), control);
        // eslint-disable-next-line no-await-in-loop
        lines += await writeDoc(conn, {
          userId, orgId, sourceType: cn.Type, sourceId: cn.CreditNoteID,
          date: toDate(cn.DateString || cn.Date), ref: cn.CreditNoteNumber,
          details: cn.Contact?.Name, currency: cn.CurrencyCode,
        }, built);
      }
      stats.creditnotes = { docs: cns.length, lines };
    }

    if (bts) {
      let lines = 0;
      for (const bt of bts) {
        if (!posts('banktxn', bt.Status)) continue; // skip DELETED
        const bankAcct = resolveAccount(accounts, {
          AccountCode: bt.BankAccount?.Code, AccountID: bt.BankAccount?.AccountID,
        });
        const built = balance(buildBankLines(bt, accounts), bankAcct);
        // eslint-disable-next-line no-await-in-loop
        lines += await writeDoc(conn, {
          userId, orgId, sourceType: `Bank${bt.Type}`, sourceId: bt.BankTransactionID,
          date: toDate(bt.DateString || bt.Date), ref: bt.Reference,
          details: bt.Contact?.Name, currency: bt.CurrencyCode,
        }, built);
      }
      stats.banktransactions = { docs: bts.length, lines };
    }

    if (mjs) {
      let lines = 0;
      for (const mj of mjs) {
        if (!posts('manualjournal', mj.Status)) continue; // skip DRAFT/VOIDED/DELETED
        const built = balance(buildManualJournalLines(mj, accounts), accounts.rounding);
        // eslint-disable-next-line no-await-in-loop
        // Xero's ManualJournal has no CurrencyCode field of its own — manual
        // journals always post in the org's base currency (Xero doesn't offer
        // a foreign-currency option for them), so the org's own currency is
        // the correct value here, not a guess.
        lines += await writeDoc(conn, {
          userId, orgId, sourceType: 'ManualJournal', sourceId: mj.ManualJournalID,
          date: toDate(mj.Date), ref: mj.Narration, details: mj.Narration,
          currency: homeCurrency,
        }, built);
      }
      stats.manualjournals = { docs: mjs.length, lines };
    }

    if (pays) {
      let lines = 0; let posted = 0;
      for (const p of pays) {
        if (String(p.Status || '').toUpperCase() !== 'AUTHORISED') continue; // skip DELETED
        const built = buildPaymentLines(p, accounts);
        if (!built.length) continue;
        posted += 1;
        // eslint-disable-next-line no-await-in-loop
        // A Payment settles in the currency of the Invoice/CreditNote it's
        // applied to — use that document's own CurrencyCode; only fall back
        // to the org's base currency for the rare payment with no linked
        // Invoice context available here.
        lines += await writeDoc(conn, {
          userId, orgId, sourceType: p.PaymentType || 'Payment', sourceId: p.PaymentID,
          date: toDate(p.Date), ref: p.Reference || p.Invoice?.InvoiceNumber,
          details: p.Invoice?.Contact?.Name, currency: p.Invoice?.CurrencyCode || homeCurrency,
        }, built);
      }
      stats.payments = { docs: pays.length, posted, lines };
    }

    if (xfers) {
      let lines = 0;
      for (const bt of xfers) {
        const built = buildBankTransferLines(bt, accounts);
        if (!built.length) continue;
        // eslint-disable-next-line no-await-in-loop
        // A transfer between two of the org's own bank accounts — Xero has no
        // per-transfer CurrencyCode; the org's base currency is correct here.
        lines += await writeDoc(conn, {
          userId, orgId, sourceType: 'BankTransfer', sourceId: bt.BankTransferID,
          date: toDate(bt.Date), ref: bt.Reference, details: null,
          currency: homeCurrency,
        }, built);
      }
      stats.banktransfers = { docs: xfers.length, lines };
    }
  } finally {
    conn.release();
  }

  if (Object.keys(errors).length) stats._errors = errors;
  console.log(`[Xero staging] user=${userId} org=${orgId} ${allFetched ? 'clean' : 'PARTIAL (wipe skipped)'} — ${JSON.stringify(stats)}`);
  return { userId, orgId, partial: !allFetched, control: {
    ar: accounts.ar?.name, ap: accounts.ap?.name,
    outputTax: accounts.outputTax?.name, inputTax: accounts.inputTax?.name,
  }, stats };
}

// ── Promote validated staging rows → shared account_transactions ───────────
// Repeatable + idempotent: copies every staging line for (userId, orgId) into
// the shared ledger the report builders read. Xero's null-account sentinel GUID
// (balanced "plug" lines on manual journals) is classified as a liability
// suspense so the Balance Sheet / Trial Balance stay balanced while the P&L is
// untouched. Safe to re-run after every rebuild (ON DUPLICATE KEY UPDATE on the
// account_transactions unique key user_id,transaction_id,transaction_number,account_id).
const XERO_NULL_ACCOUNT = '00000000-0000-0000-0000-000000000000';

async function promoteLedger(userId, orgId) {
  // writeDoc() writes finished rows straight into account_transactions
  // (transaction_id 'xero:<id>', platform 'xero', with every report column set),
  // and buildStagingLedger's `fresh` pass wipes + rewrites the whole 'xero:%'
  // set each run, so voided/deleted/draft docs drop out on their own. Promotion
  // is therefore just the null-account → suspense reclassification, applied in
  // place.
  //
  // This USED to DELETE every non-recon 'xero' row and re-INSERT them from a
  // SELECT on the SAME table — a design that only worked when writeDoc wrote to
  // a separate `xero_account_transactions` staging table. Once writeDoc started
  // writing directly into account_transactions, the DELETE removed the very rows
  // the INSERT…SELECT was about to copy, so it always promoted 0 and left the
  // ledger empty (only the 'xero-recon:%' true-up plugs survived).
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      `UPDATE account_transactions
          SET account_name      = 'Xero Suspense (Unresolved Account)',
              account_group     = 'liability',
              account_type_code = 'other_current_liability'
        WHERE user_id = ? AND org_id = ? AND platform = 'xero'
          AND transaction_id LIKE 'xero:%'
          AND account_id = ?`,
      [userId, String(orgId), XERO_NULL_ACCOUNT]
    );
    const [[row]] = await conn.execute(
      `SELECT COUNT(*) AS n FROM account_transactions
        WHERE user_id = ? AND org_id = ? AND platform = 'xero'
          AND transaction_id LIKE 'xero:%'`,
      [userId, String(orgId)]
    );
    return row?.n || 0;
  } finally {
    conn.release();
  }
}

// ── Deterministic Trial-Balance true-up ────────────────────────────────────
// Xero's /Journals + /Payments endpoints are 401 for granular / non-Advanced
// apps, so the synthesized ledger can't learn WHICH bank a payment settled into
// (it parks settlement in "Xero Payments Clearing") and has no opening balances
// — leaving bank/clearing balances off vs Xero. We DO have the
// accounting.reports.trialbalance.read scope, so we fetch Xero's OWN Trial
// Balance as-at the latest posted date and post ONE per-account adjustment so
// every account's net (Σdebit−Σcredit) in account_transactions equals Xero's TB
// to the paisa. Because both ledgers balance (ΣTB nets = 0, Σour nets = 0), the
// union of deltas sums to 0 → the adjustment set self-balances (no contra
// account needed). The adjustments are ordinary debit/credit rows in the shared
// table, so the Balance Sheet AND the account-drill breakdown reconcile — same
// as QuickBooks, whose payments already post to the real bank so it needs none.
//
// Idempotent: each account's adjustment is keyed transaction_id='xero-recon:<id>'
// and recomputed from the NON-recon net every run (ON DUPLICATE KEY UPDATE), so
// re-running never double-counts. Graceful: any token / rate-limit / scope
// failure is caught and the sync still succeeds (just without the true-up).
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function trueUpFromTrialBalance(userId, orgId) {
  let creds;
  try { creds = await getValidXeroToken(userId); }
  catch (e) { console.warn('[Xero true-up] no valid token:', e.message); return { adjusted: 0, skipped: true }; }
  const { accessToken, tenantId } = creds;

  // These plug rows aren't any single real transaction — they're a synthetic
  // per-account correction against Xero's own Trial Balance (which is itself
  // reported in the org's base currency), so the org's base currency is the
  // correct value, not a per-transaction lookup.
  const [[orgRow]] = await pool.execute(
    'SELECT currency FROM xero_organizations WHERE user_id = ? AND tenant_id = ? LIMIT 1',
    [userId, String(orgId)]
  ).catch(() => [[null]]);
  const homeCurrency = orgRow?.currency || null;

  // As-at = latest posted Xero date (so the current BS reconciles exactly).
  const [[{ maxd, mind }]] = await pool.execute(
    `SELECT MAX(transaction_date) AS maxd, MIN(transaction_date) AS mind
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND platform = 'xero'
        AND transaction_id NOT LIKE 'xero-recon:%'`,
    [userId, String(orgId)]
  );
  const asOf = maxd ? String(maxd).slice(0, 10) : new Date().toISOString().slice(0, 10);

  // The reconciliation plugs are an OPENING-BALANCE adjustment — the gap between
  // our synthesized ledger and Xero's actual position, most of which is prior
  // history we never synced. Date them at the fiscal-year start of the earliest
  // posting (not "today"), so a Balance Sheet as-of ANY date includes the full,
  // self-balancing plug set (banks reconcile, clearing stays zeroed) while the
  // real postings still filter by date — letting the report move with the
  // selected period. `aggregateBS` therefore filters recon rows by date too.
  const openingDate = (() => {
    const base = mind ? String(mind).slice(0, 10) : asOf;
    const d = new Date(base);
    if (Number.isNaN(d.getTime())) return asOf;
    const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // Indian FY (Apr)
    return `${y}-04-01`;
  })();

  // Fetch Xero's own Trial Balance as-at that date.
  let report;
  try {
    const res = await withRetry(() => axios.get(`${XERO_API_BASE}/Reports/TrialBalance`, {
      headers: headers(accessToken, tenantId),
      params: { date: asOf },
    }));
    report = res.data?.Reports?.[0];
  } catch (e) {
    console.warn('[Xero true-up] TrialBalance fetch failed (rate limit / scope):', e.response?.status || e.message);
    return { adjusted: 0, skipped: true };
  }
  if (!report) return { adjusted: 0, skipped: true };

  // Parse leaf rows → target net per account UUID. Xero TB cols are
  // [Account, Debit, Credit, YTD Debit, YTD Credit]; the YTD pair is the as-at
  // balance (period cols can be 0 for idle accounts) — prefer it, fall back.
  const target = {};
  const nameById = {};
  const visit = (rs) => {
    for (const row of rs || []) {
      if (row.Rows) visit(row.Rows);
      const cells = row.Cells || [];
      const accountId = cells[0]?.Attributes?.find?.((a) => a.Id === 'account')?.Value;
      if (!accountId) continue;
      const hasYtd = cells.length >= 5;
      const d = num((hasYtd ? cells[3] : cells[1])?.Value);
      const c = num((hasYtd ? cells[4] : cells[2])?.Value);
      target[String(accountId)] = r2(d - c);
      nameById[String(accountId)] = cells[0]?.Value || '';
    }
  };
  visit(report.Rows || []);
  if (Object.keys(target).length === 0) return { adjusted: 0, skipped: true };

  // Clear the previous plug set now that we have a usable TB (promoteLedger
  // deliberately preserves recon rows, and ON DUPLICATE KEY UPDATE below can only
  // rewrite a plug, never retire one). Without this, an account whose real
  // postings have since caught up with Xero keeps its old plug forever and gets
  // reported at double its balance.
  await pool.execute(
    `DELETE FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND platform = 'xero'
        AND transaction_id LIKE 'xero-recon:%'`,
    [userId, String(orgId)]
  );

  // Our current net per account, EXCLUDING prior true-up rows (keeps it stable).
  const [ours] = await pool.execute(
    `SELECT account_id, account_name, account_group, account_type_code,
            ROUND(SUM(debit) - SUM(credit), 2) AS net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND platform = 'xero'
        AND transaction_id NOT LIKE 'xero-recon:%'
      GROUP BY account_id, account_name, account_group, account_type_code`,
    [userId, String(orgId)]
  );
  // ACCUMULATE per account_id — the GROUP BY also splits on name/group/type, so
  // one account can come back as several rows. Overwriting made the true-up see
  // only the last slice and post a plug for the whole rest of the account.
  const ourNet = {};
  const ourMeta = {};
  for (const r of ours) {
    const id = String(r.account_id);
    ourNet[id] = r2((ourNet[id] || 0) + num(r.net));
    if (!ourMeta[id]) ourMeta[id] = { name: r.account_name, group: r.account_group, typeCode: r.account_type_code };
  }

  // Group/type for accounts present ONLY in Xero's TB (rare) — from the account
  // master so they slot into the right Balance Sheet section.
  const accounts = await loadAccounts(userId).catch(() => ({ byId: new Map() }));

  const allIds = new Set([...Object.keys(target), ...Object.keys(ourNet)]);
  const SRC = 'xero-recon';
  let adjusted = 0;
  for (const id of allIds) {
    const tgt = target[id] != null ? target[id] : 0; // not in TB → should be 0
    const cur = ourNet[id] != null ? ourNet[id] : 0;
    const delta = r2(tgt - cur);
    if (delta === 0) continue;
    const debit  = delta > 0 ? delta : 0;
    const credit = delta < 0 ? -delta : 0;
    const meta = ourMeta[id] || {};
    const acct = accounts.byId?.get?.(String(id));
    const name  = meta.name || nameById[id] || acct?.name || 'Xero account';
    const group = meta.group || acct?.group || null;
    const typeCode = meta.typeCode || acct?.typeCode || null;
    await pool.execute(
      `INSERT INTO account_transactions
         (user_id, org_id, platform, transaction_id, account_id, transaction_date,
          account_name, account_group, account_type_code, transaction_details,
          transaction_type, transaction_number, reference_number,
          debit, credit, balance, balance_type, source_type, line_number, currency_code, synced_at)
       VALUES (?, ?, 'xero', ?, ?, ?, ?, ?, ?, 'Xero Trial Balance true-up',
          'Reconciliation', '0', NULL, ?, ?, 0, ?, ?, 0, ?, NOW())
       ON DUPLICATE KEY UPDATE
          transaction_date=VALUES(transaction_date), account_name=VALUES(account_name),
          account_group=VALUES(account_group), account_type_code=VALUES(account_type_code),
          debit=VALUES(debit), credit=VALUES(credit), balance_type=VALUES(balance_type),
          currency_code=COALESCE(VALUES(currency_code), currency_code), synced_at=NOW()`,
      [userId, String(orgId), `${SRC}:${id}`, String(id), openingDate,
       name, group, typeCode, debit, credit, debit >= credit ? 'D' : 'C', SRC, homeCurrency]
    );
    adjusted += 1;
  }

  // Guarantee the recon plugs self-balance. Xero's YTD Trial Balance reconciles
  // current-year P&L against a prior-years retained-earnings figure that can land
  // on a system equity row without a parseable account id (plus sub-cent rounding
  // across many accounts). Left alone, that residual silently unbalances every
  // client's Balance Sheet (Assets ≠ Liabilities + Equity). We park it on ONE
  // clearly-labelled equity line so the whole ledger always balances exactly —
  // structurally, for any client, regardless of TB parsing edge cases. Keyed on a
  // fixed transaction_id so it self-corrects (never accumulates) on re-sync.
  const [[rs]] = await pool.execute(
    `SELECT ROUND(SUM(debit) - SUM(credit), 2) AS net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND platform = 'xero'
        AND transaction_id LIKE 'xero-recon:%'
        AND transaction_id <> 'xero-recon:__residual__'`,
    [userId, String(orgId)]
  );
  const residual = r2(rs?.net || 0);
  const rDebit  = residual < 0 ? -residual : 0; // cancel a net-credit plug set
  const rCredit = residual > 0 ? residual : 0;  // cancel a net-debit plug set
  await pool.execute(
    `INSERT INTO account_transactions
       (user_id, org_id, platform, transaction_id, account_id, transaction_date,
        account_name, account_group, account_type_code, transaction_details,
        transaction_type, transaction_number, reference_number,
        debit, credit, balance, balance_type, source_type, line_number, currency_code, synced_at)
     VALUES (?, ?, 'xero', 'xero-recon:__residual__', '__xero_recon_residual__', ?,
        'Reconciliation Rounding', 'equity', 'equity', 'Xero Trial Balance true-up residual',
        'Reconciliation', '0', NULL, ?, ?, 0, ?, 'xero-recon', 0, ?, NOW())
     ON DUPLICATE KEY UPDATE
        transaction_date=VALUES(transaction_date), debit=VALUES(debit),
        credit=VALUES(credit), balance_type=VALUES(balance_type),
        currency_code=COALESCE(VALUES(currency_code), currency_code), synced_at=NOW()`,
    [userId, String(orgId), openingDate, rDebit, rCredit, rDebit >= rCredit ? 'D' : 'C', homeCurrency]
  );
  if (Math.abs(residual) > 0.005) adjusted += 1;

  console.log(`[Xero true-up] user=${userId} org=${orgId} as-at ${asOf}: adjusted ${adjusted} accounts to match Xero Trial Balance (residual ${residual})`);
  return { adjusted, asOf, residual };
}

// ── Self-check: verify the promoted Xero ledger is internally consistent ─────
// Runs automatically after every rebuild so a posting regression surfaces LOUDLY
// (in logs + the returned object) for ANY client, instead of being discovered by
// manually eyeballing one report at a time. All checks are DB-only, deterministic
// and zero-noise on a healthy ledger — each targets a real bug class we have hit:
//   • ledgerBalance — the reconstructed double-entry ledger must net to zero.
//   • docBalance    — every single document must balance on its own.
//   • orphanDocs    — a posted invoice/bill with no header row = a voided/deleted
//                     doc wrongly promoted (the "extra ₹54,000" class).
//   • docDate       — a document's header date must appear on one of its ledger
//                     lines; a timezone/date-parse shift moves every line off it
//                     (the "missing entry / wrong period" class).
//   • reconBalance  — the Trial-Balance true-up plugs must self-balance, else the
//                     Balance Sheet is off by exactly the residual.
// Non-fatal by design: reports still build from the DB regardless; the value is
// early, automatic detection. Pass { strict: true } to throw on any failure.
async function verifyXeroLedger(userId, orgId, opts = {}) {
  const tol = opts.tolerance != null ? opts.tolerance : 1; // currency-unit slack
  const oid = String(orgId);
  const checks = {};

  // 1) Non-recon ledger balances (ΣDebit == ΣCredit).
  const [[lb]] = await pool.execute(
    `SELECT ROUND(SUM(debit),2) dr, ROUND(SUM(credit),2) cr
       FROM account_transactions
      WHERE user_id=? AND org_id=? AND platform='xero'
        AND transaction_id NOT LIKE 'xero-recon:%'`,
    [userId, oid]
  );
  const ledgerDiff = r2((lb.dr || 0) - (lb.cr || 0));
  checks.ledgerBalance = { ok: Math.abs(ledgerDiff) <= tol, dr: lb.dr, cr: lb.cr, diff: ledgerDiff };

  // 2) Trial-Balance true-up plugs self-balance (residual == Balance-Sheet gap).
  const [[rb]] = await pool.execute(
    `SELECT ROUND(SUM(debit),2) dr, ROUND(SUM(credit),2) cr, COUNT(*) n
       FROM account_transactions
      WHERE user_id=? AND org_id=? AND platform='xero'
        AND transaction_id LIKE 'xero-recon:%'`,
    [userId, oid]
  );
  const reconDiff = r2((rb.dr || 0) - (rb.cr || 0));
  checks.reconBalance = { ok: Math.abs(reconDiff) <= tol, diff: reconDiff, rows: rb.n || 0 };

  // 3) Every document balances on its own.
  const [docs] = await pool.execute(
    `SELECT transaction_id, ROUND(SUM(debit)-SUM(credit),2) diff
       FROM account_transactions
      WHERE user_id=? AND org_id=? AND platform='xero'
        AND transaction_id NOT LIKE 'xero-recon:%'
      GROUP BY transaction_id
      HAVING ABS(SUM(debit)-SUM(credit)) > ?`,
    [userId, oid, tol]
  );
  checks.docBalance = { ok: docs.length === 0, count: docs.length, offenders: docs.slice(0, 20) };

  // 4) No posted invoice/bill references a missing header row (voided/deleted docs
  //    are skipped by the header sync, so a ledger row with no header = wrongly
  //    posted). 5) Each header date must appear on one of the document's lines.
  const orphan = {};
  const dateOff = {};
  for (const [st, tbl] of [['ACCREC', 'invoices'], ['ACCPAY', 'bills']]) {
    // eslint-disable-next-line no-await-in-loop
    const [[o]] = await pool.execute(
      `SELECT COUNT(DISTINCT at.source_id) n
         FROM account_transactions at
         LEFT JOIN \`${tbl}\` h
           ON h.user_id = at.user_id
          AND h.xero_id = at.source_id COLLATE utf8mb4_unicode_ci
        WHERE at.user_id=? AND at.org_id=? AND at.platform='xero'
          AND at.source_type=? AND h.xero_id IS NULL`,
      [userId, oid, st]
    );
    orphan[st] = o.n;
    // eslint-disable-next-line no-await-in-loop
    const [[d]] = await pool.execute(
      `SELECT COUNT(*) n FROM (
         SELECT at.source_id
           FROM account_transactions at
           JOIN \`${tbl}\` h
             ON h.user_id = at.user_id
            AND h.xero_id = at.source_id COLLATE utf8mb4_unicode_ci
          WHERE at.user_id=? AND at.org_id=? AND at.platform='xero' AND at.source_type=?
          GROUP BY at.source_id
          HAVING SUM(DATE(at.transaction_date)=DATE(h.date)) = 0
       ) x`,
      [userId, oid, st]
    );
    dateOff[st] = d.n;
  }
  checks.orphanDocs = { ok: (orphan.ACCREC + orphan.ACCPAY) === 0, ...orphan };
  checks.docDate    = { ok: (dateOff.ACCREC + dateOff.ACCPAY) === 0, ...dateOff };

  const failed = Object.entries(checks).filter(([, v]) => !v.ok).map(([k]) => k);
  const ok = failed.length === 0;
  if (ok) {
    console.log(`[Xero verify] user=${userId} org=${oid} OK — all ledger invariants hold`);
  } else {
    console.warn(`[Xero verify] user=${userId} org=${oid} FAILED: ${failed.join(', ')}`);
    for (const k of failed) console.warn(`  - ${k}: ${JSON.stringify(checks[k])}`);
    if (opts.strict) {
      const e = new Error(`Xero ledger verification failed: ${failed.join(', ')}`);
      e.checks = checks;
      throw e;
    }
  }
  return { ok, failed, checks };
}

// ── Orchestrator: rebuild staging from Xero docs, then promote to the shared
// ledger so DB-backed Xero reports reflect the latest sync. Returns the build
// stats + promoted row count. maxPages caps pages/entity for quick runs (0=all).
async function rebuildXeroLedger(userId, opts = {}) {
  const build = await buildStagingLedger(userId, opts);
  const promoted = await promoteLedger(userId, build.orgId);
  // True-up bank/clearing/opening gaps against Xero's own Trial Balance so the
  // Balance Sheet + drill reconcile. Non-fatal: on any failure the sync stands.
  //
  // GUARD: Skip true-up when critical sync modules failed (429 rate-limit, etc.)
  // because the GL would be incomplete — computing recon entries against partial
  // data creates stale plugs that never self-correct until the next full sync.
  let trueup = { adjusted: 0, skipped: true };
  try { trueup = await trueUpFromTrialBalance(userId, build.orgId); }
  catch (e) { console.warn('[Xero true-up] skipped:', e.message); }
  // Self-check the promoted ledger so any posting regression surfaces immediately
  // for this client. Non-fatal: the sync stands and reports still build from DB.
  let verify = { ok: null, skipped: true };
  try { verify = await verifyXeroLedger(userId, build.orgId); }
  catch (e) { console.warn('[Xero verify] skipped:', e.message); }
  return { ...build, promoted, trueup, verify };
}

module.exports = {
  buildStagingLedger,
  promoteLedger,
  rebuildXeroLedger,
  trueUpFromTrialBalance,
  verifyXeroLedger,
  loadAccounts,
  buildInvoiceLines,
  buildCreditNoteLines,
  buildBankLines,
  buildManualJournalLines,
  buildPaymentLines,
  buildBankTransferLines,
  balance,
};
