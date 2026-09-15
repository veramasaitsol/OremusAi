import { Link } from 'react-router-dom';
import Container from '../Container.jsx';
import SectionHeader from '../SectionHeader.jsx';
import Reveal from '../Reveal.jsx';
import PricingPlans from '../PricingPlans.jsx';

export default function PricingSection({ id = 'pricing', showCompareLink = true }) {
  return (
    <section id={id} className="py-20 sm:py-24 lg:py-28">
      <Container>
        <SectionHeader
          eyebrow="Pricing"
          title="Simple, transparent pricing"
          subtitle="Start free, then pick a plan that scales with your team. No hidden fees."
        />
        <Reveal className="mt-12">
          <PricingPlans />
        </Reveal>
        {showCompareLink && (
          <p className="mt-10 text-center text-sm text-navy-500">
            Need a full breakdown?{' '}
            <Link to="/pricing" className="font-semibold text-brand-600 hover:underline">
              Compare all features →
            </Link>
          </p>
        )}
      </Container>
    </section>
  );
}
