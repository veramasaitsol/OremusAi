'use strict';

// Sync-run tracking: progress, outcome, and the notification sent to whoever
// started the sync (the admin connecting a client, or the user themselves).
jest.mock('../../config/db', () => ({ execute: jest.fn() }));
jest.mock('../notificationsService', () => ({ createNotification: jest.fn(async () => ({})) }));

let pool;
let createNotification;
let svc;
let updates;

beforeEach(() => {
  jest.resetModules();
  pool = require('../../config/db');
  ({ createNotification } = require('../notificationsService'));
  svc = require('../syncRunService');
  updates = [];
  pool.execute.mockImplementation(async (sql, params) => {
    if (/SELECT name, company FROM users/.test(sql)) return [[{ name: 'Tirumalesh', company: 'Applaud' }]];
    if (/INSERT INTO sync_runs/.test(sql)) return [{ insertId: 42 }];
    if (/UPDATE sync_runs/.test(sql)) updates.push({ sql, params });
    return [[]];
  });
});

const start = (over = {}) => svc.startSyncRun({ userId: 27, triggeredBy: 1, provider: 'xero', stepsTotal: 3, orgName: 'Applaud India', ...over });
const lastNotification = () => createNotification.mock.calls[createNotification.mock.calls.length - 1];

test('every step finishing is a success, notified to the admin who connected the client', async () => {
  const run = await start();
  for (const step of ['bills', 'invoices', 'general ledger']) await run.track(step, async () => 1);
  expect(await run.finish()).toBe('succeeded');

  const [userId, n] = lastNotification();
  expect(userId).toBe(1); // the admin, not the client
  expect(n).toEqual(expect.objectContaining({
    type: 'success', title: 'Xero sync completed for Applaud (Applaud India)', link: '/clients', dedupeKey: 'sync_run:42',
  }));
});

test('a step that fails while others succeed is "finished with issues", with the reason spelled out', async () => {
  const run = await start();
  await run.track('bills', async () => 1);
  await run.track('invoices', async () => 1);
  await expect(run.track('payments', async () => { throw Object.assign(new Error('x'), { response: { status: 401 } }); }))
    .rejects.toThrow();
  expect(await run.finish()).toBe('partial');
  const [, n] = lastNotification();
  expect(n.type).toBe('warning');
  expect(n.body).toMatch(/Xero denied access to payments .*accounting\.payments\.read/);
});

test('nothing synced is a failure', async () => {
  const run = await start({ stepsTotal: 2 });
  const boom = () => Promise.reject(Object.assign(new Error('rate'), { response: { status: 429 } }));
  await run.track('bills', boom).catch(() => {});
  await run.track('invoices', boom).catch(() => {});
  expect(await run.finish()).toBe('failed');
  const [, n] = lastNotification();
  expect(n).toEqual(expect.objectContaining({ type: 'error', title: 'Xero sync failed for Applaud (Applaud India)' }));
  // Each failed step's reason names the step it hit.
  expect(n.body.match(/rate limit/g)).toHaveLength(2);
  expect(n.body).toMatch(/^Xero rate limit reached while fetching bills/);
});

test('an expired connection says to reconnect', () => {
  const err = Object.assign(new Error('x'), { code: 'REAUTH_REQUIRED' });
  expect(svc.humanizeSyncError('quickbooks', 'bills', err)).toBe('QuickBooks connection has expired or was revoked — reconnect QuickBooks.');
});

test('a self-connect notifies the user and links to Settings', async () => {
  const run = await start({ triggeredBy: 27 });
  await run.track('bills', async () => 1);
  await run.finish();
  const [userId, n] = lastNotification();
  expect(userId).toBe(27);
  expect(n.link).toBe('/settings');
});

test('the final write lands after every progress write', async () => {
  const run = await start({ stepsTotal: 2 });
  run.begin('bills');
  run.done('bills');
  await run.track('invoices', async () => 1);
  await run.finish();
  const last = updates[updates.length - 1];
  expect(last.sql).toMatch(/status = \?/);
});

test('tracking never breaks the sync when the table is unusable', async () => {
  pool.execute.mockImplementation(async (sql) => {
    if (/CREATE TABLE/.test(sql)) throw new Error('no permission');
    return [[]];
  });
  const run = await start();
  expect(run.id).toBeNull();
  await expect(run.track('bills', async () => 7)).resolves.toBe(7);
  await expect(run.finish()).resolves.toBe('succeeded');
  expect(createNotification).not.toHaveBeenCalled(); // nothing persisted to point at
});
