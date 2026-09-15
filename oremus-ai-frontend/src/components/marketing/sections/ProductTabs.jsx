'use client';

import { useEffect, useRef, useState } from 'react';
import { LayoutDashboard, Shield, Users, Sparkles } from 'lucide-react';
import Container from '../Container.jsx';
import Reveal from '../Reveal.jsx';
import SectionHeader from '../SectionHeader.jsx';
import DashboardMock from '../mocks/DashboardMock.jsx';
import AdminMock from '../mocks/AdminMock.jsx';
import ClientsMock from '../mocks/ClientsMock.jsx';
import AiChatMock from '../mocks/AiChatMock.jsx';

const TABS = [
  { id: 'dashboard', icon: LayoutDashboard, label: 'Dashboard', desc: 'Live KPIs, trends, and AI insights in one bento view.', Mock: DashboardMock },
  { id: 'admin', icon: Shield, label: 'Admin Console', desc: 'Manage users, roles, and workspace health with RBAC.', Mock: AdminMock },
  { id: 'clients', icon: Users, label: 'Clients', desc: 'Onboard clients and connect Zoho, QuickBooks & Xero.', Mock: ClientsMock },
  { id: 'ai', icon: Sparkles, label: 'AI Assistant', desc: 'Ask questions in plain English and get instant answers.', Mock: AiChatMock },
];

const ROTATE_MS = 6000;

export default function ProductTabs({ id = 'platform' }) {
  const [active, setActive] = useState(0);
  const timer = useRef(null);

  // Always auto-rotate. Re-running on `active` change means a manual click also
  // resets the interval, giving a fresh full cycle before the next auto-advance.
  useEffect(() => {
    timer.current = setTimeout(() => setActive((a) => (a + 1) % TABS.length), ROTATE_MS);
    return () => clearTimeout(timer.current);
  }, [active]);

  const ActiveMock = TABS[active].Mock;

  return (
    <section id={id} className="relative overflow-hidden py-20 sm:py-24 lg:py-28">
      <div className="dot-grid pointer-events-none absolute inset-0 -z-10 opacity-50" />
      <Container>
        <SectionHeader
          eyebrow="The platform"
          title="One workspace, every view your team needs"
          subtitle="From executive dashboards to admin controls and an AI assistant — explore the product below."
        />

        <Reveal className="mt-12">
          {/* Tab bar */}
          <div
            className="flex flex-wrap justify-center gap-2"
            role="tablist"
            aria-label="Product views"
          >
            {TABS.map((t, i) => {
              const on = i === active;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setActive(i)}
                  className={`group relative flex items-center gap-2 overflow-hidden rounded-xl border px-4 py-2.5 text-sm font-semibold transition-all ${
                    on
                      ? 'border-brand-300 bg-brand-50 text-brand-700 shadow-soft'
                      : 'border-navy-100 bg-white text-navy-600 hover:border-navy-200 hover:text-navy-900'
                  }`}
                >
                  <t.icon size={16} className={on ? 'text-brand-600' : 'text-navy-400'} />
                  {t.label}
                  {on && (
                    <span key={active} className="absolute bottom-0 left-0 h-0.5 bg-brand-500" style={{ animation: `tabprog ${ROTATE_MS}ms linear` }} />
                  )}
                </button>
              );
            })}
          </div>

          {/* Active view caption */}
          <p className="mx-auto mt-5 max-w-xl text-center text-sm text-navy-500">{TABS[active].desc}</p>

          {/* Panel */}
          <div className="relative mt-8">
            <div className="absolute -inset-4 -z-10 rounded-3xl bg-gradient-to-tr from-brand-100/50 to-cyan-100/50 blur-2xl dark:from-brand-500/15 dark:to-cyan-500/15 dark:blur-xl" />
            <div key={active} className="animate-slide-up">
              {TABS[active].id === 'ai' ? (
                <div className="grid items-center gap-8 lg:grid-cols-2">
                  <div className="order-2 lg:order-1">
                    <h3 className="text-2xl font-bold tracking-tight text-navy-900">Ask Oremus AI anything</h3>
                    <p className="mt-3 text-sm leading-relaxed text-navy-500">
                      Type a question in plain English — “Why did expenses jump?”, “Is my cash flow healthy?” —
                      and get an instant, data-grounded answer with the chart to back it up.
                    </p>
                    <ul className="mt-5 space-y-2.5 text-sm text-navy-700">
                      {['Natural-language financial Q&A', 'Answers grounded in your live data', 'Inline charts and anomaly flags'].map((p) => (
                        <li key={p} className="flex items-center gap-2.5">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-50 text-brand-600"><Sparkles size={11} /></span>
                          {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="order-1 lg:order-2"><ActiveMock /></div>
                </div>
              ) : (
                <ActiveMock />
              )}
            </div>
          </div>
        </Reveal>
      </Container>

      <style>{`@keyframes tabprog { from { width: 0 } to { width: 100% } }`}</style>
    </section>
  );
}
