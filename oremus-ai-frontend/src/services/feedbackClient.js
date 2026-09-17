import axios from 'axios';
import { AI_API_URL as AI_BASE } from '../config/env.js';

// ─────────────────────────────────────────────────────────────────────────────
// AI answer feedback → POST {AI_API_URL}/feedback
//
// Wire contract (exact):
// {
//   "question":      "What is the total invoice amount?",
//   "correction":    "Use the total rather than the balance for the invoice amount",
//   "client_id":     "acme",
//   "request_id":    "...",
//   "generated_sql": "SELECT SUM(invoices.balance) ..."
// }
//
// The thumbs-up/down rating is a UI-only concern: it is persisted locally so
// the highlighted thumb survives reloads, but it is NOT part of the payload.
// ─────────────────────────────────────────────────────────────────────────────

const FEEDBACK_KEY = 'oremus_ai_feedback_v1';

// request_id → { rating, correction, ts } for the local thumb-highlight state.
function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(FEEDBACK_KEY));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function saveStore(map) {
  try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(map)); } catch { /* quota */ }
}

export function getStoredFeedback(requestId) {
  return loadStore()[requestId] || null;
}

function setStoredFeedback(requestId, entry) {
  const map = loadStore();
  if (entry) map[requestId] = entry; else delete map[requestId];
  saveStore(map);
}

// POST the feedback. A failed POST never blocks the UI — the local record is
// written first, and the error is surfaced to the caller via { ok }.
export async function submitFeedback({ requestId, question, correction = '', clientId = null, generatedSql = '', rating = null }) {
  const payload = {
    question,
    correction,
    client_id: clientId,
    request_id: requestId,
    generated_sql: generatedSql,
  };
  setStoredFeedback(requestId, { rating, correction, ts: Date.now() });
  try {
    await axios.post(`${AI_BASE}/feedback`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    return { ok: true };
  } catch (err) {
    console.warn('[feedback] submit failed:', err?.message);
    return { ok: false, error: err?.message };
  }
}