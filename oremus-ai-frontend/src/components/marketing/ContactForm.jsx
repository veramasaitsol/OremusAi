'use client';

import { useState } from 'react';
import { Check, Loader2, ArrowRight } from 'lucide-react';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const INITIAL = { name: '', email: '', company: '', employees: '1–10', message: '' };

// Front-end demo-request form. It is intentionally self-contained: it does NOT
// call any backend API (none exists for lead capture), so it cannot break
// existing endpoints. To go live, POST `form` to your CRM/endpoint inside submit.
export default function ContactForm() {
  const [form, setForm] = useState(INITIAL);
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState('idle'); // idle | submitting | done

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function validate() {
    const next = {};
    if (!form.name.trim()) next.name = 'Please enter your name.';
    if (!EMAIL_RE.test(form.email)) next.email = 'Please enter a valid work email.';
    if (!form.company.trim()) next.company = 'Please enter your company.';
    if (form.message.trim().length < 10) next.message = 'Tell us a little more (10+ characters).';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!validate()) return;
    setStatus('submitting');
    // Simulated async submit. Replace with a real POST to wire up lead capture.
    await new Promise((r) => setTimeout(r, 800));
    setStatus('done');
  }

  if (status === 'done') {
    return (
      <div className="rounded-2xl border border-navy-100 bg-white p-8 text-center shadow-card">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-50">
          <Check size={24} className="text-brand-600" />
        </div>
        <h3 className="mt-4 text-xl font-bold text-navy-900">Thanks, {form.name.split(' ')[0] || 'there'}!</h3>
        <p className="mt-2 text-sm text-navy-500">
          Your demo request is in. A product specialist will reach out to{' '}
          <span className="font-medium text-navy-700">{form.email}</span> within one business day.
        </p>
      </div>
    );
  }

  const field =
    'mt-1.5 w-full rounded-lg border border-navy-200 bg-white px-3.5 py-2.5 text-sm text-navy-900 placeholder:text-navy-400 outline-none transition-colors focus:border-brand-400 focus:ring-2 focus:ring-brand-100';

  return (
    <form onSubmit={onSubmit} noValidate className="rounded-2xl border border-navy-100 bg-white p-6 shadow-card sm:p-8">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="cf-name" className="text-sm font-medium text-navy-800">Full name</label>
          <input id="cf-name" type="text" value={form.name} onChange={set('name')} placeholder="Jane Cooper" className={field} aria-invalid={!!errors.name} />
          {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
        </div>
        <div>
          <label htmlFor="cf-email" className="text-sm font-medium text-navy-800">Work email</label>
          <input id="cf-email" type="email" value={form.email} onChange={set('email')} placeholder="jane@company.com" className={field} aria-invalid={!!errors.email} />
          {errors.email && <p className="mt-1 text-xs text-red-500">{errors.email}</p>}
        </div>
        <div>
          <label htmlFor="cf-company" className="text-sm font-medium text-navy-800">Company</label>
          <input id="cf-company" type="text" value={form.company} onChange={set('company')} placeholder="Acme Inc." className={field} aria-invalid={!!errors.company} />
          {errors.company && <p className="mt-1 text-xs text-red-500">{errors.company}</p>}
        </div>
        <div>
          <label htmlFor="cf-emp" className="text-sm font-medium text-navy-800">Company size</label>
          <select id="cf-emp" value={form.employees} onChange={set('employees')} className={field}>
            <option>1–10</option>
            <option>11–50</option>
            <option>51–200</option>
            <option>201–1000</option>
            <option>1000+</option>
          </select>
        </div>
      </div>
      <div className="mt-4">
        <label htmlFor="cf-msg" className="text-sm font-medium text-navy-800">How can we help?</label>
        <textarea id="cf-msg" rows={4} value={form.message} onChange={set('message')} placeholder="Tell us about your finance stack and what you'd like to see…" className={field} aria-invalid={!!errors.message} />
        {errors.message && <p className="mt-1 text-xs text-red-500">{errors.message}</p>}
      </div>
      <button
        type="submit"
        disabled={status === 'submitting'}
        className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-5 py-3 text-sm font-semibold text-white shadow-glow transition-all hover:bg-brand-600 disabled:opacity-70 sm:w-auto"
      >
        {status === 'submitting' ? (
          <><Loader2 size={16} className="animate-spin" /> Sending…</>
        ) : (
          <>Request a demo <ArrowRight size={16} /></>
        )}
      </button>
      <p className="mt-3 text-xs text-navy-400">
        By submitting, you agree to our{' '}
        <a href="/privacy" className="underline hover:text-navy-600">Privacy Policy</a>.
      </p>
    </form>
  );
}
