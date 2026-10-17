'use strict';

/**
 * Sync-run tracking — live progress + outcome for a provider sync.
 * ---------------------------------------------------------------------------
 * Every provider sync (Zoho / QuickBooks / Xero) runs in the background after
 * an OAuth connect, so the person who clicked "Connect" had no way to tell
 * how far it got or whether it worked. A SyncRun records it in `sync_runs`:
 *
 *   running   → steps_done / steps_total and the step(s) in progress
 *   succeeded → every step finished
 *   partial   → finished, but some data couldn't be fetched (each reason kept)
 *   failed    → nothing could be synced, or the sync aborted
 *
 * On finish it also drops a notification for whoever triggered the sync (the
 * admin connecting on a client's behalf, or the user themselves).
 *
 * Tracking must never break a sync: every write is best-effort, and when the
 * table can't be used the run silently becomes a no-op.
 */

const pool = require('../config/db');
const { createNotification } = require('./notificationsService');

const PROVIDER_LABEL = { zoho: 'Zoho Books', quickbooks: 'QuickBooks', xero: 'Xero' };

// A run whose process died (server restart, crash) never finishes on its own;
// treat one that hasn't moved for this long as interrupted.
const STALE_AFTER_MINUTES = 60;

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.execute(
      `CREATE TABLE IF NOT EXISTS sync_runs (
         id            INT AUTO_INCREMENT PRIMARY KEY,
         user_id       INT          NOT NULL,
         triggered_by  INT          NOT NULL,
         provider      VARCHAR(16)  NOT NULL,
         org_label     VARCHAR(255) NULL,
         status        VARCHAR(12)  NOT NULL DEFAULT 'running',
         stage         VARCHAR(255) NULL,
         steps_done    INT          NOT NULL DEFAULT 0,
         steps_total   INT          NOT NULL DEFAULT 0,
         error_summary TEXT         NULL,
         errors_json   TEXT         NULL,
         started_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
         finished_at   DATETIME     NULL,
         KEY idx_triggered (triggered_by, started_at),
         KEY idx_user (user_id, started_at)
       ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    ).catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED', 'EAI_AGAIN', 'ECONNREFUSED']);

/**
 * Turn whatever a sync step threw into one sentence an admin can act on.
 * @param {string} provider  zoho | quickbooks | xero
 * @param {string} what      what was being fetched, e.g. "bills"
 * @param {Error|string} err
 */
function humanizeSyncError(provider, what, err) {
  const P = PROVIDER_LABEL[provider] || provider;
  if (typeof err === 'string') {
    const m = err.match(/HTTP (\d{3})/);
    err = m ? { response: { status: Number(m[1]) }, message: err } : { message: err };
  }
  const status = err?.response?.status || (typeof err?.status === 'number' ? err.status : null);
  const upstream = err?.response?.data;
  const upstreamMsg = typeof upstream === 'string' ? upstream
    : (upstream?.Detail || upstream?.message || upstream?.error_description || upstream?.Fault?.Error?.[0]?.Detail || null);

  if (err?.code === 'REAUTH_REQUIRED') {
    return `${P} connection has expired or was revoked — reconnect ${P}.`;
  }
  if (provider === 'xero' && status === 401 && /payment|overpayment|prepayment/i.test(what)) {
    return `Xero denied access to ${what} — the connection is missing the accounting.payments.read permission. Grant it and reconnect Xero.`;
  }
  if (provider === 'xero' && (status === 401 || status === 403) && /budget/i.test(what)) {
    return 'Xero denied access to budgets — the connection is missing the accounting.budgets.read permission. Grant it and reconnect Xero.';
  }
  if (status === 401) return `${P} denied access while fetching ${what} — the connection may have expired or lacks a permission. Reconnect ${P}.`;
  if (status === 403) return `${P} refused access to ${what} — the connected ${P} user doesn't have permission to view it.`;
  if (status === 429) return `${P} rate limit reached while fetching ${what} — try the sync again in a few minutes.`;
  if (status >= 500) return `${P} was temporarily unavailable while fetching ${what} (HTTP ${status}) — try again later.`;
  if (NETWORK_CODES.has(err?.code)) return `Couldn't reach ${P} while fetching ${what} (${err.code}) — check the server's internet connection and try again.`;
  if (/^ER_/.test(err?.code || '')) return `Database error while saving ${what}: ${String(err.sqlMessage || err.message).slice(0, 160)}`;
  if (status) return `${P} returned HTTP ${status} while fetching ${what}${upstreamMsg ? `: ${String(upstreamMsg).slice(0, 160)}` : ''}.`;
  return `${what}: ${String(err?.message || err || 'unknown error').slice(0, 200)}`;
}

