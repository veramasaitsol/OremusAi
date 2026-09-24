// import axios from 'axios';
// import { AI_API_URL as AI_BASE } from '../config/env.js';

// const AI_PLATFORM_LABELS = {
//   zoho: 'Zoho',
//   quickbooks: 'QuickBooks',
//   qbo: 'QuickBooks',
//   xero: 'Xero',
//   none: 'Zoho',
// };

// export function formatAIPlatform(platform) {
//   const key = String(platform ?? 'zoho').trim().toLowerCase();
//   return AI_PLATFORM_LABELS[key] || 'Zoho';
// }

// // Oremus AI query service. Lives on its own origin (separate from the /api
// // backend), so it uses a dedicated axios call rather than the shared client.
// // Override the base via VITE_AI_API_URL in the .env file if the host changes.

// // ─────────────────────────────────────────────────────────────────────────────
// // Response normalization
// //
// // The on-premise AI service answers POST /query with:
// // {
// //   "data":          "<div>5814.189617</div>",   ← answer, HTML-wrapped
// //   "generated_sql": "SELECT AVG(invoices.balance) AS result FROM invoices",
// //   "meta":          { "execution_time_ms": 10895.95, "db_execution_time_ms": 71.44 },
// //   "query_params":  {},
// //   "status":        "SUCCESS",
// //   "success":       true
// // }
// //
// // The UI renders `answer` (narrative), `data` (row array for tables) and `sql`,
// // so normalizeAIResponse() maps the wire shape onto that. `data` may also be a
// // full HTML <table> for row-set answers — those rows are extracted so the UI's
// // table/chart rendering works unchanged.
// // ─────────────────────────────────────────────────────────────────────────────

// // Pull rows + narrative text out of an HTML payload. Two quirks handled:
// // 1) Fragments like "<tr><td>…</td></tr>" (no <table> wrapper) are invalid
// //    standalone HTML, and DOMParser silently STRIPS those tags — every cell
// //    then concatenates into one unreadable blob ("iduser_idorg_id…").
// //    Wrapping such fragments in <table>…</table> preserves the structure.
// // 2) The narrative answer must not repeat the table's own cell text.
// function parseHtmlPayload(html) {
//   const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
//   const hasTable = /<table[\s>]/i.test(html);
//   const isFragment = !hasTable && /<(tr|td|th|tbody|thead)[\s>]/i.test(html);
//   const source = isFragment ? `<table>${html}</table>` : html;

//   let doc;
//   try {
//     doc = new DOMParser().parseFromString(source, 'text/html');
//   } catch {
//     return { text: stripTags(html), rows: null };
//   }

//   const fullText = (doc.documentElement.textContent || '').replace(/\s+/g, ' ').trim();
//   let rows = null;
//   let text = fullText;

//   const table = doc.querySelector('table');
//   if (table) {
//     const trs = Array.from(table.querySelectorAll('tr')).filter((tr) => tr.children.length);
//     if (trs.length >= 2) {
//       const headers = Array.from(trs[0].children).map((c, i) => (c.textContent || '').trim() || `col_${i + 1}`);
//       rows = trs.slice(1).map((tr) => {
//         const row = {};
//         Array.from(tr.children).forEach((c, i) => {
//           row[headers[i] || `col_${i + 1}`] = (c.textContent || '').trim();
//         });
//         return row;
//       }).filter((r) => Object.keys(r).length);
//       // Narrative = text living OUTSIDE the table (e.g. "<div>5814.19</div>",
//       // or a sentence beside it) so table cells never double up as prose.
//       const outside = doc.documentElement.cloneNode(true);
//       outside.querySelectorAll('table').forEach((t) => t.remove());
//       text = (outside.textContent || '').replace(/\s+/g, ' ').trim();
//     }
//   }

//   return { text, rows: rows && rows.length ? rows : null };
// }

// // Wire shape (or legacy shapes) → { answer, data: rows|null, sql, timing, success }.
// export function normalizeAIResponse(raw) {
//   if (raw == null) return { answer: '', data: null, sql: '', executionTimeMs: null, dbTimeMs: null, success: false };
//   if (typeof raw === 'string') {
//     return { answer: parseHtmlPayload(raw).text, data: null, sql: '', executionTimeMs: null, dbTimeMs: null, success: true };
//   }

//   const out = { ...raw };

//   if (typeof raw.data === 'string') {
//     // HTML-wrapped answer (the service's current format).
//     const { text, rows } = parseHtmlPayload(raw.data);
//     out.answer = raw.answer ?? text;
//     out.data = rows; // null unless the HTML contained a <table>
//   } else if (Array.isArray(raw.data)) {
//     out.data = raw.data; // already a row set
//   } else {
//     out.data = null;
//   }

