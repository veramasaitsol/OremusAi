import Container from '../Container.jsx';
import Reveal from '../Reveal.jsx';
import SectionHeader from '../SectionHeader.jsx';
import Icon from '../Icon.jsx';
import { FEATURES } from '../data.js';

export default function FeatureGrid({
  eyebrow = 'Features',
  title = 'Everything you need to run finance',
  subtitle = 'One platform that replaces a stack of spreadsheets, exports, and manual reconciliation.',
  id = 'features',
}) {
  return (
    <section id={id} className="py-20 sm:py-24 lg:py-28">
      <Container>
        <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />
        <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <Reveal
              key={f.title}
              delay={(i % 3) * 80}
              className="group rounded-2xl border border-navy-100 bg-white p-7 shadow-card transition-all hover:-translate-y-1 hover:shadow-lift"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-500 group-hover:text-white">
                <Icon name={f.icon} size={22} />
              </div>
              <h3 className="mt-5 text-lg font-semibold text-navy-900">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-navy-500">{f.desc}</p>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}
