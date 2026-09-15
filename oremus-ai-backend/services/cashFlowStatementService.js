'use strict';

/**
 * Statement of Cash Flows — thin wrapper around the canonical builder.
 * ---------------------------------------------------------------------------
 * The real implementation lives in zohoLedgerReportsService.buildCashFlow(),
 * which:
 *   • Uses computePLFigures() for Net Income (ties to the P&L exactly)
 *   • Classifies BS accounts into operating / investing / financing
 *   • Excludes xero-recon:% true-up entries
 *   • Works for ALL platforms (Zoho / QuickBooks / Xero)
 *   • Supports multi-period comparison
 *
 * This file exists for backward compatibility — routes that import
 * `buildCashFlowStatement` from here keep working.  It delegates to the
 * canonical builder and remaps the cell key from `amount` → `cur` so the
 * existing frontend viewers (CashFlowsDirectViewer, ReportTable) render
 * identically.
 */

const { buildCashFlow } = require('./zohoLedgerReportsService');

async function buildCashFlowStatement(userId, params = {}) {
  const result = await buildCashFlow(userId, params);

  // Remap cell keys: canonical builder uses `amount`, legacy viewers expect `cur`.
  const remapped = (result.rows || []).map((row) => {
    if (!row.cells) return row;
    if ('amount' in row.cells && !('cur' in row.cells)) {
      return { ...row, cells: { cur: row.cells.amount } };
    }
    return row;
  });

  // Update column key from `amount` → `cur`.
  const columns = (result.columns || []).map((col) =>
    col.key === 'amount' ? { ...col, key: 'cur' } : col,
  );

  return { ...result, rows: remapped, columns };
}

module.exports = { buildCashFlowStatement };