class SyncRun {
  constructor({ id, userId, triggeredBy, provider, orgLabel, stepsTotal }) {
    this.id = id;
    this.userId = userId;
    this.triggeredBy = triggeredBy;
    this.provider = provider;
    this.orgLabel = orgLabel;
    this.stepsTotal = stepsTotal;
    this.stepsDone = 0;
    this.active = new Set();
    this.errors = [];    // a step failed outright
    this.warnings = [];  // a step finished but couldn't fetch everything
    this.finished = false;
    this.startedAt = Date.now();
  }

  stage() {
    if (!this.active.size) return null;
    const list = [...this.active];
    return list.length > 3 ? `${list.slice(0, 3).join(', ')} +${list.length - 3} more` : list.join(', ');
  }

  // Writes are queued so a slow progress update can never land after (and
  // overwrite) the final one; steps run in parallel for QuickBooks / Zoho.
  save(extra = {}) {
    if (!this.id) return Promise.resolve();
    const cols = { stage: this.stage(), steps_done: this.stepsDone, steps_total: this.stepsTotal, ...extra };
    const keys = Object.keys(cols);
    this.queue = (this.queue || Promise.resolve()).then(() => pool.execute(
      `UPDATE sync_runs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
      [...keys.map((k) => cols[k]), this.id]
    )).catch((e) => console.warn(`[sync-run ${this.id}] progress not saved:`, e.message));
    return this.queue;
  }

  begin(label) { this.active.add(label); this.save(); }

  done(label) { this.active.delete(label); this.stepsDone += 1; this.save(); }

  fail(label, err) {
    this.active.delete(label);
    this.stepsDone += 1;
    this.errors.push({ step: label, message: humanizeSyncError(this.provider, label, err) });
    this.save();
  }

  // A step that finished but couldn't fetch part of its data.
  warn(label, err) {
    this.warnings.push({ step: label, message: humanizeSyncError(this.provider, label, err) });
  }

  /** Run `fn` as one tracked step; records the outcome and re-throws a failure. */
  async track(label, fn) {
    this.begin(label);
    try {
      const value = await fn();
      this.done(label);
      return value;
    } catch (e) {
      this.fail(label, e);
      throw e;
    }
  }

  /** Close the run. `fatal` = the sync aborted before it could finish. */
  async finish(fatal = null) {
    if (this.finished) return;
    this.finished = true;
    if (fatal) this.errors.push({ step: 'sync', message: humanizeSyncError(this.provider, 'data', fatal) });
    const okSteps = this.stepsDone - this.errors.filter((e) => e.step !== 'sync').length;
    const status = fatal || (this.errors.length && okSteps <= 0) ? 'failed'
      : (this.errors.length || this.warnings.length) ? 'partial'
        : 'succeeded';
    const issues = [...this.errors, ...this.warnings];
    // Distinct reasons only — eight steps failing on the same 401 is one problem.
    const reasons = [...new Set(issues.map((i) => i.message))];
    const summary = reasons.length ? reasons.slice(0, 3).join(' ') + (reasons.length > 3 ? ` (+${reasons.length - 3} more)` : '') : null;
    this.active.clear();
    await this.save({
      status,
      steps_done: status === 'failed' ? this.stepsDone : this.stepsTotal,
      error_summary: summary,
      errors_json: issues.length ? JSON.stringify(issues) : null,
      finished_at: new Date(),
    });
    await this.notify(status, summary);
    return status;
  }

  async notify(status, summary) {
    if (!this.id) return;
    const P = PROVIDER_LABEL[this.provider] || this.provider;
    const who = this.orgLabel ? ` for ${this.orgLabel}` : '';
    const secs = Math.round((Date.now() - this.startedAt) / 1000);
    const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    const forClient = this.triggeredBy !== this.userId;
    const n = {
      succeeded: { type: 'success', title: `${P} sync completed${who}`, body: `All data synced successfully in ${took}.` },
      partial:   { type: 'warning', title: `${P} sync finished with issues${who}`, body: summary },
      failed:    { type: 'error',   title: `${P} sync failed${who}`, body: summary },
    }[status];
    try {
      await createNotification(this.triggeredBy, {
        ...n,
        link: forClient ? '/clients' : '/settings',
        dedupeKey: `sync_run:${this.id}`,
        meta: { syncRunId: this.id, provider: this.provider, clientUserId: this.userId, status },
      });
    } catch (e) {
      console.warn(`[sync-run ${this.id}] notification not created:`, e.message);
    }
  }
}

// Client / company name shown on the progress bar and in the notification.
async function labelFor(userId, orgName) {
  try {
    const [[u]] = await pool.execute('SELECT name, company FROM users WHERE id = ?', [userId]);
    const base = (u?.company || u?.name || '').trim();
    if (base && orgName && orgName.trim() && orgName.trim() !== base) return `${base} (${orgName.trim()})`;
    return base || (orgName ? orgName.trim() : null);
  } catch {
    return orgName || null;
  }
}

/**
 * Start tracking a sync. Never throws: if the run can't be recorded the
 * returned run still works (it just isn't persisted).
 * @param {object} p { userId, triggeredBy, provider, stepsTotal, orgName }
 */
async function startSyncRun({ userId, triggeredBy, provider, stepsTotal, orgName = null }) {
  const orgLabel = await labelFor(userId, orgName);
  const run = new SyncRun({ id: null, userId, triggeredBy: triggeredBy || userId, provider, orgLabel, stepsTotal });
  try {
    await ensureTable();
    const [res] = await pool.execute(
      `INSERT INTO sync_runs (user_id, triggered_by, provider, org_label, steps_total)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, run.triggeredBy, provider, orgLabel, stepsTotal]
    );
    run.id = res.insertId;
  } catch (e) {
    console.warn('[sync-run] tracking unavailable:', e.message);
  }
  return run;
}

