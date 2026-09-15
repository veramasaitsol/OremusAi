import { Target, Eye, HeartHandshake, ShieldCheck } from 'lucide-react';
import Seo from '../../components/marketing/Seo.jsx';
import PageHero from '../../components/marketing/PageHero.jsx';
import Container from '../../components/marketing/Container.jsx';
import Reveal from '../../components/marketing/Reveal.jsx';
import SectionHeader from '../../components/marketing/SectionHeader.jsx';
import StatsBand from '../../components/marketing/sections/StatsBand.jsx';
import CTABand from '../../components/marketing/sections/CTABand.jsx';
import { COMPANY } from '../../components/marketing/data.js';

const VALUES = [
  { icon: Target, title: 'Clarity first', desc: 'Finance should be obvious, not opaque. We turn scattered data into decisions you can trust.' },
  { icon: ShieldCheck, title: 'Security by default', desc: 'Multi-tenant isolation, encrypted tokens, and role-based access are built in, not bolted on.' },
  { icon: HeartHandshake, title: 'Customer obsession', desc: 'We measure success by your close time and confidence, not by feature counts.' },
  { icon: Eye, title: 'Honest by design', desc: 'Transparent pricing, no lock-in, and your data is always yours to export.' },
];

export default function About() {
  return (
    <>
      <Seo title="About" />
      <PageHero
        eyebrow="About us"
        title="Giving finance teams a single source of truth"
        subtitle={`${COMPANY.name} unifies the accounting systems businesses already use into one secure, real-time workspace — so finance can stop reconciling and start deciding.`}
      />

      <section className="py-16 sm:py-20">
        <Container>
          <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <h2 className="text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">Our mission</h2>
              <p className="mt-4 text-base leading-relaxed text-navy-500">
                Finance teams spend more time wrangling spreadsheets than analyzing them. Data lives in
                Zoho Books, QuickBooks, and Xero — never in one place, never agreeing.
              </p>
              <p className="mt-4 text-base leading-relaxed text-navy-500">
                We built Oremus to end that. By normalizing every transaction into one consistent model and
                surfacing it through live dashboards and automated ratios, we help teams close faster, catch
                anomalies earlier, and make decisions with confidence.
              </p>
            </Reveal>
            <Reveal delay={120}>
              <h2 className="text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">What we believe</h2>
              <p className="mt-4 text-base leading-relaxed text-navy-500">
                Great financial software should be fast to adopt, secure by default, and honest about pricing.
                It should respect that your data is yours, and that your team’s time is better spent on analysis
                than on exports.
              </p>
              <p className="mt-4 text-base leading-relaxed text-navy-500">
                That philosophy shapes every decision we make — from our multi-tenant architecture to our
                transparent plans and our white-glove onboarding.
              </p>
            </Reveal>
          </div>
        </Container>
      </section>

      <StatsBand />

      <section className="py-16 sm:py-20">
        <Container>
          <SectionHeader eyebrow="Our values" title="The principles behind the product" />
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {VALUES.map((v, i) => (
              <Reveal
                key={v.title}
                delay={(i % 4) * 70}
                className="rounded-2xl border border-navy-100 bg-white p-6 shadow-card transition-all hover:shadow-lift"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                  <v.icon size={20} />
                </div>
                <h3 className="mt-4 text-base font-semibold text-navy-900">{v.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-navy-500">{v.desc}</p>
              </Reveal>
            ))}
          </div>
        </Container>
      </section>

      <CTABand title="Join the finance teams that trust Oremus" subtitle="See how a single source of truth changes the way you work." />
    </>
  );
}
