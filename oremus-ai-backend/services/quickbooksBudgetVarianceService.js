'use strict';

/**
 * QuickBooks Budget Variance report.
 * ---------------------------------------------------------------------------
 * QBO's Reports API has no Budget report, so — like the Xero + Zoho builders —
 * the actuals come from the provider's P&L: one call for the selected period and
 * one for the year-to-date (Indian Apr–Mar FY). With no budget store the budget
 * columns are empty ("-"), so Variance equals the actual. The shared
 * budgetFromPL helper emits the canonical cur/curBudget/ytd/ytdBudget contract
 * the viewer reads.
 */

const { resolveRange, fyStartOf, budgetVarianceFromPL } = require('./budgetFromPLService');

async function buildQuickbooksBudgetVariance(userId, params = {}) {
  // Lazy require avoids a load-time circular dependency with quickbooksReportsService.
  const qbReports = require('./quickbooksReportsService');

  const { from, to } = resolveRange(params);
  const ytdFrom = fyStartOf(to);

  const periodPL = await qbReports.fetchReport(userId, 'profitandloss', { from_date: from, to_date: to });
  const ytdPL = from === ytdFrom
    ? periodPL
    : await qbReports.fetchReport(userId, 'profitandloss', { from_date: ytdFrom, to_date: to });

  return budgetVarianceFromPL(periodPL, ytdPL, { from, to, ytdFrom });
}

module.exports = { buildQuickbooksBudgetVariance };
