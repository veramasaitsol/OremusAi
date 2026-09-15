'use strict';
const { Router } = require('express');
const pool       = require('../config/db');
const auth       = require('../middleware/auth');
const { createNotification, generateForUser } = require('../services/notificationsService');

const router = Router();
router.use(auth);

// GET /api/notifications?status=unread&page=1&limit=30
router.get('/', async (req, res) => {
  try {
    const page    = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit   = Math.min(100, Math.max(1, parseInt(req.query.limit || '30', 10)));
    const offset  = (page - 1) * limit;
    const unreadOnly = req.query.status === 'unread';
    const unreadF = unreadOnly ? ' AND read_at IS NULL' : '';

    const [rows] = await pool.execute(
      `SELECT id, type, title, body, link, meta, read_at, created_at
         FROM notifications
        WHERE user_id = ?${unreadF}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      [req.user.id],
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM notifications WHERE user_id = ?${unreadF}`,
      [req.user.id],
    );
    const [[{ unread }]] = await pool.execute(
      'SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND read_at IS NULL',
      [req.user.id],
    );

    return res.json({ data: rows, total, unread, page, limit });
  } catch (err) {
    console.error('Notifications list error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', async (req, res) => {
  try {
    const [[{ count }]] = await pool.execute(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL',
      [req.user.id],
    );
    return res.json({ count });
  } catch (err) {
    console.error('Notifications unread-count error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/notifications/generate — derive notifications from live data.
router.post('/generate', async (req, res) => {
  try {
    const created = await generateForUser(req.user.id, req.orgId || null);
    return res.json({ created });
  } catch (err) {
    console.error('Notifications generate error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/notifications — create an ad-hoc notification for the current user.
router.post('/', async (req, res) => {
  try {
    const { type, title, body, link, meta } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title is required' });
    await createNotification(req.user.id, { type, title, body, link, meta });
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Notifications create error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/notifications/:id/read — mark one as read.
router.patch('/:id/read', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    await pool.execute(
      'UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ? AND read_at IS NULL',
      [id, req.user.id],
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('Notifications mark-read error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/notifications/read-all — mark all unread as read.
router.post('/read-all', async (req, res) => {
  try {
    const [result] = await pool.execute(
      'UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL',
      [req.user.id],
    );
    return res.json({ updated: result.affectedRows });
  } catch (err) {
    console.error('Notifications read-all error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/notifications/:id — remove one.
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    await pool.execute('DELETE FROM notifications WHERE id = ? AND user_id = ?', [id, req.user.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Notifications delete error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
