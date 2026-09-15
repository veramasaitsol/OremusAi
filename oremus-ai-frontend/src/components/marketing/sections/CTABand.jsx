import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import Container from '../Container.jsx';
import Reveal from '../Reveal.jsx';

export default function CTABand({
  title = 'Ready to see your finances clearly?',
  subtitle = 'Get a personalized demo, or sign in and start exploring your dashboards today.',
}) {
  return (
    <section className="py-16 sm:py-20">
      <Container>
        <Reveal className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-600 to-brand-500 px-6 py-14 text-center shadow-lift sm:px-12 sm:py-16">
          <div className="dot-grid pointer-events-none absolute inset-0 opacity-10" />
          <div className="relative">
            <h2 className="mx-auto max-w-2xl text-3xl font-bold tracking-tight text-white sm:text-4xl">{title}</h2>
            <p className="mx-auto mt-4 max-w-xl text-base text-brand-50">{subtitle}</p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                to="/contact"
                className="group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-6 py-3.5 text-sm font-semibold text-brand-700 shadow-lg transition-all hover:bg-brand-50 sm:w-auto"
              >
                Get a demo
                <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                to="/login"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/30 px-6 py-3.5 text-sm font-semibold text-white transition-all hover:bg-white/10 sm:w-auto"
              >
                Sign in
              </Link>
            </div>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
