'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Analytics Warehouse ETL (Phase 5).
//
// Populates the star-schema dim_*/fact_* tables from the provider raw warehouse.
// Provider-agnostic by contract: facts/dims are keyed by (user_id, provider,
// connection_ref). Today the Zoho source maps zb_* → facts; QuickBooks / Xero
// can register their own source mappers later without touching consumers.
//
// Strategy: dimensions are upserted (ON DUPLICATE KEY); facts are fully rebuilt
// per connection (DELETE scope + bulk INSERT … SELECT) so removed/voided docs
// disappear and the warehouse always reflects the current raw state. Bulk
// server-side INSERT … SELECT keeps it fast (Phase 9).
// ─────────────────────────────────────────────────────────────────────────────

const pool = require('../config/db');

// ─── date dimension ──────────────────────────────────────────────────────────
// Indian fiscal year (Apr–Mar). Populated once for a wide range; idempotent.
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

async function ensureDimDate() {
  const [[{ c }]] = await pool.execute('SELECT COUNT(*) AS c FROM dim_date');
  if (c > 0) return 0;

  const rows = [];
  const start = new Date(Date.UTC(2015, 0, 1));
  const end   = new Date(Date.UTC(2035, 11, 31));
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;            // 1-12
    const day = d.getUTCDate();
    const dow0 = d.getUTCDay();               // 0=Sun
    const dateKey = y * 10000 + m * 100 + day;
    const fullDate = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const quarter = Math.floor((m - 1) / 3) + 1;
    const fiscalYear = m >= 4 ? y : y - 1;
    const fiscalQuarter = m >= 4 ? Math.floor((m - 4) / 3) + 1 : Math.floor((m + 8) / 3) + 1;
    const dowIso = dow0 === 0 ? 7 : dow0;     // 1=Mon..7=Sun
    rows.push([
      dateKey, fullDate, day, m, MONTHS[m - 1], quarter, y,
      fiscalYear, fiscalQuarter, dowIso, DAYS[dow0], dow0 === 0 || dow0 === 6 ? 1 : 0,
    ]);
  }

  let written = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const flat = slice.flat();
    await pool.query(
      `INSERT IGNORE INTO dim_date
         (date_key, full_date, day, month, month_name, quarter, year,
          fiscal_year, fiscal_quarter, day_of_week, day_name, is_weekend)
       VALUES ${placeholders}`,
      flat
    );
    written += slice.length;
  }
  return written;
}

// ─── account classification (Zoho account_type → 5-bucket classification) ─────
// MySQL CASE expression, used inside the dim_account INSERT … SELECT.
const ZOHO_CLASS_CASE = `
  CASE
    WHEN account_type IN ('income','other_income') THEN 'Revenue'
    WHEN account_type IN ('expense','cost_of_goods_sold','other_expense') THEN 'Expense'
    WHEN account_type IN ('accounts_payable','credit_card','long_term_liability','other_liability','other_current_liability','overseas_tax_payable','tax_payable') THEN 'Liability'
    WHEN account_type IN ('equity') THEN 'Equity'
    WHEN account_type IN ('accounts_receivable','bank','cash','fixed_asset','other_asset','other_current_asset','stock','payment_clearing_account','input_tax','intangible_asset','right_to_use_asset','financial_asset') THEN 'Asset'
    ELSE 'Asset'
  END`;

