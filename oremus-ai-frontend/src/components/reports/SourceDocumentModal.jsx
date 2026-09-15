import { useEffect, useState } from 'react';
import { X, FileText, Loader2 } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import axiosClient from '../../services/axiosClient.js';
import { fmt } from '../../utils/fmt.js';

// Drill-down leaf: the full source document behind a ledger entry
// (Invoice / Bill / Payment / Journal Entry, …). Reached from
// AccountLedgerModal or any drill row carrying { sourceType, sourceRef }.
function money(v, currency) {
  if (v == null) return '';
  return fmt(Number(v), { dec: 2, currency });
}

// Extract a friendly { description, qty, rate, amount } from a QBO line.
function readLine(line) {
  const detail =
    line.SalesItemLineDetail ||
    line.ItemBasedExpenseLineDetail ||
    line.AccountBasedExpenseLineDetail ||
    line.JournalEntryLineDetail ||
    line.DepositLineDetail ||
    {};
  const itemName =
    detail.ItemRef?.name ||
    detail.AccountRef?.name ||
    line.Description ||
    '';
  return {
    description: line.Description || itemName,
    name: itemName,
    qty: detail.Qty != null ? Number(detail.Qty) : null,
    rate: detail.UnitPrice != null ? Number(detail.UnitPrice) : null,
    amount: line.Amount != null ? Number(line.Amount) : null,
    posting: detail.PostingType || null,
  };
}

export default function SourceDocumentModal({ open, onClose, sourceType, sourceRef, currency = 'USD' }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [doc, setDoc] = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    if (!open || !sourceType || !sourceRef) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDoc(null);
    setShowRaw(false);
    axiosClient
      .get(`/accounting/source/${encodeURIComponent(sourceType)}/${encodeURIComponent(sourceRef)}`)
      .then(({ data }) => { if (!cancelled) setDoc(data); })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.error || e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, sourceType, sourceRef]);

  const cur = doc?.currency || currency;
  const payload = doc?.payload || {};
  const lines = Array.isArray(payload.Line)
    ? payload.Line.filter((l) => l.DetailType !== 'SubTotalLineDetail').map(readLine)
    : [];

  return (
    <Modal open={open} onClose={onClose} size="lg">
      <header className="flex items-center justify-between px-5 py-4 border-b border-navy-200 dark:border-navy-800">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/10">
            <FileText size={18} />
          </span>
          <div>
            <h3 className="text-sm font-bold text-navy-900 dark:text-navy-50">
              {doc?.entity || sourceType} {doc?.docNumber ? `#${doc.docNumber}` : ''}
            </h3>
            <p className="text-[11px] text-navy-400">Source document</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-navy-400 hover:text-navy-700 dark:hover:text-navy-200"
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto scroll-thin px-5 py-4">
        {loading && (
          <div className="flex items-center justify-center py-12 text-navy-400">
            <Loader2 className="animate-spin mr-2" size={18} /> Loading source document…
          </div>
        )}
        {error && !loading && (
          <div className="py-10 text-center text-sm text-navy-500">{error}</div>
        )}
        {doc && !loading && (
          <>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
              <div>
                <dt className="text-[10.5px] uppercase tracking-wider text-navy-400">Name</dt>
                <dd className="text-[13px] font-medium text-navy-800 dark:text-navy-100">{doc.displayName || '—'}</dd>
              </div>
              <div>
                <dt className="text-[10.5px] uppercase tracking-wider text-navy-400">Date</dt>
                <dd className="text-[13px] font-medium text-navy-800 dark:text-navy-100">{doc.txnDate || '—'}</dd>
              </div>
              <div>
                <dt className="text-[10.5px] uppercase tracking-wider text-navy-400">Total</dt>
                <dd className="text-[13px] font-semibold tabular-nums text-navy-800 dark:text-navy-100">{money(doc.totalAmt, cur)}</dd>
              </div>
              <div>
                <dt className="text-[10.5px] uppercase tracking-wider text-navy-400">Balance</dt>
                <dd className="text-[13px] font-semibold tabular-nums text-navy-800 dark:text-navy-100">{doc.balance != null ? money(doc.balance, cur) : '—'}</dd>
              </div>
            </dl>

            {lines.length > 0 && (
              <div className="rounded-xl border border-navy-100 dark:border-navy-800 overflow-hidden mb-4">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="bg-navy-50 dark:bg-navy-900/60 text-[10px] uppercase tracking-wider text-navy-400">
                      <th className="text-left px-3 py-2">Item / Description</th>
                      <th className="text-right px-3 py-2">Qty</th>
                      <th className="text-right px-3 py-2">Rate</th>
                      <th className="text-right px-3 py-2">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i} className="border-t border-navy-100 dark:border-navy-800">
                        <td className="px-3 py-2 text-navy-700 dark:text-navy-200">
                          {l.description || l.name || '—'}
                          {l.posting ? <span className="ml-1 text-[10px] text-navy-400">({l.posting})</span> : null}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-navy-500">{l.qty != null ? l.qty : ''}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-navy-500">{l.rate != null ? money(l.rate, cur) : ''}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-navy-700 dark:text-navy-200">{l.amount != null ? money(l.amount, cur) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowRaw((s) => !s)}
              className="text-[11.5px] text-brand-600 hover:underline"
            >
              {showRaw ? 'Hide' : 'Show'} raw data
            </button>
            {showRaw && (
              <pre className="mt-2 max-h-72 overflow-auto scroll-thin rounded-lg bg-navy-900 text-navy-100 text-[11px] p-3">
                {JSON.stringify(payload, null, 2)}
              </pre>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
