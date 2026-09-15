'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Minimal in-process sequential job queue (Phase 9 background jobs).
//
// Serialises heavy background work (warehouse syncs, ETL rebuilds) so concurrent
// triggers don't stampede the DB / provider API. Dedupes by key: enqueuing a key
// that is already pending/running returns the existing job instead of piling on.
//
// This is intentionally lightweight (no Redis/BullMQ) to stay dependency-free and
// match the existing setInterval-based cron style. Swappable later if needed.
// ─────────────────────────────────────────────────────────────────────────────

const queue = [];          // [{ key, task, resolve, reject }]
const known = new Map();   // key -> Promise (pending or running)
let running = false;

function size() { return queue.length + (running ? 1 : 0); }

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      const result = await job.task();
      job.resolve(result);
    } catch (e) {
      job.reject(e);
    } finally {
      known.delete(job.key);
    }
  }
  running = false;
}

// enqueue(key, task) → Promise. Same key while pending returns the same promise.
function enqueue(key, task) {
  if (known.has(key)) return known.get(key);
  const p = new Promise((resolve, reject) => {
    queue.push({ key, task, resolve, reject });
  });
  known.set(key, p);
  drain().catch(() => {});
  return p;
}

module.exports = { enqueue, size };
