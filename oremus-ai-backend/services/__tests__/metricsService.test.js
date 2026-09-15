'use strict';

// Mock the db pool so warehouse query functions are unit-testable without MySQL.
jest.mock('../../config/db', () => ({ execute: jest.fn() }));
const pool = require('../../config/db');

const m = require('../metricsService');

// ── Report row fixtures (transformed shape: { label, cells, level, isHeader,
//    isSubtotal, isTotal }). Zoho keys value as cells.amount, QB as cells.c0,
//    Xero as cells.c1. ──────────────────────────────────────────────────────
const zohoPL = [
  { label: 'Operating Income', isHeader: true, level: 0, cells: { amount: null } },
  { label: 'Sales', level: 1, cells: { amount: 1000 } },
  { label: 'Total for Operating Income', isSubtotal: true, level: 0, cells: { amount: 1000 } },
  { label: 'Cost of Goods Sold', isHeader: true, level: 0, cells: { amount: null } },
  { label: 'Materials', level: 1, cells: { amount: 400 } },
  { label: 'Total for Cost of Goods Sold', isSubtotal: true, level: 0, cells: { amount: 400 } },
  { label: 'Gross Profit', isSubtotal: true, level: 0, cells: { amount: 600 } },
  { label: 'Operating Expense', isHeader: true, level: 0, cells: { amount: null } },
  { label: 'Salaries', level: 1, cells: { amount: 200 } },
  { label: 'Depreciation', level: 1, cells: { amount: 50 } },
  { label: 'Total for Operating Expense', isSubtotal: true, level: 0, cells: { amount: 250 } },
  { label: 'Operating Profit', isSubtotal: true, level: 0, cells: { amount: 350 } },
  { label: 'Net Profit/Loss', isTotal: true, level: 0, cells: { amount: 350 } },
];

const qboPL = [
  { label: 'Total Income', isSubtotal: true, level: 0, cells: { c0: 2000 } },
  { label: 'Total Cost of Goods Sold', isSubtotal: true, level: 0, cells: { c0: 800 } },
  { label: 'Gross Profit', isSubtotal: true, level: 0, cells: { c0: 1200 } },
  { label: 'Interest Expense', level: 1, cells: { c0: 100 } },
  { label: 'Total Expenses', isSubtotal: true, level: 0, cells: { c0: 500 } },
  { label: 'Net Operating Income', isSubtotal: true, level: 0, cells: { c0: 700 } },
  { label: 'Net Income', isTotal: true, level: 0, cells: { c0: 600 } },
];

const xeroPL = [
  { label: 'Total Income', isSubtotal: true, level: 0, cells: { c1: 5000 } },
  { label: 'Gross Profit', isSubtotal: true, level: 0, cells: { c1: 5000 } }, // no COGS section
  { label: 'Total Operating Expenses', isSubtotal: true, level: 0, cells: { c1: 2000 } },
  { label: 'Net Profit', isTotal: true, level: 0, cells: { c1: 3000 } },
];

describe('rowAmount', () => {
  test('reads c0 / amount / balance / last numeric', () => {
    expect(m.rowAmount({ cells: { c0: 5 } })).toBe(5);
    expect(m.rowAmount({ cells: { amount: 7 } })).toBe(7);
    expect(m.rowAmount({ cells: { balance: 9 } })).toBe(9);
    expect(m.rowAmount({ cells: { c1: 11 } })).toBe(11);
    expect(m.rowAmount({ cells: {} })).toBe(0);
  });
});

describe('derivePL', () => {
  test('Zoho: gross/operating/net from summary rows', () => {
    const pl = m.derivePL(zohoPL, 'zoho');
    expect(pl.revenue).toBe(1000);
    expect(pl.cogs).toBe(400);
    expect(pl.grossProfit).toBe(600);
    expect(pl.opex).toBe(250);
    expect(pl.operatingProfit).toBe(350);
    expect(pl.netProfit).toBe(350);
    expect(pl.depreciation).toBe(50);
  });

  test('QB: picks summary rows including interest leaf', () => {
    const pl = m.derivePL(qboPL, 'quickbooks');
    expect(pl.revenue).toBe(2000);
    expect(pl.cogs).toBe(800);
    expect(pl.grossProfit).toBe(1200);
    expect(pl.netProfit).toBe(600);
    expect(pl.interest).toBe(100);
  });

  test('Xero: missing COGS → grossProfit equals revenue', () => {
    const pl = m.derivePL(xeroPL, 'xero');
    expect(pl.revenue).toBe(5000);
    expect(pl.cogs).toBe(0);
    expect(pl.grossProfit).toBe(5000);
    expect(pl.netProfit).toBe(3000);
  });
});

