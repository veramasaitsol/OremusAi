import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import Seo from '../../components/marketing/Seo.jsx';
import PageHero from '../../components/marketing/PageHero.jsx';
import ProductTabs from '../../components/marketing/sections/ProductTabs.jsx';
import FeatureGrid from '../../components/marketing/sections/FeatureGrid.jsx';
import AiHighlight from '../../components/marketing/sections/AiHighlight.jsx';
import ProductShowcase from '../../components/marketing/sections/ProductShowcase.jsx';
import HowItWorks from '../../components/marketing/sections/HowItWorks.jsx';
import CTABand from '../../components/marketing/sections/CTABand.jsx';
import Container from '../../components/marketing/Container.jsx';
import Reveal from '../../components/marketing/Reveal.jsx';
import SectionHeader from '../../components/marketing/SectionHeader.jsx';
import { INTEGRATIONS } from '../../components/marketing/data.js';

export default function Features() {
  return (
    <>
      <Seo title="Product & Features" />
      <PageHero
        eyebrow="Product"
        title="One platform for all your financial data"
        subtitle="From real-time dashboards to AI anomaly detection, Oremus gives finance teams the clarity to move fast and stay in control."
      >
        <Link
          to="/contact"
          className="group inline-flex items-center gap-2 rounded-xl bg-brand-500 px-6 py-3 text-sm font-semibold text-white shadow-glow transition-all hover:bg-brand-600"
        >
          Get a demo <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
        </Link>
      </PageHero>

      <ProductTabs />
      <FeatureGrid eyebrow="Capabilities" title="Built for finance, end to end" />
      <AiHighlight />
      <ProductShowcase />

      <section id="integrations" className="bg-navy-50/50 py-20 sm:py-24">
        <Container>
          <SectionHeader
            eyebrow="Integrations"
            title="Connects with your accounting stack"
            subtitle="Authenticate once with secure OAuth. Oremus syncs continuously and idempotently — no duplicates, no manual exports."
          />
          <Reveal className="mt-12 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {INTEGRATIONS.map((i) => (
              <div key={i} className="flex items-center justify-center rounded-2xl border border-navy-100 bg-white px-4 py-6 text-center text-sm font-semibold text-navy-700 shadow-card transition-all hover:shadow-lift">
                {i}
              </div>
            ))}
          </Reveal>
        </Container>
      </section>

      <HowItWorks />
      <CTABand />
    </>
  );
}
