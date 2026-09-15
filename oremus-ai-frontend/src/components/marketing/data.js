// Central content for the public marketing site. Keeping copy in one place
// makes SEO/JSON-LD and the rendered pages share a single source of truth.

export { SITE_URL } from '../../config/env.js';

export const COMPANY = {
  name: 'Oremus AI',
  legalName: 'Oremus AI',
  tagline: 'The financial analytics platform for modern finance teams',
  description:
    'Oremus AI unifies financial analytics and reporting across Zoho Books, QuickBooks, and Xero — real-time dashboards, transactions, and ratios in one secure workspace.',
  email: 'hello@oremusai.com',
  sales: 'sales@oremusai.com',
  phone: '+1 (415) 555-0142',
  address: '535 Mission St, San Francisco, CA 94105',
  social: {
    twitter: 'https://twitter.com/oremusai',
    linkedin: 'https://www.linkedin.com/company/oremusai',
    github: 'https://github.com/oremusai',
  },
};

export const NAV_LINKS = [
  { label: 'Product', href: '/features' },
  { label: 'Services', href: '/services' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'About', href: '/about' },
  { label: 'Contact', href: '/contact' },
];

export const STATS = [
  { value: '2.4M+', label: 'Transactions analyzed' },
  { value: '97.8%', label: 'Anomaly precision' },
  { value: '14×', label: 'Faster month-end close' },
  { value: '99.99%', label: 'Platform uptime' },
];

export const INTEGRATIONS = ['Zoho Books', 'QuickBooks', 'Xero', 'Stripe', 'NetSuite', 'Sage'];

export const FEATURES = [
  {
    icon: 'LayoutDashboard',
    title: 'Live financial dashboards',
    desc: 'Revenue, expenses, cash flow, and profitability update in real time — no spreadsheets, no manual exports.',
  },
  {
    icon: 'ArrowLeftRight',
    title: 'Unified transactions',
    desc: 'Every invoice, bill, and journal entry from all your accounting systems, normalized into one searchable ledger.',
  },
  {
    icon: 'Gauge',
    title: 'Financial ratios & KPIs',
    desc: 'Liquidity, solvency, and efficiency ratios computed automatically and tracked over time.',
  },
  {
    icon: 'Sparkles',
    title: 'AI anomaly detection',
    desc: 'Surface unusual transactions and trend breaks with 97.8% precision before they hit your close.',
  },
  {
    icon: 'Plug',
    title: 'Native integrations',
    desc: 'Connect Zoho Books, QuickBooks, and Xero with OAuth in minutes. Data syncs continuously and idempotently.',
  },
  {
    icon: 'ShieldCheck',
    title: 'Enterprise security',
    desc: 'Role-based access, multi-tenant isolation, JWT auth, and encrypted token storage by default.',
  },
];

export const SERVICES = [
  {
    icon: 'Workflow',
    title: 'Onboarding & implementation',
    desc: 'White-glove setup of your integrations, organizations, and user roles so you see value on day one.',
  },
  {
    icon: 'LineChart',
    title: 'Custom reporting',
    desc: 'Tailored dashboards and report packs mapped to your board, investors, and operating cadence.',
  },
  {
    icon: 'Users',
    title: 'Multi-entity consolidation',
    desc: 'Roll up multiple organizations and currencies into a single consolidated view of the business.',
  },
  {
    icon: 'Headphones',
    title: 'Dedicated support',
    desc: 'A named success manager and priority support for Business and Enterprise customers.',
  },
];

export const STEPS = [
  {
    n: '01',
    title: 'Connect your accounting',
    desc: 'Authenticate Zoho Books, QuickBooks, or Xero with secure OAuth. No CSV uploads, no IT project.',
  },
  {
    n: '02',
    title: 'We sync & normalize',
    desc: 'Oremus continuously pulls customers, invoices, bills, and journals into one clean, idempotent data model.',
  },
  {
    n: '03',
    title: 'Explore live dashboards',
    desc: 'Open ready-made dashboards for revenue, cash flow, and ratios — or drill into any transaction instantly.',
  },
  {
    n: '04',
    title: 'Decide with confidence',
    desc: 'Share role-scoped views with your team, spot anomalies early, and close the month up to 14× faster.',
  },
];

export const INDUSTRIES = [
  { icon: 'Building2', title: 'Accounting firms', desc: 'Manage every client’s books from one multi-tenant workspace with per-client access controls.' },
  { icon: 'Rocket', title: 'Startups & SMBs', desc: 'Investor-ready metrics without hiring a full finance team or wrangling spreadsheets.' },
  { icon: 'Factory', title: 'Manufacturing', desc: 'Track margins, AP/AR aging, and cash conversion across complex operations.' },
  { icon: 'ShoppingCart', title: 'Retail & e-commerce', desc: 'Reconcile multi-channel revenue and expenses into a single source of truth.' },
  { icon: 'Briefcase', title: 'Professional services', desc: 'Monitor utilization, billing, and profitability per engagement in real time.' },
  { icon: 'Landmark', title: 'Multi-entity groups', desc: 'Consolidate organizations and currencies into one board-ready financial picture.' },
];

