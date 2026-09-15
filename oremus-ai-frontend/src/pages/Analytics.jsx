import { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  Sparkles, Send, Loader2, ChevronDown, Code2, BarChart3, Plus, History,
  Copy, Check, FileSpreadsheet, Lock, X,
} from 'lucide-react';
import { selectUser } from '../features/auth/authSlice.js';
import { selectActiveCurrency } from '../features/ui/uiSlice.js';
import { askAI, formatAIPlatform } from '../services/aiClient.js';
import { fmt, currencyLocale } from '../utils/fmt.js';

// ─────────────────────────────────────────────────────────────────────────────
// AI Search (Ask Oremus) — chat with your books.
// Layout mirrors the reference design: a left rail (New Query, quick actions,
// recent conversations, on-premise badge) beside a conversation view where the
// AI replies with rich answer cards (table + bars + copy/export) and follow-up
// suggestion chips.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TABLE_ROWS = 50;
const BAR_COUNT = 6;

const QUICK_ACTIONS = [
  { label: 'Cash Flow Summary',  prompt: 'Show me a cash flow summary' },
  { label: 'P&L Overview',       prompt: 'Give me a profit & loss overview' },
  { label: 'AR Aging Report',    prompt: 'Show the accounts receivable aging report' },
  { label: 'Revenue Trends',     prompt: 'Show revenue trends over the last 6 months' },
  { label: 'Vendor Payments',    prompt: 'Summarize vendor payments' },
];

const FOLLOW_UPS = [
  'Show last quarter comparison',
  'Which customer has the highest outstanding?',
  'Export this report',
];

// Columns whose integer values are identifiers, not quantities — keep them raw
// (no thousands separators turning a year "2025" into "2,025").
const ID_LIKE = /(^|[_\s])(id|year|code|no|num|number|phone|pin|zip)([_\s]|$)/i;

// Columns that carry money — rendered with the active currency symbol.
const MONEY_KEY = /amount|revenue|total|balance|value|price|sales|cost|expense|outstanding|paid|cash|profit|income|fee|tax|amt|debit|credit/i;

// Columns whose "total" would be meaningless (rates, percentages, averages).
const RATE_KEY = /rate|percent|pct|growth|margin|avg|average|ratio|%/i;

