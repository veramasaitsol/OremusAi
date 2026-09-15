import { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Lock, Eye, EyeOff, ChevronRight, ArrowLeft, AlertTriangle, CheckCircle2 } from 'lucide-react';
import Logo from '../components/ui/Logo.jsx';
import { resetPasswordRequest } from '../features/auth/authAPI.js';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setLoading(true);
    try {
      await resetPasswordRequest({ token, password });
      setDone(true);
      setTimeout(() => navigate('/login'), 2500);
    } catch (err) {
      setError(err?.response?.data?.error || 'This reset link is invalid or has expired.');
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

        {done ? (
          <>
            <div className="w-11 h-11 rounded-full bg-emerald-50 dark:bg-emerald-500/15 grid place-items-center mb-4">
              <CheckCircle2 size={22} className="text-emerald-600 dark:text-emerald-400" />
            </div>
            <h2 className="text-[24px] font-bold tracking-tight text-navy-900 dark:text-white">Password updated</h2>
            <p className="text-[13.5px] text-navy-500 dark:text-navy-400 mt-1.5 mb-6">
              Your password has been changed. Redirecting you to sign in…
            </p>
            <Link
              to="/login"
              className="w-full h-11 rounded-lg bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[13.5px] shadow-glow transition flex items-center justify-center gap-2"
            >
              <ArrowLeft size={14} /> Back to sign in
            </Link>
          </>
        ) : !token ? (
          <>
            <h2 className="text-[24px] font-bold tracking-tight text-navy-900 dark:text-white">Invalid link</h2>
            <p className="text-[13.5px] text-navy-500 dark:text-navy-400 mt-1.5 mb-6">
              This password reset link is missing its token. Please request a new one.
            </p>
            <Link
              to="/forgot-password"
              className="w-full h-11 rounded-lg bg-brand-500 hover:bg-brand-600 text-white font-semibold text-[13.5px] shadow-glow transition flex items-center justify-center gap-2"
            >
              Request a new link <ChevronRight size={14} />
            </Link>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="mb-6">
              <h2 className="text-[24px] font-bold tracking-tight text-navy-900 dark:text-white">Set a new password</h2>
              <p className="text-[13.5px] text-navy-500 dark:text-navy-400 mt-1.5">
                Choose a strong password you haven't used before.
              </p>
            </div>

            <label className="block text-[12px] font-semibold text-navy-700 dark:text-navy-200 mb-1.5">New password</label>
            <div className="relative">
              <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-navy-400" />
              <input
                type={showPwd ? 'text' : 'password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full h-11 pl-9 pr-10 rounded-lg bg-white dark:bg-navy-900/60 border border-navy-200 dark:border-navy-700 focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20 text-[13.5px] outline-none text-navy-900 dark:text-white"
              />
              <button
                type="button"
                onClick={() => setShowPwd((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 grid place-items-center text-navy-400 hover:text-navy-700"
                aria-label="Toggle password visibility"
              >
                {showPwd ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>

            <label className="block text-[12px] font-semibold text-navy-700 dark:text-navy-200 mb-1.5 mt-4">Confirm password</label>
            <div className="relative">
              <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-navy-400" />
              <input
                type={showPwd ? 'text' : 'password'}
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                className="w-full h-11 pl-9 pr-3 rounded-lg bg-white dark:bg-navy-900/60 border border-navy-200 dark:border-navy-700 focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20 text-[13.5px] outline-none text-navy-900 dark:text-white"
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
                  Updating…
                </>
              ) : (
                <>Update password <ChevronRight size={14} /></>
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