export const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    blurb: 'For individuals and small teams getting started with financial analytics.',
    monthly: 29,
    yearly: 24,
    cta: 'Start free trial',
    ctaHref: '/login',
    highlight: false,
    features: [
      '1 connected integration',
      'Up to 3 users',
      'Live dashboards',
      'Transactions & ratios',
      '12 months of history',
      'Email support',
    ],
  },
  {
    id: 'business',
    name: 'Business',
    blurb: 'For growing finance teams that need multi-entity reporting and collaboration.',
    monthly: 99,
    yearly: 82,
    cta: 'Start free trial',
    ctaHref: '/login',
    highlight: true,
    features: [
      'Up to 5 integrations',
      'Up to 25 users',
      'Multi-entity consolidation',
      'AI anomaly detection',
      'Custom report packs',
      'Role-based access control',
      'Unlimited history',
      'Priority support',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    blurb: 'For organizations needing scale, security, and a dedicated success team.',
    monthly: null,
    yearly: null,
    cta: 'Contact sales',
    ctaHref: '/contact',
    highlight: false,
    features: [
      'Unlimited integrations',
      'Unlimited users',
      'SSO & advanced RBAC',
      'Dedicated success manager',
      'Custom data residency',
      'SLA & 99.99% uptime',
      'Onboarding & implementation',
      'Premium 24/7 support',
    ],
  },
];

export const COMPARISON = [
  { group: 'Core', rows: [
    { label: 'Connected integrations', starter: '1', business: '5', enterprise: 'Unlimited' },
    { label: 'Team members', starter: '3', business: '25', enterprise: 'Unlimited' },
    { label: 'Live dashboards', starter: true, business: true, enterprise: true },
    { label: 'Transactions & ratios', starter: true, business: true, enterprise: true },
    { label: 'Data history', starter: '12 months', business: 'Unlimited', enterprise: 'Unlimited' },
  ]},
  { group: 'Analytics', rows: [
    { label: 'AI anomaly detection', starter: false, business: true, enterprise: true },
    { label: 'Multi-entity consolidation', starter: false, business: true, enterprise: true },
    { label: 'Custom report packs', starter: false, business: true, enterprise: true },
  ]},
  { group: 'Security & support', rows: [
    { label: 'Role-based access control', starter: false, business: true, enterprise: true },
    { label: 'SSO (SAML/OIDC)', starter: false, business: false, enterprise: true },
    { label: 'Dedicated success manager', starter: false, business: false, enterprise: true },
    { label: 'SLA & 99.99% uptime', starter: false, business: false, enterprise: true },
    { label: 'Support', starter: 'Email', business: 'Priority', enterprise: '24/7 premium' },
  ]},
];

export const TESTIMONIALS = [
  {
    quote: 'Oremus replaced three spreadsheets and a week of manual work every month. Our close went from 11 days to under 2.',
    name: 'Priya Nair',
    role: 'VP Finance, Acme Logistics',
    initials: 'PN',
  },
  {
    quote: 'We manage 40+ clients across Zoho and QuickBooks. The multi-tenant view is the only reason our team scales.',
    name: 'Daniel Okoye',
    role: 'Partner, Northbeam Advisory',
    initials: 'DO',
  },
  {
    quote: 'The anomaly detection caught a duplicated vendor bill worth $48k before it was ever paid. It paid for itself in week one.',
    name: 'Sara Lindqvist',
    role: 'Controller, Vensframe',
    initials: 'SL',
  },
];

export const FAQS = [
  {
    q: 'Which accounting systems does Oremus AI connect to?',
    a: 'Oremus connects natively to Zoho Books, QuickBooks Online, and Xero via secure OAuth. You can connect multiple systems and consolidate them into a single view.',
  },
  {
    q: 'How long does setup take?',
    a: 'Most teams are live in under 15 minutes. You authenticate your accounting platform, we sync your data, and your dashboards populate automatically — no CSV uploads or IT project required.',
  },
  {
    q: 'Is my financial data secure?',
    a: 'Yes. We use JWT-based authentication, role-based access control, multi-tenant data isolation, and encrypted storage of integration tokens. Your data is never shared between organizations.',
  },
  {
    q: 'Can I manage multiple companies or clients?',
    a: 'Absolutely. Oremus is multi-tenant by design. Accounting firms and multi-entity groups can manage many organizations with per-client roles and permissions from one workspace.',
  },
  {
    q: 'Do you offer a free trial?',
    a: 'Yes — every paid plan includes a free trial. No credit card is required to start, and you can upgrade or cancel at any time.',
  },
  {
    q: 'What happens to my data if I cancel?',
    a: 'You retain full control of your data. You can export it at any time, and we remove your synced data on request after cancellation in line with our data retention policy.',
  },
];

export const FOOTER_LINKS = [
  {
    title: 'Product',
    links: [
      { label: 'Features', href: '/features' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Integrations', href: '/features#integrations' },
      { label: 'Sign in', href: '/login' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Services', href: '/services' },
      { label: 'Contact', href: '/contact' },
      { label: 'Request a demo', href: '/contact' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'How it works', href: '/#how-it-works' },
      { label: 'Use cases', href: '/#industries' },
      { label: 'FAQ', href: '/#faq' },
      { label: 'Testimonials', href: '/#testimonials' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Privacy Policy', href: '/privacy' },
      { label: 'Terms & Conditions', href: '/terms' },
    ],
  },
];
