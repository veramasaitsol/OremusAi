import { Mail, Phone, MapPin, Clock } from 'lucide-react';
import Seo from '../../components/marketing/Seo.jsx';
import PageHero from '../../components/marketing/PageHero.jsx';
import Container from '../../components/marketing/Container.jsx';
import Reveal from '../../components/marketing/Reveal.jsx';
import ContactForm from '../../components/marketing/ContactForm.jsx';
import { COMPANY } from '../../components/marketing/data.js';

const DETAILS = [
  { icon: Mail, label: 'Email', value: COMPANY.email, href: `mailto:${COMPANY.email}` },
  { icon: Phone, label: 'Phone', value: COMPANY.phone, href: `tel:${COMPANY.phone.replace(/[^+\d]/g, '')}` },
  { icon: MapPin, label: 'Office', value: COMPANY.address },
  { icon: Clock, label: 'Response time', value: 'Within 1 business day' },
];

export default function Contact() {
  return (
    <>
      <Seo title="Contact & Demo Request" />
      <PageHero
        eyebrow="Contact"
        title="Let’s talk"
        subtitle="Request a personalized demo or ask us anything. A product specialist will get back to you within one business day."
      />

      <section className="pb-20 sm:pb-24">
        <Container>
          <div className="grid gap-10 lg:grid-cols-5 lg:gap-12">
            <Reveal className="lg:col-span-2">
              <h2 className="text-xl font-bold text-navy-900">Get in touch</h2>
              <p className="mt-2 text-sm leading-relaxed text-navy-500">
                Whether you’re evaluating Oremus or ready to roll it out across your team, we’re here to help.
              </p>
              <ul className="mt-8 space-y-5">
                {DETAILS.map((d) => (
                  <li key={d.label} className="flex items-start gap-4">
                    <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                      <d.icon size={18} />
                    </span>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-navy-400">{d.label}</p>
                      {d.href ? (
                        <a href={d.href} className="text-sm font-medium text-navy-800 hover:text-brand-600">{d.value}</a>
                      ) : (
                        <p className="text-sm font-medium text-navy-800">{d.value}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Reveal>

            <Reveal delay={120} className="lg:col-span-3">
              <ContactForm />
            </Reveal>
          </div>
        </Container>
      </section>
    </>
  );
}
