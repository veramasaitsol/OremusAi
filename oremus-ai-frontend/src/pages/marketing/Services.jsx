import Seo from '../../components/marketing/Seo.jsx';
import PageHero from '../../components/marketing/PageHero.jsx';
import ServicesGrid from '../../components/marketing/sections/ServicesGrid.jsx';
import HowItWorks from '../../components/marketing/sections/HowItWorks.jsx';
import CTABand from '../../components/marketing/sections/CTABand.jsx';

export default function Services() {
  return (
    <>
      <Seo title="Services" />
      <PageHero
        eyebrow="Services"
        title="We don’t just ship software — we make you successful"
        subtitle="Our team partners with you from day one, so you see value fast and keep getting more of it."
      />
      <ServicesGrid eyebrow="What we offer" title="Services built around your finance team" id="services" />
      <HowItWorks />
      <CTABand title="Let’s build your finance command center" subtitle="Talk to our team about onboarding, custom reporting, and consolidation." />
    </>
  );
}