// ─── dimension upserts (Zoho) ─────────────────────────────────────────────────
async function upsertDimensions(userId, orgId) {
  await pool.execute(
    `INSERT INTO dim_customer (user_id, provider, connection_ref, source_id, name, status, currency_code)
       SELECT user_id, 'zoho', org_id, zoho_id, contact_name, status, currency_code
         FROM customers
        WHERE user_id=? AND org_id=? AND is_deleted=0 AND contact_type='customer'
     ON DUPLICATE KEY UPDATE name=VALUES(name), status=VALUES(status), currency_code=VALUES(currency_code)`,
    [userId, orgId]
  );
  await pool.execute(
    `INSERT INTO dim_vendor (user_id, provider, connection_ref, source_id, name, status, currency_code)
       SELECT user_id, 'zoho', org_id, zoho_id, contact_name, status, currency_code
         FROM vendors
        WHERE user_id=? AND org_id=? AND is_deleted=0 AND contact_type='vendor'
     ON DUPLICATE KEY UPDATE name=VALUES(name), status=VALUES(status), currency_code=VALUES(currency_code)`,
    [userId, orgId]
  );
  await pool.execute(
    `INSERT INTO dim_account (user_id, provider, connection_ref, source_id, name, account_type, classification, parent_id)
       SELECT user_id, 'zoho', org_id, zoho_account_id, account_name, account_type, ${ZOHO_CLASS_CASE}, parent_account_id
         FROM zb_chart_of_accounts
        WHERE user_id=? AND org_id=? AND is_deleted=0
     ON DUPLICATE KEY UPDATE name=VALUES(name), account_type=VALUES(account_type),
        classification=VALUES(classification), parent_id=VALUES(parent_id)`,
    [userId, orgId]
  );
  await pool.execute(
    `INSERT INTO dim_item (user_id, provider, connection_ref, source_id, name, item_type, rate)
       SELECT user_id, 'zoho', org_id, zoho_item_id, COALESCE(name, item_name), item_type, rate
         FROM zb_items
        WHERE user_id=? AND org_id=?
     ON DUPLICATE KEY UPDATE name=VALUES(name), item_type=VALUES(item_type), rate=VALUES(rate)`,
    [userId, orgId]
  );
  await pool.execute(
    `INSERT INTO dim_project (user_id, provider, connection_ref, source_id, name, status, customer_id)
       SELECT user_id, 'zoho', org_id, zoho_project_id, project_name, status, customer_id
         FROM zb_projects
        WHERE user_id=? AND org_id=? AND is_deleted=0
     ON DUPLICATE KEY UPDATE name=VALUES(name), status=VALUES(status), customer_id=VALUES(customer_id)`,
    [userId, orgId]
  );
}

// date_key SQL fragment from a DATE column
const DKEY = (col) => `CASE WHEN ${col} IS NULL THEN NULL ELSE (YEAR(${col})*10000 + MONTH(${col})*100 + DAY(${col})) END`;
// aging bucket SQL from a due_date column (only meaningful for open balances)
const AGING = (due) => `
  CASE
    WHEN ${due} IS NULL OR DATEDIFF(CURDATE(), ${due}) <= 0 THEN 'current'
    WHEN DATEDIFF(CURDATE(), ${due}) <= 30 THEN '1-30'
    WHEN DATEDIFF(CURDATE(), ${due}) <= 60 THEN '31-60'
    WHEN DATEDIFF(CURDATE(), ${due}) <= 90 THEN '61-90'
    ELSE '90+'
  END`;
const OVERDUE = (due) => `GREATEST(0, CASE WHEN ${due} IS NULL THEN 0 ELSE DATEDIFF(CURDATE(), ${due}) END)`;

