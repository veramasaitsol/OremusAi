import Seo from '../../components/marketing/Seo.jsx';
import Hero from '../../components/marketing/sections/Hero.jsx';
import StatsBand from '../../components/marketing/sections/StatsBand.jsx';
import ProductTabs from '../../components/marketing/sections/ProductTabs.jsx';
import FeatureGrid from '../../components/marketing/sections/FeatureGrid.jsx';
import AiHighlight from '../../components/marketing/sections/AiHighlight.jsx';
import ProductShowcase from '../../components/marketing/sections/ProductShowcase.jsx';
import HowItWorks from '../../components/marketing/sections/HowItWorks.jsx';
import ServicesGrid from '../../components/marketing/sections/ServicesGrid.jsx';
import Industries from '../../components/marketing/sections/Industries.jsx';
import PricingSection from '../../components/marketing/sections/PricingSection.jsx';
import Testimonials from '../../components/marketing/sections/Testimonials.jsx';
import FAQSection from '../../components/marketing/sections/FAQSection.jsx';
import CTABand from '../../components/marketing/sections/CTABand.jsx';
import JsonLd from '../../components/marketing/JsonLd.jsx';
import { COMPANY, FAQS, PLANS } from '../../components/marketing/data.js';

export default function Landing() {
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQS.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  const productLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: COMPANY.name,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: COMPANY.description,
    offers: PLANS.filter((p) => p.monthly != null).map((p) => ({
      '@type': 'Offer',
      name: `${p.name} plan`,
      price: String(p.monthly),
      priceCurrency: 'USD',
    })),
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: '4.9',
      reviewCount: '128',
    },
  };

  return (
    <>
      <Seo fullTitle="Oremus AI — Financial Analytics & Reporting Platform" />
      <JsonLd data={faqLd} />
      <JsonLd data={productLd} />
      <Hero />
      <StatsBand />
      <ProductTabs />
      <FeatureGrid />
      <AiHighlight />
      <ProductShowcase />
      <HowItWorks />
      <ServicesGrid />
      <Industries />
      <PricingSection />
      <Testimonials />
      <FAQSection />
      <CTABand />
    </>
  );
}
