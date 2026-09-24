import { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import * as Icons from 'lucide-react';
import { X, Sparkles, Send, Loader2 } from 'lucide-react';
import Badge from '../ui/Badge.jsx';
import { selectUser } from '../../features/auth/authSlice.js';
import { selectOrgSelectedId } from '../../features/orgs/orgsSlice.js';
import { askAI, formatAIPlatform } from '../../services/aiClient.js';

const ICON_BG = {
  green: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-300',
  amber: 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-300',
  blue:  'bg-brand-100 text-brand-600 dark:bg-brand-500/20 dark:text-brand-300',
};

const MAX_TABLE_ROWS = 50;

// Renders a SELECT result set returned by /query as a compact, scrollable table.
function ResultTable({ rows }) {
  if (!rows.length) return <div className="text-[12px] text-navy-500">No rows returned.</div>;
  // Show only columns that have at least one value (SELECT * yields many nulls).
  const keys = Object.keys(rows[0]).filter((k) =>
    rows.some((r) => r[k] !== null && r[k] !== '' && r[k] !== undefined));
  const shown = rows.slice(0, MAX_TABLE_ROWS);
  return (
    <div>
      <div className="text-[11px] text-navy-500 mb-1">
        {rows.length} row{rows.length === 1 ? '' : 's'}
        {rows.length > shown.length ? ` · showing first ${shown.length}` : ''}
      </div>
      <div className="overflow-auto max-h-[320px] rounded-md border border-navy-100 dark:border-navy-800">
        <table className="text-[10.5px] border-collapse">
          <thead>
            <tr>
              {keys.map((k) => (
                <th key={k} className="sticky top-0 bg-navy-50 dark:bg-navy-900 px-2 py-1.5 text-left font-semibold text-navy-500 dark:text-navy-300 whitespace-nowrap border-b border-navy-100 dark:border-navy-800">
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="border-b border-navy-50 dark:border-navy-800/40">
                {keys.map((k) => (
                  <td key={k} className="px-2 py-1 whitespace-nowrap text-navy-700 dark:text-navy-300">
                    {r[k] == null ? '' : String(r[k])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Render an AI reply: a natural-language answer, the executed SQL, and/or a data table.
function AiAnswer({ data }) {
  if (typeof data === 'string') return <span className="whitespace-pre-wrap">{data}</span>;
  const text = data?.answer ?? data?.response ?? data?.message ?? data?.text;
  const rows = Array.isArray(data?.data) ? data.data : null;
  const hasStructured = text != null || data?.sql || rows;
  return (
    <div className="space-y-2">
      {text != null && (
        <div className="whitespace-pre-wrap">{typeof text === 'string' ? text : JSON.stringify(text)}</div>
      )}
      {data?.sql && (
        <pre className="text-[10.5px] bg-navy-100/70 dark:bg-navy-900 rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-words text-navy-600 dark:text-navy-300 font-mono">
          {data.sql}
        </pre>
      )}
      {rows && <ResultTable rows={rows} />}
      {!hasStructured && (
        <pre className="text-[11px] overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(data, null, 2)}</pre>
      )}
    </div>
  );
}

export default function AskOremusModal({ insights = [], onClose }) {
  const user = useSelector(selectUser);
  const selectedOrgId = useSelector(selectOrgSelectedId);
  // The AI query needs a provider; fall back to Zoho when the user has none.
  const platform = formatAIPlatform(user?.integrationType && user.integrationType !== 'none'
    ? user.integrationType
    : 'zoho');

  const [messages, setMessages] = useState([]); // { role: 'user' | 'ai' | 'error', text?, data? }
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  const send = async (question) => {
    const q = (question ?? input).trim();
    if (!q || loading) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text: q }]);
    setLoading(true);
    try {
      const data = await askAI({ platform, question: q, org_id: selectedOrgId });
      setMessages((m) => [...m, { role: 'ai', data }]);
    } catch (err) {
      const msg = err?.response?.data?.message || err?.message || 'Request failed.';
      setMessages((m) => [...m, { role: 'error', text: `Sorry, I couldn't answer that. (${msg})` }]);
    } finally {
      setLoading(false);
    }
  };

  const hasChat = messages.length > 0;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-40 animate-fadein"
        onClick={onClose}
      />
      <div className="fixed right-0 top-0 h-full w-full max-w-[460px] bg-white dark:bg-navy-950 shadow-2xl z-50 flex flex-col animate-slidein-right">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-navy-100 dark:border-navy-800">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 to-cyan-500 text-white grid place-items-center">
            <Sparkles size={16} />
          </div>
          <div className="flex-1">
            <div className="text-[15px] font-bold text-navy-900 dark:text-white">Ask Oremus AI</div>
            <div className="text-[11px] text-navy-400 capitalize">Connected to {platform}</div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg grid place-items-center text-navy-400 hover:text-navy-700 dark:hover:text-white hover:bg-navy-100 dark:hover:bg-navy-800 transition"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {hasChat ? (
            <div className="space-y-3">
              {messages.map((m, i) => (
                <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                  <div
                    className={
                      m.role === 'user'
                        ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-gradient-to-r from-brand-500 to-cyan-500 text-white px-3.5 py-2 text-[12.5px] leading-snug'
                        : m.role === 'error'
                          ? 'max-w-[92%] rounded-2xl rounded-bl-sm bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 border border-red-100 dark:border-red-500/20 px-3.5 py-2 text-[12.5px] leading-snug'
                          : 'max-w-full w-full rounded-2xl rounded-bl-sm bg-navy-50 dark:bg-navy-800/50 text-navy-800 dark:text-navy-100 border border-navy-100 dark:border-navy-800 px-3.5 py-2.5 text-[12.5px] leading-snug'
                    }
                  >
                    {m.role === 'ai' ? <AiAnswer data={m.data} /> : m.text}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="rounded-2xl rounded-bl-sm bg-navy-50 dark:bg-navy-800/50 border border-navy-100 dark:border-navy-800 px-3.5 py-2 text-[12.5px] text-navy-500 flex items-center gap-2">
                    <Loader2 size={13} className="animate-spin" /> Thinking…
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Insights */}
              {insights.length > 0 && (
                <div>
                  <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">Insights</div>
                  <div className="space-y-2.5">
                    {insights.map((ins, i) => {
                      const Icon = Icons[ins.icon] || Icons.Lightbulb;
                      const badgeTone = ins.tone === 'amber' ? 'amber' : ins.tone === 'green' ? 'green' : 'blue';
                      return (
                        <div key={i} className="rounded-lg border border-navy-100 dark:border-navy-800 bg-navy-50/50 dark:bg-navy-800/30 p-3">
                          <div className="flex items-start gap-2">
                            <div className={`w-6 h-6 rounded-md grid place-items-center shrink-0 ${ICON_BG[ins.tone]}`}>
                              <Icon size={11} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 mb-0.5">
                                <Badge tone={badgeTone} className="!text-[9px]">{ins.tag}</Badge>
                              </div>
                              <div className="text-[12px] font-semibold text-navy-900 dark:text-white leading-tight">{ins.title}</div>
                              <p className="text-[11px] text-navy-600 dark:text-navy-400 mt-1 leading-snug">{ins.body}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-navy-100 dark:border-navy-800 p-3">
          <div className="flex items-center gap-2 rounded-xl border border-navy-200 dark:border-navy-700 bg-navy-50 dark:bg-navy-900 px-3 py-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Ask anything about your finances…"
              className="flex-1 bg-transparent text-[13px] text-navy-800 dark:text-navy-100 placeholder:text-navy-400 outline-none"
            />
            <button
              onClick={() => send()}
              disabled={loading || !input.trim()}
              className="w-8 h-8 rounded-lg grid place-items-center bg-gradient-to-r from-brand-500 to-cyan-500 text-white shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