// ─── fact rebuilds (Zoho) ─────────────────────────────────────────────────────
async function rebuildFacts(userId, orgId) {
  const scope = [userId, orgId];

  // fact_revenue ← invoices (+) and credit notes (−, so SUM(total) is net revenue)
  await pool.execute(`DELETE FROM fact_revenue WHERE user_id=? AND provider='zoho' AND connection_ref=?`, scope);
  await pool.execute(
    `INSERT INTO fact_revenue
       (user_id, provider, connection_ref, date_key, txn_date, doc_type, doc_id, doc_number,
        customer_source_id, customer_name, status, sub_total, tax_total, total, balance, currency_code)
     SELECT user_id, 'zoho', org_id, ${DKEY('date')}, date, 'invoice', zoho_id, invoice_number,
            zoho_customer_id, customer_name, status, sub_total, tax_total, total, balance, currency_code
       FROM invoices
      WHERE user_id=? AND org_id=? AND is_deleted=0`,
    scope
  );
  await pool.execute(
    `INSERT INTO fact_revenue
       (user_id, provider, connection_ref, date_key, txn_date, doc_type, doc_id, doc_number,
        customer_source_id, customer_name, status, sub_total, tax_total, total, balance, currency_code)
     SELECT user_id, 'zoho', org_id, ${DKEY('date')}, date, 'credit_note', zoho_creditnote_id, creditnote_number,
            zoho_customer_id, customer_name, status, -sub_total, -tax_total, -total, -balance, currency_code
       FROM zb_credit_notes
      WHERE user_id=? AND org_id=? AND is_deleted=0`,
    scope
  );

  // fact_expense ← bills + expenses
  await pool.execute(`DELETE FROM fact_expense WHERE user_id=? AND provider='zoho' AND connection_ref=?`, scope);
  await pool.execute(
    `INSERT INTO fact_expense
       (user_id, provider, connection_ref, date_key, txn_date, doc_type, doc_id, doc_number,
        vendor_source_id, vendor_name, category, account_source_id, status, sub_total, tax_total, total, balance, currency_code)
     SELECT user_id, 'zoho', org_id, ${DKEY('date')}, date, 'bill', zoho_id, bill_number,
            zoho_vendor_id, vendor_name, NULL, NULL, status, sub_total, tax_total, total, balance, currency_code
       FROM bills
      WHERE user_id=? AND org_id=? AND is_deleted=0`,
    scope
  );
  await pool.execute(
    `INSERT INTO fact_expense
       (user_id, provider, connection_ref, date_key, txn_date, doc_type, doc_id, doc_number,
        vendor_source_id, vendor_name, category, account_source_id, status, sub_total, tax_total, total, balance, currency_code)
     SELECT user_id, 'zoho', org_id, ${DKEY('date')}, date, 'expense', zoho_id, reference_number,
            zoho_vendor_id, vendor_name, account_name, account_id, status,
            sub_total, tax_amount, total, 0, currency_code
       FROM expense_entries
      WHERE user_id=? AND org_id=? AND is_deleted=0`,
    scope
  );

  // fact_cashflow ← bank transactions (Zoho: debit=inflow, credit=outflow)
  await pool.execute(`DELETE FROM fact_cashflow WHERE user_id=? AND provider='zoho' AND connection_ref=?`, scope);
  await pool.execute(
    `INSERT INTO fact_cashflow
       (user_id, provider, connection_ref, date_key, txn_date, source_id, account_source_id,
        account_name, txn_type, direction, amount, currency_code)
     SELECT user_id, 'zoho', org_id, ${DKEY('transaction_date')}, transaction_date, transaction_id, account_id,
            account_name, transaction_type,
            CASE WHEN debit_or_credit='debit' THEN 'inflow' ELSE 'outflow' END,
            amount, currency_code
       FROM bank_transactions
      WHERE user_id=? AND org_id=?
        AND transaction_type NOT IN ('transfer_fund')`,
    scope
  );

  // fact_receivable ← open invoices
  await pool.execute(`DELETE FROM fact_receivable WHERE user_id=? AND provider='zoho' AND connection_ref=?`, scope);
  await pool.execute(
    `INSERT INTO fact_receivable
       (user_id, provider, connection_ref, date_key, txn_date, due_date, doc_id, doc_number,
        customer_source_id, customer_name, status, total, balance, days_overdue, aging_bucket, currency_code)
     SELECT user_id, 'zoho', org_id, ${DKEY('date')}, date, due_date, zoho_id, invoice_number,
            zoho_customer_id, customer_name, status, total, balance,
            ${OVERDUE('due_date')}, ${AGING('due_date')}, currency_code
       FROM invoices
      WHERE user_id=? AND org_id=? AND is_deleted=0
        AND balance > 0 AND status NOT IN ('paid','void','draft')`,
    scope
  );

  // fact_payable ← open bills
  await pool.execute(`DELETE FROM fact_payable WHERE user_id=? AND provider='zoho' AND connection_ref=?`, scope);
  await pool.execute(
    `INSERT INTO fact_payable
       (user_id, provider, connection_ref, date_key, txn_date, due_date, doc_id, doc_number,
        vendor_source_id, vendor_name, status, total, balance, days_overdue, aging_bucket, currency_code)
     SELECT user_id, 'zoho', org_id, ${DKEY('date')}, date, due_date, zoho_id, bill_number,
            zoho_vendor_id, vendor_name, status, total, balance,
            ${OVERDUE('due_date')}, ${AGING('due_date')}, currency_code
       FROM bills
      WHERE user_id=? AND org_id=? AND is_deleted=0
        AND balance > 0 AND status NOT IN ('paid','void','draft')`,
    scope
  );

  // fact_tax ← output (invoices) + input (bills)
  await pool.execute(`DELETE FROM fact_tax WHERE user_id=? AND provider='zoho' AND connection_ref=?`, scope);
  await pool.execute(
    `INSERT INTO fact_tax
       (user_id, provider, connection_ref, date_key, txn_date, doc_type, doc_id, direction,
        taxable_amount, tax_amount, currency_code)
     SELECT user_id, 'zoho', org_id, ${DKEY('date')}, date, 'invoice', zoho_id, 'output',
            sub_total, tax_total, currency_code
       FROM invoices
      WHERE user_id=? AND org_id=? AND is_deleted=0 AND tax_total <> 0`,
    scope
  );
  await pool.execute(
    `INSERT INTO fact_tax
       (user_id, provider, connection_ref, date_key, txn_date, doc_type, doc_id, direction,
        taxable_amount, tax_amount, currency_code)
     SELECT user_id, 'zoho', org_id, ${DKEY('date')}, date, 'bill', zoho_id, 'input',
            sub_total, tax_total, currency_code
       FROM bills
      WHERE user_id=? AND org_id=? AND is_deleted=0 AND tax_total <> 0`,
    scope
  );
}

