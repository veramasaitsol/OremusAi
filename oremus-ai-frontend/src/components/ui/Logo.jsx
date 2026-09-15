export default function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <defs>
        <linearGradient id="oremus-logo-grad" x1="0" y1="0" x2="32" y2="32">
          <stop offset="0%" stopColor="#2563EB" />
          <stop offset="100%" stopColor="#06B6D4" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#oremus-logo-grad)" />
      <path d="M10 21V13a6 6 0 0 1 12 0v8" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="16" cy="13" r="2.2" fill="white" />
    </svg>
  );
}
