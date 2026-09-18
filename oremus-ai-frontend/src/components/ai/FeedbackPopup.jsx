import { useEffect, useState } from 'react';
import { Check, Loader2, ThumbsDown, ThumbsUp, X } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Post-answer feedback popup — shared by every Oremus AI chat surface
// (AI Search page + dashboard "Ask Oremus" panel). Pops up after each answer:
// thumbs → optional comment → submit. Anchored bottom-right like a toast.
// ─────────────────────────────────────────────────────────────────────────────
export default function FeedbackPopup({ popup, onRate, onCorrection, onSubmit, onClose }) {
  const { rating, correction, submitting, thanks } = popup;

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div
      className="fixed bottom-[92px] right-4 lg:right-6 z-[60] w-[min(360px,calc(100vw-2rem))] animate-slide-up"
      role="dialog"
      aria-label="Rate this answer"
    >
      <div className="rounded-2xl border border-navy-200/80 dark:border-navy-700 bg-white dark:bg-navy-900 shadow-lift overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-brand-500 via-cyan-500 to-brand-500" />
        {thanks ? (
          <div className="px-5 py-6 flex flex-col items-center text-center gap-1">
            <div className="w-10 h-10 rounded-full bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 grid place-items-center mb-1">
              <Check size={18} />
            </div>
            <div className="text-[14px] font-semibold text-navy-900 dark:text-white">Thanks for the feedback!</div>
            <div className="text-[12px] text-navy-400">It helps Oremus AI answer better.</div>
          </div>
        ) : (
          <>
            <div className="px-4 pt-3.5 pb-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[13.5px] font-semibold text-navy-900 dark:text-white">How was this answer?</div>
                <button
                  onClick={onClose}
                  className="w-6 h-6 rounded-md grid place-items-center text-navy-400 hover:text-navy-700 dark:hover:text-white hover:bg-navy-100 dark:hover:bg-navy-800 transition"
                  aria-label="Dismiss feedback"
                >
                  <X size={13} />
                </button>
              </div>
              <p className="text-[11.5px] text-navy-400 mt-0.5">Your rating tunes Oremus AI to your books.</p>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => onRate('up')}
                  aria-label="Good answer"
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[12.5px] font-medium transition-colors ${
                    rating === 'up'
                      ? 'border-emerald-300 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                      : 'border-navy-200/80 dark:border-navy-700 text-navy-500 dark:text-navy-300 hover:bg-navy-100 dark:hover:bg-navy-800'
                  }`}
                >
                  <ThumbsUp size={14} /> Helpful
                </button>
                <button
                  onClick={() => onRate('down')}
                  aria-label="Bad answer"
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[12.5px] font-medium transition-colors ${
                    rating === 'down'
                      ? 'border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-300'
                      : 'border-navy-200/80 dark:border-navy-700 text-navy-500 dark:text-navy-300 hover:bg-navy-100 dark:hover:bg-navy-800'
                  }`}
                >
                  <ThumbsDown size={14} /> Not helpful
                </button>
              </div>
            </div>
            {rating && (
              <div className="px-4 pb-4 space-y-2.5 animate-fadein">
                <textarea
                  value={correction}
                  onChange={(e) => onCorrection(e.target.value)}
                  rows={2}
                  placeholder={rating === 'down' ? 'Describe the correction (optional)' : 'Anything to add? (optional)'}
                  className="w-full rounded-lg border border-navy-200/80 dark:border-navy-700 bg-navy-50 dark:bg-navy-950/60 px-3 py-2 text-[12.5px] text-navy-800 dark:text-navy-100 placeholder:text-navy-400 outline-none focus:border-brand-400 dark:focus:border-brand-500/60 resize-none transition-colors"
                />
                <button
                  onClick={onSubmit}
                  disabled={submitting}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-brand-500 to-brand-600 px-4 py-2.5 text-[13px] font-semibold text-white shadow-glow disabled:opacity-60 hover:from-brand-600 hover:to-brand-700 transition-colors"
                >
                  {submitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  {submitting ? 'Submitting…' : 'Submit feedback'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Shared state machine for one pending feedback prompt. Returns [popup, api]
// where api = { open, rate, comment, submit, close }.
export function useFeedbackPopup({ submit }) {
  const [popup, setPopup] = useState(null);

  const close = () => setPopup(null);
  const open = (payload) => setPopup({ rating: null, correction: '', ...payload });

  const submitCurrent = async () => {
    if (!popup || !popup.rating || popup.submitting) return;
    setPopup((p) => ({ ...p, submitting: true }));
    const { messageKey, rating, correction, question, ...rest } = popup;
    await submit({ requestId: messageKey, rating, correction, question, ...rest });
    setPopup((p) => ({ ...p, submitting: false, thanks: true }));
    setTimeout(() => setPopup(null), 1600);
  };

  return [
    popup,
    {
      open,
      close,
      rate: (rating) => setPopup((p) => (p ? { ...p, rating } : p)),
      correction: (correction) => setPopup((p) => (p ? { ...p, correction } : p)),
      submit: submitCurrent,
    },
  ];
}
