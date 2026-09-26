import { useEffect, useState } from 'react';
import { X, BookOpen, Loader2, Download } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import axiosClient from '../../services/axiosClient.js';
import { fmt } from '../../utils/fmt.js';
import { exportRowsCSV, exportRowsXLSX } from '../../utils/exportReport.js';
import SourceDocumentModal from './SourceDocumentModal.jsx';

// Report → Account drill: one account's General Ledger from the posted
// double-entry lines, with a running balance. Each row drills further to its
// source document.
function money(v, currency) {
  if (v == null || v === 0) return '';
  return fmt(Number(v), { dec: 2, currency });
}

export default function AccountLedgerModal({
  open, onClose, accountRef, accountName, currency = 'USD', from, to, asOf = false,
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [source, setSource] = useState(null); // { sourceType, sourceRef }

  useEffect(() => {
    if (!open || !accountRef) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    const params = { account_ref: accountRef };
    if (from) params.from = from;
    if (to) params.to = to;
    axiosClient
      .get('/accounting/ledger', { params })
      .then(({ data: d }) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.error || e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, accountRef, from, to]);

  const cur = data?.currency || currency;
  const ledger = data?.ledger || [];
  const totals = data?.totals;

  // Export every line (not just what's on screen) with the original-currency
  // amount and rate beside the base-currency figures, so a difference against
  // the platform's own report can be traced line by line.
  const exportLedger = (format) => {
    if (!ledger.length) return;
    const n = (v) => (v == null || v === '' ? '' : Number(v));
    const headers = [
      'Date', 'Transaction Type', 'Num', 'Name', 'Memo',
      'Currency', 'Exchange Rate', 'Original Debit', 'Original Credit',
      `Debit (${cur})`, `Credit (${cur})`, `Balance (${cur})`,
    ];
    const rows = ledger.map((r) => (r.isOpening
      ? ['', 'Beginning Balance', '', '', '', '', '', '', '', '', '', n(r.balance)]
      : [
        r.date ? String(r.date).slice(0, 10) : '', r.sourceType || '', r.docNumber || '',
        r.name || '', r.memo || '', r.currencyCode || '', n(r.exchangeRate),
        n(r.nativeDebit), n(r.nativeCredit), n(r.debit), n(r.credit), n(r.balance),
      ]));
    if (totals) rows.push(['', 'Total', '', '', '', '', '', '', '', n(totals.debit), n(totals.credit), n(totals.balance)]);
    const period = from && to ? `${from} to ${to}` : (to ? `As of ${to}` : '');
    const name = `${accountName || 'Account'} ledger`;
    if (format === 'xlsx') exportRowsXLSX(headers, rows, name, [accountName || 'Account', `General Ledger ${period}`.trim()]);
    else exportRowsCSV(headers, rows, name);
  };

  return (
    <>
      <Modal open={open} onClose={onClose} size="lg">
        <header className="flex items-center justify-between px-5 py-4 border-b border-navy-200 dark:border-navy-800">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/10">
              <BookOpen size={18} />
            </span>
            <div>
              <h3 className="text-sm font-bold text-navy-900 dark:text-navy-50">{accountName || 'Account ledger'}</h3>
              <p className="text-[11px] text-navy-400">General Ledger{from && to ? ` · ${from} → ${to}` : (to ? ` · As of ${to}` : '')}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {ledger.length > 0 && !loading && (
              <>
                <button
                  type="button"
                  onClick={() => exportLedger('xlsx')}
                  className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-navy-600 dark:text-navy-300 hover:text-brand-600"
                >
                  <Download size={13} /> Excel
                </button>
                <button
                  type="button"
                  onClick={() => exportLedger('csv')}
                  className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-navy-600 dark:text-navy-300 hover:text-brand-600"
                >
                  <Download size={13} /> CSV
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-navy-400 hover:text-navy-700 dark:hover:text-navy-200"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto scroll-thin">
          {loading && (
            <div className="flex items-center justify-center py-12 text-navy-400">
              <Loader2 className="animate-spin mr-2" size={18} /> Loading ledger…
            </div>
          )}
          {error && !loading && (
            <div className="py-10 text-center text-sm text-navy-500">{error}</div>
          )}
          {data && !loading && ledger.length === 0 && (
            <div className="py-10 text-center text-sm text-navy-500">No posted transactions for this account in the period.</div>
          )}
          {data && !loading && ledger.length > 0 && (
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b-2 border-navy-200 dark:border-navy-700">
                  <th className="sticky top-0 z-10 bg-white dark:bg-navy-950 px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-navy-500 dark:text-navy-300">Date</th>
                  <th className="sticky top-0 z-10 bg-white dark:bg-navy-950 px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-navy-500 dark:text-navy-300">Transaction</th>
                  <th className="sticky top-0 z-10 bg-white dark:bg-navy-950 px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-navy-500 dark:text-navy-300">Num</th>
                  <th className="sticky top-0 z-10 bg-white dark:bg-navy-950 px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-navy-500 dark:text-navy-300">Name</th>
                  <th className="sticky top-0 z-10 bg-white dark:bg-navy-950 px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-wider text-navy-500 dark:text-navy-300">Debit</th>
                  <th className="sticky top-0 z-10 bg-white dark:bg-navy-950 px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-wider text-navy-500 dark:text-navy-300">Credit</th>
                  <th className="sticky top-0 z-10 bg-white dark:bg-navy-950 px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-wider text-navy-500 dark:text-navy-300">Balance</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((r, i) => {
                  const drillable = !!(r.sourceType && r.sourceRef);
                  return (
                    <tr
                      key={i}
                      className={
                        'border-t border-navy-100 dark:border-navy-800 ' +
                        (drillable ? 'cursor-pointer hover:bg-navy-50/60 dark:hover:bg-navy-900/40' : '')
                      }
                      onClick={drillable ? () => setSource({ sourceType: r.sourceType, sourceRef: r.sourceRef }) : undefined}
                    >
                      <td className="px-3 py-2 text-navy-500">{r.date ? String(r.date).slice(0, 10) : ''}</td>
                      <td className={'px-3 py-2 ' + (drillable ? 'text-brand-600 font-medium' : 'text-navy-700 dark:text-navy-200')}>{r.sourceType || ''}</td>
                      <td className="px-3 py-2 font-mono text-navy-500">{r.docNumber || ''}</td>
                      <td className="px-3 py-2 text-navy-700 dark:text-navy-200">{r.name || ''}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-navy-700 dark:text-navy-200">{money(r.debit, cur)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-navy-700 dark:text-navy-200">{money(r.credit, cur)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium text-navy-800 dark:text-navy-100">{fmt(Number(r.balance || 0), { dec: 2, currency: cur })}</td>
                    </tr>
                  );
                })}
              </tbody>
              {totals && (
                <tfoot>
                  <tr className="bg-navy-50 dark:bg-navy-900/60 font-semibold border-t-2 border-navy-200 dark:border-navy-700">
                    <td className="px-3 py-2" colSpan={4}>Total</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(Number(totals.debit || 0), { dec: 2, currency: cur })}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(Number(totals.credit || 0), { dec: 2, currency: cur })}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(Number(totals.balance || 0), { dec: 2, currency: cur })}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      </Modal>

      <SourceDocumentModal
        open={!!source}
        onClose={() => setSource(null)}
        sourceType={source?.sourceType}
        sourceRef={source?.sourceRef}
        currency={cur}
      />
    </>
  );
}
