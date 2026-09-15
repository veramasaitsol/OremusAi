import Reveal from './Reveal.jsx';

// Server-friendly section heading block (eyebrow + H2 + subtitle).
// `as` controls the heading level so pages keep a correct H1→H6 hierarchy.
export default function SectionHeader({
  eyebrow,
  title,
  subtitle,
  as: Heading = 'h2',
  center = true,
  className = '',
}) {
  return (
    <Reveal className={`${center ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl'} ${className}`}>
      {eyebrow && (
        <span className="inline-flex items-center gap-2 rounded-full border border-brand-100 bg-brand-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-brand-600">
          {eyebrow}
        </span>
      )}
      <Heading className="mt-4 text-3xl font-bold tracking-tight text-navy-900 sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]">
        {title}
      </Heading>
      {subtitle && (
        <p className="mt-4 text-base leading-relaxed text-navy-500 sm:text-lg">{subtitle}</p>
      )}
    </Reveal>
  );
}
