import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles, ShieldCheck } from 'lucide-react';
import Container from '../Container.jsx';
import Reveal from '../Reveal.jsx';
import ProductMock from './ProductMock.jsx';
import { INTEGRATIONS } from '../data.js';

export default function Hero() {
  return (
    <section className="relative overflow-hidden pt-28 sm:pt-32 lg:pt-36">
      <div className="aurora pointer-events-none absolute inset-0 -z-10" />
      <div className="dot-grid pointer-events-none absolute inset-0 -z-10 opacity-60" />

      <Container>
        <div className="mx-auto max-w-3xl text-center">
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-100 bg-white/80 px-4 py-1.5 text-xs font-semibold text-brand-600 shadow-soft backdrop-blur">
              <Sparkles size={14} /> AI-powered financial analytics
            </span>
          </Reveal>
          <Reveal delay={80}>
            <h1 className="mt-6 text-4xl font-extrabold leading-[1.08] tracking-tight text-navy-900 sm:text-5xl lg:text-6xl">
              The financial analytics platform {' '}
              <span className="text-gradient-anim">modern finance teams</span>
            </h1>
          </Reveal>
          <Reveal delay={160}>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-navy-500">
              Unify Zoho Books, QuickBooks, and Xero into one secure workspace. Real-time dashboards,
              normalized transactions, and financial ratios — so you close faster and decide with confidence.
            </p>
          </Reveal>
          <Reveal delay={240}>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                to="/contact"
                className="group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-500 px-6 py-3.5 text-sm font-semibold text-white shadow-glow transition-all hover:bg-brand-600 sm:w-auto"
              >
                Get a demo
                <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                to="/login"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-navy-200 bg-white px-6 py-3.5 text-sm font-semibold text-navy-800 transition-all hover:bg-navy-50 sm:w-auto"
              >
                Sign in
              </Link>
            </div>
          </Reveal>
          <Reveal delay={300}>
            <p className="mt-5 inline-flex items-center gap-1.5 text-xs text-navy-400">
              <ShieldCheck size={14} className="text-brand-400" /> No credit card required · Free trial · Cancel anytime
            </p>
          </Reveal>
        </div>

        <Reveal delay={120} className="mt-14 sm:mt-16">
          <div className="animate-floaty">
            <ProductMock />
          </div>
        </Reveal>

        <Reveal delay={120} className="mt-12">
          <p className="text-center text-xs font-semibold uppercase tracking-wider text-navy-400">
            Connects with the tools you already use
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
            {INTEGRATIONS.map((i) => (
              <span key={i} className="text-base font-semibold text-navy-400 transition-colors hover:text-navy-700">
                {i}
              </span>
            ))}
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