/**
 * Runs for the progress bar: everything still running, plus anything that
 * finished in the last `recentMinutes`, that `userId` triggered or that synced
 * `userId`'s own data. Runs that stopped moving are closed as interrupted.
 */
async function listRecentRuns(userId, { recentMinutes = 10 } = {}) {
  try {
    await ensureTable();
  } catch {
    return [];
  }
  const [stale] = await pool.execute(
    `SELECT id FROM sync_runs
      WHERE status = 'running' AND (triggered_by = ? OR user_id = ?)
        AND updated_at < NOW() - INTERVAL ${STALE_AFTER_MINUTES} MINUTE`,
    [userId, userId]
  );
  for (const r of stale) {
    await pool.execute(
      `UPDATE sync_runs SET status = 'failed', finished_at = NOW(), stage = NULL,
              error_summary = 'The sync stopped responding (the server may have restarted) — start the sync again.'
        WHERE id = ? AND status = 'running'`,
      [r.id]
    );
  }
  const [rows] = await pool.execute(
    `SELECT id, user_id, triggered_by, provider, org_label, status, stage,
            steps_done, steps_total, error_summary, started_at, finished_at
       FROM sync_runs
      WHERE (triggered_by = ? OR user_id = ?)
        AND (status = 'running' OR finished_at >= NOW() - INTERVAL ${Number(recentMinutes) | 0} MINUTE)
      ORDER BY started_at DESC
      LIMIT 10`,
    [userId, userId]
  );
  return rows.map((r) => ({
    id: r.id,
    clientUserId: r.user_id,
    provider: r.provider,
    providerLabel: PROVIDER_LABEL[r.provider] || r.provider,
    label: r.org_label,
    status: r.status,
    stage: r.stage,
    stepsDone: r.steps_done,
    stepsTotal: r.steps_total,
    // Never 100% until it has actually finished.
    percent: r.status === 'running'
      ? Math.min(99, r.steps_total ? Math.round((r.steps_done / r.steps_total) * 100) : 0)
      : 100,
    error: r.error_summary,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }));
}

module.exports = { startSyncRun, listRecentRuns, humanizeSyncError, SyncRun, PROVIDER_LABEL };
