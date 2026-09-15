// Export a transformed report ({ columns, rows, currency }) to CSV or Excel.
// CSV is dependency-free; the XLSX path lazy-loads SheetJS so it never weighs
// down the initial bundle. Both preserve the report's column order, keep
// numeric cells as real numbers, and indent rows by their hierarchy level.

// Build an array-of-arrays (header + data rows) from the report data shape.
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

// Safe, readable file name: "<Report Name> <YYYY-MM-DD>".
function buildFileName(reportName) {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = String(reportName || 'report').replace(/[\\/:*?"<>|]+/g, ' ').trim();
  return `${base} ${stamp}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportReportCSV(data, reportName) {
  if (!data) return;
  const aoa = toAoA(data);
  // Prepend a UTF-8 BOM so Excel opens accented characters / ₹ correctly.
  const csv = '\ufeff' + aoa.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${buildFileName(reportName)}.csv`);
}

export async function exportReportXLSX(data, reportName) {
  if (!data) return;
  const XLSX = await import('xlsx');
  const aoa = toAoA(data);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Reasonable column widths: wide first (label) column, the rest auto-ish.
  const cols = data?.columns || [];
  ws['!cols'] = cols.map((c, i) => ({ wch: i === 0 ? 44 : 18 }));
  const wb = XLSX.utils.book_new();
  // Excel sheet names are capped at 31 chars and forbid : \ / ? * [ ].
  const sheetName = String(reportName || 'Report').replace(/[:\\/?*[\]]+/g, ' ').slice(0, 31) || 'Report';
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, `${buildFileName(reportName)}.xlsx`);
}

function htmlEscape(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Format a numeric cell for the PDF (matches the on-screen grouping/decimals).
function pdfNum(v, currency) {
  if (typeof v !== 'number') return htmlEscape(v);
  try {
    return v.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  } catch {
    return v.toFixed(2);
  }
}

// Dependency-free PDF export: render the report into a print window styled like
// the on-screen Zoho-style sheet, then trigger the browser's print dialog
// (user picks "Save as PDF"). `meta` is optional { company, basis, from, to }.
export function exportReportPDF(data, reportName, meta = {}) {
  if (!data || typeof window === 'undefined') return;
  const cols = data.columns || [];
  const currency = data.currency || 'USD';

  const headRow = cols
    .map((c) => `<th class="${c.align === 'right' ? 'r' : 'l'}">${htmlEscape(c.label ?? c.key)}</th>`)
    .join('');

  const bodyRows = (data.rows || []).map((r) => {
    const cls = [
      r.isHeader ? 'hdr' : '',
      r.isSubtotal ? 'sub' : '',
      r.isTotal ? 'tot' : '',
    ].filter(Boolean).join(' ');
    const indent = Math.min(r.level || 0, 5) * 16;
    const tds = cols.map((c, ci) => {
      if (ci === 0) {
        return `<td class="l" style="padding-left:${8 + indent}px">${htmlEscape(r.label ?? '')}</td>`;
      }
      const v = r.cells?.[c.key];
      const txt = v == null || v === '' ? '' : (typeof v === 'number' ? pdfNum(v, currency) : htmlEscape(v));
      return `<td class="${c.align === 'right' ? 'r' : 'l'}">${txt}</td>`;
    }).join('');
    return `<tr class="${cls}">${tds}</tr>`;
  }).join('');

  const company = htmlEscape(meta.company || 'Oremus');
  const periodLine = meta.from && meta.to ? `<div class="meta">From ${htmlEscape(meta.from)} To ${htmlEscape(meta.to)}</div>` : '';
  const basisLine = meta.basis ? `<div class="meta">Basis: ${htmlEscape(meta.basis)}</div>` : '';
  const title = htmlEscape(reportName || 'Report');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  *{box-sizing:border-box} body{font-family:Inter,Arial,sans-serif;color:#1e293b;margin:24px;}
  .head{text-align:center;margin-bottom:16px}
  .head .co{font-size:16px;font-weight:700}
  .head .rn{font-size:14px;font-weight:600;margin-top:2px}
  .head .meta{font-size:11px;color:#64748b;margin-top:2px}
  .head .cur{font-size:10.5px;color:#94a3b8;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:11.5px}
  th{font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;font-weight:600;padding:6px 8px;border-bottom:2px solid #cbd5e1}
  td{padding:5px 8px}
  .l{text-align:left}.r{text-align:right;font-variant-numeric:tabular-nums}
  tr.hdr td{font-weight:700;border-top:1px solid #e2e8f0}
  tr.sub td{background:#f1f5f9;font-weight:600}
  tr.tot td{background:#eff6ff;font-weight:700;border-top:2px solid #93c5fd}
  @media print{body{margin:12mm}}
</style></head><body>
  <div class="head">
    <div class="co">${company}</div>
    <div class="rn">${title}</div>
    ${basisLine}
    ${periodLine}
    <div class="cur">Amount in ${htmlEscape(currency)}</div>
  </div>
  <table><thead><tr>${headRow}</tr></thead><tbody>${bodyRows}</tbody></table>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) return; // popup blocked
  w.document.open();
  w.document.write(html);
  w.document.close();
  // Give the new document a tick to lay out before invoking print.
  w.onload = () => { w.focus(); w.print(); };
  // Fallback if onload doesn't fire (already-loaded blank doc).
  setTimeout(() => { try { w.focus(); w.print(); } catch { /* noop */ } }, 400);
}
