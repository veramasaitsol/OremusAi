import Seo from '../../components/marketing/Seo.jsx';
import LegalPage from '../../components/marketing/LegalPage.jsx';

const EMAILS = ['privacy@oremuscorp.com', 'info@oremuscorp.com'];

const SECTIONS = [
  {
    heading: '1. About Oremus AI',
    body: [
      'Oremus AI (“Oremus AI”, “Oremus”, “we”, “us”, or “our”) provides business and financial analytics services designed to generate reports and insights from business/accounting information made available through supported integrations.',
      'This Privacy Policy explains how information is handled when you use the Oremus AI website and services.',
    ],
  },
  {
    heading: '2. Personal Data',
    body: [
      'Oremus AI is primarily designed to process business and accounting information. Oremus AI does not intentionally collect personal data from customer accounting datasets except where such information may be necessary to provide, authenticate, secure, maintain, or support the service.',
      'Oremus AI is designed to work with business and accounting information required to generate the requested reports and insights.',
      'Customers and users should not provide personal data to Oremus AI.',
    ],
  },
  {
    heading: '3. Business and Accounting Information',
    body: [
      'Oremus AI may receive business or accounting information from services that a customer has authorized, such as supported accounting platforms. This information is used only for the purpose of providing the requested reports, calculations, dashboards, and business insights.',
      'Oremus AI does not use the information received from these integrations for unrelated purposes or for advertising.',
    ],
  },
  {
    heading: '4. Data Retention',
    body: [
      'Information provided for generating reports and insights is processed for the requested service and is retained only for as long as reasonably necessary to provide, secure, maintain, and support the service, unless otherwise agreed with the customer or required by law.',
    ],
  },
  {
    heading: '5. AI and Automated Processing',
    body: [
      'Oremus AI may use artificial intelligence and automated processing to analyse business/accounting information and generate requested reports and insights.',
      'Information processed by Oremus AI is not used to train general-purpose AI models unless separately agreed and disclosed.',
      'AI-generated information is intended to support business analysis and should be reviewed by the user before being relied upon for accounting, tax, legal, financial, or other important decisions.',
    ],
  },
  {
    heading: '6. Security',
    body: [
      'Oremus AI applies reasonable technical and organisational safeguards designed to protect information processed through the service against unauthorized access, disclosure, alteration, loss, or misuse.',
      'The specific security controls may include access controls, authentication, encryption, monitoring, secure infrastructure, and other measures appropriate to the service environment.',
    ],
  },
  {
    heading: '7. Third-Party Integrations',
    body: [
      'Oremus AI may integrate with third-party business or accounting platforms. When an integration is enabled, the applicable third party remains responsible for its own systems and privacy practices.',
      'Oremus AI uses information from an authorized integration only for providing the requested functionality.',
    ],
  },
  {
    heading: '8. Cookies and Website Information',
    body: [
      'The Oremus AI website may use essential cookies or similar technologies required for website functionality and security. If analytics or non-essential tracking technologies are introduced, Oremus AI will provide appropriate information and controls as required by applicable law.',
    ],
  },
  {
    heading: '9. Legal and Regulatory Compliance',
    body: [
      'Oremus AI seeks to operate in accordance with applicable privacy and data-protection requirements. Where applicable to a particular processing activity, this may include India’s Digital Personal Data Protection Act, 2023 and applicable regulations, as well as other applicable privacy laws. The rights and obligations applicable to a particular activity may depend on the nature of the information, processing activity, and applicable law.',
    ],
  },
  {
    heading: '10. Contact Us',
    body: [
      'For privacy, security, or service-related questions, please contact Oremus through the following parent-company email addresses:',
      <>
        <span className="font-medium text-navy-900">Privacy / Security / General Enquiries: </span>
        {EMAILS.map((email, i) => (
          <span key={email}>
            {i > 0 && <span className="text-navy-400"> | </span>}
            {/* Each address wraps as a whole unit; only an address wider than
                the screen itself breaks. */}
            <a href={`mailto:${email}`} className="inline-block max-w-full break-words font-medium text-brand-600 hover:underline">{email}</a>
          </span>
        ))}
      </>,
    ],
  },
];

export default function Privacy() {
  return (
    <>
      <Seo title="Privacy Policy" />
      <LegalPage
        eyebrow="OREMUS AI"
        title="Privacy Policy"
        effective="30 September 2026"
        updated="30 September 2026"
        sections={SECTIONS}
      />
    </>
  );
}
