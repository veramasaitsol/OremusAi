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

const isWorkbookReport = (data) => !!(data?.workbook || Array.isArray(data?.sections));

// A workbook report (the GST Returns Workbook) is a list of numbered sections
// rather than one { columns, rows } table — flatten it into one
// array-of-arrays: section title, its column header, its rows (a plain array
// of cells, a sub-heading, or a full-width note), then a blank separator row.
function workbookToAoA(data) {
  const aoa = [];
  for (const s of data?.sections || []) {
    aoa.push([`${s.no ? `${s.no}  ` : ''}${s.title || ''}`]);
    if (s.columns?.length) aoa.push(s.columns);
    for (const r of s.rows || []) {
      if (Array.isArray(r.cells)) aoa.push(r.cells.map((v) => (v == null ? '' : v)));
      else if (r.subhead) aoa.push([r.subhead]);
      else if (r.fullNote) aoa.push([r.fullNote]);
      else if (r.label != null) aoa.push([r.label, r.spanNote || '']);
    }
    aoa.push([]);
  }
  return aoa;
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
  const aoa = isWorkbookReport(data) ? workbookToAoA(data) : toAoA(data);
  // Prepend a UTF-8 BOM so Excel opens accented characters / ₹ correctly.
  const csv = '\ufeff' + aoa.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${buildFileName(reportName)}.csv`);
}

// Export an arbitrary small row set to CSV — for a drill-down/breakdown panel
// (a tax rate's contributing invoices, a cell's underlying bills, …) rather
// than a full { columns, rows } report. `headers` is a plain string array;
// `rows` an array of same-length value arrays.
export function exportRowsCSV(headers, rows, filename) {
  if (!rows?.length) return;
  const aoa = [headers, ...rows];
  const csv = '﻿' + aoa.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${buildFileName(filename)}.csv`);
}

// Excel counterpart of exportRowsCSV. Numeric cells stay numbers so they can be
// summed/filtered in Excel. `titleLines` (optional) are printed above the header.
export async function exportRowsXLSX(headers, rows, filename, titleLines = []) {
  if (!rows?.length) return;
  const XLSX = await import('xlsx');
  const aoa = [...titleLines.map((t) => [t]), ...(titleLines.length ? [[]] : []), headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = headers.map((h, i) => ({ wch: i === 0 ? 12 : Math.max(12, String(h).length + 2) }));
  const wb = XLSX.utils.book_new();
  const sheetName = String(filename || 'Breakdown').replace(/[:\\/?*[\]]+/g, ' ').slice(0, 31) || 'Breakdown';
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, `${buildFileName(filename)}.xlsx`);
}

// A drill-down breakdown as an export sheet: every entry, then a reconciliation
// footer (lines total → ÷ divisor for an average → report figure → difference),
// so a gap against another platform can be traced entry by entry.
export function breakdownToSheet({ name, title, subtitle, rows = [], divisor, divisorLabel, reportFigure, currency }) {
  const cur = currency || '';
  const n = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '' : Number(v));
  const headers = ['Date', 'Reference', 'Name / Description', 'Account', 'Source', 'Type',
    'Original Currency', 'Exchange Rate', 'Original Amount', `Amount${cur ? ` (${cur})` : ''}`];
  const body = rows.map((e) => [e.date || '', e.ref || '', e.name || '', e.account || '', e.source || '',
    e.type || '', e.currency || '', n(e.rate), n(e.nativeAmount), n(e.amount)]);
  const total = Math.round(rows.reduce((s, e) => s + (Number(e.amount) || 0), 0) * 100) / 100;
  const pad = (label, v) => ['', '', label, '', '', '', '', '', '', v];
  const footer = [[], pad(`Total of ${rows.length} entries`, total)];
  let explained = total;
  if (divisor) {
    explained = Math.round((total / divisor) * 100) / 100;
    footer.push(pad(`÷ ${divisor} ${divisorLabel || ''} = average`.trim(), explained));
  }
  if (reportFigure != null && !Number.isNaN(Number(reportFigure))) {
    footer.push(pad('Figure on report', Math.round(Number(reportFigure) * 100) / 100));
    footer.push(pad('Difference', Math.round((explained - Number(reportFigure)) * 100) / 100));
  }
  return {
    name: name || title || 'Breakdown',
    headers,
    rows: [...body, ...footer],
    titleLines: [title, subtitle].filter(Boolean),
  };
}