async function countFacts(userId, orgId) {
  const tables = ['fact_revenue', 'fact_expense', 'fact_cashflow', 'fact_receivable', 'fact_payable', 'fact_tax'];
  let total = 0;
  const detail = {};
  for (const t of tables) {
    const [[r]] = await pool.execute(
      `SELECT COUNT(*) AS c FROM ${t} WHERE user_id=? AND provider='zoho' AND connection_ref=?`,
      [userId, orgId]
    );
    detail[t] = parseInt(r.c || 0);
    total += detail[t];
  }
  return { total, detail };
}

// ─── main entry ──────────────────────────────────────────────────────────────
// runEtl(userId, { provider, connectionRef }) — rebuilds the warehouse for one
// connection. Zoho is the only source mapper implemented today.
async function runEtl(userId, { provider = 'zoho', connectionRef } = {}) {
  if (provider !== 'zoho') {
    throw Object.assign(new Error(`Analytics ETL not implemented for provider '${provider}'`), { code: 'ETL_PROVIDER_UNSUPPORTED' });
  }
  if (!connectionRef) throw Object.assign(new Error('connectionRef (org_id) required'), { code: 'ETL_NO_CONNECTION' });

  const [run] = await pool.execute(
    `INSERT INTO analytics_etl_runs (user_id, provider, connection_ref, status) VALUES (?,?,?,'running')`,
    [userId, provider, connectionRef]
  );
  const runId = run.insertId;
  try {
    await ensureDimDate();
    await upsertDimensions(userId, connectionRef);
    await rebuildFacts(userId, connectionRef);
    const { total, detail } = await countFacts(userId, connectionRef);
    await pool.execute(
      `UPDATE analytics_etl_runs SET completed_at=NOW(), status='succeeded', rows_written=?, detail=? WHERE id=?`,
      [total, JSON.stringify(detail), runId]
    );
    return { runId, status: 'succeeded', rowsWritten: total, detail };
  } catch (e) {
    await pool.execute(
      `UPDATE analytics_etl_runs SET completed_at=NOW(), status='failed', detail=? WHERE id=?`,
      [JSON.stringify({ error: e.message }), runId]
    );
    throw e;
  }
}

module.exports = { runEtl, ensureDimDate };
