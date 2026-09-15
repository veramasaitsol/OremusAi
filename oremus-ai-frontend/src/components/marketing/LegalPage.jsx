import Container from './Container.jsx';
import Reveal from './Reveal.jsx';

// Renders a legal document from a structured list of { heading, body[] } sections.
export default function LegalPage({ title, updated, intro, sections }) {
  return (
    <section className="pt-32 pb-20 sm:pt-36 sm:pb-24">
      <Container className="max-w-3xl">
        <Reveal>
          <h1 className="text-3xl font-extrabold tracking-tight text-navy-900 sm:text-4xl">{title}</h1>
          <p className="mt-3 text-sm text-navy-400">Last updated: {updated}</p>
          {intro && <p className="mt-6 text-base leading-relaxed text-navy-600">{intro}</p>}
        </Reveal>

        <div className="mt-10 space-y-8">
          {sections.map((s, i) => (
            <Reveal key={s.heading} delay={Math.min(i, 6) * 40}>
              <h2 className="text-lg font-semibold text-navy-900">{s.heading}</h2>
              {s.body.map((p, k) => (
                <p key={k} className="mt-3 text-[15px] leading-relaxed text-navy-600">{p}</p>
              ))}
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}
