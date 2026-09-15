'use strict';

/**
 * Server-side report export — turns a transformed report ({ columns, rows,
 * currency, meta }) into a real .xlsx (SheetJS) or .pdf (PDFKit) Buffer.
 *
 * The report shape is the SAME one every viewer renders and the JSON report
 * endpoints return, so the exported file matches the on-screen sheet exactly,
 * regardless of provider (Zoho / QuickBooks / Xero / mock).
 *
 *   columns: [{ key, label, align }]
 *   rows:    [{ label, level, cells: { [key]: value }, isHeader, isSubtotal, isTotal }]
 */

const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');

// ── Shared helpers ───────────────────────────────────────────────────────────

// Safe, readable file name: "<Report Name> <YYYY-MM-DD>".
function buildFileName(reportName) {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = String(reportName || 'report').replace(/[\\/:*?"<>|]+/g, ' ').trim();
  return `${base} ${stamp}`;
}

// Array-of-arrays (header row + data rows) from the report shape.
function toAoA(data) {
  const cols = data?.columns || [];
  const header = cols.map((c) => c.label ?? c.key);
  const rows = (data?.rows || []).map((r) => {
    const indent = '    '.repeat(Math.max(0, r.level || 0));
    return cols.map((c) => {
      if (c.key === 'label') return `${indent}${r.label ?? ''}`;
      const v = r.cells?.[c.key];
      return v == null ? '' : v;
    });
  });
  return [header, ...rows];
}

// Format a numeric cell (Indian grouping for INR, else international).
function fmtNum(v, currency) {
  if (typeof v !== 'number') return v == null ? '' : String(v);
  try {
    return v.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  } catch {
    return v.toFixed(2);
  }
}

// ── XLSX ─────────────────────────────────────────────────────────────────────

function toXlsxBuffer(data, reportName) {
  const aoa = toAoA(data);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const cols = data?.columns || [];
  // Wide first (label) column, the rest a sensible fixed width.
  ws['!cols'] = cols.map((_, i) => ({ wch: i === 0 ? 44 : 18 }));
  const wb = XLSX.utils.book_new();
  // Excel sheet names cap at 31 chars and forbid : \ / ? * [ ].
  const sheetName = String(reportName || 'Report').replace(/[:\\/?*[\]]+/g, ' ').slice(0, 31) || 'Report';
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ── PDF ──────────────────────────────────────────────────────────────────────

// Render the report as a paginated table. Returns a Promise<Buffer> because
// PDFKit streams its output.
function toPdfBuffer(data, reportName, meta = {}) {
  return new Promise((resolve, reject) => {
    try {
      const cols = data?.columns || [];
      const rows = data?.rows || [];
      const currency = data?.currency || meta.currency || 'USD';

      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageLeft = doc.page.margins.left;
      const pageRight = doc.page.width - doc.page.margins.right;
      const usableW = pageRight - pageLeft;

      // Column widths: first (label) column gets ~38%, the rest share the rest.
      const n = cols.length || 1;
      const labelW = n > 1 ? usableW * 0.38 : usableW;
      const otherW = n > 1 ? (usableW - labelW) / (n - 1) : 0;
      const colW = cols.map((_, i) => (i === 0 ? labelW : otherW));
      const colX = [];
      let acc = pageLeft;
      for (let i = 0; i < n; i++) { colX[i] = acc; acc += colW[i]; }

      // ── Centered header block ─────────────────────────────────────────────
      doc.font('Helvetica-Bold').fontSize(14)
        .text(meta.company || 'Oremus', pageLeft, doc.page.margins.top, { width: usableW, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(12)
        .text(reportName || 'Report', { width: usableW, align: 'center' });
      doc.font('Helvetica').fontSize(8.5).fillColor('#64748b');
      if (meta.basis) doc.text(`Basis: ${meta.basis}`, { width: usableW, align: 'center' });
      if (meta.from && meta.to) doc.text(`From ${meta.from} To ${meta.to}`, { width: usableW, align: 'center' });
      doc.text(`Amount in ${currency}`, { width: usableW, align: 'center' });
      doc.fillColor('#1e293b').moveDown(0.6);

      const rowH = 16;
      const headerH = 18;

      const drawHeaderRow = () => {
        const y = doc.y;
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#334155');
        cols.forEach((c, i) => {
          doc.text(String(c.label ?? c.key ?? ''), colX[i] + 4, y + 4, {
            width: colW[i] - 8,
            align: c.align === 'right' ? 'right' : 'left',
            lineBreak: false,
          });
        });
        doc.moveTo(pageLeft, y + headerH).lineTo(pageRight, y + headerH)
          .lineWidth(1).strokeColor('#cbd5e1').stroke();
        doc.y = y + headerH + 2;
        doc.fillColor('#1e293b');
      };

      drawHeaderRow();

      doc.font('Helvetica').fontSize(8.5);
      for (const r of rows) {
        // Page break — repeat the column header on each new page.
        if (doc.y + rowH > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
          drawHeaderRow();
          doc.font('Helvetica').fontSize(8.5);
        }

        const y = doc.y;
        const emphasized = r.isHeader || r.isSubtotal || r.isTotal;

        // Subtle background band for subtotal/total rows.
        if (r.isTotal || r.isSubtotal) {
          doc.rect(pageLeft, y, usableW, rowH).fill(r.isTotal ? '#eff6ff' : '#f1f5f9');
          doc.fillColor('#1e293b');
        }

        doc.font(emphasized ? 'Helvetica-Bold' : 'Helvetica');
        const indent = Math.min(r.level || 0, 6) * 12;

        cols.forEach((c, i) => {
          let txt;
          if (i === 0) {
            txt = String(r.label ?? '');
          } else {
            const v = r.cells?.[c.key];
            txt = typeof v === 'number' ? fmtNum(v, currency) : (v == null ? '' : String(v));
          }
          const x = colX[i] + 4 + (i === 0 ? indent : 0);
          doc.text(txt, x, y + 3, {
            width: colW[i] - 8 - (i === 0 ? indent : 0),
            align: c.align === 'right' ? 'right' : 'left',
            lineBreak: false,
            ellipsis: true,
          });
        });

        if (r.isTotal) {
          doc.moveTo(pageLeft, y).lineTo(pageRight, y).lineWidth(1).strokeColor('#93c5fd').stroke();
        }
        doc.fillColor('#1e293b');
        doc.y = y + rowH;
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildFileName, toXlsxBuffer, toPdfBuffer };
