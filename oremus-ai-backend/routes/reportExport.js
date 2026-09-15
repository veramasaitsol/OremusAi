'use strict';

/**
 * Report export API.
 * ---------------------------------------------------------------------------
 * POST /api/report-export?format=xlsx|pdf
 *   body: {
 *     data:       { columns, rows, currency, meta },   // the on-screen report
 *     reportName: "Profit and Loss",
 *     meta:       { company, basis, from, to }          // optional header info
 *   }
 *   → streams back the generated .xlsx or .pdf as a file download.
 *
 * The frontend already holds the transformed report in Redux, so it POSTs that
 * exact payload here and the server serialises it. This keeps the exported file
 * byte-for-byte aligned with what the user sees and works for EVERY provider
 * (Zoho / QuickBooks / Xero / mock) without re-fetching anything.
 */

const express = require('express');
const { Router } = express;
const auth = require('../middleware/auth');
const { buildFileName, toXlsxBuffer, toPdfBuffer } = require('../utils/reportExport');

const router = Router();

// Reports can be large (hundreds of rows) — allow a generous body for this route
// only, without touching the global 100kb express.json() limit.
router.use(express.json({ limit: '15mb' }));
router.use(auth);
router.use(require('../middleware/adminClientView')); // honor admin view-as-client (X-Client-Id)

router.post('/', async (req, res) => {
  try {
    const format = String(req.query.format || 'xlsx').toLowerCase();
    const { data, reportName = 'Report', meta = {} } = req.body || {};

    if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
      return res.status(400).json({ error: 'Invalid report data (expected { columns, rows }).' });
    }

    const fileBase = buildFileName(reportName);

    if (format === 'xlsx') {
      const buf = toXlsxBuffer(data, reportName);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.xlsx"`);
      return res.send(buf);
    }

    if (format === 'pdf') {
      const buf = await toPdfBuffer(data, reportName, meta);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.pdf"`);
      return res.send(buf);
    }

    return res.status(400).json({ error: `Unsupported format: ${format} (use xlsx or pdf).` });
  } catch (e) {
    console.error('[report-export] error:', e.message);
    return res.status(500).json({ error: 'Failed to generate export', detail: e.message });
  }
});

module.exports = router;