// "total_revenue" → "Total Revenue".
function titleize(k) {
  return String(k).replace(/[_\s]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function isNumeric(v) {
  if (v === null || v === undefined || v === '') return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') { const t = v.trim(); return t !== '' && !Number.isNaN(Number(t)); }
  return false;
}

// Format a numeric cell: money columns get the currency symbol + locale-aware
// grouping (en-IN lakh/crore commas for INR), other numbers just grouping.
function fmtCell(v, { numeric, money, idLike }, currency) {
  if (v === null || v === undefined || v === '') return '—';
  if (!numeric) return String(v);
  const n = Number(v);
  if (idLike) return String(Math.trunc(n));
  if (money) return fmt(n, { currency, dec: Number.isInteger(n) ? 0 : 2 });
  return n.toLocaleString(currencyLocale(currency), {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

// "Just now" / "5m ago" / "Yesterday" / "3 days ago" / "2 weeks ago".
function relTime(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'Just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  const w = Math.floor(d / 7);
  return w === 1 ? '1 week ago' : `${w} weeks ago`;
}

// Inspect a result set to pick the best label + value columns for the bars.
function analyze(rows) {
  if (!rows || !rows.length) return null;
  const keys = Object.keys(rows[0]).filter((k) => rows.some((r) => r[k] != null && r[k] !== ''));
  const numericKeys = keys.filter((k) => {
    if (ID_LIKE.test(k)) return false;
    const vals = rows.map((r) => r[k]).filter((v) => v != null && v !== '');
    return vals.length > 0 && vals.every(isNumeric);
  });
  const labelKey = keys.find((k) => !numericKeys.includes(k) && !ID_LIKE.test(k))
    || keys.find((k) => !numericKeys.includes(k))
    || keys[0];
  return { keys, numericKeys, labelKey, valueKey: numericKeys[0] || null };
}

// A computed "Total" row — only for table-shaped results (one label column +
// numeric measures) where summing makes sense. Returns RAW values (numbers for
// summable columns, null for non-summable ones) so the caller formats them
// exactly once with the same per-column metadata as the data rows.
function computeTotalRow(rows, meta) {
  if (rows.length < 2) return null;
  const summable = meta.filter((m) => m.numeric && !m.idLike && !RATE_KEY.test(m.key));
  if (summable.length < 1) return null;
  const total = {};
  meta.forEach((m, i) => {
    if (i === 0) { total[m.key] = 'Total'; return; }
    if (!summable.includes(m)) { total[m.key] = null; return; }
    total[m.key] = rows.reduce((acc, r) => acc + (Number(r[m.key]) || 0), 0);
  });
  return total;
}

// Result table: uppercase headers, right-aligned tabular numbers, computed
// Total row, sticky header + scroll for long result sets.
function ResultTable({ rows, currency }) {
  if (!rows.length) return <div className="text-[12px] text-navy-500">No rows returned.</div>;
  const keys = Object.keys(rows[0]).filter((k) =>
    rows.some((r) => r[k] !== null && r[k] !== '' && r[k] !== undefined));
  const shown = rows.slice(0, MAX_TABLE_ROWS);
  const meta = keys.map((k) => {
    const vals = rows.map((r) => r[k]).filter((v) => v !== null && v !== '' && v !== undefined);
    const numeric = vals.length > 0 && vals.every(isNumeric);
    return { key: k, numeric, idLike: ID_LIKE.test(k), money: numeric && MONEY_KEY.test(k), align: numeric && !ID_LIKE.test(k) };
  });
  const totalRow = computeTotalRow(rows, meta);
  return (
    <div className="rounded-xl border border-navy-200/70 dark:border-navy-700/70 overflow-hidden">
      <div className="overflow-auto max-h-[420px] scroll-thin">
        <table className="w-full text-[12.5px] border-collapse">
          <thead>
            <tr>
              {meta.map((m) => (
                <th
                  key={m.key}
                  className={`sticky top-0 z-10 bg-navy-50 dark:bg-navy-900 px-3.5 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-navy-400 dark:text-navy-400 whitespace-nowrap border-b border-navy-200/70 dark:border-navy-700/70 ${m.align ? 'text-right' : 'text-left'}`}
                >
                  {titleize(m.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="hover:bg-brand-50/50 dark:hover:bg-navy-800/40 transition-colors">
                {meta.map((m) => (
                  <td
                    key={m.key}
                    className={`px-3.5 py-2 whitespace-nowrap border-b border-navy-100/70 dark:border-navy-800/50 ${m.align ? 'text-right tabular-nums font-medium text-navy-800 dark:text-navy-100' : 'text-navy-700 dark:text-navy-300'}`}
                  >
                    {fmtCell(r[m.key], m, currency)}
                  </td>
                ))}
              </tr>
            ))}
            {totalRow && (
              <tr className="bg-navy-50/80 dark:bg-navy-800/40">
                {meta.map((m) => {
                  const v = totalRow[m.key];
                  return (
                    <td
                      key={m.key}
                      className={`px-3.5 py-2.5 whitespace-nowrap border-t-2 border-navy-200 dark:border-navy-700 font-bold text-navy-900 dark:text-white ${m.align ? 'text-right tabular-nums' : ''}`}
                    >
                      {v === null ? '—' : typeof v === 'number' ? fmtCell(v, m, currency) : v}
                    </td>
                  );
                })}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length && (
        <div className="px-3.5 py-1.5 text-[10.5px] text-navy-400 border-t border-navy-100/70 dark:border-navy-800/50">
          Showing first {shown.length} of {rows.length} rows
        </div>
      )}
    </div>
  );
}

// "REVENUE BY CUSTOMER" — horizontal bars for the top entries. Pure CSS widths,
// deterministic render, values formatted with the active currency.
function InsightBars({ rows, analysis, currency }) {
  const { labelKey, valueKey } = analysis;
  if (!valueKey || !labelKey || labelKey === valueKey || rows.length < 2) return null;
  const data = rows
    .map((r) => ({ name: r[labelKey] == null || r[labelKey] === '' ? '—' : String(r[labelKey]), value: Number(r[valueKey]) }))
    .filter((d) => Number.isFinite(d.value))
    .sort((a, b) => b.value - a.value)
    .slice(0, BAR_COUNT);
  if (data.length < 2) return null;
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 0) || 1;
  const money = MONEY_KEY.test(valueKey);
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-navy-400 mb-3">
        <BarChart3 size={13} />
        {`${titleize(valueKey)} by ${titleize(labelKey)}`}
      </div>
      <div className="space-y-3">
        {data.map((d, i) => (
          <div key={i} className="grid grid-cols-[minmax(96px,180px)_1fr_auto] items-center gap-3">
            <span className="truncate text-[12.5px] text-navy-600 dark:text-navy-300" title={d.name}>{d.name}</span>
            <div className="h-2.5 rounded-full bg-navy-100 dark:bg-navy-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-400 transition-[width] duration-500"
                style={{ width: `${Math.max((Math.abs(d.value) / max) * 100, 2)}%` }}
              />
            </div>
            <span className="text-[12.5px] tabular-nums font-semibold text-navy-800 dark:text-navy-100">
              {money ? fmt(d.value, { currency, dec: Number.isInteger(d.value) ? 0 : 2 }) : d.value.toLocaleString(currencyLocale(currency))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// The executed SQL, tucked behind a collapsible toggle.
function SqlBlock({ sql }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-navy-200/70 dark:border-navy-700/70 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-medium text-navy-500 dark:text-navy-400 hover:bg-navy-50 dark:hover:bg-navy-900/50 transition-colors"
      >
        <span className="flex items-center gap-1.5"><Code2 size={13} /> View SQL query</span>
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <pre className="text-[11px] bg-navy-50 dark:bg-navy-900 p-3 overflow-x-auto whitespace-pre-wrap break-words text-navy-600 dark:text-navy-300 font-mono border-t border-navy-200/70 dark:border-navy-700/70">
          {sql}
        </pre>
      )}
    </div>
  );
}

// Plain-text version of an answer for the clipboard: narrative + TSV table.
function answerPlainText(data) {
  const text = data?.answer ?? data?.response ?? data?.message ?? data?.text;
  const rows = Array.isArray(data?.data) ? data.data : null;
  let out = text != null ? (typeof text === 'string' ? text : JSON.stringify(text)) : '';
  if (rows && rows.length) {
    const keys = Object.keys(rows[0]);
    out += `\n\n${keys.map(titleize).join('\t')}`;
    out += `\n${rows.map((r) => keys.map((k) => (r[k] == null ? '' : String(r[k]))).join('\t')).join('\n')}`;
  }
  return out.trim();
}

// Download the result set as a real .xlsx (SheetJS lazy-loaded like reports).
async function exportRowsXlsx(data) {
  const rows = Array.isArray(data?.data) ? data.data : null;
  if (!rows || !rows.length) return;
  const XLSX = await import('xlsx');
  const keys = Object.keys(rows[0]);
  const aoa = [keys.map(titleize), ...rows.map((r) => keys.map((k) => (r[k] == null ? '' : r[k])))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = keys.map((_, i) => ({ wch: i === 0 ? 36 : 18 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'AI Result');
  XLSX.writeFile(wb, `AI Result ${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// One AI reply card: answer text, table, bars, SQL toggle, provenance footer.
function AiCard({ data, currency, hasRows }) {
  const [copied, setCopied] = useState(false);
  const text = data?.answer ?? data?.response ?? data?.message ?? data?.text;
  const rows = Array.isArray(data?.data) ? data.data : null;
  const analysis = rows && rows.length ? analyze(rows) : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(answerPlainText(data));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="space-y-4">
      {text != null && (
        <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-navy-800 dark:text-navy-100">
          {typeof text === 'string' ? text : JSON.stringify(text)}
        </div>
      )}
      {analysis && <ResultTable rows={rows} currency={currency} />}
      {analysis && (
        <div className="rounded-xl border border-navy-200/70 dark:border-navy-700/70 bg-navy-50/50 dark:bg-navy-900/40 p-4">
          <InsightBars rows={rows} analysis={analysis} currency={currency} />
        </div>
      )}
      {data?.sql && <SqlBlock sql={data.sql} />}

      {/* Provenance + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-200/70 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 px-3 py-1.5 text-[11.5px] font-medium text-brand-600 dark:text-brand-300">
          <Lock size={11} />
          Generated by Oremus AI · On-premise data
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={copy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-navy-200/80 dark:border-navy-700 px-3 py-1.5 text-[12px] font-medium text-navy-600 dark:text-navy-300 hover:bg-navy-100 dark:hover:bg-navy-800 transition-colors"
          >
            {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {hasRows && (
            <button
              onClick={() => exportRowsXlsx(data)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-brand-500 to-brand-600 px-3.5 py-1.5 text-[12px] font-semibold text-white shadow-glow hover:from-brand-600 hover:to-brand-700 transition-colors"
            >
              <FileSpreadsheet size={13} />
              Export to Excel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Recent conversations persistence ─────────────────────────────────────────
const CONVO_KEY = 'oremus_ai_conversations_v1';
const MAX_CONVOS = 12;

function loadConvos() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONVO_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
function saveConvos(convos) {
  try { localStorage.setItem(CONVO_KEY, JSON.stringify(convos.slice(0, MAX_CONVOS))); } catch { /* quota */ }
}

export default function Analytics() {
  const user = useSelector(selectUser);
  const currency = useSelector(selectActiveCurrency);
  // The AI query needs a provider; fall back to Zoho when the user has none.
  const platform = formatAIPlatform(user?.integrationType && user.integrationType !== 'none'
    ? user.integrationType
    : 'zoho');

  const [convos, setConvos] = useState(loadConvos);
  const [activeId, setActiveId] = useState(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [railOpen, setRailOpen] = useState(false); // mobile history drawer
  const scrollRef = useRef(null);

  const active = convos.find((c) => c.id === activeId) || null;
  const messages = active?.messages ?? [];
  const hasChat = messages.length > 0;

  useEffect(() => { saveConvos(convos); }, [convos]);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  // Create-or-update a conversation and bubble it to the top of recents.
  const upsert = (id, fn) => {
    setConvos((list) => {
      const idx = list.findIndex((c) => c.id === id);
      const base = idx >= 0 ? list[idx] : { id, title: '', ts: Date.now(), messages: [] };
      const next = { ...base, ...fn(base), ts: Date.now() };
      if (!next.title) {
        next.title = next.messages.find((m) => m.role === 'user')?.text?.slice(0, 60) || 'New query';
      }
      const out = idx >= 0 ? list.map((c) => (c.id === id ? next : c)) : [next, ...list];
      return out.slice(0, MAX_CONVOS);
    });
  };

  const send = async (raw) => {
    const q = String(raw ?? input).trim();
    if (!q || loading) return;
    setInput('');
    const id = activeId || `c_${Date.now()}`;
    if (!activeId) setActiveId(id);
    upsert(id, (c) => ({ ...c, messages: [...c.messages, { role: 'user', text: q }] }));
    setLoading(true);
    try {
      const data = await askAI({ platform, question: q });
      upsert(id, (c) => ({ ...c, messages: [...c.messages, { role: 'ai', data }] }));
    } catch (err) {
      const msg = err?.response?.data?.message || err?.message || 'Request failed.';
      upsert(id, (c) => ({ ...c, messages: [...c.messages, { role: 'error', text: `Sorry, I couldn't answer that. (${msg})` }] }));
    } finally {
      setLoading(false);
    }
  };

  const onFollowUp = (chip) => {
    if (chip === 'Export this report') {
      const lastAi = [...messages].reverse().find((m) => m.role === 'ai');
      if (lastAi) exportRowsXlsx(lastAi.data);
      return;
    }
    send(chip);
  };

  const startNewQuery = () => {
    setActiveId(null);
    setInput('');
    setRailOpen(false);
  };

  // ── Left rail (shared by desktop sidebar + mobile drawer) ──────────────────
  const railContent = (
    <div className="flex flex-col h-full">
      <div className="p-4">
        <button
          onClick={startNewQuery}
          className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-brand-500/50 bg-brand-500/10 px-4 py-3 text-[13.5px] font-semibold text-brand-600 dark:text-brand-300 hover:bg-brand-500/20 transition-colors"
        >
          <Plus size={16} />
          New Query
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin px-4 pb-4">
        {/* Quick actions */}
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-navy-400 mb-2.5">Quick Actions</div>
        <div className="space-y-0.5 mb-6">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.label}
              onClick={() => { setRailOpen(false); send(a.prompt); }}
              className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-navy-600 dark:text-navy-300 hover:bg-navy-100/70 dark:hover:bg-navy-800/60 hover:text-navy-900 dark:hover:text-white transition-colors text-left"
            >
              <span className="w-1.5 h-1.5 rounded-[3px] bg-brand-500 shrink-0" />
              <span className="truncate">{a.label}</span>
            </button>
          ))}
        </div>

        {/* Recent conversations */}
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-navy-400 mb-2.5">Recent Conversations</div>
        {convos.length === 0 ? (
          <div className="text-[12px] text-navy-400 px-2.5">No conversations yet.</div>
        ) : (
          <div className="space-y-1">
            {convos.map((c) => (
              <button
                key={c.id}
                onClick={() => { setActiveId(c.id); setRailOpen(false); }}
                className={`w-full text-left rounded-xl px-3 py-2.5 transition-colors border ${
                  c.id === activeId
                    ? 'bg-navy-100 dark:bg-navy-800/70 border-navy-200 dark:border-navy-700'
                    : 'border-transparent hover:bg-navy-100/60 dark:hover:bg-navy-800/40'
                }`}
              >
                <div className="text-[13px] font-medium text-navy-800 dark:text-navy-100 truncate">{c.title}</div>
                <div className="text-[11px] text-navy-400 mt-0.5">{relTime(c.ts)}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* On-premise badge */}
      <div className="border-t border-navy-200/70 dark:border-navy-800 p-4">
        <div className="flex items-start gap-2 text-[11.5px] text-navy-500 dark:text-navy-400">
          <span className="relative flex h-2 w-2 mt-1 shrink-0">
            <span className="animate-ping-slow absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span>On-premise · Data never leaves your servers</span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-[calc(100vh-56px)] overflow-hidden">
      {/* Desktop rail */}
      <aside className="hidden lg:flex w-[280px] shrink-0 flex-col border-r border-navy-200/70 dark:border-navy-800 bg-white/70 dark:bg-navy-900/40">
        {railContent}
      </aside>

      {/* Mobile history drawer */}
      {railOpen && (
        <div className="lg:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] animate-fadein" onClick={() => setRailOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-[300px] max-w-[85vw] bg-white dark:bg-navy-950 shadow-2xl flex flex-col animate-slide-left">
            <div className="flex items-center justify-between px-4 pt-4">
              <span className="text-[13px] font-semibold text-navy-800 dark:text-white">AI Search</span>
              <button
                onClick={() => setRailOpen(false)}
                className="w-8 h-8 rounded-lg grid place-items-center text-navy-400 hover:bg-navy-100 dark:hover:bg-navy-800 transition"
                aria-label="Close history"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 min-h-0">{railContent}</div>
          </div>
        </div>
      )}

      {/* Conversation column */}
      <section className="flex-1 min-w-0 flex flex-col">
        {/* Slim mobile bar (desktop has no header, like the reference) */}
        <div className="lg:hidden flex items-center gap-2 px-4 py-2.5 border-b border-navy-200/70 dark:border-navy-800 bg-white/70 dark:bg-navy-900/40">
          <button
            onClick={() => setRailOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-navy-200/80 dark:border-navy-700 px-3 py-1.5 text-[12px] font-medium text-navy-600 dark:text-navy-300"
          >
            <History size={14} /> History
          </button>
          <button
            onClick={startNewQuery}
            className="inline-flex items-center gap-1.5 rounded-lg border border-brand-500/50 bg-brand-500/10 px-3 py-1.5 text-[12px] font-semibold text-brand-600 dark:text-brand-300"
          >
            <Plus size={14} /> New
          </button>
          <span className="ml-auto text-[11px] text-navy-400 capitalize">{platform}</span>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-4 lg:px-8 py-6">
          <div className="max-w-[880px] mx-auto">
            {hasChat ? (
              <div className="space-y-7">
                {messages.map((m, i) => (
                  <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex items-start gap-3'}>
                    {m.role !== 'user' && (
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-cyan-500 text-white grid place-items-center shrink-0 shadow-glow">
                        <Sparkles size={15} />
                      </div>
                    )}
                    {m.role === 'user' ? (
                      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-gradient-to-br from-brand-500 to-brand-700 text-white px-4 py-2.5 text-[13.5px] leading-snug shadow-card">
                        {m.text}
                      </div>
                    ) : m.role === 'error' ? (
                      <div className="max-w-[90%] rounded-2xl rounded-tl-md bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 border border-red-100 dark:border-red-500/20 px-4 py-2.5 text-[13.5px] leading-snug">
                        {m.text}
                      </div>
                    ) : (
                      <div className="flex-1 min-w-0 rounded-2xl rounded-tl-md border border-navy-200/70 dark:border-navy-800 bg-white dark:bg-navy-900/60 shadow-card px-5 py-4">
                        <AiCard data={m.data} currency={currency} hasRows={Array.isArray(m.data?.data) && m.data.data.length > 0} />
                        {/* Follow-up chips */}
                        <div className="flex flex-wrap gap-2 mt-5 pt-4 border-t border-navy-100 dark:border-navy-800">
                          {FOLLOW_UPS.map((chip) => (
                            <button
                              key={chip}
                              onClick={() => onFollowUp(chip)}
                              disabled={loading}
                              className="rounded-full border border-navy-200/80 dark:border-navy-700 px-3.5 py-1.5 text-[12px] text-navy-600 dark:text-navy-300 hover:bg-navy-100 dark:hover:bg-navy-800 hover:text-navy-900 dark:hover:text-white transition-colors disabled:opacity-50"
                            >
                              {chip}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {loading && (
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-cyan-500 text-white grid place-items-center shrink-0 shadow-glow">
                      <Sparkles size={15} />
                    </div>
                    <div className="rounded-2xl rounded-tl-md border border-navy-200/70 dark:border-navy-800 bg-white dark:bg-navy-900/60 px-4 py-3 inline-flex items-center gap-1.5">
                      {[0, 1, 2].map((d) => (
                        <span key={d} className="typing-dot w-1.5 h-1.5 rounded-full bg-brand-500" style={{ animationDelay: `${d * 0.15}s` }} />
                      ))}
                      <span className="ml-1.5 text-[12px] text-navy-400">Thinking…</span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Empty state */
              <div className="h-full flex flex-col items-center justify-center text-center py-16">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-cyan-500 text-white grid place-items-center mb-5 shadow-glow glow-pulse">
                  <Sparkles size={28} />
                </div>
                <h2 className="text-[22px] font-bold text-navy-900 dark:text-white mb-2">Ask Oremus AI</h2>
                <p className="text-[13.5px] text-navy-500 dark:text-navy-400 max-w-md mb-8">
                  Ask anything about your finances and get instant, grounded answers from your live {platform} data.
                </p>
                <div className="grid sm:grid-cols-2 gap-2.5 w-full max-w-xl">
                  {QUICK_ACTIONS.map((a) => (
                    <button
                      key={a.label}
                      onClick={() => send(a.prompt)}
                      className="rounded-xl border border-navy-200/80 dark:border-navy-800 bg-white dark:bg-navy-900/60 px-4 py-3 text-[13px] font-medium text-navy-700 dark:text-navy-200 hover:border-brand-400 dark:hover:border-brand-500/50 hover:shadow-lift transition-all text-left"
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Composer */}
        <div className="px-4 lg:px-8 pb-4 pt-1">
          <div className="max-w-[880px] mx-auto">
            <div className="flex items-center gap-2 rounded-2xl border border-navy-200/80 dark:border-navy-700 bg-white dark:bg-navy-900 shadow-lift px-4 py-2.5 focus-within:border-brand-400 dark:focus-within:border-brand-500/60 transition-colors">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Ask about revenue, expenses, cash flow, customers…"
                className="flex-1 bg-transparent text-[14px] text-navy-800 dark:text-navy-100 placeholder:text-navy-400 outline-none"
              />
              <button
                onClick={() => send()}
                disabled={loading || !input.trim()}
                aria-label="Send question"
                className="w-10 h-10 rounded-full grid place-items-center bg-gradient-to-br from-brand-500 to-brand-600 text-white shrink-0 shadow-glow disabled:opacity-40 disabled:cursor-not-allowed hover:from-brand-600 hover:to-brand-700 transition-colors"
              >
                {loading ? <Loader2 size={17} className="animate-spin" /> : <Send size={16} />}
              </button>
            </div>
            <div className="text-center text-[11px] text-navy-400 mt-2.5">
              Oremus AI answers are grounded in your {platform} ledger · figures shown in {currency}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
