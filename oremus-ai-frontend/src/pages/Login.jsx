import { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate, Navigate, Link } from 'react-router-dom';
import { toast } from '../utils/toastStore.js';
import {
  Mail, Lock, Eye, EyeOff, Sun, Moon, Check, ChevronRight, AlertTriangle,
} from 'lucide-react';
import Logo from '../components/ui/Logo.jsx';
import Badge from '../components/ui/Badge.jsx';
import { login, selectIsAuthed } from '../features/auth/authSlice.js';
import { toggleTheme } from '../features/ui/uiSlice.js';
import { cn } from '../utils/classNames.js';

const STATS = [
  { v: '2.4M+', l: 'Transactions analyzed' },
  { v: '97.8%', l: 'Anomaly precision' },
  { v: '14×', l: 'Faster month-end close' },
];

const AVATARS = [12, 33, 47, 5];

function GoogleIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.75h3.57c2.08-1.92 3.28-4.74 3.28-8.07Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.67l-3.57-2.75c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.11A6.59 6.59 0 0 1 5.5 12c0-.73.13-1.45.34-2.11V7.05H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.95l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" />
    </svg>
  );
}

function MicrosoftIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#F25022" d="M2 2h9.5v9.5H2z" />
      <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
      <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" />
      <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
    </svg>
  );
}