//   if (out.answer == null) out.answer = extractAnswer(raw);
//   out.sql = raw.sql ?? raw.generated_sql ?? '';
//   out.executionTimeMs = raw.meta?.execution_time_ms ?? raw.executionTimeMs ?? null;
//   out.dbTimeMs = raw.meta?.db_execution_time_ms ?? null;
//   // Only an EXPLICIT failure marks the answer as failed. A missing success AND
//   // missing status (legacy shapes) must stay truthy or old payloads would break.
//   const status = raw.status != null ? String(raw.status).toUpperCase() : null;
//   out.success = raw.success != null ? Boolean(raw.success) : (status != null ? status === 'SUCCESS' : true);
//   return out;
// }

// // POST /query { platform, question } → normalized AI answer.
// // The service's `success` flag gates the result: only a successful response is
// // returned as an answer; a failed one throws (with the service's reason) so the
// // chat surfaces show their error bubble instead of an answer card.
// export async function askAI({ platform, question }) {
//   const payloadPlatform = formatAIPlatform(platform);
//   const { data } = await axios.post(
//     `${AI_BASE}/query`,
//     { platform: payloadPlatform, question },
//     { headers: { 'Content-Type': 'application/json' }, timeout: 120000 },
//   );
//   const normalized = normalizeAIResponse(data);
//   if (!normalized.success) {
//     // Even on failure, render the data text as a normal answer card (not a
//     // red error bubble). Strip HTML from data to get plain text.
//     const strip = (s) => (typeof s === 'string' ? s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '');
//     normalized.answer = strip(data?.data) || strip(data?.summary) || normalized.answer || '';
//     normalized.success = true; // render as normal answer
//   }
//   return normalized;
// }

// // The /query response shape isn't strictly fixed — pull the human-readable
// // answer from the most likely fields, falling back to the raw payload.
// export function extractAnswer(data) {
//   if (data == null) return '';
//   if (typeof data === 'string') return data;
//   const answer = data.answer ?? data.response ?? data.message ?? data.result ?? data.text;
//   if (answer != null) return typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2);
//   return JSON.stringify(data, null, 2);
// }

import axios from 'axios';
import { AI_API_URL as AI_BASE } from '../config/env.js';

const AI_PLATFORM_LABELS = {
  zoho: 'Zoho',
  quickbooks: 'QuickBooks',
  qbo: 'QuickBooks',
  xero: 'Xero',
  none: 'Zoho',
};

export function formatAIPlatform(platform) {
  const key = String(platform ?? 'zoho').trim().toLowerCase();
  return AI_PLATFORM_LABELS[key] || 'Zoho';
}

function getCurrentClientIdFromStorage() {
  try {
    const raw = localStorage.getItem('oremus_current_v1');
    if (!raw) return null;

    const session = JSON.parse(raw);
    if (session?.clientId) return String(session.clientId);

    const token = session?.token;
    if (!token || typeof token !== 'string') return null;

    const payloadPart = token.split('.')[1];
    if (!payloadPart) return null;

    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = JSON.parse(atob(padded));
    const clientId = decoded?.clientId ?? decoded?.client_id ?? decoded?.clientid;
    return clientId ? String(clientId) : null;
  } catch {
    return null;
  }
}

// Oremus AI query service. Lives on its own origin (separate from the /api
// backend), so it uses a dedicated axios call rather than the shared client.
// Override the base via VITE_AI_API_URL in the .env file if the host changes.

// ─────────────────────────────────────────────────────────────────────────────
// Response normalization
//
// The on-premise AI service answers POST /query with:
// {
//   "data":          "<div>5814.189617</div>",   ← answer, HTML-wrapped
//   "generated_sql": "SELECT AVG(invoices.balance) AS result FROM invoices",
//   "meta":          { "execution_time_ms": 10895.95, "db_execution_time_ms": 71.44 },
//   "query_params":  {},
//   "status":        "SUCCESS",
//   "success":       true
// }
//
// The UI renders `answer` (narrative), `data` (row array for tables) and `sql`,
// so normalizeAIResponse() maps the wire shape onto that. `data` may also be a
// full HTML <table> for row-set answers — those rows are extracted so the UI's
// table/chart rendering works unchanged.
// ─────────────────────────────────────────────────────────────────────────────

