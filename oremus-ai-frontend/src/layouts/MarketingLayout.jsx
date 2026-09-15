import { Outlet } from 'react-router-dom';
import MarketingNav from '../components/marketing/MarketingNav.jsx';
import MarketingFooter from '../components/marketing/MarketingFooter.jsx';
import BackToTop from '../components/marketing/BackToTop.jsx';
import JsonLd from '../components/marketing/JsonLd.jsx';
import { COMPANY, SITE_URL } from '../components/marketing/data.js';

// Public marketing chrome. Mirrors the Next (marketing) route-group layout —
// nav, footer, back-to-top button and the org/site JSON-LD — but renders the
// active page through react-router's <Outlet/> instead of `children`.
export default function MarketingLayout() {
  const orgLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: COMPANY.name,
    legalName: COMPANY.legalName,
    url: SITE_URL,
    logo: `${SITE_URL}/og.png`,
    description: COMPANY.description,
    email: COMPANY.email,
    address: {
      '@type': 'PostalAddress',
      streetAddress: '535 Mission St',
      addressLocality: 'San Francisco',
      addressRegion: 'CA',
      postalCode: '94105',
      addressCountry: 'US',
    },
    sameAs: [COMPANY.social.twitter, COMPANY.social.linkedin, COMPANY.social.github],
  };

  const siteLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: COMPANY.name,
    url: SITE_URL,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${SITE_URL}/?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };

  return (
    <div className="marketing-root min-h-screen bg-white text-navy-900 antialiased transition-colors">
      <JsonLd data={orgLd} />
      <JsonLd data={siteLd} />
      <MarketingNav />
      <main>
        <Outlet />
      </main>
      <MarketingFooter />
      <BackToTop />
    </div>
  );
}
