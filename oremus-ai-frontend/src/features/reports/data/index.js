// Aggregator that maps a provider id ('zoho' | 'quickbooks' | 'xero') to its
// category list, report-by-category dictionary, and a flattened "all reports"
// list. Used by reportsSlice and any component that needs provider-scoped
// catalog access.

import { ZOHO_CATEGORIES,  ZOHO_REPORTS_BY_CAT } from './zoho.js';

function flatten(byCat) {
  return Object.entries(byCat).flatMap(([cat, list]) =>
    list.map((r) => ({ ...r, category: cat })),
  );
}

// The finalized set of 37 reports is COMMON across every provider — Zoho,
// QuickBooks and Xero all expose the same catalog so a client sees the same
// reports regardless of which platform they're connected to. The live-data flow
// stays provider-aware in reportsAPI (Zoho → /zb-reports, QB/Xero → /accounting),
// and any report the provider can't serve live degrades gracefully to mock.
const COMMON_CATALOG = {
  categories:        ZOHO_CATEGORIES,
  reportsByCategory: ZOHO_REPORTS_BY_CAT,
  allReports:        flatten(ZOHO_REPORTS_BY_CAT),
};

export const CATALOGS = {
  zoho:       COMMON_CATALOG,
  quickbooks: COMMON_CATALOG,
  xero:       COMMON_CATALOG,
};

export function getCatalog(providerId) {
  return CATALOGS[providerId] || CATALOGS.zoho;
}
