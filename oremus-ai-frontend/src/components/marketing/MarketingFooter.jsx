import { Link } from 'react-router-dom';
import Logo from '@/components/ui/Logo.jsx';
import Container from './Container.jsx';
import { FOOTER_LINKS, COMPANY, INTEGRATIONS } from './data.js';

export default function MarketingFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-navy-100 bg-navy-50/60">
      <Container className="py-14 lg:py-16">
        <div className="grid gap-10 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <Link to="/" className="flex items-center gap-2.5" aria-label={`${COMPANY.name} home`}>
              <Logo size={30} />
              <span className="text-[17px] font-bold tracking-tight text-navy-900">{COMPANY.name}</span>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-navy-500">{COMPANY.description}</p>
            <p className="mt-4 text-sm text-navy-500">
              <a href={`mailto:${COMPANY.email}`} className="font-medium text-brand-600 hover:underline">
                {COMPANY.email}
              </a>
            </p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {INTEGRATIONS.slice(0, 3).map((i) => (
                <span key={i} className="rounded-md border border-navy-200 bg-white px-2 py-1 text-xs font-medium text-navy-600">
                  {i}
                </span>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4 lg:col-span-8">
            {FOOTER_LINKS.map((col) => (
              <div key={col.title}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-navy-400">{col.title}</h3>
                <ul className="mt-4 space-y-2.5">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      <Link to={l.href} className="text-sm text-navy-600 transition-colors hover:text-brand-600">
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-4 border-t border-navy-100 pt-6 sm:flex-row sm:items-center">
          <p className="text-sm text-navy-500">© {year} {COMPANY.legalName}. All rights reserved.</p>
          <div className="flex items-center gap-5 text-sm">
            <Link to="/privacy" className="text-navy-500 hover:text-navy-900">Privacy</Link>
            <Link to="/terms" className="text-navy-500 hover:text-navy-900">Terms</Link>
            <Link to="/contact" className="text-navy-500 hover:text-navy-900">Contact</Link>
          </div>
        </div>
      </Container>
    </footer>
  );
}
