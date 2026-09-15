import Container from '../Container.jsx';
import SectionHeader from '../SectionHeader.jsx';
import Reveal from '../Reveal.jsx';
import FAQAccordion from '../FAQAccordion.jsx';

export default function FAQSection({ id = 'faq' }) {
  return (
    <section id={id} className="bg-navy-50/50 py-20 sm:py-24 lg:py-28">
      <Container>
        <SectionHeader
          eyebrow="FAQ"
          title="Frequently asked questions"
          subtitle="Everything you need to know about getting started with Oremus AI."
        />
        <Reveal className="mt-12">
          <FAQAccordion />
        </Reveal>
      </Container>
    </section>
  );
}
