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

// Oremus AI query service. Lives on its own origin (separate from the /api
// backend), so it uses a dedicated axios call rather than the shared client.
// Override the base via VITE_AI_API_URL in the .env file if the host changes.

// POST /query { platform, question } → AI answer.
export async function askAI({ platform, question }) {
  const payloadPlatform = formatAIPlatform(platform);
  const { data } = await axios.post(
    `${AI_BASE}/query`,
    { platform: payloadPlatform, question },
    { headers: { 'Content-Type': 'application/json' }, timeout: 60000 },
  );
  return data;
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
