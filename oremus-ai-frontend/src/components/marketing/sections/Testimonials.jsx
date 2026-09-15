import { Star } from 'lucide-react';
import Container from '../Container.jsx';
import Reveal from '../Reveal.jsx';
import SectionHeader from '../SectionHeader.jsx';
import { TESTIMONIALS } from '../data.js';

export default function Testimonials({ id = 'testimonials' }) {
  return (
    <section id={id} className="py-20 sm:py-24 lg:py-28">
      <Container>
        <SectionHeader
          eyebrow="Customer stories"
          title="Finance teams trust Oremus"
          subtitle="From fast-growing startups to multi-entity accounting firms, teams close faster and decide with confidence."
        />
        <div className="mt-14 grid gap-6 lg:grid-cols-3">
          {TESTIMONIALS.map((t, i) => (
            <Reveal
              key={t.name}
              delay={i * 90}
              className="flex flex-col rounded-2xl border border-navy-100 bg-white p-7 shadow-card transition-all hover:shadow-lift"
            >
              <div className="flex gap-0.5 text-amber-400">
                {Array.from({ length: 5 }).map((_, k) => (
                  <Star key={k} size={16} fill="currentColor" />
                ))}
              </div>
              <blockquote className="mt-4 flex-1 text-[15px] leading-relaxed text-navy-700">“{t.quote}”</blockquote>
              <div className="mt-6 flex items-center gap-3 border-t border-navy-100 pt-5">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-cyan-500 text-sm font-bold text-white">
                  {t.initials}
                </span>
                <div>
                  <p className="text-sm font-semibold text-navy-900">{t.name}</p>
                  <p className="text-xs text-navy-500">{t.role}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}