// Pull rows + narrative text out of an HTML payload. Two quirks handled:
// 1) Fragments like "<tr><td>…</td></tr>" (no <table> wrapper) are invalid
//    standalone HTML, and DOMParser silently STRIPS those tags — every cell
//    then concatenates into one unreadable blob ("iduser_idorg_id…").
//    Wrapping such fragments in <table>…</table> preserves the structure.
// 2) The narrative answer must not repeat the table's own cell text.
function parseHtmlPayload(html) {
  const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const hasTable = /<table[\s>]/i.test(html);
  const isFragment = !hasTable && /<(tr|td|th|tbody|thead)[\s>]/i.test(html);
  const source = isFragment ? `<table>${html}</table>` : html;

  let doc;
  try {
    doc = new DOMParser().parseFromString(source, 'text/html');
  } catch {
    return { text: stripTags(html), rows: null };
  }

  const fullText = (doc.documentElement.textContent || '').replace(/\s+/g, ' ').trim();
  let rows = null;
  let text = fullText;

  const table = doc.querySelector('table');
  if (table) {
    const trs = Array.from(table.querySelectorAll('tr')).filter((tr) => tr.children.length);
    if (trs.length >= 2) {
      const headers = Array.from(trs[0].children).map((c, i) => (c.textContent || '').trim() || `col_${i + 1}`);
      rows = trs.slice(1).map((tr) => {
        const row = {};
        Array.from(tr.children).forEach((c, i) => {
          row[headers[i] || `col_${i + 1}`] = (c.textContent || '').trim();
        });
        return row;
      }).filter((r) => Object.keys(r).length);
      // Narrative = text living OUTSIDE the table (e.g. "<div>5814.19</div>",
      // or a sentence beside it) so table cells never double up as prose.
      const outside = doc.documentElement.cloneNode(true);
      outside.querySelectorAll('table').forEach((t) => t.remove());
      text = (outside.textContent || '').replace(/\s+/g, ' ').trim();
    }
  }

  return { text, rows: rows && rows.length ? rows : null };
}

// Wire shape (or legacy shapes) → { answer, data: rows|null, sql, timing, success }.
export function normalizeAIResponse(raw) {
  if (raw == null) return { answer: '', data: null, sql: '', executionTimeMs: null, dbTimeMs: null, success: false };
  if (typeof raw === 'string') {
    return { answer: parseHtmlPayload(raw).text, data: null, sql: '', executionTimeMs: null, dbTimeMs: null, success: true };
  }

  const out = { ...raw };

  if (typeof raw.data === 'string') {
    // HTML-wrapped answer (the service's current format).
    // Preserve the raw HTML so the UI can render it directly.
    out.rawHtml = raw.data;
    const { text, rows } = parseHtmlPayload(raw.data);
    out.answer = raw.answer ?? text;
    out.data = rows; // null unless the HTML contained a <table>
  } else if (Array.isArray(raw.data)) {
    out.data = raw.data; // already a row set
    out.rawHtml = null;
  } else {
    out.data = null;
    out.rawHtml = null;
  }

  if (out.answer == null) out.answer = extractAnswer(raw);
  out.sql = raw.sql ?? raw.generated_sql ?? '';
  out.executionTimeMs = raw.meta?.execution_time_ms ?? raw.executionTimeMs ?? null;
  out.dbTimeMs = raw.meta?.db_execution_time_ms ?? null;
  // Only an EXPLICIT failure marks the answer as failed. A missing success AND
  // missing status (legacy shapes) must stay truthy or old payloads would break.
  const status = raw.status != null ? String(raw.status).toUpperCase() : null;
  out.success = raw.success != null ? Boolean(raw.success) : (status != null ? status === 'SUCCESS' : true);
  return out;
}

// POST /query { platform, org_id, question } → normalized AI answer.
// The service's `success` flag gates the result: only a successful response is
// returned as an answer; a failed one throws (with the service's reason) so the
// chat surfaces show their error bubble instead of an answer card.
export async function askAI({ platform, question, org_id, orgId }) {
  const resolvedClientId = getCurrentClientIdFromStorage();
  const payload = {
    question,
    ...(resolvedClientId ? { clientId: String(resolvedClientId) } : {}),
  };

  const resolvedOrgId = org_id ?? orgId;
  if (resolvedOrgId != null && resolvedOrgId !== '') {
    payload.org_id = String(resolvedOrgId);
  }

  const { data } = await axios.post(
    `${AI_BASE}/query`,
    payload,
    { headers: { 'Content-Type': 'application/json' }, timeout: 120000 },
  );
  const normalized = normalizeAIResponse(data);
  if (!normalized.success) {
    // Even on failure, render the data text as a normal answer card (not a
    // red error bubble). Strip HTML from data to get plain text.
    const strip = (s) => (typeof s === 'string' ? s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '');
    normalized.answer = strip(data?.data) || strip(data?.summary) || normalized.answer || '';
    normalized.success = true; // render as normal answer
  }
  return normalized;
}

// The /query response shape isn't strictly fixed — pull the human-readable
// answer from the most likely fields, falling back to the raw payload.
export function extractAnswer(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  const answer = data.answer ?? data.response ?? data.message ?? data.result ?? data.text;
  if (answer != null) return typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2);
  return JSON.stringify(data, null, 2);
}