describe('margins', () => {
  test('value/revenue*100', () => {
    const pl = m.derivePL(zohoPL, 'zoho');
    const mg = m.margins(pl);
    expect(mg.grossMargin).toBe(60);
    expect(mg.operatingMargin).toBe(35);
    expect(mg.netMargin).toBe(35);
  });
  test('revenue <= 0 → null margins', () => {
    const mg = m.margins({ revenue: 0, grossProfit: 0, operatingProfit: 0, netProfit: 0 });
    expect(mg.grossMargin).toBeNull();
    expect(mg.operatingMargin).toBeNull();
    expect(mg.netMargin).toBeNull();
  });
});

describe('deriveEbitda', () => {
  test('D&A present → reported', () => {
    const pl = m.derivePL(zohoPL, 'zoho');
    const eb = m.deriveEbitda(pl);
    expect(eb.ebitda).toBe(400); // 350 operating + 50 depreciation
    expect(eb.daSource).toBe('reported');
    expect(eb.ebitdaMargin).toBe(40);
  });
  test('D&A absent → fallback, ebitda == operatingProfit', () => {
    const eb = m.deriveEbitda({ operatingProfit: 700, depreciation: 0, revenue: 2000 });
    expect(eb.ebitda).toBe(700);
    expect(eb.daSource).toBe('fallback');
  });
});

describe('growth', () => {
  test('normal', () => { expect(m.growth(120, 100).growthPct).toBe(20); });
  test('prior 0 → null', () => { expect(m.growth(120, 0).growthPct).toBeNull(); });
  test('prior null → null', () => { expect(m.growth(120, null).growthPct).toBeNull(); });
  test('negative prior uses abs', () => { expect(m.growth(50, -100).growthPct).toBe(150); });
});

describe('priorPeriod', () => {
  test('shifts window back by its own length', () => {
    expect(m.priorPeriod({ from: '2025-04-01', to: '2026-03-31' }))
      .toEqual({ from: '2024-04-01', to: '2025-03-31' });
    expect(m.priorPeriod({ from: '2026-01-01', to: '2026-01-30' }))
      .toEqual({ from: '2025-12-02', to: '2025-12-31' });
  });
});

describe('deriveCashFlow', () => {
  const cf = [
    { label: 'Net Cash Provided by Operating Activities', isSubtotal: true, cells: { c0: 800 } },
    { label: 'Purchase of fixed asset', cells: { c0: -300 } },
    { label: 'Net Cash from Investing Activities', isSubtotal: true, cells: { c0: -300 } },
    { label: 'Net Cash from Financing Activities', isSubtotal: true, cells: { c0: 100 } },
    { label: 'Net Change in Cash', isTotal: true, cells: { c0: 600 } },
  ];
  test('extracts activities + capex', () => {
    const out = m.deriveCashFlow(cf, 'quickbooks');
    expect(out.operating).toBe(800);
    expect(out.investing).toBe(-300);
    expect(out.financing).toBe(100);
    expect(out.netChange).toBe(600);
    expect(out.capex).toBe(300);
  });
  test('empty → netChange 0', () => {
    const out = m.deriveCashFlow([], 'zoho');
    expect(out.netChange).toBe(0);
  });
});

describe('warehouse queries (mocked db)', () => {
  afterEach(() => pool.execute.mockReset());

  test('bankFlows: debit=inflow, credit=outflow', async () => {
    pool.execute.mockResolvedValueOnce([[{ dc: 'debit', total: 1000 }, { dc: 'credit', total: 400 }]]);
    const f = await m.bankFlows(1, 'org1', '2025-04-01', '2026-03-31');
    expect(f).toEqual({ inflow: 1000, outflow: 400, net: 600 });
  });

  test('revenueByProduct: top-N + Other', async () => {
    const rows = [];
    for (let i = 1; i <= 12; i++) rows.push({ itemId: String(i), name: `Item ${i}`, amount: 100 - i });
    pool.execute.mockResolvedValueOnce([rows]);
    const out = await m.revenueByProduct(1, 'org1', '2025-04-01', '2026-03-31', null, 10);
    expect(out.length).toBe(11); // 10 + Other
    expect(out[10].name).toBe('Other');
    expect(out[10].amount).toBe((100 - 11) + (100 - 12)); // 89 + 88
  });

  test('recurringSplit: math', async () => {
    pool.execute.mockResolvedValueOnce([[{ recurring: 300, oneTime: 700 }]]);
    const out = await m.recurringSplit(1, 'org1', '2025-04-01', '2026-03-31', null);
    expect(out).toEqual({ recurring: 300, oneTime: 700, total: 1000, recurringPct: 30 });
  });
});
