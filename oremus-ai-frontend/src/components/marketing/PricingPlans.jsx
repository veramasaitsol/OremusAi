'use client';

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ArrowRight } from 'lucide-react';
import { PLANS } from './data.js';

export default function PricingPlans() {
  const [yearly, setYearly] = useState(true);

  return (
    <div>
      {/* Billing toggle */}
      <div className="flex items-center justify-center gap-3">
        <span className={`text-sm font-medium ${!yearly ? 'text-navy-900' : 'text-navy-400'}`}>Monthly</span>
        <button
          type="button"
          role="switch"
          aria-checked={yearly}
          aria-label="Toggle yearly billing"
          onClick={() => setYearly((v) => !v)}
          className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
            yearly ? 'bg-brand-500' : 'bg-navy-300'
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              yearly ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
        <span className={`text-sm font-medium ${yearly ? 'text-navy-900' : 'text-navy-400'}`}>
          Yearly
          <span className="ml-2 rounded-full bg-cyan-50 px-2 py-0.5 text-xs font-semibold text-cyan-600">Save 17%</span>
        </span>
      </div>

      <div className="mt-10 grid items-stretch gap-6 lg:grid-cols-3">
        {PLANS.map((p) => {
          const price = yearly ? p.yearly : p.monthly;
          return (
            <div
              key={p.id}
              className={`relative flex flex-col rounded-2xl border bg-white p-7 transition-all ${
                p.highlight
                  ? 'border-brand-300 shadow-lift ring-1 ring-brand-200 lg:-mt-3 lg:mb-3'
                  : 'border-navy-100 shadow-card hover:shadow-lift'
              }`}
            >
              {p.highlight && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand-500 px-3 py-1 text-xs font-semibold text-white shadow-glow">
                  Most popular
                </span>
              )}
              <h3 className="text-lg font-bold text-navy-900">{p.name}</h3>
              <p className="mt-1.5 min-h-[40px] text-sm leading-relaxed text-navy-500">{p.blurb}</p>

              <div className="mt-5 flex items-end gap-1">
                {price == null ? (
                  <span className="text-3xl font-bold tracking-tight text-navy-900">Custom</span>
                ) : (
                  <>
                    <span className="text-4xl font-bold tracking-tight text-navy-900">${price}</span>
                    <span className="mb-1 text-sm text-navy-400">/mo</span>
                  </>
                )}
              </div>
              <p className="mt-1 h-4 text-xs text-navy-400">
                {price != null && (yearly ? 'per user, billed annually' : 'per user, billed monthly')}
              </p>

              <Link
                to={p.ctaHref}
                className={`mt-6 inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-sm font-semibold transition-all ${
                  p.highlight
                    ? 'bg-brand-500 text-white shadow-glow hover:bg-brand-600'
                    : 'border border-navy-200 text-navy-800 hover:bg-navy-50'
                }`}
              >
                {p.cta}
                <ArrowRight size={15} />
              </Link>

              <ul className="mt-7 space-y-3 border-t border-navy-100 pt-6">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm text-navy-700">
                    <Check size={17} className="mt-0.5 flex-shrink-0 text-brand-500" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
