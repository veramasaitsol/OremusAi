import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, ChevronRight, ArrowLeft, AlertTriangle, CheckCircle2 } from 'lucide-react';
import Logo from '../components/ui/Logo.jsx';
import { forgotPasswordRequest } from '../features/auth/authAPI.js';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await forgotPasswordRequest({ email });
      setSent(true);
      if (res?.resetLink) setDevLink(res.resetLink);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-6 bg-gradient-to-br from-[#0B1B3F] via-[#0F172A] to-[#082636]">
      <div className="w-full max-w-[440px] glass rounded-2xl p-8 sm:p-10 shadow-lift">
        <div className="flex items-center gap-2.5 mb-7">
          <Logo size={34} />
          <div>
            <div className="font-bold text-[17px] tracking-tight text-navy-900 dark:text-white leading-tight">Oremus</div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-navy-500">Finance · AI</div>
          </div>
        </div>

        {sent ? (
          <>
            <div className="mb-6">
              <div className="w-11 h-11 rounded-full bg-emerald-50 dark:bg-emerald-500/15 grid place-items-center mb-4">
                <CheckCircle2 size={22} className="text-emerald-600 dark:text-emerald-400" />
              </div>
              <h2 className="text-[24px] font-bold tracking-tight text-navy-900 dark:text-white">Check your email</h2>
              <p className="text-[13.5px] text-navy-500 dark:text-navy-400 mt-1.5">
                If an account exists for <span className="font-semibold text-navy-700 dark:text-navy-200">{email}</span>,
                we've sent a link to reset your password.
              </p>
            </div>
            {devLink && (
              <div className="mb-6 px-3 py-2.5 rounded-lg bg-brand-50 dark:bg-brand-500/15 border border-brand-200 dark:border-brand-500/30 text-[12px] text-navy-700 dark:text-navy-200">
                <div className="font-semibold mb-1">Dev mode — reset link:</div>
                <Link to={devLink.replace(/^https?:\/\/[^/]+/, '')} className="text-brand-600 dark:text-brand-300 break-all hover:underline">
                  {devLink}
                </Link>
              </div>
            )}
            <Link
              to="/login"
              className="w-full h-11 rounded-lg bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[13.5px] shadow-glow transition flex items-center justify-center gap-2"
            >
              <ArrowLeft size={14} /> Back to sign in
            </Link>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="mb-6">
              <h2 className="text-[24px] font-bold tracking-tight text-navy-900 dark:text-white">Forgot password?</h2>
              <p className="text-[13.5px] text-navy-500 dark:text-navy-400 mt-1.5">
                Enter your work email and we'll send you a link to reset your password.
              </p>
            </div>

            <label className="block text-[12px] font-semibold text-navy-700 dark:text-navy-200 mb-1.5">Work email</label>
            <div className="relative">
              <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-navy-400" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="w-full h-11 pl-9 pr-3 rounded-lg bg-white dark:bg-navy-900/60 border border-navy-200 dark:border-navy-700 focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20 text-[13.5px] outline-none text-navy-900 dark:text-white placeholder:text-navy-400"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-5 w-full h-11 rounded-lg bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[13.5px] shadow-glow transition active:scale-[0.99] flex items-center justify-center gap-2 disabled:opacity-80"
            >
              {loading ? (
                <>
                  <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="white" strokeOpacity="0.3" strokeWidth="3" />
                    <path d="M22 12a10 10 0 0 1-10 10" stroke="white" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                  Sending…
                </>
              ) : (
                <>Send reset link <ChevronRight size={14} /></>
              )}
            </button>

            <Link to="/login" className="mt-5 flex items-center justify-center gap-1.5 text-[12.5px] font-semibold text-navy-500 hover:text-brand-600">
              <ArrowLeft size={13} /> Back to sign in
            </Link>

            {error && (
              <div className="mt-4 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 text-[12px] text-red-700 dark:text-red-300 flex items-start gap-2">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
