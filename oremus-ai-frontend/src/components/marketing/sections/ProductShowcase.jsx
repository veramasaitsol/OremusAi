import { Link } from 'react-router-dom';
import { Check, ArrowRight } from 'lucide-react';
import Container from '../Container.jsx';
import Reveal from '../Reveal.jsx';

const POINTS = [
  'Real-time KPIs for revenue, expenses, cash flow, and profitability',
  'Drill from any chart straight into the underlying transactions',
  'Financial ratios computed and trended automatically',
  'Role-scoped views so every team sees exactly what they should',
];

// Alternating "product overview" band — copy on one side, visual on the other.
export default function ProductShowcase({
  id = 'product',
  eyebrow = 'Product overview',
  title = 'See your whole financial picture in one place',
  reverse = false,
}) {
  return (
    <section id={id} className="py-20 sm:py-24 lg:py-28">
      <Container>
        <div className={`grid items-center gap-12 lg:grid-cols-2 lg:gap-16 ${reverse ? 'lg:[&>*:first-child]:order-2' : ''}`}>
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-100 bg-brand-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-brand-600">
              {eyebrow}
            </span>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-navy-900 sm:text-4xl">{title}</h2>
            <p className="mt-4 text-base leading-relaxed text-navy-500">
              Oremus normalizes data from every connected accounting system into a single, consistent model —
              so the numbers always agree and you never reconcile by hand again.
            </p>
            <ul className="mt-6 space-y-3">
              {POINTS.map((p) => (
                <li key={p} className="flex items-start gap-3 text-sm text-navy-700">
                  <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-brand-50">
                    <Check size={13} className="text-brand-600" />
                  </span>
                  {p}
                </li>
              ))}
            </ul>
            <Link
              to="/features"
              className="group mt-7 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:text-brand-700"
            >
              Explore the product
              <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Reveal>

          <Reveal delay={120}>
            <div className="relative">
              <div className="absolute -inset-4 -z-10 rounded-3xl bg-gradient-to-tr from-brand-100/60 to-cyan-100/60 blur-2xl dark:from-brand-500/15 dark:to-cyan-500/15 dark:blur-xl" />
              <div className="browser-frame">
                <div className="border-b border-navy-100 bg-navy-50/70 px-4 py-2.5 text-xs font-medium text-navy-400">
                  Financial ratios
                </div>
                <div className="space-y-3 bg-white p-5">
                  {[
                    { l: 'Current ratio', v: '2.41', t: 'Healthy', good: true },
                    { l: 'Quick ratio', v: '1.86', t: 'Healthy', good: true },
                    { l: 'Debt-to-equity', v: '0.42', t: 'Low risk', good: true },
                    { l: 'Gross margin', v: '63.2%', t: '+4.1% YoY', good: true },
                    { l: 'Operating margin', v: '21.7%', t: '+2.0% YoY', good: true },
                  ].map((r) => (
                    <div key={r.l} className="flex items-center justify-between rounded-lg border border-navy-100 px-4 py-3">
                      <span className="text-sm text-navy-600">{r.l}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-bold text-navy-900">{r.v}</span>
                        <span className="rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-semibold text-green-600">{r.t}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}