export default function Login() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const isAuthed = useSelector(selectIsAuthed);
  const theme = useSelector((s) => s.ui.theme);
  const dark = theme === 'dark';

  const [email, setEmail] = useState('');//admin@oremus.com
  const [password, setPassword] = useState('');//admin123
  const [showPwd, setShowPwd] = useState(false);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Show a "session expired" notice when redirected here by the 401 handler,
  // then strip the flag from the URL so a refresh doesn't repeat it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('expired') === '1') {
      toast.error('Your session has expired. Please log in again.');
      params.delete('expired');
      const qs = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
  }, []);

  if (isAuthed) return <Navigate to="/dashboard" replace />;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const res = await dispatch(login({ email, password }));
    setLoading(false);
    if (res.meta.requestStatus === 'fulfilled') {
      navigate('/dashboard');
    } else {
      setError('Incorrect email or password. Try the demo credentials below.');
    }
  };

  return (
    <div className="min-h-screen w-full flex bg-navy-50 dark:bg-navy-950">
      {/* LEFT — branding panel */}
      <div className="hidden lg:flex w-[54%] relative overflow-hidden text-white bg-gradient-to-br from-[#0B1B3F] via-[#0F172A] to-[#082636] pointer-events-none select-none">
        <div
          className="absolute -top-20 -left-20 w-[420px] h-[420px] rounded-full blob"
          style={{ background: 'radial-gradient(closest-side, rgba(37,99,235,0.55), transparent)' }}
        />
        <div
          className="absolute -bottom-32 -right-10 w-[520px] h-[520px] rounded-full blob"
          style={{ background: 'radial-gradient(closest-side, rgba(6,182,212,0.42), transparent)', animationDelay: '4s' }}
        />
        <div className="absolute inset-0 grid-bg opacity-50" />

        {/* Decorative chart pattern */}
        <svg
          className="absolute bottom-0 left-0 right-0 w-full h-2/5 opacity-[0.35]"
          viewBox="0 0 800 300"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="loginChart1" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#06B6D4" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#06B6D4" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="loginChart2" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2563EB" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#2563EB" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d="M0,220 C80,210 140,170 220,160 C300,150 360,180 440,150 C520,120 580,80 660,90 C730,98 770,70 800,60 L800,300 L0,300 Z" fill="url(#loginChart2)" />
          <path d="M0,220 C80,210 140,170 220,160 C300,150 360,180 440,150 C520,120 580,80 660,90 C730,98 770,70 800,60" stroke="#2563EB" strokeWidth="2" fill="none" />
          <path d="M0,250 C80,240 140,230 220,210 C300,195 360,220 440,200 C520,180 580,160 660,150 C730,145 770,135 800,130 L800,300 L0,300 Z" fill="url(#loginChart1)" />
          <path d="M0,250 C80,240 140,230 220,210 C300,195 360,220 440,200 C520,180 580,160 660,150 C730,145 770,135 800,130" stroke="#06B6D4" strokeWidth="2" fill="none" />
        </svg>

        <div className="relative z-10 flex flex-col p-12 xl:p-16 w-full">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <Logo size={36} />
            <div>
              <div className="text-[18px] font-bold tracking-tight">Oremus</div>
              <div className="text-[10.5px] uppercase tracking-[0.18em] text-cyan-300/80">Finance · AI</div>
            </div>
          </div>

          {/* Hero */}
          <div className="mt-auto max-w-[520px]">
            <Badge tone="cyan" dot className="!bg-cyan-500/15 !text-cyan-300 mb-5">
              <span className="pulse-dot">●</span> AI engine online
            </Badge>
            <h1 className="text-[42px] xl:text-[48px] font-bold leading-[1.05] tracking-tight">
              AI-Powered Financial<br />
              <span className="bg-gradient-to-r from-cyan-300 to-brand-300 bg-clip-text text-transparent">
                Reporting Platform.
              </span>
            </h1>
            <p className="mt-5 text-[15px] text-white/70 leading-relaxed">
              Close books faster, detect anomalies before they hit the P&amp;L, and let Oremus
              turn raw ledgers into board-ready insights — in seconds.
            </p>

            {/* Stat cards */}
            <div className="mt-8 grid grid-cols-3 gap-3 max-w-[480px]">
              {STATS.map((s) => (
                <div
                  key={s.l}
                  className="rounded-xl bg-white/[0.06] border border-white/10 backdrop-blur-sm px-3 py-3"
                >
                  <div className="text-[20px] font-bold tracking-tight">{s.v}</div>
                  <div className="text-[10.5px] text-white/60 mt-0.5">{s.l}</div>
                </div>
              ))}
            </div>

            {/* Mini testimonial */}
            <div className="mt-8 flex items-center gap-3 text-[12.5px] text-white/70">
              <div className="flex -space-x-2">
                {AVATARS.map((n) => (
                  <img
                    key={n}
                    src={`https://i.pravatar.cc/40?img=${n}`}
                    alt=""
                    className="w-7 h-7 rounded-full border-2 border-[#0F172A] object-cover"
                  />
                ))}
              </div>
              Trusted by 1,200+ finance teams at companies like Linear, Vercel, Ramp.
            </div>
          </div>

          <div className="mt-12 text-[11.5px] text-white/40 flex items-center gap-4">
            <span>© 2026 Oremus, Inc.</span>
            <span className="w-1 h-1 rounded-full bg-white/20" />
            <span>SOC 2 Type II · ISO 27001</span>
          </div>
        </div>
      </div>

      {/* RIGHT — form */}
      <div className="flex-1 relative flex items-center justify-center p-6 lg:p-12">
        {/* mobile gradient bg */}
        <div className="lg:hidden absolute inset-0 bg-gradient-to-br from-[#0B1B3F] via-[#0F172A] to-[#082636] -z-10" />

        <button
          onClick={() => dispatch(toggleTheme())}
          className="absolute top-6 right-6 h-9 w-9 rounded-lg border border-navy-200 dark:border-navy-700 bg-white dark:bg-navy-800 text-navy-500 grid place-items-center hover:bg-navy-50 dark:hover:bg-navy-700"
          aria-label="Toggle theme"
        >
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        <form onSubmit={handleSubmit} className="w-full max-w-[440px] glass rounded-2xl p-8 sm:p-10 shadow-lift">
          <div className="lg:hidden flex items-center gap-2.5 mb-7">
            <Logo size={34} />
            <div>
              <div className="font-bold text-[17px] tracking-tight text-navy-900 dark:text-white leading-tight">Oremus</div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-navy-500">Finance · AI</div>
            </div>
          </div>

          <div className="mb-6">
            <h2 className="text-[26px] font-bold tracking-tight text-navy-900 dark:text-white">
              Welcome back
            </h2>
            <p className="text-[13.5px] text-navy-500 dark:text-navy-400 mt-1.5">
              Sign in to continue to your finance workspace.
            </p>
          </div>

          {/* SSO */}
          {/* <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              className="h-10 rounded-lg border border-navy-200 dark:border-navy-700 bg-white dark:bg-navy-900/60 hover:bg-navy-50 dark:hover:bg-navy-800 text-[12.5px] font-semibold text-navy-700 dark:text-navy-200 flex items-center justify-center gap-2 transition"
            >
              <GoogleIcon size={15} /> Google
            </button>
            <button
              type="button"
              className="h-10 rounded-lg border border-navy-200 dark:border-navy-700 bg-white dark:bg-navy-900/60 hover:bg-navy-50 dark:hover:bg-navy-800 text-[12.5px] font-semibold text-navy-700 dark:text-navy-200 flex items-center justify-center gap-2 transition"
            >
              <MicrosoftIcon size={14} /> Microsoft
            </button>
          </div> */}

          {/* <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-navy-200/70 dark:border-navy-700/60" />
            </div>
            <div className="relative flex justify-center">
              <span className="px-3 text-[10.5px] uppercase tracking-[0.18em] font-semibold text-navy-400 bg-white/95 dark:bg-transparent">
                or sign in with email
              </span>
            </div>
          </div> */}

          {/* Email */}
          <label className="block text-[12px] font-semibold text-navy-700 dark:text-navy-200 mb-1.5">
            Work email
          </label>
          <div className="relative">
            <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-navy-400" />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className="w-full h-11 pl-9 pr-3 rounded-lg bg-white dark:bg-navy-900/60 border border-navy-200 dark:border-navy-700 focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20 text-[13.5px] outline-none text-navy-900 dark:text-white placeholder:text-navy-400"
            />
          </div>

          {/* Password */}
          <div className="flex items-center justify-between mt-4 mb-1.5">
            <label className="text-[12px] font-semibold text-navy-700 dark:text-navy-200">Password</label>
            <Link className="text-[11.5px] font-medium text-brand-600 hover:underline" to="/forgot-password">Forgot password?</Link>
          </div>
          <div className="relative">
            <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-navy-400" />
            <input
              type={showPwd ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
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

          {/* Remember */}
          <label className="flex items-center gap-2 mt-4 text-[12.5px] text-navy-600 dark:text-navy-300 cursor-pointer select-none">
            <button
              type="button"
              onClick={() => setRemember((r) => !r)}
              className={cn(
                'w-4 h-4 rounded border flex items-center justify-center transition',
                remember
                  ? 'bg-brand-500 border-brand-500'
                  : 'bg-white dark:bg-navy-900 border-navy-300 dark:border-navy-600'
              )}
              aria-pressed={remember}
            >
              {remember && <Check size={11} className="text-white" />}
            </button>
            Keep me signed in for 30 days
          </label>

          {/* Submit */}
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
                Signing in…
              </>
            ) : (
              <>
                Sign in <ChevronRight size={14} />
              </>
            )}
          </button>

          <p className="text-[12px] text-center text-navy-500 mt-5">
            New to Oremus?{' '}
            <a className="font-semibold text-brand-600 hover:underline" href="#">
              Request access →
            </a>
          </p>

          {error && (
            <div className="mt-4 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 text-[12px] text-red-700 dark:text-red-300 flex items-start gap-2">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
