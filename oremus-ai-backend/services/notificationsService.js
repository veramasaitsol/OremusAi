'use strict';
// Notification helpers: create (idempotent when a dedupe key is supplied) and
// generate user notifications derived from live financial data (overdue
// invoices, bills past due) plus a one-time welcome message.
const pool = require('../config/db');

const VALID_TYPES = new Set(['info', 'success', 'warning', 'error', 'finance', 'sync', 'system']);

function inr(amount) {
  const n = Number(amount || 0);
  try {
    return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return '₹' + n.toFixed(2);
  }
}

/**
 * Insert a notification. When `dedupeKey` is provided the row is upserted on
 * (user_id, dedupe_key) so repeat calls never duplicate.
 */
async function createNotification(userId, { type = 'info', title, body = null, link = null, dedupeKey = null, meta = null } = {}) {
  if (!userId || !title) throw new Error('userId and title are required');
  const safeType = VALID_TYPES.has(type) ? type : 'info';
  const metaJson = meta == null ? null : JSON.stringify(meta);

  const [result] = await pool.execute(
    `INSERT INTO notifications (user_id, type, title, body, link, dedupe_key, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE title = VALUES(title), body = VALUES(body), link = VALUES(link), meta = VALUES(meta)`,
    [userId, safeType, title, body, link, dedupeKey, metaJson],
  );
  return result;
}

/**
 * Derive notifications for a user from their current data. Idempotent — safe to
 * call on every page load. Returns the number of (new or refreshed) rows.
 */
async function generateForUser(userId, orgId = null) {
  let touched = 0;
  const orgF = orgId ? ' AND org_id = ?' : '';
  const orgP = orgId ? [orgId] : [];

  // One-time welcome (only when the user has no notifications at all).
  const [[{ cnt }]] = await pool.execute(
    'SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ?',
    [userId],
  );
  if (cnt === 0) {
    await createNotification(userId, {
      type: 'system',
      title: 'Welcome to Oremus',
      body: 'Your notification center is ready. We will alert you about overdue invoices, bills due, and account activity here.',
      link: '/dashboard',
      dedupeKey: 'welcome',
    });
    touched++;
  }

  // Overdue invoices (AR): unpaid balance with a due date in the past.
  try {
    const [invoices] = await pool.execute(
      `SELECT id, invoice_number, customer_name, balance, due_date
         FROM invoices
        WHERE user_id = ? AND balance > 0 AND due_date IS NOT NULL AND due_date < CURDATE()
          AND (status IS NULL OR status NOT IN ('paid','void','draft'))${orgF}
        ORDER BY due_date ASC
        LIMIT 15`,
      [userId, ...orgP],
    );
    for (const inv of invoices) {
      await createNotification(userId, {
        type: 'warning',
        title: `Invoice ${inv.invoice_number || '#' + inv.id} is overdue`,
        body: `${inv.customer_name || 'Customer'} · ${inr(inv.balance)} outstanding (due ${inv.due_date}).`,
        link: '/invoices',
        dedupeKey: `invoice_overdue:${inv.id}`,
        meta: { invoiceId: inv.id, amount: Number(inv.balance) },
      });
      touched++;
    }
  } catch (e) {
    console.error('[notifications] invoice scan:', e.message);
  }

  // Bills past due (AP).
  try {
    const [bills] = await pool.execute(
      `SELECT id, bill_number, vendor_name, balance, due_date
         FROM bills
        WHERE user_id = ? AND balance > 0 AND due_date IS NOT NULL AND due_date < CURDATE()
          AND (status IS NULL OR status NOT IN ('paid','void','draft'))${orgF}
        ORDER BY due_date ASC
        LIMIT 15`,
      [userId, ...orgP],
    );
    for (const bill of bills) {
      await createNotification(userId, {
        type: 'finance',
        title: `Bill ${bill.bill_number || '#' + bill.id} is due`,
        body: `${bill.vendor_name || 'Vendor'} · ${inr(bill.balance)} payable (due ${bill.due_date}).`,
        link: '/vendors',
        dedupeKey: `bill_due:${bill.id}`,
        meta: { billId: bill.id, amount: Number(bill.balance) },
      });
      touched++;
    }
  } catch (e) {
    console.error('[notifications] bill scan:', e.message);
  }

  return touched;
}

module.exports = { createNotification, generateForUser };
