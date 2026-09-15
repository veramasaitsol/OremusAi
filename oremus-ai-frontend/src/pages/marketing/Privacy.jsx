import Seo from '../../components/marketing/Seo.jsx';
import LegalPage from '../../components/marketing/LegalPage.jsx';
import { COMPANY } from '../../components/marketing/data.js';

const SECTIONS = [
  {
    heading: '1. Information we collect',
    body: [
      'We collect account information you provide (such as your name, email, and company), and financial data you authorize us to access through connected accounting integrations like Zoho Books, QuickBooks, and Xero.',
      'We also collect limited usage and device information to operate and improve the service.',
    ],
  },
  {
    heading: '2. How we use your information',
    body: [
      'We use your information to provide financial analytics and reporting, secure your account, deliver support, and improve the platform. We do not sell your personal or financial data.',
    ],
  },
  {
    heading: '3. Integration data',
    body: [
      'When you connect an accounting system, we access only the data required to provide dashboards, transactions, and ratios. OAuth tokens are stored encrypted and can be revoked at any time by disconnecting the integration.',
    ],
  },
  {
    heading: '4. Data security',
    body: [
      'We protect your data with encryption, role-based access control, and multi-tenant isolation so that data is never shared between organizations. Despite our safeguards, no method of transmission or storage is 100% secure.',
    ],
  },
  {
    heading: '5. Data retention and deletion',
    body: [
      'We retain your data while your account is active. You can export your data at any time, and we delete synced data on request after cancellation in line with our retention schedule and legal obligations.',
    ],
  },
  {
    heading: '6. Your rights',
    body: [
      'Depending on your jurisdiction, you may have rights to access, correct, export, or delete your personal data. To exercise these rights, contact us using the details below.',
    ],
  },
  {
    heading: '7. Changes to this policy',
    body: [
      'We may update this Privacy Policy from time to time. Material changes will be communicated through the service or by email.',
    ],
  },
  {
    heading: '8. Contact us',
    body: [
      `If you have questions about this policy or your data, contact us at ${COMPANY.email}.`,
    ],
  },
];

export default function Privacy() {
  return (
    <>
      <Seo title="Privacy Policy" />
      <LegalPage
        title="Privacy Policy"
        updated="May 30, 2026"
        intro={`This Privacy Policy explains how ${COMPANY.name} collects, uses, and protects your information when you use our platform and website.`}
        sections={SECTIONS}
      />
    </>
  );
}
