import Container from '../Container.jsx';
import Reveal from '../Reveal.jsx';
import SectionHeader from '../SectionHeader.jsx';
import { STEPS } from '../data.js';

export default function HowItWorks({ id = 'how-it-works' }) {
  return (
    <section id={id} className="py-20 sm:py-24 lg:py-28">
      <Container>
        <SectionHeader
          eyebrow="How it works"
          title="Live in minutes, not months"
          subtitle="No CSV uploads, no IT project. Connect your accounting platform and your dashboards build themselves."
        />
        <div className="relative mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {/* connecting line on desktop */}
          <div className="absolute left-0 right-0 top-7 hidden h-px bg-gradient-to-r from-transparent via-brand-200 to-transparent lg:block" />
          {STEPS.map((s, i) => (
            <Reveal key={s.n} delay={i * 90} className="relative text-center lg:text-left">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-brand-100 bg-white text-lg font-bold text-brand-600 shadow-soft lg:mx-0">
                {s.n}
              </div>
              <h3 className="mt-5 text-base font-semibold text-navy-900">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-navy-500">{s.desc}</p>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}
