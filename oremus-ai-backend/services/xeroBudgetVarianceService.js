'use strict';

/**
 * Xero Budget Variance report.
 * ---------------------------------------------------------------------------
 * Xero's JSON API has no Budget report, so — like the Zoho ledger builder — the
 * actuals come from the provider's P&L: one call for the selected period and one
 * for the year-to-date (Indian Apr–Mar FY). With no budget store the budget
 * columns are empty ("-"), so Variance equals the actual — precisely what Xero
 * shows for a company with no budget loaded. The shared budgetFromPL helper
 * emits the canonical cur/curBudget/ytd/ytdBudget contract the viewer reads.
 */

const { resolveRange, fyStartOf, budgetVarianceFromPL } = require('./budgetFromPLService');

async function buildXeroBudgetVariance(userId, params = {}) {
  // Lazy require avoids a load-time circular dependency with xeroReportsService.
  const xeroReports = require('./xeroReportsService');

  const { from, to } = resolveRange(params);
  const ytdFrom = fyStartOf(to);

  const periodPL = await xeroReports.fetchReport(userId, 'profitandloss', { from_date: from, to_date: to });
  const ytdPL = from === ytdFrom
    ? periodPL
    : await xeroReports.fetchReport(userId, 'profitandloss', { from_date: ytdFrom, to_date: to });

  return budgetVarianceFromPL(periodPL, ytdPL, { from, to, ytdFrom });
}

module.exports = { buildXeroBudgetVariance };
