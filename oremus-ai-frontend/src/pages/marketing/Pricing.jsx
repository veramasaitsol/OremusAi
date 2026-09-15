import { Link } from 'react-router-dom';
import { ArrowRight, Building2 } from 'lucide-react';
import Seo from '../../components/marketing/Seo.jsx';
import PageHero from '../../components/marketing/PageHero.jsx';
import Container from '../../components/marketing/Container.jsx';
import Reveal from '../../components/marketing/Reveal.jsx';
import SectionHeader from '../../components/marketing/SectionHeader.jsx';
import PricingPlans from '../../components/marketing/PricingPlans.jsx';
import ComparisonTable from '../../components/marketing/ComparisonTable.jsx';
import FAQAccordion from '../../components/marketing/FAQAccordion.jsx';
import CTABand from '../../components/marketing/sections/CTABand.jsx';
import JsonLd from '../../components/marketing/JsonLd.jsx';
import { PLANS, FAQS, SITE_URL, COMPANY } from '../../components/marketing/data.js';

const PRICING_FAQS = [
  { q: 'Is there a free trial?', a: 'Yes. Every paid plan includes a free trial with no credit card required. Upgrade or cancel anytime.' },
  { q: 'Can I change plans later?', a: 'Absolutely. You can upgrade, downgrade, or switch between monthly and yearly billing at any time from your workspace.' },
  { q: 'How does per-user pricing work?', a: 'You’re billed per active user on your plan. Yearly billing saves roughly 17% versus paying monthly.' },
  { q: 'What counts as an integration?', a: 'Each connected accounting system — Zoho Books, QuickBooks, or Xero — counts as one integration.' },
  ...FAQS.slice(2, 4),
];

export default function Pricing() {
  const offerLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: `${COMPANY.name} Plans`,
    description: 'Financial analytics and reporting plans for teams of every size.',
    offers: PLANS.filter((p) => p.monthly != null).map((p) => ({
      '@type': 'Offer',
      name: `${p.name} plan`,
      price: String(p.yearly),
      priceCurrency: 'USD',
      url: `${SITE_URL}/pricing`,
      availability: 'https://schema.org/InStock',
    })),
  };

  return (
    <>
      <Seo title="Pricing" />
      <JsonLd data={offerLd} />
      <PageHero
        eyebrow="Pricing"
        title="Pricing that scales with you"
        subtitle="Start free, then choose the plan that fits your team. Switch between monthly and yearly anytime."
      />

      <section className="pb-8">
        <Container>
          <Reveal><PricingPlans /></Reveal>
        </Container>
      </section>

      {/* Enterprise band */}
      <section className="py-12">
        <Container>
          <Reveal className="flex flex-col items-start gap-6 rounded-3xl border border-navy-100 bg-gradient-to-br from-navy-900 to-navy-800 p-8 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-white/10 text-white">
                <Building2 size={24} />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white sm:text-2xl">Enterprise</h2>
                <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-navy-300">
                  Custom pricing for organizations needing SSO, advanced RBAC, data residency, a dedicated success
                  manager, and a 99.99% uptime SLA. We’ll tailor a plan to your scale and security requirements.
                </p>
              </div>
            </div>
            <Link
              to="/contact"
              className="group inline-flex flex-shrink-0 items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-navy-900 transition-all hover:bg-brand-50"
            >
              Contact sales <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Reveal>
        </Container>
      </section>

      {/* Full comparison */}
      <section className="py-16 sm:py-20">
        <Container>
          <SectionHeader eyebrow="Compare" title="Compare every feature" subtitle="A detailed look at what’s included in each plan." />
          <Reveal className="mt-12"><ComparisonTable /></Reveal>
        </Container>
      </section>

      {/* Pricing FAQ */}
      <section className="bg-navy-50/50 py-16 sm:py-20">
        <Container>
          <SectionHeader eyebrow="FAQ" title="Pricing questions" subtitle="Common questions about plans and billing." />
          <Reveal className="mt-12"><FAQAccordion items={PRICING_FAQS} /></Reveal>
        </Container>
      </section>

      <CTABand title="Talk to sales" subtitle="Not sure which plan is right? We’ll help you find the best fit." />
    </>
  );
}
