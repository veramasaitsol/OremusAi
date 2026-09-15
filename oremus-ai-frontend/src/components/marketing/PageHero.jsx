import Container from './Container.jsx';
import Reveal from './Reveal.jsx';

// Compact hero for secondary pages. Always renders an H1 for correct hierarchy.
export default function PageHero({ eyebrow, title, subtitle, children }) {
  return (
    <section className="relative overflow-hidden pt-32 pb-12 sm:pt-36 sm:pb-16">
      <div className="aurora pointer-events-none absolute inset-0 -z-10" />
      <Container>
        <div className="mx-auto max-w-3xl text-center">
          {eyebrow && (
            <Reveal>
              <span className="inline-flex items-center gap-2 rounded-full border border-brand-100 bg-white/80 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-brand-600 shadow-soft backdrop-blur">
                {eyebrow}
              </span>
            </Reveal>
          )}
          <Reveal delay={60}>
            <h1 className="mt-5 text-4xl font-extrabold tracking-tight text-navy-900 sm:text-5xl">{title}</h1>
          </Reveal>
          {subtitle && (
            <Reveal delay={120}>
              <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-navy-500">{subtitle}</p>
            </Reveal>
          )}
          {children && <Reveal delay={180}><div className="mt-8">{children}</div></Reveal>}
        </div>
      </Container>
    </section>
  );
}
