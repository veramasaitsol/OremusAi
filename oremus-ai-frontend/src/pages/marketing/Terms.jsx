import Seo from '../../components/marketing/Seo.jsx';
import LegalPage from '../../components/marketing/LegalPage.jsx';
import { COMPANY } from '../../components/marketing/data.js';

const SECTIONS = [
  {
    heading: '1. Acceptance of terms',
    body: [
      `By accessing or using ${COMPANY.name} (the "Service"), you agree to be bound by these Terms & Conditions. If you do not agree, do not use the Service.`,
    ],
  },
  {
    heading: '2. Use of the service',
    body: [
      'You agree to use the Service only for lawful purposes and in accordance with these terms. You are responsible for maintaining the confidentiality of your account credentials and for all activity under your account.',
    ],
  },
  {
    heading: '3. Subscriptions and billing',
    body: [
      'Paid plans are billed in advance on a monthly or yearly basis. Fees are non-refundable except where required by law. You may upgrade, downgrade, or cancel at any time; changes take effect according to your billing cycle.',
    ],
  },
  {
    heading: '4. Integrations and third-party services',
    body: [
      'The Service connects to third-party accounting platforms at your direction. Your use of those platforms is governed by their own terms. We are not responsible for the availability or accuracy of third-party data.',
    ],
  },
  {
    heading: '5. Intellectual property',
    body: [
      `All software, content, and trademarks associated with the Service are the property of ${COMPANY.name} or its licensors. You retain ownership of the data you provide.`,
    ],
  },
  {
    heading: '6. Disclaimers',
    body: [
      'The Service is provided "as is" without warranties of any kind. Financial analytics are provided for informational purposes and do not constitute financial, accounting, or legal advice.',
    ],
  },
  {
    heading: '7. Limitation of liability',
    body: [
      `To the maximum extent permitted by law, ${COMPANY.name} shall not be liable for any indirect, incidental, or consequential damages arising from your use of the Service.`,
    ],
  },
  {
    heading: '8. Termination',
    body: [
      'We may suspend or terminate access to the Service for violation of these terms. Upon termination, your right to use the Service ends, and you may export your data in accordance with our Privacy Policy.',
    ],
  },
  {
    heading: '9. Changes to these terms',
    body: [
      'We may update these terms from time to time. Continued use of the Service after changes constitutes acceptance of the revised terms.',
    ],
  },
  {
    heading: '10. Contact',
    body: [
      `Questions about these terms can be sent to ${COMPANY.email}.`,
    ],
  },
];

export default function Terms() {
  return (
    <>
      <Seo title="Terms & Conditions" />
      <LegalPage
        title="Terms & Conditions"
        updated="May 30, 2026"
        intro={`These Terms & Conditions govern your access to and use of the ${COMPANY.name} platform and website.`}
        sections={SECTIONS}
      />
    </>
  );
}
