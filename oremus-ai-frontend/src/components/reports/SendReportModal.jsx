// QuickBooks-Online–style "Send <report>" modal. There is no server-side
// mailer in this app, so "Send email" works client-side: it generates the
// report file in the chosen format (reusing the export utilities) and opens the
// user's email client with To / Cc / Subject / Message pre-filled so they can
// attach the just-downloaded file. Faithful to the QBO email dialog.

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { exportReportCSV, exportReportXLSX, exportReportPDF } from '../../utils/exportReport.js';
import { cn } from '../../utils/classNames.js';

const QB_GREEN = '#2CA01C';

const FORMATS = [
  ['excel', 'Excel', 'xlsx'],
  ['csv',   'CSV',   'csv'],
  ['pdf',   'PDF',   'pdf'],
];

const inputCls =
  'w-full h-11 px-3 rounded-md bg-white border border-navy-300 text-[14px] text-navy-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 placeholder:text-navy-400';

const rowLabelCls = 'text-[14px] font-semibold text-navy-700 pt-3';

// At least one address that looks like an email.
function hasValidEmail(str) {
  return String(str || '')
    .split(',')
    .map((s) => s.trim())
    .some((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

export default function SendReportModal({ open, onClose, reportName, data, meta = {} }) {
  const company = meta.company || 'Oremus';
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(reportName || 'Report');
  const [format, setFormat] = useState('excel');
  const [message, setMessage] = useState('');
  const [fileName, setFileName] = useState(reportName || 'Report');
  const [error, setError] = useState('');

  // Reset the form each time the modal opens (or the report changes).
  useEffect(() => {
    if (!open) return;
    setSubject(reportName || 'Report');
    setFileName(reportName || 'Report');
    setMessage(
      `Hello,\n\nAttached is the '${reportName}' report for ${company}.\n\nRegards,\n${company}`,
    );
    setTo('');
    setCc('');
    setFormat('excel');
    setError('');
  }, [open, reportName, company]);

  if (!open) return null;

  const ext = FORMATS.find(([id]) => id === format)?.[2] || 'xlsx';

  const handleSend = () => {
    if (!hasValidEmail(to)) {
      setError('Enter at least one valid recipient email address.');
      return;
    }
    // 1. Download the report in the chosen format so it can be attached.
    if (format === 'csv') exportReportCSV(data, fileName);
    else if (format === 'pdf') exportReportPDF(data, fileName, meta);
    else exportReportXLSX(data, fileName);

    // 2. Open the user's mail client with everything pre-filled.
    const q = [];
    if (cc.trim()) q.push(`cc=${encodeURIComponent(cc.trim())}`);
    q.push(`subject=${encodeURIComponent(subject)}`);
    q.push(`body=${encodeURIComponent(message)}`);
    window.location.href = `mailto:${encodeURIComponent(to.trim())}?${q.join('&')}`;

    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-navy-950/40 px-4 py-8"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-[680px] rounded-xl bg-white shadow-2xl">
        <header className="relative px-6 pt-6 pb-4">
          <h2 className="text-center text-[24px] font-bold text-navy-900">Send {reportName}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-5 top-5 h-8 w-8 grid place-items-center rounded-md text-navy-400 hover:bg-navy-100"
          >
            <X size={20} />
          </button>
        </header>

        <div className="px-6 pb-6 space-y-3">
          <div className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-2 items-start">
            <span className={rowLabelCls}>To</span>
            <input
              className={inputCls}
              value={to}
              onChange={(e) => { setTo(e.target.value); setError(''); }}
              placeholder="Separate multiple emails with commas"
            />

            <span className={rowLabelCls}>Cc</span>
            <input
              className={inputCls}
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="Separate multiple emails with commas"
            />

            <span className={rowLabelCls}>Subject</span>
            <input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} />

            <span className={rowLabelCls}>Format</span>
            <div className="flex items-center gap-6 pt-3">
              {FORMATS.map(([id, label]) => (
                <label key={id} className="inline-flex items-center gap-2 cursor-pointer text-[14px] text-navy-700">
                  <input
                    type="radio"
                    name="send-format"
                    checked={format === id}
                    onChange={() => setFormat(id)}
                    className="accent-emerald-600 h-4 w-4"
                  />
                  {label}
                </label>
              ))}
            </div>

            <span className={rowLabelCls}>Message</span>
            <textarea
              rows={6}
              className={cn(inputCls, 'h-auto py-2.5 resize-y leading-relaxed')}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />

            <span className={rowLabelCls}>FileName</span>
            <div className="flex items-center gap-2 pt-0">
              <input className={inputCls} value={fileName} onChange={(e) => setFileName(e.target.value)} />
              <span className="text-[14px] font-semibold text-navy-500 shrink-0">.{ext}</span>
            </div>
          </div>

          {error && (
            <p className="text-[12.5px] font-semibold text-rose-600">{error}</p>
          )}
          <p className="text-[11.5px] text-navy-400">
            The report downloads in your chosen format and your email app opens with this message ready — attach the downloaded file before sending.
          </p>

          <div className="flex items-center justify-between pt-3">
            <button
              type="button"
              onClick={onClose}
              className="h-11 px-6 rounded-md border-2 border-emerald-600 text-emerald-700 text-[14px] font-semibold hover:bg-emerald-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSend}
              className="h-11 px-6 rounded-md text-white text-[14px] font-semibold shadow-soft hover:opacity-95"
              style={{ background: QB_GREEN }}
            >
              Send email
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