// Several row sets into one workbook — one sheet each. `sheets` =
// [{ name, headers, rows, titleLines? }]. Excel caps sheet names at 31 chars and
// forbids : \ / ? * [ ], and names must be unique.
export async function exportSheetsXLSX(sheets, filename) {
  const usable = (sheets || []).filter((s) => s.rows?.length);
  if (!usable.length) return;
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const used = new Set();
  for (const s of usable) {
    const title = s.titleLines || [];
    const aoa = [...title.map((t) => [t]), ...(title.length ? [[]] : []), s.headers, ...s.rows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = s.headers.map((h, i) => ({ wch: i === 0 ? 12 : Math.max(12, String(h).length + 2) }));
    let name = String(s.name || 'Sheet').replace(/[:\\/?*[\]]+/g, ' ').slice(0, 31) || 'Sheet';
    for (let n = 2; used.has(name); n += 1) name = `${name.slice(0, 28)} ${n}`;
    used.add(name);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  XLSX.writeFile(wb, `${buildFileName(filename)}.xlsx`);
}

export async function exportReportXLSX(data, reportName) {
  if (!data) return;
  const XLSX = await import('xlsx');
  const workbookShaped = isWorkbookReport(data);
  const aoa = workbookShaped ? workbookToAoA(data) : toAoA(data);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Reasonable column widths: wide first (label) column, the rest auto-ish.
  const colCount = workbookShaped
    ? Math.max(1, ...aoa.map((r) => r.length))
    : (data?.columns || []).length;
  ws['!cols'] = Array.from({ length: colCount }, (_, i) => ({ wch: i === 0 ? 44 : 18 }));
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

// Print-to-PDF for a workbook report (the GST Returns Workbook): one small
// table per numbered section instead of one big table, mirroring the on-screen
// GstReturnsWorkbookViewer layout.
function exportWorkbookPDF(data, reportName, meta = {}) {
  const currency = data.currency || 'USD';
  const sections = data.sections || [];

  const sectionHtml = sections.map((s) => {
    const cols = s.columns || [];
    const headRow = cols.length
      ? `<thead><tr>${cols.map((c) => `<th>${htmlEscape(c)}</th>`).join('')}</tr></thead>` : '';
    const bodyRows = (s.rows || []).map((r) => {
      if (r.subhead) return `<tr class="subhead"><td colspan="${cols.length || 1}">${htmlEscape(r.subhead)}</td></tr>`;
      if (r.fullNote) return `<tr class="note"><td colspan="${cols.length || 1}">${htmlEscape(r.fullNote)}</td></tr>`;
      if (Array.isArray(r.cells)) {
        const tds = r.cells.map((v, i) => {
          const txt = typeof v === 'number' ? pdfNum(v, currency) : htmlEscape(v);
          return `<td class="${i === 0 ? 'l' : 'r'}">${txt}</td>`;
        }).join('');
        return `<tr class="${r.bold ? 'tot' : ''}">${tds}</tr>`;
      }
      if (r.label != null) {
        return `<tr><td class="l">${htmlEscape(r.label)}</td><td class="note" colspan="${Math.max(1, cols.length - 1)}">${htmlEscape(r.spanNote || '')}</td></tr>`;
      }
      return '';
    }).join('');
    return `<div class="section"><h3>${htmlEscape(s.no ? `${s.no}  ${s.title || ''}` : s.title || '')}</h3>
      <table>${headRow}<tbody>${bodyRows}</tbody></table></div>`;
  }).join('');

  const company = htmlEscape(meta.company || 'Oremus');
  const periodLine = meta.from && meta.to ? `<div class="meta">From ${htmlEscape(meta.from)} To ${htmlEscape(meta.to)}</div>` : '';
  const title = htmlEscape(reportName || 'Report');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  *{box-sizing:border-box} body{font-family:Inter,Arial,sans-serif;color:#1e293b;margin:24px;}
  .head{text-align:center;margin-bottom:16px}
  .head .co{font-size:16px;font-weight:700}
  .head .rn{font-size:14px;font-weight:600;margin-top:2px}
  .head .meta{font-size:11px;color:#64748b;margin-top:2px}
  .section{margin-bottom:18px;break-inside:avoid}
  .section h3{font-size:12px;margin:0 0 6px}
  table{width:100%;border-collapse:collapse;font-size:10.5px}
  th{font-size:9px;text-transform:uppercase;letter-spacing:.03em;color:#64748b;font-weight:600;padding:4px 6px;border-bottom:2px solid #cbd5e1;text-align:left}
  td{padding:4px 6px}
  .l{text-align:left}.r{text-align:right;font-variant-numeric:tabular-nums}
  tr.subhead td{font-weight:700;background:#f1f5f9}
  tr.tot td{font-weight:700;border-top:1px solid #93c5fd}
  td.note{color:#94a3b8;font-style:italic}
  @media print{body{margin:12mm}}
</style></head><body>
  <div class="head">
    <div class="co">${company}</div>
    <div class="rn">${title}</div>
    ${periodLine}
    <div class="meta">Amount in ${htmlEscape(currency)}</div>
  </div>
  ${sectionHtml}
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.onload = () => { w.focus(); w.print(); };
  setTimeout(() => { try { w.focus(); w.print(); } catch { /* noop */ } }, 400);
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
  if (isWorkbookReport(data)) return exportWorkbookPDF(data, reportName, meta);
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
