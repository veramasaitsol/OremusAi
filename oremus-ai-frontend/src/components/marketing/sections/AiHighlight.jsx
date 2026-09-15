import { Sparkles, MessageSquareText, Wand2, ShieldCheck } from 'lucide-react';
import Container from '../Container.jsx';
import Reveal from '../Reveal.jsx';
import AiChatMock from '../mocks/AiChatMock.jsx';

const POINTS = [
  { icon: MessageSquareText, title: 'Plain-English answers', desc: 'Ask about revenue, runway, or anomalies — no SQL, no report builder.' },
  { icon: Wand2, title: 'Grounded in your data', desc: 'Every answer is computed live from your connected accounting systems.' },
  { icon: ShieldCheck, title: 'Private & role-aware', desc: 'The assistant only ever sees data the signed-in user is allowed to see.' },
];

export default function AiHighlight({ id = 'ai' }) {
  return (
    <section id={id} className="relative overflow-hidden bg-navy-950 py-20 text-white sm:py-24 lg:py-28">
      <div className="conic-ring pointer-events-none absolute inset-0 -z-10 opacity-40" />
      <div className="pointer-events-none absolute left-1/2 top-0 -z-10 h-72 w-72 -translate-x-1/2 rounded-full bg-brand-500/30 blur-[120px]" />
      <Container>
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-brand-200">
              <Sparkles size={14} /> Oremus AI Assistant
            </span>
            <h2 className="mt-5 text-3xl font-bold tracking-tight sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]">
              Your finances, answered in{' '}
              <span className="text-gradient-anim">seconds</span>
            </h2>
            <p className="mt-4 max-w-lg text-base leading-relaxed text-navy-300">
              The built-in AI chat board turns questions into answers. Ask anything about your numbers and
              get an instant, accurate response — complete with the chart that proves it.
            </p>
            <ul className="mt-8 space-y-5">
              {POINTS.map((p) => (
                <li key={p.title} className="flex items-start gap-4">
                  <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-white/10 text-brand-200">
                    <p.icon size={18} />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-white">{p.title}</p>
                    <p className="mt-1 text-sm leading-relaxed text-navy-300">{p.desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delay={140} className="animate-floaty">
            <AiChatMock />
          </Reveal>
        </div>
      </Container>
    </section>
  );
}
