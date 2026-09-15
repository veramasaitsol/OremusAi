import Container from '../Container.jsx';
import Reveal from '../Reveal.jsx';
import SectionHeader from '../SectionHeader.jsx';
import Icon from '../Icon.jsx';
import { INDUSTRIES } from '../data.js';

export default function Industries({ id = 'industries' }) {
  return (
    <section id={id} className="bg-navy-50/50 py-20 sm:py-24 lg:py-28">
      <Container>
        <SectionHeader
          eyebrow="Use cases"
          title="Built for every kind of finance team"
          subtitle="Whether you manage one company or forty, Oremus adapts to how your business runs."
        />
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {INDUSTRIES.map((it, i) => (
            <Reveal
              key={it.title}
              delay={(i % 3) * 70}
              className="group flex items-start gap-4 rounded-2xl border border-navy-100 bg-white p-6 shadow-card transition-all hover:-translate-y-1 hover:shadow-lift"
            >
              <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-500 group-hover:text-white">
                <Icon name={it.icon} size={20} />
              </div>
              <div>
                <h3 className="text-base font-semibold text-navy-900">{it.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-navy-500">{it.desc}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}
