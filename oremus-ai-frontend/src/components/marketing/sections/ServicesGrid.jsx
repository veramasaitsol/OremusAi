import Container from '../Container.jsx';
import Reveal from '../Reveal.jsx';
import SectionHeader from '../SectionHeader.jsx';
import Icon from '../Icon.jsx';
import { SERVICES } from '../data.js';

export default function ServicesGrid({
  eyebrow = 'Services',
  title = 'Expert services, not just software',
  subtitle = 'From onboarding to custom reporting, our team makes sure you get value fast and keep it.',
  id = 'services',
}) {
  return (
    <section id={id} className="bg-navy-50/50 py-20 sm:py-24 lg:py-28">
      <Container>
        <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />
        <div className="mt-14 grid gap-6 sm:grid-cols-2">
          {SERVICES.map((s, i) => (
            <Reveal
              key={s.title}
              delay={(i % 2) * 80}
              className="flex gap-5 rounded-2xl border border-navy-100 bg-white p-7 shadow-card transition-all hover:shadow-lift"
            >
              <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-cyan-500 text-white">
                <Icon name={s.icon} size={22} />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-navy-900">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-navy-500">{s.desc}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}
