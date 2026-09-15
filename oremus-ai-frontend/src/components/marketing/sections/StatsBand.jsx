import Container from '../Container.jsx';
import Reveal from '../Reveal.jsx';
import CountUp from '../CountUp.jsx';
import { STATS } from '../data.js';

export default function StatsBand() {
  return (
    <section className="py-12">
      <Container>
        <Reveal className="relative grid grid-cols-2 gap-6 overflow-hidden rounded-3xl border border-navy-100 bg-gradient-to-br from-navy-900 to-navy-800 p-8 sm:p-10 lg:grid-cols-4">
          <div className="conic-ring pointer-events-none absolute inset-0 opacity-20" />
          {STATS.map((s) => (
            <div key={s.label} className="relative text-center">
              <p className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
                <CountUp value={s.value} />
              </p>
              <p className="mt-1.5 text-xs text-navy-300 sm:text-sm">{s.label}</p>
            </div>
          ))}
        </Reveal>
      </Container>
    </section>
  );
}
