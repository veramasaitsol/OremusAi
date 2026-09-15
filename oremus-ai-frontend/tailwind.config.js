/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      colors: {
        brand: {
          50: '#EFF4FF', 100: '#DBE6FF', 200: '#BFD1FF', 300: '#94B0FF',
          400: '#6386FE', 500: '#2563EB', 600: '#1D4ED8', 700: '#1E40AF',
          800: '#1E3A8A', 900: '#172554',
        },
        navy: {
          50: '#F8FAFC', 100: '#F1F5F9', 200: '#E2E8F0', 300: '#CBD5E1',
          400: '#94A3B8', 500: '#64748B', 600: '#475569', 700: '#334155',
          800: '#1E293B', 900: '#0F172A', 950: '#020617',
        },
        cyan: { 50: '#ECFEFF', 100: '#CFFAFE', 500: '#06B6D4', 600: '#0891B2' },
      },
      boxShadow: {
        soft: '0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.06)',
        card: '0 1px 2px rgba(15,23,42,0.04), 0 4px 16px -4px rgba(15,23,42,0.08)',
        lift: '0 1px 2px rgba(15,23,42,0.06), 0 12px 32px -8px rgba(15,23,42,0.12)',
        glow: '0 0 0 1px rgba(37,99,235,0.12), 0 8px 24px -8px rgba(37,99,235,0.35)',
      },
      keyframes: {
        fadein:    { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
        slideUp:   {
          '0%':   { opacity: 0, transform: 'translateY(16px) scale(0.97)' },
          '100%': { opacity: 1, transform: 'translateY(0)     scale(1)'    },
        },
        slideLeft: {
          '0%':   { opacity: 0, transform: 'translateX(32px)' },
          '100%': { opacity: 1, transform: 'translateX(0)'    },
        },
        slideInRight: {
          '0%':   { opacity: 0, transform: 'translateX(100%)' },
          '100%': { opacity: 1, transform: 'translateX(0)' },
        },
        pulseDot: { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.4 } },
      },
      animation: {
        fadein:          'fadein .18s ease-out',
        'slide-up':      'slideUp .22s cubic-bezier(0.16,1,0.3,1)',
        'slide-left':    'slideLeft .28s cubic-bezier(0.16,1,0.3,1)',
        'slidein-right': 'slideInRight .3s cubic-bezier(0.16,1,0.3,1)',
        'pulse-dot':     'pulseDot 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
