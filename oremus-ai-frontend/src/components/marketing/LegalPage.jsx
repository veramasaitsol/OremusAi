import Container from './Container.jsx';
import Reveal from './Reveal.jsx';

// Renders a legal document from a structured list of { heading, body[] } sections.
// A body entry is a paragraph: plain text, or JSX when it needs links.
// `eyebrow` and `effective` are optional.
export default function LegalPage({ eyebrow, title, effective, updated, intro, sections }) {
  return (
    <section className="pt-28 pb-16 sm:pt-36 sm:pb-24">
      <Container className="max-w-3xl">
        <Reveal>
          {eyebrow && (
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-600">{eyebrow}</p>
          )}
          <h1 className={`${eyebrow ? 'mt-2 ' : ''}text-3xl font-extrabold tracking-tight text-navy-900 sm:text-4xl`}>{title}</h1>
          <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-sm text-navy-400">
            {effective && <span>Effective date: {effective}</span>}
            {effective && <span aria-hidden="true" className="hidden sm:inline">|</span>}
            <span>Last updated: {updated}</span>
          </p>
          {intro && <p className="mt-6 text-base leading-relaxed text-navy-600">{intro}</p>}
        </Reveal>

        <div className="mt-8 space-y-7 sm:mt-10 sm:space-y-8">
          {sections.map((s, i) => (
            <Reveal key={s.heading} delay={Math.min(i, 6) * 40}>
              <h2 className="text-base font-semibold text-navy-900 sm:text-lg">{s.heading}</h2>
              {s.body.map((p, k) => (
                <p key={k} className="mt-3 break-words text-[15px] leading-relaxed text-navy-600">{p}</p>
              ))}
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}
