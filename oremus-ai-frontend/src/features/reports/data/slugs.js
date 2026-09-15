// URL-slug helpers for deep-linking each report to its own route
// (e.g. "Profit and Loss" <-> /reports/profit-and-loss). The catalog is COMMON
// across providers, so a slug resolves to the same report card everywhere.

import { CATALOGS } from './index.js';

// "Profit and Loss" -> "profit-and-loss"; "AR Aging Summary" -> "ar-aging-summary".
export function slugifyReport(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Resolve a URL slug back to its catalog report ({ name, category, ... }) for the
// given provider. Returns null when no report matches (caller redirects).
export function findReportBySlug(provider, slug) {
  const all = CATALOGS[provider]?.allReports || CATALOGS.zoho?.allReports || [];
  return all.find((r) => slugifyReport(r.name) === slug) || null;
}
