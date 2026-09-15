// Report data generators.
// Each generator returns { columns, rows, renderMode, currency } in the canonical shape.
// rows: [{ label, level?, isTotal?, isSubtotal?, cells: { colKey: number }, drill?: [{name,ref,date,amount}] }]
//
// The dispatcher (generateReport) looks up by exact name first, then by alias,
// and finally falls back to a deterministic generic generator. This lets the
// QuickBooks and Xero catalogs reuse signature reports while still having
// names that match their native UIs.

const CURRENCY = 'USD';

// ----------------------------------------------------------------------------
// Helpers

const periodCols = (current = 'Apr 2026', prior = 'Apr 2025') => [
  { key: 'label', label: 'Account', align: 'left' },
  { key: 'cur',   label: current,   align: 'right' },
  { key: 'prv',   label: prior,     align: 'right' },
];

const header   = (label, cells = {}) => ({ label, level: 0, cells });
const data     = (label, cells, drill) => ({ label, cells, ...(drill && { drill }) });
const subtotal = (label, cells) => ({ label, isSubtotal: true, cells });
const total    = (label, cells) => ({ label, isTotal: true, cells });

const sum = (rows, key) => rows.reduce((acc, r) => acc + (r.cells?.[key] || 0), 0);

const drill = (entries) =>
  entries.map(([name, ref, date, amount]) => ({ name, ref, date, amount }));

// Deterministic pseudo-random in [0,1) seeded by a string.
function seeded(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) % 1_000_000) / 1_000_000;
  };
}

// ----------------------------------------------------------------------------
// Flagship reports (used by every provider)

export function profitAndLoss() {
  const revenueRows = [
    data('Product Sales',     { cur: 1_842_000, prv: 1_456_000 },
      drill([
        ['Acme Logistics',     'INV-2104', '2026-04-02', 184_000],
        ['Northbeam Studios',  'INV-2105', '2026-04-09', 126_500],
        ['Foundry Labs',       'INV-2117', '2026-04-21',  98_750],
      ])),
    data('Services',          { cur:   428_000, prv:   360_000 }),
    data('Subscriptions',     { cur:   211_000, prv:   170_000 }),
    data('Other Income',      { cur:    18_000, prv:    14_500 }),
  ];
  const revSubtotal = subtotal('Total Revenue', {
    cur: sum(revenueRows, 'cur'),
    prv: sum(revenueRows, 'prv'),
  });

  const cogsRows = [
    data('Cost of Goods Sold',{ cur:   642_000, prv:   534_000 }),
    data('Hosting & Infra',   { cur:    62_300, prv:    47_900 }),
  ];
  const cogsSubtotal = subtotal('Total Cost of Sales', {
    cur: sum(cogsRows, 'cur'),
    prv: sum(cogsRows, 'prv'),
  });

  const grossProfit = total('Gross Profit', {
    cur: revSubtotal.cells.cur - cogsSubtotal.cells.cur,
    prv: revSubtotal.cells.prv - cogsSubtotal.cells.prv,
  });

  const opexRows = [
    data('Salaries & Wages',  { cur:   486_000, prv:   402_000 },
      drill([
        ['Payroll · Engineering','PR-04-01','2026-04-30',186_000],
        ['Payroll · GTM',        'PR-04-02','2026-04-30',122_000],
        ['Contractors',          'PR-04-03','2026-04-30', 38_000],
      ])),
    data('Marketing',         { cur:    98_200, prv:    71_500 }),
    data('Rent & Utilities',  { cur:    32_500, prv:    31_200 }),
    data('Software & Tools',  { cur:    24_700, prv:    19_300 }),
    data('Travel',            { cur:    12_400, prv:     8_600 }),
    data('Other Operating',   { cur:    18_900, prv:    16_400 }),
  ];
  const opexSubtotal = subtotal('Total Operating Expenses', {
    cur: sum(opexRows, 'cur'),
    prv: sum(opexRows, 'prv'),
  });

  const operatingIncome = total('Operating Income', {
    cur: grossProfit.cells.cur - opexSubtotal.cells.cur,
    prv: grossProfit.cells.prv - opexSubtotal.cells.prv,
  });

  const taxRow = data('Income Tax', {
    cur: Math.round(operatingIncome.cells.cur * 0.22),
    prv: Math.round(operatingIncome.cells.prv * 0.22),
  });

  const netIncome = total('Net Income', {
    cur: operatingIncome.cells.cur - taxRow.cells.cur,
    prv: operatingIncome.cells.prv - taxRow.cells.prv,
  });

  return {
    columns: periodCols(),
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [
      header('Revenue'),
      ...revenueRows,
      revSubtotal,
      header('Cost of Sales'),
      ...cogsRows,
      cogsSubtotal,
      grossProfit,
      header('Operating Expenses'),
      ...opexRows,
      opexSubtotal,
      operatingIncome,
      taxRow,
      netIncome,
    ],
  };
}

export function balanceSheet() {
  // QuickBooks Balance Sheet layout: a single "Total" column with deep nested
  // sections (Assets → Current Assets → Accounts Receivable → leaf), each
  // closed by a "Total for <section>" subtotal, then the combined
  // "Liabilities and Equity" tree — mirroring QBO's report builder.
  const cents = (n) => Math.round(n * 100) / 100;
  const sec = (label, level) => ({ label, level, isHeader: true });
  const acc = (label, level, amount) => ({ label, level, cells: { total: amount } });
  const sub = (label, level, amount) => ({ label, level, isSubtotal: true, cells: { total: amount } });
  const tot = (label, amount) => ({ label, level: 0, isTotal: true, cells: { total: amount } });

  // Assets
  const ar = 1_362_376.28;
  const inventory = 405_070.94;
  const uncategorized = 99.00;
  const otherCurrentAssets = cents(inventory + uncategorized);
  const currentAssets = cents(ar + otherCurrentAssets);
  const totalAssets = currentAssets;

  // Liabilities
  const ap = 592_291.04;
  const currentLiabilities = ap;
  const totalLiabilities = currentLiabilities;

  // Equity balances against assets − liabilities (here all carried as Net Income).
  const netIncome = cents(totalAssets - totalLiabilities);
  const retainedEarnings = 0;
  const totalEquity = cents(retainedEarnings + netIncome);

  return {
    columns: [
      { key: 'label', label: '',      align: 'left'  },
      { key: 'total', label: 'Total', align: 'right' },
    ],
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [
      sec('Assets', 0),
      sec('Current Assets', 1),
      sec('Accounts Receivable', 2),
      acc('Accounts Receivable (A/R)', 3, ar),
      sub('Total for Accounts Receivable', 2, ar),
      sec('Other Current Assets', 2),
      acc('Inventory Asset', 3, inventory),
      acc('Uncategorized Asset', 3, uncategorized),
      sub('Total for Other Current Assets', 2, otherCurrentAssets),
      sub('Total for Current Assets', 1, currentAssets),
      tot('Total for Assets', totalAssets),

      sec('Liabilities and Equity', 0),
      sec('Liabilities', 1),
      sec('Current Liabilities', 2),
      sec('Accounts Payable', 3),
      acc('Accounts Payable (A/P)', 4, ap),
      sub('Total for Accounts Payable', 3, ap),
      sub('Total for Current Liabilities', 2, currentLiabilities),
      sub('Total for Liabilities', 1, totalLiabilities),
      sec('Equity', 1),
      acc('Retained Earnings', 2, retainedEarnings),
      acc('Net Income', 2, netIncome),
      sub('Total for Equity', 1, totalEquity),
      tot('Total for Liabilities and Equity', cents(totalLiabilities + totalEquity)),
    ],
  };
}

export function cashFlow() {
  // QuickBooks Statement of Cash Flows (indirect method): a single "Total"
  // column. Operating Activities starts at Net Income, then an "Adjustments to
  // reconcile…" subsection of working-capital movements, the reconciled
  // "Net cash provided by operating activities", and the period roll-forward
  // (NET CASH INCREASE, Cash at beginning, CASH AT END) — mirroring QBO.
  const cents = (n) => Math.round(n * 100) / 100;
  const sec = (label, level) => ({ label, level, isHeader: true });
  const acc = (label, level, amount) => ({ label, level, cells: { total: amount } });
  const sub = (label, level, amount) => ({ label, level, isSubtotal: true, cells: { total: amount } });
  const tot = (label, amount) => ({ label, level: 0, isTotal: true, cells: { total: amount } });

  const netIncome = 1_175_255.18;
  const ap = 592_291.04;
  const ar = -1_362_376.28;
  const inventory = -405_070.94;
  const uncategorized = -99.00;
  const adjustments = cents(ap + ar + inventory + uncategorized);
  const netOperating = cents(netIncome + adjustments);
  const netChange = netOperating;            // no investing/financing activity
  const cashBeginning = 0;
  const cashEnding = cents(cashBeginning + netChange);

  return {
    columns: [
      { key: 'label', label: 'Full name', align: 'left'  },
      { key: 'total', label: 'Total',     align: 'right' },
    ],
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [
      sec('OPERATING ACTIVITIES', 0),
      acc('Net Income', 1, netIncome),
      sec('Adjustments to reconcile Net Income to Net Cash provided by operations', 1),
      acc('Accounts Payable (A/P)', 2, ap),
      acc('Accounts Receivable (A/R)', 2, ar),
      acc('Inventory Asset', 2, inventory),
      acc('Uncategorized Asset', 2, uncategorized),
      sub('Total for Adjustments to reconcile Net Income to Net Cash provided by operations', 1, adjustments),
      sub('Net cash provided by operating activities', 0, netOperating),
      sub('NET CASH INCREASE FOR PERIOD', 0, netChange),
      sub('Cash at beginning of period', 0, cashBeginning),
      tot('CASH AT END OF PERIOD', cashEnding),
    ],
  };
}

export function cashSummary() {
  // Xero "Cash Summary": a period column, an Average (YTD) column, and a
  // Variance column. Rows are all bold lines — Surplus (Deficit), Net Cash
  // Movement, a "Summary" section header, then Opening Balance and Cash Balance
  // (Cash Balance = Opening Balance + Net Cash Movement). Mirrors Xero's layout.
  const cents = (n) => Math.round(n * 100) / 100;
  const line = (label, cur, avg) => ({
    label, isSubtotal: true,
    cells: { cur, avg, var: cents((cur || 0) - (avg || 0)) },
  });
  const sec = (label) => ({ label, isHeader: true });

  const surplus = 42_180.55;          // operating surplus for the period
  const surplusAvg = 38_905.20;       // average monthly surplus (YTD)
  const netMovement = surplus;        // no non-operating cash movements
  const netMovementAvg = surplusAvg;
  const opening = 318_640.00;         // cash at start of period
  const openingAvg = 286_120.00;
  const closing = cents(opening + netMovement);
  const closingAvg = cents(openingAvg + netMovementAvg);

  return {
    columns: [
      { key: 'label', label: '',               align: 'left'  },
      { key: 'cur',   label: 'Period',          align: 'right' },
      { key: 'avg',   label: 'Average (YTD)',   align: 'right' },
      { key: 'var',   label: 'Variance',        align: 'right' },
    ],
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [
      line('Surplus (Deficit)', surplus, surplusAvg),
      line('Net Cash Movement', netMovement, netMovementAvg),
      sec('Summary'),
      line('Opening Balance', opening, openingAvg),
      line('Cash Balance', closing, closingAvg),
    ],
  };
}

export function foreignCurrencyGains() {
  // Xero "Foreign Currency Gains and Losses": multi-column FX statement grouped
  // by account class (Accounts Receivable / Payable), each with per-currency
  // rows (Balance + code, Balance in base, Realised/Unrealised gains and their
  // YTD figures, and FX Exposure), section totals, then a Total Gain (Loss) and
  // an overall FX Exposure line — mirroring Xero's layout.
  const grp = (label) => ({ label, isHeader: true });
  const ccy = (name, balance, code, balanceBase) => ({
    label: name,
    cells: { balance, ccy: code, balanceBase, realised: 0, unrealised: 0, realisedYtd: 0, unrealisedYtd: 0, fx: 0 },
  });
  const sub = (label, balanceBase) => ({
    label, isSubtotal: true,
    cells: { balanceBase, realised: 0, unrealised: 0, realisedYtd: 0, unrealisedYtd: 0, fx: 0 },
  });
  const tot = (label, cells) => ({ label, isTotal: true, cells });

  const arInr = 3_471_674.91;
  const apInr = 8_013_907.73;

  return {
    columns: [
      { key: 'label',         label: '',                   align: 'left'  },
      { key: 'balance',       label: 'Balance',            align: 'right' },
      { key: 'balanceBase',   label: 'Balance INR',        align: 'right' },
      { key: 'realised',      label: 'Realised Gain',      align: 'right' },
      { key: 'unrealised',    label: 'Unrealised Gain',    align: 'right' },
      { key: 'realisedYtd',   label: 'Realised Gain YTD',  align: 'right' },
      { key: 'unrealisedYtd', label: 'Unrealised Gain YTD', align: 'right' },
      { key: 'fx',            label: 'FX Exposure',        align: 'right' },
    ],
    renderMode: 'normal',
    currency: 'INR',
    rows: [
      grp('Accounts Receivable'),
      ccy('Indian Rupee', arInr, 'INR', arInr),
      sub('Total Accounts Receivable', arInr),
      grp('Accounts Payable'),
      ccy('Indian Rupee', apInr, 'INR', apInr),
      sub('Total Accounts Payable', apInr),
      tot('Total Gain (Loss)', { realised: 0, unrealised: 0, realisedYtd: 0, unrealisedYtd: 0, fx: 0 }),
      tot('FX Exposure', { fx: 0 }),
    ],
  };
}

export function cashFlowsDirect() {
  // Xero "Statement of Cash Flows" (direct method): a single period column.
  // A bold "Net Cash Flows" line, then a "Cash and Cash Equivalents" section
  // with the beginning- and end-of-period balances (end = beginning + net).
  const cents = (n) => Math.round(n * 100) / 100;
  const line = (label, cur) => ({ label, isSubtotal: true, cells: { cur } });
  const sec = (label) => ({ label, isHeader: true });

  const netCashFlows = 42_180.55;
  const beginning = 318_640.00;
  const ending = cents(beginning + netCashFlows);

  return {
    columns: [
      { key: 'label', label: '',      align: 'left'  },
      { key: 'cur',   label: 'Total', align: 'right' },
    ],
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [
      line('Net Cash Flows', netCashFlows),
      sec('Cash and Cash Equivalents'),
      line('Cash and cash equivalents at beginning of period', beginning),
      line('Cash and cash equivalents at end of period', ending),
    ],
  };
}

export function trialBalance() {
  const cols = [
    { key: 'label', label: 'Account', align: 'left' },
    { key: 'dr',    label: 'Debit',   align: 'right' },
    { key: 'cr',    label: 'Credit',  align: 'right' },
  ];

  const accounts = [
    ['Cash',                   1_204_000, 0],
    ['Accounts Receivable',      486_000, 0],
    ['Inventory',                238_000, 0],
    ['Property & Equipment',     612_000, 0],
    ['Accounts Payable',               0,  228_000],
    ['Short-term Debt',                0,   62_000],
    ['Long-term Debt',                 0,  348_000],
    ['Paid-in Capital',                0,  500_000],
    ['Retained Earnings',              0, 1_618_000],
    ['Revenue',                        0, 2_499_000],
    ['Cost of Sales',            704_300, 0],
    ['Operating Expenses',       672_700, 0],
  ];
  const rows = accounts.map(([label, dr, cr]) => data(label, { dr, cr }));
  const drSum = sum(rows, 'dr');
  const crSum = sum(rows, 'cr');

  return {
    columns: cols,
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [
      header('Accounts'),
      ...rows,
      total('Total', { dr: drSum, cr: crSum }),
    ],
  };
}

// ----------------------------------------------------------------------------
// Aging report (shared between AR / AP — bucket columns match QBO/Xero shapes)

function agingReport(label, parties) {
  const cols = [
    { key: 'label',  label, align: 'left' },
    { key: 'c0',     label: 'Current',     align: 'right' },
    { key: 'c1_30',  label: '1–30 days',   align: 'right' },
    { key: 'c31_60', label: '31–60 days',  align: 'right' },
    { key: 'c61_90', label: '61–90 days',  align: 'right' },
    { key: 'c90',    label: '90+ days',    align: 'right' },
    { key: 'total',  label: 'Total',       align: 'right' },
  ];
  const rows = parties.map((p) => {
    const cells = {
      c0:     p[1] || 0,
      c1_30:  p[2] || 0,
      c31_60: p[3] || 0,
      c61_90: p[4] || 0,
      c90:    p[5] || 0,
    };
    cells.total = cells.c0 + cells.c1_30 + cells.c31_60 + cells.c61_90 + cells.c90;
    return data(p[0], cells);
  });
  const tot = {
    c0:     sum(rows, 'c0'),
    c1_30:  sum(rows, 'c1_30'),
    c31_60: sum(rows, 'c31_60'),
    c61_90: sum(rows, 'c61_90'),
    c90:    sum(rows, 'c90'),
  };
  tot.total = tot.c0 + tot.c1_30 + tot.c31_60 + tot.c61_90 + tot.c90;
  return {
    columns: cols,
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [...rows, total('Total', tot)],
  };
}

export function arAging() {
  return agingReport('Customer', [
    ['Acme Logistics',       42_000, 28_500, 14_200, 6_400, 0],
    ['Northbeam Studios',    18_400, 12_900,  3_300, 0,     0],
    ['Foundry Labs',         28_700,      0,      0, 8_100, 4_200],
    ['Linear Inc.',          62_000, 18_000,      0, 0,     0],
    ['Ramp',                 21_400,  6_400,      0, 0,     0],
    ['ABC Corporate Pvt Ltd',12_800,  4_200,  3_100, 2_400, 1_200],
    ['Short Pvt Ltd',         7_400,  2_300,  1_900,   600, 300],
  ]);
}

export function apAging() {
  return agingReport('Vendor', [
    ['WeWork Bandra',         14_200,  6_400, 1_200, 0,     0],
    ['AWS',                   18_900, 12_400, 4_200, 0,     0],
    ['Bharti Airtel Ltd.',     4_400,  3_200,   800, 200,   0],
    ['Upender Traders',        3_800,  2_600,   400, 0,     0],
    ['Stripe Atlas',           1_600,    800,   200, 0,     0],
  ]);
}

export function arAgingSummary() {
  // QuickBooks "A/R Aging Summary": receivables by aging bucket. Mirrors the
  // QBO screenshot — every customer's balance sits in the "1 - 30" bucket, all
  // other buckets blank, and Total equals the bucket amount. Empty cells use
  // '' (not 0) so the QB variant renders them blank, matching QBO.
  const parties = [
    ['AbbVie,Inc.',                                63_474.38],
    ['AstraZeneca CAMCAR Costa Rica SA',            6_120.00],
    ['Bayer (China) Limited',                     106_531.26],
    ['Bayer Consumer Care AG',                     82_500.00],
    ['Bellmore Home Center, Inc.',                  7_440.00],
    ['Boston Scientific',                           1_391.40],
    ['Boston Scientific Asia Pacific Pte. Ltd.',   11_500.00],
    ['Boston Scientific Corporation',              13_556.00],
    ['Boston Scientific International SA',          15_005.00],
    ['ConvaTec Inc.',                             196_896.00],
    ['DePuy Orthopaedics Inc',                     34_776.00],
    ['Effective People A/S',                       30_300.00],
    ['Exact Sciences Corporation',                348_000.00],
    ['Gilead Sciences,Inc',                       237_600.00],
    ['GP Strategies Limited GBR 402',               8_564.00],
    ['GP Strategies Middle East Training LLC',      9_650.00],
    ['GP Strategies Singapore (Asia) Pte. Ltd.',   36_585.00],
    ['GP Strategies Taiwan Ltd',                    3_260.00],
    ['GP Strategies (Thailand) Co., Ltd.',          5_432.00],
    ['MERCK HEALTHCARE VIETNAM LIMITED',            5_336.00],
    ['Nokia Solutions and Networks Gmbh& Co.KG',   10_250.00],
    ['Novo Nordisk Inc.',                          89_400.00],
    ['Novo Nordisk Pharma (Singapore) Pte Ltd',    14_920.00],
    ['Sixt Se .',                                  16_659.24],
    ['Viatris Middle EastFZ-LLC',                   7_230.00],
  ];
  const dataRows = parties.map(([name, amount]) =>
    data(name, { c0: '', c1_30: amount, c31_60: '', c61_90: '', c90: '', total: amount }));
  return {
    columns: [
      { key: 'label',  label: '',            align: 'left'  },
      { key: 'c0',     label: 'CURRENT',     align: 'right' },
      { key: 'c1_30',  label: '1 - 30',      align: 'right' },
      { key: 'c31_60', label: '31 - 60',     align: 'right' },
      { key: 'c61_90', label: '61 - 90',     align: 'right' },
      { key: 'c90',    label: '91 AND OVER', align: 'right' },
      { key: 'total',  label: 'Total',       align: 'right' },
    ],
    renderMode: 'normal',
    currency: CURRENCY,
    rows: dataRows,
  };
}

export function arAgingDetail() {
  // QuickBooks "A/R Aging Detail": one row per open invoice, grouped by aging
  // bucket. Mirrors the QBO screenshot — all 25 invoices fall in the
  // "1 - 30 days past due" bucket, with a bucket subtotal and grand TOTAL.
  const cents = (n) => Math.round(n * 100) / 100;
  const invoices = [
    ['AbbVie,Inc.',                                63_474.38],
    ['AstraZeneca CAMCAR Costa Rica SA',            6_120.00],
    ['Bayer (China) Limited',                     106_531.26],
    ['Bayer Consumer Care AG',                     82_500.00],
    ['Bellmore Home Center, Inc.',                  7_440.00],
    ['Boston Scientific',                           1_391.40],
    ['Boston Scientific Asia Pacific Pte. Ltd.',   11_500.00],
    ['Boston Scientific Corporation',              13_556.00],
    ['Boston Scientific International SA',          15_005.00],
    ['ConvaTec Inc.',                             196_896.00],
    ['DePuy Orthopaedics Inc',                     34_776.00],
    ['Effective People A/S',                       30_300.00],
    ['Exact Sciences Corporation',                348_000.00],
    ['Gilead Sciences,Inc',                       237_600.00],
    ['GP Strategies (Thailand) Co., Ltd.',          5_432.00],
    ['GP Strategies Limited GBR 402',               8_564.00],
    ['GP Strategies Middle East Training LLC',      9_650.00],
    ['GP Strategies Singapore (Asia) Pte. Ltd.',   36_585.00],
    ['GP Strategies Taiwan Ltd',                    3_260.00],
    ['MERCK HEALTHCARE VIETNAM LIMITED',            5_336.00],
    ['Nokia Solutions and Networks Gmbh& Co.KG',   10_250.00],
    ['Novo Nordisk Inc.',                          89_400.00],
    ['Novo Nordisk Pharma (Singapore) Pte Ltd',    14_920.00],
    ['Sixt Se .',                                  16_659.24],
    ['Viatris Middle EastFZ-LLC',                   7_230.00],
  ];
  const dataRows = invoices.map(([customer, amount]) => ({
    label: '05/22/2026',
    level: 1,
    cells: { type: 'Invoice', num: '', customer, due: '05/22/2026', amount, openbal: amount },
  }));
  const grand = cents(dataRows.reduce((acc, r) => acc + r.cells.amount, 0));
  return {
    columns: [
      { key: 'label',    label: 'Date',             align: 'left'  },
      { key: 'type',     label: 'Transaction type', align: 'left'  },
      { key: 'num',      label: 'Num',              align: 'left'  },
      { key: 'customer', label: 'Customer full name', align: 'left' },
      { key: 'due',      label: 'Due date',         align: 'left'  },
      { key: 'amount',   label: 'Amount',           align: 'right' },
      { key: 'openbal',  label: 'Open balance',     align: 'right' },
    ],
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [
      { label: `1 - 30 days past due (${invoices.length})`, isHeader: true, level: 0 },
      ...dataRows,
      subtotal('Total for 1 - 30 days past due', { amount: grand, openbal: grand }),
      total('TOTAL', { amount: grand, openbal: grand }),
    ],
  };
}

export function apAgingSummary() {
  // QuickBooks "A/P Aging Summary": payables by aging bucket. Mirrors the QBO
  // screenshot — vendors spread across 1-30 / 31-60 / 61-90 / 91 AND OVER
  // buckets, CURRENT empty, with a grand TOTAL row. Empty cells use '' (not 0)
  // so the QB variant renders them blank, matching QBO.
  const parties = [
    // [name, current, 1-30, 31-60, 61-90, 91+]
    ['Anthropic',                          '',        '',     '',        '',         200.00],
    ['BUNNYWAY, informacijske st...',      '',  1_068.12,     '',        '',      53_897.00],
    ['Corix Insurance Services LLC',       '',  3_828.00,     '',        '',           ''],
    ['Daily',                              '', 15_822.54,     '',  8_867.80,       5_660.50],
    ['Elevenlabs',                         '',  2_996.42,     '',    663.99,       1_322.80],
    ['Fireflies.ai Corp',                  '',    187.78,     '',        '',           ''],
    ['Fly.io, Inc',                        '',  1_188.74,     '',        '',           ''],
    ['Freeman',                            '', 22_482.29,     '',        '',           ''],
    ['HeyGen',                             '',    537.00,     '',     99.00,           ''],
    ['Life Sciences Trainers and Ed...',   '',        '', 9_500.00,      '',           ''],
    ['Mailgun Technologies, Inc',          '',    332.53,     '',        '',           ''],
    ['Minfy Technologies Private Li...',   '', 10_524.78,     '',        '',           ''],
    ['OpenAI, LLC',                        '',  5_644.07,     '',        '',           ''],
    ['Oremus Corporation NA',              '',        '',     '',    300.00,         300.00],
    ['Pipedrive OU',                       '',  2_016.00,     '',        '',           ''],
    ['Regus',                              '',    789.10,     '',        '',       6_601.28],
    ['Saleswinnr Technology Soluti...',    '',   -461.92,     '', 315_945.74,     88_937.42],
    ['SKYLINE Northeast',                  '', 33_040.06,     '',        '',           ''],
  ];
  const dataRows = parties.map(([name, c0, c1_30, c31_60, c61_90, c90]) => {
    const rowTotal = [c1_30, c31_60, c61_90, c90]
      .reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0);
    return data(name, { c0, c1_30, c31_60, c61_90, c90, total: Math.round(rowTotal * 100) / 100 });
  });
  const sumBucket = (key) => Math.round(
    dataRows.reduce((a, r) => a + (typeof r.cells[key] === 'number' ? r.cells[key] : 0), 0) * 100) / 100;
  return {
    columns: [
      { key: 'label',  label: '',            align: 'left'  },
      { key: 'c0',     label: 'CURRENT',     align: 'right' },
      { key: 'c1_30',  label: '1 - 30',      align: 'right' },
      { key: 'c31_60', label: '31 - 60',     align: 'right' },
      { key: 'c61_90', label: '61 - 90',     align: 'right' },
      { key: 'c90',    label: '91 AND OVER', align: 'right' },
      { key: 'total',  label: 'Total',       align: 'right' },
    ],
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [
      ...dataRows,
      total('TOTAL', {
        c0: '',
        c1_30:  sumBucket('c1_30'),
        c31_60: sumBucket('c31_60'),
        c61_90: sumBucket('c61_90'),
        c90:    sumBucket('c90'),
        total:  sumBucket('total'),
      }),
    ],
  };
}

export function apAgingDetail() {
  // QuickBooks "A/P Aging Detail": one row per open bill, grouped by aging
  // bucket (91+, 61-90, 31-60, 1-30). Mirrors the QBO screenshot, including the
  // "Past due" column and a Vendor Credit line. Bucket subtotals + grand TOTAL.
  const cents = (n) => Math.round(n * 100) / 100;
  const buckets = [
    ['91 or more days past due', [
      ['02/28/2026', 'Bill', 'Smart/25-26/011',  'Saleswinnr Technology Solutions...', '02/28/2026', '111', 88_937.42],
      ['05/22/2026', 'Bill', 'BABB1F3F-0013',    'Daily',                              '02/28/2026', '111',  5_660.50],
      ['03/01/2026', 'Bill', 'BCDN-BCDN-794846', 'BUNNYWAY, informacijske storit...',  '03/01/2026', '110', 53_897.00],
      ['03/01/2026', 'Bill', 'ADDDC54C-0009',    'Anthropic',                          '03/01/2026', '110',    200.00],
      ['02/28/2026', 'Bill', '#OCN-IN2026-0060', 'Oremus Corporation NA',              '03/07/2026', '104',    300.00],
      ['03/10/2026', 'Bill', 'E75D6DCB-0068',    'Elevenlabs',                         '03/10/2026', '101',    660.98],
      ['03/01/2026', 'Bill', '1683-34916',       'Regus',                              '03/15/2026', '96',   6_601.28],
      ['03/15/2026', 'Bill', 'E75D6DCB -0069',   'Elevenlabs',                         '03/15/2026', '96',     661.82],
    ]],
    ['61 - 90 days past due', [
      ['03/24/2026', 'Bill', 'Not found',        'Elevenlabs',                         '03/24/2026', '87',     663.99],
      ['03/31/2026', 'Bill', 'MQZDHAVM-0004',    'HeyGen',                             '03/31/2026', '80',      99.00],
      ['03/31/2026', 'Bill', 'Smart/25-26/012',  'Saleswinnr Technology Solutions...', '03/31/2026', '80',  315_945.74],
      ['03/31/2026', 'Bill', '9F62DE43-0023',    'Daily',                              '03/31/2026', '80',    5_119.01],
      ['03/31/2026', 'Bill', 'Not found',        'Daily',                              '03/31/2026', '80',    3_748.79],
      ['03/30/2026', 'Bill', 'OCN-IN2026-0091',  'Oremus Corporation NA',              '04/06/2026', '74',      300.00],
    ]],
    ['31 - 60 days past due', [
      ['03/30/2026', 'Bill', '2269', 'Life Sciences Trainers and Educa...', '04/29/2026', '51', 5_000.00],
      ['03/30/2026', 'Bill', '2268', 'Life Sciences Trainers and Educa...', '04/29/2026', '51', 4_500.00],
    ]],
    ['1 - 30 days past due', [
      ['05/22/2026', 'Bill', '',           'BUNNYWAY, informacijske storit...',  '05/22/2026', '28',  1_068.12],
      ['05/22/2026', 'Bill', '',           'Corix Insurance Services LLC',       '05/22/2026', '28',  3_828.00],
      ['05/22/2026', 'Bill', '',           'Daily',                              '05/22/2026', '28', 10_703.53],
      ['05/22/2026', 'Bill', '',           'Elevenlabs',                         '05/22/2026', '28',  2_996.42],
      ['05/22/2026', 'Bill', '',           'Fly.io, Inc',                        '05/22/2026', '28',  1_188.74],
      ['05/22/2026', 'Bill', '',           'Freeman',                            '05/22/2026', '28', 22_482.29],
      ['05/22/2026', 'Bill', '',           'HeyGen',                             '05/22/2026', '28',    537.00],
      ['05/22/2026', 'Bill', '',           'Mailgun Technologies, Inc',          '05/22/2026', '28',    332.53],
      ['05/22/2026', 'Bill', '',           'Minfy Technologies Private Limited', '05/22/2026', '28', 10_524.78],
      ['05/22/2026', 'Bill', '',           'OpenAI, LLC',                        '05/22/2026', '28',  5_644.07],
      ['05/22/2026', 'Bill', '',           'Pipedrive OU',                       '05/22/2026', '28',  2_016.00],
      ['05/22/2026', 'Bill', '',           'Regus',                              '05/22/2026', '28',    789.10],
      ['05/22/2026', 'Bill', '',           'SKYLINE Northeast',                  '05/22/2026', '28', 33_040.06],
      ['05/22/2026', 'Bill', '9F62DE43-0023', 'Daily',                          '05/22/2026', '28',  5_119.01],
      ['05/22/2026', 'Bill', '2804-4292',  'Fireflies.ai Corp',                  '05/22/2026', '28',    187.78],
      ['05/22/2026', 'Vendor Credit', '',  'Saleswinnr Technology Solutions...', '',           '',     -461.92],
    ]],
  ];
  const rows = [];
  let grand = 0;
  for (const [name, bills] of buckets) {
    rows.push({ label: `${name} (${bills.length})`, isHeader: true, level: 0 });
    let bucketSum = 0;
    for (const [date, type, num, vendor, due, pastdue, amount] of bills) {
      bucketSum += amount;
      rows.push({
        label: date,
        level: 1,
        cells: { type, num, vendor, due, pastdue, amount, openbal: amount },
      });
    }
    bucketSum = cents(bucketSum);
    grand = cents(grand + bucketSum);
    rows.push(subtotal(`Total for ${name}`, { amount: bucketSum, openbal: bucketSum }));
  }
  rows.push(total('TOTAL', { amount: grand, openbal: grand }));
  return {
    columns: [
      { key: 'label',   label: 'Date',                align: 'left'  },
      { key: 'type',    label: 'Transaction type',    align: 'left'  },
      { key: 'num',     label: 'Num',                 align: 'left'  },
      { key: 'vendor',  label: 'Vendor display name', align: 'left'  },
      { key: 'due',     label: 'Due date',            align: 'left'  },
      { key: 'pastdue', label: 'Past due',            align: 'left'  },
      { key: 'amount',  label: 'Amount',              align: 'right' },
      { key: 'openbal', label: 'Open balance',        align: 'right' },
    ],
    renderMode: 'normal',
    currency: CURRENCY,
    rows,
  };
}

export function inventoryItemSummary() {
  // Xero "Inventory Item Summary": 8 columns grouped by inventory type. Mirrors
  // the Xero screenshot — a single "Untracked" group with Opening/Closing
  // Balance lines and untracked item codes; all values are blank ("-").
  const codes = [
    'PERF', 'OUT', 'CAL', 'CALTS', 'ASS', 'SALES', 'EMPTS',
    'TCMSUB', 'SRV', 'EMPSUB', 'PERFTS', 'OUTTS', 'ASFNDE',
  ];
  const itemRows = codes.map((code) => ({ label: code }));
  return {
    columns: [
      { key: 'code',      label: 'Item Code',       align: 'left'  },
      { key: 'name',      label: 'Item Name',       align: 'left'  },
      { key: 'opening',   label: 'Opening Balance', align: 'right' },
      { key: 'purchases', label: 'Purchases',       align: 'right' },
      { key: 'cogs',      label: 'COGS',            align: 'right' },
      { key: 'adj',       label: 'Adjustments',     align: 'right' },
      { key: 'closing',   label: 'Closing Balance', align: 'right' },
      { key: 'sales',     label: 'Sales',           align: 'right' },
    ],
    renderMode: 'normal',
    currency: CURRENCY,
    itemCount: codes.length + 5,
    rows: [
      { label: 'Untracked', isGroup: true },
      { label: 'Opening Balance', strong: true },
      ...itemRows,
      { label: 'Total Untracked', strong: true },
      { label: 'Closing Balance', strong: true },
      { label: 'Total', isTotal: true },
    ],
  };
}

// Zoho Books "detail" reports render in the native Zoho viewer (Filters / Date
// Range / Report By / Run Report chrome). `zoho` carries the chrome config the
// viewer reads. Rows start empty → the viewer shows Zoho's "no transactions"
// empty state, matching the screenshots.
function zohoDetailReport(columns, zoho) {
  return { columns, rows: [], renderMode: 'normal', currency: CURRENCY, zoho };
}

export function creditNoteDetails() {
  return zohoDetailReport(
    [
      { key: 'status',   label: 'Status',             align: 'left'  },
      { key: 'date',     label: 'Credit Date',        align: 'left', sortable: true },
      { key: 'cnnum',    label: 'Credit Note#',       align: 'left'  },
      { key: 'refnum',   label: 'Credit Note#',       align: 'left'  },
      { key: 'customer', label: 'Customer Name',      align: 'left'  },
      { key: 'amount',   label: 'Credit Note Amount', align: 'right' },
      { key: 'balance',  label: 'Balance Amount',     align: 'right' },
    ],
    { module: 'Payments Received', title: 'Credit Note Details', reportBy: null, customizeCount: 7 },
  );
}

export function recurringInvoiceDetails() {
  return zohoDetailReport(
    [
      { key: 'status',    label: 'Status',            align: 'left'  },
      { key: 'profile',   label: 'Profile Name',      align: 'left'  },
      { key: 'customer',  label: 'Customer Name',     align: 'left'  },
      { key: 'frequency', label: 'Frequency',         align: 'left'  },
      { key: 'lastinv',   label: 'Last Invoice Date', align: 'left'  },
      { key: 'nextinv',   label: 'Next Invoice Date', align: 'left'  },
      { key: 'expiry',    label: 'Expiry Date',       align: 'left'  },
      { key: 'amount',    label: 'Amount',            align: 'right' },
    ],
    {
      module: 'Recurring Invoices',
      title: 'Recurring Invoice Details',
      reportBy: { value: 'Next Invoice Date', options: ['Next Invoice Date', 'Last Invoice Date', 'Created Time', 'Expiry Date'] },
      customizeCount: 8,
    },
  );
}

// Zoho Books "Purchases by Item": items procured with quantity, amount and
// average price, in INR. Unlike the empty detail reports above, this one has
// posted data + a Total row + a Total Count footer.
export function purchasesByItem() {
  const items = [
    ['GST', 24_849.15],
    ['TowardsConsultancyChargesvideSS05dated04Dec2025', 25_000.00],
    ['TowardsConsultancyChargesvideSS06dated03Jan2026', 25_000.00],
    ['TowardsHotelandStayExpensesDomestic5videIHHC78953dated01Jan2026', 25_030.07],
    ['TowardsHotelandStayExpensesDomestic5videR15940822500456dated01Dec2025', 9_428.58],
    ['TowardsHotelandStayExpensesDomesticvideIHHC789531dated01Jan2026', 1_259.93],
    ['TowardsProfessionalChargesvideOCSIN25260789dated15Dec2025', 15_000.00],
    ['TowardsProfessionalChargesvideOCSIN25260837dated29Dec2025', 30_000.00],
    ['TowardsProfessionalChargesvideOCSIN25260939dated27Jan2026', 30_000.00],
    ['TowardsRentUtilitiesvide000H143dated01Dec2025', 75_000.00],
    ['TowardsRentUtilitiesvide000H163dated01Jan2026', 75_000.00],
    ['TowardsRentUtilitiesvide000H182dated01Feb2026', 75_000.00],
    ['TowardsROCchargesvideOCSIN25260892dated01Jan2026', 800.00],
    ['TowardsTravellingTicketExpensesDomestic5videMP1252611AN34943dated01Dec2025', 6_781.00],
    ['TowardsTravellingTicketExpensesDomestic5videMP1252612AO40779dated01Jan2026', 5_231.00],
    ['TowardsTravellingTicketExpensesDomestic5videTS1252611BM89334dated01Dec2025', 5_429.00],
  ];
  const dataRows = items.map(([name, amount]) => data(name, { qty: 1, amount, avg: amount }));
  const totalQty = dataRows.reduce((a, r) => a + (r.cells.qty || 0), 0);
  const totalAmount = Math.round(sum(dataRows, 'amount') * 100) / 100;
  return {
    columns: [
      { key: 'label',  label: 'ITEM NAME',          align: 'left'  },
      { key: 'qty',    label: 'QUANTITY PURCHASED',  align: 'right' },
      { key: 'amount', label: 'AMOUNT',              align: 'right', money: true },
      { key: 'avg',    label: 'AVERAGE PRICE',       align: 'right', money: true },
    ],
    rows: [
      ...dataRows,
      total('Total', { qty: totalQty, amount: totalAmount, avg: null }),
    ],
    renderMode: 'normal',
    currency: 'INR',
    zoho: {
      module: 'Purchases and Expenses',
      title: 'Purchases by Item',
      customizeCount: 4,
      compareWith: true,
      totalCount: dataRows.length,
    },
  };
}

// QuickBooks "Transaction Detail by Account" — every posting line grouped under
// its account. Each account is an isHeader section showing its line count; the
// detail rows carry a per-section running balance; each section closes with a
// "Total for <Account>" subtotal; a bold grand TOTAL footer ties them together.
export function transactionDetailByAccount() {
  const date = '05/22/2026';

  // The 25 opening-balance invoices appear twice: under A/R (Split = Services)
  // and under Services (Split = A/R). Same names + amounts, mirrored split.
  const invoiceLines = [
    ['AbbVie,Inc.', 63_474.38],
    ['AstraZeneca CAMCAR Costa Ric...', 6_120.00],
    ['Bayer (China) Limited', 106_531.26],
    ['Bayer Consumer Care AG', 82_500.00],
    ['Bellmore Home Center, Inc.', 7_440.00],
    ['Boston Scientific', 1_391.40],
    ['Boston Scientific Asia Pacific Pte...', 11_500.00],
    ['Boston Scientific Corporation', 13_556.00],
    ['Boston Scientific International SA', 15_005.00],
    ['ConvaTec Inc.', 196_896.00],
    ['DePuy Orthopaedics Inc', 34_776.00],
    ['Effective People A/S', 30_300.00],
    ['Exact Sciences Corporation', 348_000.00],
    ['Gilead Sciences,Inc', 237_600.00],
    ['GP Strategies (Thailand) Co., Ltd.', 5_432.00],
    ['GP Strategies Limited GBR 402', 8_564.00],
    ['GP Strategies Middle East Traini...', 9_650.00],
    ['GP Strategies Singapore (Asia) P...', 36_585.00],
    ['GP Strategies Taiwan Ltd', 3_260.00],
    ['MERCK HEALTHCARE VIETNA...', 5_336.00],
    ['Nokia Solutions and Networks G...', 10_250.00],
    ['Novo Nordisk Inc.', 89_400.00],
    ['Novo Nordisk Pharma (Singapor...', 14_920.00],
    ['Sixt Se .', 16_659.24],
    ['Viatris Middle EastFZ-LLC', 7_230.00],
  ];
  const arRows = invoiceLines.map(([name, amount]) => ({
    type: 'Invoice', num: '', name, desc: 'Opening Balance', split: 'Services', amount,
  }));
  const servicesRows = invoiceLines.map(([name, amount]) => ({
    type: 'Invoice', num: '', name, desc: 'Opening Balance', split: 'Accounts Receivable (A/R)', amount,
  }));

  const inventoryRows = [
    { type: 'Bill', num: '2804-4292', name: 'Fireflies.ai Corp', desc: 'Remaining time on 9x Business ...', split: 'Accounts Payable (A/P)', amount: 1_690.01 },
    { type: 'Bill', num: '2804-4292', name: 'Fireflies.ai Corp', desc: 'Unused time on 8x Business Fire...', split: 'Accounts Payable (A/P)', amount: -1_502.23 },
  ];

  // 14 opening-balance bills shared by the A/P and Prior-Period sections.
  const openingBills = [
    ['BUNNYWAY', 1_068.12, 'Bill'],
    ['Corix Insurance Services LLC', 3_828.00, 'Bill'],
    ['Daily', 10_703.53, 'Bill'],
    ['Elevenlabs', 2_996.42, 'Bill'],
    ['Fly.io, Inc', 1_188.74, 'Bill'],
    ['Freeman', 22_482.29, 'Bill'],
    ['HeyGen', 537.00, 'Bill'],
    ['Mailgun Technologies, Inc', 332.53, 'Bill'],
    ['Minfy Technologies Private Limited', 10_524.78, 'Bill'],
    ['OpenAI, LLC', 5_644.07, 'Bill'],
    ['Pipedrive OU', 2_016.00, 'Bill'],
    ['Regus', 789.10, 'Bill'],
    ['Saleswinnr Technology Solutions...', -461.92, 'Vendor Credit'],
    ['SKYLINE Northeast', 33_040.06, 'Bill'],
  ];
  const apRows = [
    ...openingBills.map(([name, amount, type]) => ({
      type, num: '', name, desc: 'Opening Balance', split: 'Prior Period Expenses and Corre...', amount,
    })),
    { type: 'Bill', num: '9F62DE43-0023', name: 'Daily',            desc: '', split: 'Prior Period Expenses and Corre...', amount: 5_119.01 },
    { type: 'Bill', num: '2804-4292',     name: 'Fireflies.ai Corp', desc: '', split: 'Inventory Asset',                   amount: 187.78 },
    { type: 'Bill', num: 'BABB1F3F-0013', name: 'Daily',            desc: '', split: 'Prior Period Expenses and Corre...', amount: 5_660.50 },
  ];

  const daily9F = [
    ['Audio-only recording minutes F...', 0.28],
    ['Audio participant minutes Feb 2...', 0.00],
    ['First 10,000', 0.00],
    ['Cloud recording storage Feb 28...', 0.50],
    ['Cloud recording minutes Feb 28...', 2_037.52],
    ['Live streaming minutes Feb 28-...', 0.00],
    ['Real-Time Transcription Feb 28-...', 629.47],
    ['First 2,000', 0.00],
    ['2,001 and above', 629.47],
    ['First 10,000', 0.00],
    ['Next 10,001 to 99,999', 360.00],
    ['Next 100,000 to 499,999', 1_461.77],
  ];
  const dailyBABB = [
    ['Pipecat Cloud Reserved Session...', 1_157.84],
    ['Pipecat Cloud Active Session Mi...', 4_120.40],
    ['Pipecat Cloud Reserved Session...', 0.00],
    ['Pipecat Cloud Active Jan 31-Fe...', 0.00],
    ['Pipecat-Cloud Krisp Session Min...', 0.00],
    ['100,001 and above', 21.20],
    ['Pipecat-Cloud Reserved Session...', 0.00],
    ['Pipecat-Cloud Active Session Mi...', 0.00],
    ['Audio-only recording minutes Ja...', 0.00],
    ['Cloud recording storage Jan 31-...', 0.38],
    ['Cloud recording minutes Jan 31...', 360.68],
    ['Video participant minutes Ja 3...', 0.00],
    ['First 10,000', 0.00],
  ];
  const priorPeriodRows = [
    ...openingBills.map(([name, amount, type]) => ({
      type, num: '', name, desc: 'Opening Balance', split: 'Accounts Payable (A/P)', amount,
    })),
    ...daily9F.map(([desc, amount]) => ({
      type: 'Bill', num: '9F62DE43-0023', name: 'Daily', desc, split: 'Accounts Payable (A/P)', amount,
    })),
    ...dailyBABB.map(([desc, amount]) => ({
      type: 'Bill', num: 'BABB1F3F-0013', name: 'Daily', desc, split: 'Accounts Payable (A/P)', amount,
    })),
  ];

  const buildSection = (account, partials) => {
    const out = [{ label: `${account} (${partials.length})`, isHeader: true, level: 0 }];
    let bal = 0;
    for (const p of partials) {
      bal = Math.round((bal + p.amount) * 100) / 100;
      out.push({
        label: date,
        level: 1,
        cells: { type: p.type, num: p.num, name: p.name, desc: p.desc, split: p.split, amount: p.amount, balance: bal },
      });
    }
    out.push({ label: `Total for ${account}`, isSubtotal: true, level: 0, cells: { amount: bal } });
    return out;
  };

  const allRows = [
    ...buildSection('Accounts Receivable (A/R)', arRows),
    ...buildSection('Inventory Asset', inventoryRows),
    ...buildSection('Accounts Payable (A/P)', apRows),
    ...buildSection('Services', servicesRows),
    ...buildSection('Prior Period Expenses and Corrections', priorPeriodRows),
  ];
  const grand = Math.round(
    [arRows, inventoryRows, apRows, servicesRows, priorPeriodRows]
      .flat()
      .reduce((a, r) => a + r.amount, 0) * 100,
  ) / 100;

  return {
    columns: [
      { key: 'date',    label: 'Transaction date', align: 'left'  },
      { key: 'type',    label: 'Transaction type', align: 'left'  },
      { key: 'num',     label: 'Num',              align: 'left'  },
      { key: 'name',    label: 'Name',             align: 'left'  },
      { key: 'desc',    label: 'Description',      align: 'left'  },
      { key: 'split',   label: 'Split',            align: 'left'  },
      { key: 'amount',  label: 'Amount',           align: 'right' },
      { key: 'balance', label: 'Balance',          align: 'right' },
    ],
    rows: [...allRows, total('TOTAL', { amount: grand })],
    renderMode: 'normal',
    currency: 'USD',
  };
}

// QuickBooks "Vendor Contact List" — a flat directory of every vendor with
// company, contact and billing details (no totals, no period). Phone / Email /
// Account # / Tax ID are blank like the screenshot; Track 1099 is "No".
export function vendorContactList() {
  // [vendor, hasCompany, billing, fullnameOverride]
  const v = [
    ['Ahuja Valecha & Associates LLP', true, 'Meera Madhav | Cloud 9 Estate ...'],
    ['Airbnb', false, ''],
    ['Anthropic', true, 'San Francisco California United ...'],
    ['Apple', false, ''],
    ['Astra IT, Inc', true, '2093 PHILADELPHIA PIKE 4080 ...'],
    ['AT&T', false, ''],
    ['AVA Global Professional Service...', true, 'Meera Madhav | Cloud 9 Estate ...'],
    ['Best Buy', false, ''],
    ['Bitla & Co.,', true, '#13-6-345/1/A, Plot No.21, Ram...'],
    ['Blue Shield', false, ''],
    ['BLUETECH MEDIA LLP', true, 'BLUETECH MEDIA LLP WEWork...'],
    ['BUNNYWAY, informacijske storit...', true, 'Dunajska cesta 165 1000 Ljubljana'],
    ['CANVA', true, ''],
    ['Catenon India Private Limited', true, '6th Floor, The Kode, Baner - Pas...'],
    ['CertPro LLC', true, ''],
    ['Chick-Fil-A', false, ''],
    ['Corix Insurance Services LLC', true, '90 Park Avenue 27th Floor New ...'],
    ['Cursor', true, '801 West End Avenue New York...'],
    ['Dailpad,Inc', true, ''],
    ['Daily', true, '548 Market St Suite SAN FRAN...'],
    ['Deel, Inc', true, '425 1st St San Francisco United ...', 'Inc Deel'],
    ['De-Identification Inc.', true, 'Corporation Trust Center, 1209 ...'],
    ['Dell', true, ''],
    ['Dropbox', false, ''],
    ['EasyDMARC,Inc.', true, '8 The Green # 7668 Dover Dela...'],
    ['Elevenlabs', true, ''],
    ['Encore Group', false, ''],
    ['Fireflies.ai Corp', true, '2802 Vizzolini Court Pleasanton ...'],
    ['Fly.io, Inc', true, '2261 Market Street #4990 San F...', 'Inc Fly.io'],
    ['Freeman', true, ''],
    ['Frontier', true, ''],
    ['G2.com, Inc', true, '100 S. Wacker Dr., #600 Chicag...', 'Inc G2.com'],
    ['Google', false, ''],
    ['Groq Inc.', true, '301 CASTRO ST STE 200 Mount...'],
    ['GrubHub', false, ''],
    ['Hampton Inn and Suites by Hilton', true, '1277 US-22 Bridgewater New J...'],
    ['HCC Specialty', true, 'Edgewater Place Wakefield Mas...'],
    ['HeyGen', true, 'Millennium Drive Los Angeles C...'],
    ['HILTON AUSTIN AIRPORT', true, '9515 HOTEL DR AUSTIN, TX 78...'],
    ['HRV CertPro Pvt. Ltd.', true, '#C-7, Kudremukh Colony, Kora...'],
    ['Innovix Solutions ltd', true, '222B M.Saeed St Red Sea Hurg...'],
    ['Intuit (QuickBooks)', true, ''],
    ['IQPC Exchange LLC', true, '615 Channelside Drive Suite 20...'],
    ['IRS', false, ''],
    ['Lemlist', true, ''],
    ['lempire', true, 'France'],
    ['Life Sciences Trainers and Educa...', true, ''],
    ['LinkedIn', false, ''],
    ['LTEN', true, ''],
    ['Mailgun Technologies', false, ''],
    ['Mailgun Technologies, Inc', true, '112 E. Pecan St. #1135 San Ant...'],
    ['Market Resource Partners Limited', true, 'Weaving Works, 11 Ormeau Ave...'],
    ['Pipedrive OU', true, 'Mustamäe tee 3a Tallinn Harjum...'],
    ['PWP Screaming F', true, ''],
    ['Regus', true, '101 Hudson Street 21st Floor Je...'],
    ['Replicate, Inc.', true, '2261 Market Street #4056 San F...', 'Inc. Replicate'],
    ['Roberts Immigration Law Group...', true, '8 Wright St Ste 107, Westport C...'],
    ['Roca Services Corp dba Rainpro...', true, ''],
    ['Saleswinnr Technology Solutions...', true, ''],
    ['Semrush Privacycom', true, ''],
    ['Sheraton', true, 'Brussels Airport B-1930 Zavente...'],
    ['Shutterstock, Inc', true, 'Empire State Building 350 Fifth ...', 'Inc Shutterstock'],
    ['Singapore Airlines', true, 'Singapore'],
    ['SKYLINE Northeast', true, 'Trade Show Exhibits,Graphics & ...'],
    ['Smarketers LLP', true, '3rd floor, Sreshta Marvel Sy.No....'],
    ['Smart & Final', false, ''],
    ['Sprinto Inc', true, '580 California Street 12th & 16t...'],
    ['Subcontractor - Ethan Operndek', true, ''],
    ['Targetorate Consulting Inc', true, '1829 Walnut springs DR, Allen T...'],
    ['The Life Sciences Trainers & Edu...', true, '4423 Pheasant Ridge Road, Ste...'],
    ['The Phantom Company', true, '49 rue de Ponthieu rue de Pont...'],
    ['T Mobile', true, ''],
    ['Togai Inc.', true, ''],
    ['TT GROUP WORLDWIDE', true, 'Fifth Floor The Atrium 1 Harefiel...'],
    ['Uber', false, ''],
    ['UpGuard', true, 'STE # 120-387 650 Castro Stree...'],
    ['UptimeRobot', true, 'Obchodná 507/2 81106 Bratisla...'],
    ['US Govt Tax', true, ''],
    ['Virtualpost', true, ''],
    ['Vouch Insurance Services LLC', true, ''],
    ['Walmart', false, ''],
    ['Walt Disney World Dolphin', true, '1500 EPCOT Resorts Blvd Lake ...'],
    ['ZenLeads Inc. (dba Apollo.io)', true, ''],
    ['ZoomInfo technologies', true, ''],
  ];
  const rows = v.map(([vendor, hasCompany, billing, full]) => ({
    label: vendor,
    cells: {
      company: hasCompany ? vendor : '',
      phone: '',
      email: '',
      fullname: full || vendor,
      billing: billing || '',
      acct: '',
      taxid: '',
      track1099: 'No',
    },
  }));
  return {
    columns: [
      { key: 'vendor',    label: 'Vendor',          align: 'left' },
      { key: 'company',   label: 'Company',         align: 'left' },
      { key: 'phone',     label: 'Phone numbers',   align: 'left' },
      { key: 'email',     label: 'Email',           align: 'left' },
      { key: 'fullname',  label: 'Full name',       align: 'left' },
      { key: 'billing',   label: 'Billing address', align: 'left' },
      { key: 'acct',      label: 'Account #',       align: 'left' },
      { key: 'taxid',     label: 'Tax ID',          align: 'left' },
      { key: 'track1099', label: 'Track 1099',      align: 'left' },
    ],
    rows,
    renderMode: 'normal',
    currency: 'USD',
  };
}

// Zoho Books "GSTR-3B Summary" multi-section workbook. Numeric cells render as
// ₹0.00; string cells (the plain "0" of section 3.1.1 row (i), blanks) render
// verbatim; spanNote rows carry a centered note across the value columns;
// fullNote rows span the whole table; subhead rows are section sub-headers.
export function gstReturnsWorkbook() {
  return {
    workbook: true,
    currency: 'INR',
    sections: [
      {
        no: '3.1',
        title: 'Details of Outward Supplies and inward supplies liable to reverse charge',
        tint: 'blue',
        columns: ['Nature of Supply', 'Taxable Value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'],
        rows: [
          { cells: ['(a) Outward taxable supplies (other than zero rated, nil rated and exempted)', 0, 0, 0, 0, 0] },
          { cells: ['(b) Outward taxable supplies (zero rated)', 0, 0, null, null, 0] },
          { cells: ['(c) Other outward supplies (Nil rated, exempted)', 0, null, null, null, null] },
          { cells: ['(d) Inward supplies (liable to reverse charge)', 0, 0, 0, 0, 0] },
          { cells: ['(e) Non-GST outward supplies', 0, null, null, null, null] },
          { cells: ['Total Value', 0, 0, 0, 0, 0], bold: true },
        ],
      },
      {
        no: '3.1.1',
        title: 'Details of supplies notified under sub-section (5) of section 9 of the Central Goods and Services Tax Act',
        tint: 'blue',
        columns: ['Description', 'Taxable Value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'],
        rows: [
          { cells: ['(i) Taxable supplies on which electronic commerce operator pays tax under Sub-section (5) of Section 9 [To be furnished by the electronic commerce operator]', '0', '0', '0', '0', '0'] },
          { cells: ['(ii) Taxable supplies made by the registered person through electronic commerce operator, on which electronic commerce operator is required to pay tax under Sub-section (5) of Section 9 [To be furnished by the registered person making supplies through electronic commerce operator]', 0, null, null, null, null] },
        ],
      },
      {
        no: '3.2',
        title: 'Of the supplies shown in 3.1 (a) above, details of inter-State supplies made to unregistered persons, composition taxable persons and UIN holders',
        tint: 'blue',
        columns: ['', 'Place of Supply', 'Taxable Value', 'Integrated Tax'],
        rows: [
          { subhead: 'Supplies made to Unregistered Persons' },
          { cells: ['', '', null, null] },
          { subhead: 'Supplies made to Composition Taxable Persons' },
          { cells: ['', '', null, null] },
          { subhead: 'Supplies made to UIN holders' },
          { fullNote: 'We are not tracking supplies made to UIN holders' },
        ],
      },
      {
        no: '4',
        title: 'Eligible ITC',
        tint: 'orange',
        columns: ['Details', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess'],
        rows: [
          { subhead: '(A) ITC Available (whether in full or part)' },
          { cells: ['(1) Import of Goods', 0, null, null, 0] },
          { cells: ['(2) Import of Services', 0, null, null, 0] },
          { cells: ['(3) Inward supplies liable to reverse charge ( other than 1 & 2 above)', 0, 0, 0, 0] },
          { label: '(4) Inward supplies from ISD', spanNote: '- - -We do not support in Zoho Books- - -' },
          { cells: ['(5) All other ITC', 0, 0, 0, 0] },
        ],
      },
      {
        no: '5',
        title: 'Values of exempt, nil-rated and non-GST inward supplies',
        tint: 'orange',
        columns: ['Nature of Supply', 'Inter-State Supplies', 'Intra-State Supplies'],
        rows: [
          { cells: ['Composition Scheme, Exempted, Nil Rated', 0, 0] },
          { cells: ['Non-GST supply', 0, 0] },
        ],
      },
    ],
  };
}

// Zoho Books "Tax Summary" — flat list of taxes with taxable + tax amounts and
// a grand Total. Tax percentage is a plain string (9, 2.5) so it shows without
// currency; taxable/tax columns are money. The "Others" line and Total carry
// only a tax amount.
export function taxSummary() {
  // Each levy carries a drill-down `breakdown` (the contributing invoices /
  // bills / credit notes, same shape the live backend sends) so the demo
  // renders the expandable Tax Summary exactly like the real one.
  const rows = [
    { label: 'SGST9',   pct: '9',   taxable: 1_39_35_697.73, tax: 12_54_212.81, breakdown: [
      { date: '2026-04-10', ref: 'INV-2401', source: 'Acme Logistics',           amount: 5_00_000 },
      { date: '2026-05-15', ref: 'INV-2412', source: 'Northbeam Studios',        amount: 4_00_000 },
      { date: '2026-06-20', ref: 'INV-2431', source: 'Foundry Labs',             amount: 3_54_212.81 },
      { date: '2026-04-12', ref: 'INV-2405', source: 'Zeta India',               amount: 2_80_000 },
      { date: '2026-04-19', ref: 'INV-2409', source: 'Paytm Services',           amount: 2_45_000 },
      { date: '2026-05-02', ref: 'INV-2413', source: 'Razorpay Software',        amount: 2_10_000 },
      { date: '2026-05-18', ref: 'INV-2418', source: 'Freshworks Inc.',          amount: 1_95_000 },
      { date: '2026-06-01', ref: 'INV-2424', source: 'Zoho Corporation',         amount: 1_72_000 },
      { date: '2026-06-14', ref: 'INV-2429', source: 'Groww Financial',          amount: 1_48_000 },
      { date: '2026-06-27', ref: 'INV-2435', source: 'Swiggy Marketplace',       amount: 1_21_500 },
      { date: '2026-07-05', ref: 'INV-2439', source: 'Ola Electric',             amount: 96_000 },
      { date: '2026-07-16', ref: 'INV-2444', source: 'Dream11 Fantasy',          amount: 74_250 },
      { date: '2026-07-29', ref: 'INV-2449', source: 'Cred Payments',            amount: 51_750 },
    ] },
    { label: 'SGST6',   pct: '6',   taxable: -2_85_332.27,   tax: -17_119.92, breakdown: [
      { date: '2026-04-18', ref: 'BILL-881', source: 'WeWork Bandra',           amount: -7_500 },
      { date: '2026-05-22', ref: 'BILL-904', source: 'AWS',                     amount: -5_000 },
      { date: '2026-06-30', ref: 'BILL-921', source: 'Bharti Airtel Ltd.',      amount: -4_619.92 },
    ] },
    { label: 'SGST2.5', pct: '2.5', taxable: -95_786.31,     tax: -2_394.67, breakdown: [
      { date: '2026-04-05', ref: 'BILL-870', source: 'Upender Traders',         amount: -1_200 },
      { date: '2026-05-11', ref: 'BILL-889', source: 'Stripe Atlas',            amount: -800 },
      { date: '2026-06-02', ref: 'BILL-901', source: 'Regus',                   amount: -394.67 },
    ] },
    { label: 'IGST5',   pct: '5',   taxable: -90_450.00,     tax: -4_522.50, breakdown: [
      { date: '2026-04-12', ref: 'INV-2406', source: 'Ramp',                    amount: -2_000 },
      { date: '2026-05-03', ref: 'INV-2415', source: 'Linear Inc.',             amount: -1_500 },
      { date: '2026-06-25', ref: 'INV-2438', source: 'ABC Corporate Pvt Ltd',   amount: -1_022.50 },
    ] },
    { label: 'IGST18',  pct: '18',  taxable: 59_38_491.10,   tax: 10_68_928.38, breakdown: [
      { date: '2026-04-20', ref: 'INV-2410', source: 'Acme Logistics',          amount: 4_50_000 },
      { date: '2026-05-28', ref: 'INV-2422', source: 'Foundry Labs',            amount: 3_25_000 },
      { date: '2026-06-15', ref: 'INV-2433', source: 'Northbeam Studios',       amount: 2_93_928.38 },
    ] },
    { label: 'IGST12',  pct: '12',  taxable: -6_035.00,      tax: -724.20, breakdown: [
      { date: '2026-05-09', ref: 'BILL-894', source: 'Saleswinnr Technology Solutions', amount: -400 },
      { date: '2026-06-19', ref: 'BILL-912', source: 'HeyGen',                  amount: -324.20 },
    ] },
    { label: 'CGST9',   pct: '9',   taxable: 1_39_35_697.73, tax: 12_54_212.81, breakdown: [
      { date: '2026-04-10', ref: 'INV-2401', source: 'Acme Logistics',          amount: 5_00_000 },
      { date: '2026-05-15', ref: 'INV-2412', source: 'Northbeam Studios',       amount: 4_00_000 },
      { date: '2026-06-20', ref: 'INV-2431', source: 'Foundry Labs',            amount: 3_54_212.81 },
    ] },
    { label: 'CGST6',   pct: '6',   taxable: -2_85_332.27,   tax: -17_119.92, breakdown: [
      { date: '2026-04-18', ref: 'BILL-881', source: 'WeWork Bandra',           amount: -7_500 },
      { date: '2026-05-22', ref: 'BILL-904', source: 'AWS',                     amount: -5_000 },
      { date: '2026-06-30', ref: 'BILL-921', source: 'Bharti Airtel Ltd.',      amount: -4_619.92 },
    ] },
    { label: 'CGST2.5', pct: '2.5', taxable: -95_786.31,     tax: -2_394.67, breakdown: [
      { date: '2026-04-05', ref: 'BILL-870', source: 'Upender Traders',         amount: -1_200 },
      { date: '2026-05-11', ref: 'BILL-889', source: 'Stripe Atlas',            amount: -800 },
      { date: '2026-06-02', ref: 'BILL-901', source: 'Regus',                   amount: -394.67 },
    ] },
  ];
  const dataRows = rows.map((r) => ({
    label: r.label,
    cells: { pct: r.pct, taxable: r.taxable, tax: r.tax },
    ...(r.breakdown && { breakdown: r.breakdown }),
  }));
  dataRows.push({ label: 'Others (Manual transactions in Output IGST account)', cells: { pct: null, taxable: null, tax: -29_91_623.81 } });
  dataRows.push({ label: 'Total', isTotal: true, cells: { pct: null, taxable: null, tax: 5_41_454.31 } });
  return {
    columns: [
      { key: 'name',    label: 'Tax Name',        align: 'left' },
      { key: 'pct',     label: 'Tax Percentage',  align: 'right' },
      { key: 'taxable', label: 'Taxable Amount',  align: 'right', money: true },
      { key: 'tax',     label: 'Tax Amount',      align: 'right', money: true },
    ],
    rows: dataRows,
    renderMode: 'normal',
    currency: 'INR',
    zoho: { module: 'Taxes', title: 'Tax Summary', basis: 'Accrual' },
  };
}

// Zoho Books "TDS Summary" — tax deducted at source grouped by TDS section. Each
// section row carries a two-line label (section + nature) via `sublabel`; the
// Total row only has the tax-deducted figure.
export function tdsSummary() {
  const rows = [
    { label: 'Section 194 I', sublabel: 'Rent on land or furniture etc and Rent on plant and machinery', tds: 3_07_567.17, total: 30_91_138.00, after: 27_83_570.83 },
    { label: 'Section 194 J', sublabel: 'Professional Fees', tds: 5_96_260.08, total: 59_62_600.64, after: 53_66_340.56 },
  ];
  const dataRows = rows.map((r) => ({
    label: r.label,
    sublabel: r.sublabel,
    cells: { tds: r.tds, total: r.total, after: r.after },
  }));
  dataRows.push({ label: 'Total', isTotal: true, cells: { tds: 9_03_827.25, total: null, after: null } });
  return {
    columns: [
      { key: 'section', label: 'TDS Section',                align: 'left' },
      { key: 'tds',     label: 'Tax Deducted at Source',    align: 'right', money: true },
      { key: 'total',   label: 'Total',                     align: 'right', money: true },
      { key: 'after',   label: 'Total After TDS Deduction', align: 'right', money: true },
    ],
    rows: dataRows,
    renderMode: 'normal',
    currency: 'INR',
    zoho: {
      module: 'Taxes',
      title: 'TDS Summary',
      basis: 'Accrual',
      groupBy: 'TDS Section',
      reportBy: { label: 'Report Basis', value: 'Accrual', options: ['Accrual', 'Cash'] },
    },
  };
}

// QuickBooks "Bank Reconciliation" — the Reconcile "History by account" page.
// A bank account has no saved reconciliation history yet, so the table is empty
// and shows QuickBooks' empty-state prompt. Account + Report period are the only
// filters.
export function bankReconciliation() {
  return {
    qbReconcile: true,
    currency: 'USD',
    accounts: ['Analysis Checking (2...)'],
    reportPeriods: ['All Dates'],
    columns: [
      'Statement ending date', 'Reconciled on', 'Ending balance',
      'Changes', 'Auto adjustment', 'Statements', 'Action',
    ],
    rows: [],
    emptyText: "Each time you reconcile this account, the reconciliation report is saved here. If you're ready to reconcile now, click the Reconcile tab.",
  };
}

// QuickBooks "General Ledger" — every posted transaction grouped by distribution
// account. Each account section shows a "Beginning Balance" row (running Balance
// column) and a "Total for <account>" subtotal. Columns mirror QBO exactly:
// Distribution account / Transaction date / Transaction type / Num / Name /
// Description / Split / Amount / Balance.
export function generalLedger() {
  const cols = [
    { key: 'label',   label: 'Distribution account', align: 'left'  },
    { key: 'date',    label: 'Transaction date',     align: 'left'  },
    { key: 'type',    label: 'Transaction type',     align: 'left'  },
    { key: 'num',     label: 'Num',                  align: 'left'  },
    { key: 'name',    label: 'Name',                 align: 'left'  },
    { key: 'desc',    label: 'Description',          align: 'left'  },
    { key: 'split',   label: 'Split',                align: 'left'  },
    { key: 'amount',  label: 'Amount',               align: 'right' },
    { key: 'balance', label: 'Balance',              align: 'right' },
  ];

  // [account, beginningBalance]. `null` balance = no opening balance shown.
  const accounts = [
    ['Accounts Receivable (A/R)',            1_362_376.28],
    ['Inventory Asset',                        405_070.94],
    ['Uncategorized Asset',                         99.00],
    ['Accounts Payable (A/P)',                 592_291.04],
    ['Services',                             1_362_376.28],
    ['Advertising & marketing',                    200.00],
    ['Commissions & fees',                         600.00],
    ['Employee benefits',                        9_500.00],
    ['Prior Period Expenses and Corrections',  176_821.10],
    ['Office expenses',                               null],
  ];

  const rows = [];
  accounts.forEach(([name, bal]) => {
    rows.push(header(`${name} (1)`));
    rows.push({ label: 'Beginning Balance', level: 1, cells: { balance: bal } });
    // Office expenses with sub-accounts gets QuickBooks' distinct subtotal label.
    const totalLabel = name === 'Office expenses'
      ? 'Total for Office expenses with sub-accounts'
      : `Total for ${name}`;
    rows.push(subtotal(totalLabel, {}));
  });

  return {
    columns: cols,
    renderMode: 'normal',
    currency: CURRENCY,
    rows,
  };
}

// Zoho Books "Realized Gain or Loss" (Currency module) — settled FX gains/losses
// per transaction. Empty for organisations with no multi-currency settlements;
// shows Zoho's "No data to display" state and the base-currency footnote.
export function realizedGainLoss() {
  return {
    columns: [
      { key: 'date',     label: 'Date',            align: 'left'  },
      { key: 'type',     label: 'Transaction Type',align: 'left'  },
      { key: 'currency', label: 'Currency',        align: 'left'  },
      { key: 'rate',     label: 'Exchange Rate',   align: 'right' },
      { key: 'realized', label: 'Realized Amount', align: 'right', money: true },
      { key: 'gainloss', label: 'Gain or Loss',    align: 'right', money: true },
    ],
    rows: [],
    renderMode: 'normal',
    currency: 'INR',
    zoho: {
      module: 'Currency',
      title: 'Realized Gain or Loss',
      emptyText: 'No data to display',
      baseCurrencyNote: true,
    },
  };
}

// ----------------------------------------------------------------------------
// Single-period grouped reports (Sales by Customer, Expenses by Vendor, etc.)

function singlePeriodTable(labelHeader, rows) {
  const cols = [
    { key: 'label',  label: labelHeader, align: 'left' },
    { key: 'count',  label: 'Txns',      align: 'right' },
    { key: 'amount', label: 'Amount',    align: 'right' },
  ];
  const dataRows = rows.map(([name, count, amount]) =>
    data(name, { count, amount }));
  return {
    columns: cols,
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [
      ...dataRows,
      total('Total', { count: sum(dataRows, 'count'), amount: sum(dataRows, 'amount') }),
    ],
  };
}

export function salesByCustomer() {
  // QuickBooks "Sales by Customer Summary": a single "Total" column listing
  // each customer's total sales, then a grand "TOTAL" row — mirroring QBO.
  const customers = [
    ['AbbVie,Inc.',                                63_474.38],
    ['AstraZeneca CAMCAR Costa Rica SA',            6_120.00],
    ['Bayer (China) Limited',                     106_531.26],
    ['Bayer Consumer Care AG',                     82_500.00],
    ['Bellmore Home Center, Inc.',                  7_440.00],
    ['Boston Scientific',                           1_391.40],
    ['Boston Scientific Asia Pacific Pte. Ltd.',   11_500.00],
    ['Boston Scientific Corporation',              13_556.00],
    ['Boston Scientific International SA',          15_005.00],
    ['ConvaTec Inc.',                             196_896.00],
    ['DePuy Orthopaedics Inc',                     34_776.00],
    ['Effective People A/S',                       30_300.00],
    ['Exact Sciences Corporation',                348_000.00],
    ['Gilead Sciences,Inc',                       237_600.00],
    ['GP Strategies (Thailand) Co., Ltd.',          5_432.00],
    ['GP Strategies Limited GBR 402',               8_564.00],
    ['GP Strategies Middle East Training LLC',      9_650.00],
    ['GP Strategies Singapore (Asia) Pte. Ltd.',   36_585.00],
    ['GP Strategies Taiwan Ltd',                    3_260.00],
    ['MERCK HEALTHCARE VIETNAM LIMITED',            5_336.00],
    ['Nokia Solutions and Networks Gmbh& Co.KG',   10_250.00],
    ['Novo Nordisk Inc.',                          89_400.00],
    ['Novo Nordisk Pharma (Singapore) Pte Ltd',    14_920.00],
    ['Sixt Se .',                                  16_659.24],
    ['Viatris Middle EastFZ-LLC',                   7_230.00],
  ];
  const dataRows = customers.map(([name, amount]) => data(name, { total: amount }));
  return {
    columns: [
      { key: 'label', label: '',      align: 'left'  },
      { key: 'total', label: 'Total', align: 'right' },
    ],
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [
      ...dataRows,
      total('TOTAL', { total: sum(dataRows, 'total') }),
    ],
  };
}

export function salesByProductDetail() {
  // QuickBooks "Sales by Product/Service Detail": line-level rows grouped under
  // the "Services" product/service, with a running Balance column, a group
  // subtotal and a grand TOTAL. Same customers/amounts as Sales by Customer.
  const cents = (n) => Math.round(n * 100) / 100;
  const lines = [
    ['AbbVie,Inc.',                                63_474.38],
    ['AstraZeneca CAMCAR Costa Rica SA',            6_120.00],
    ['Bayer (China) Limited',                     106_531.26],
    ['Bayer Consumer Care AG',                     82_500.00],
    ['Bellmore Home Center, Inc.',                  7_440.00],
    ['Boston Scientific',                           1_391.40],
    ['Boston Scientific Asia Pacific Pte. Ltd.',   11_500.00],
    ['Boston Scientific Corporation',              13_556.00],
    ['Boston Scientific International SA',          15_005.00],
    ['ConvaTec Inc.',                             196_896.00],
    ['DePuy Orthopaedics Inc',                     34_776.00],
    ['Effective People A/S',                       30_300.00],
    ['Exact Sciences Corporation',                348_000.00],
    ['Gilead Sciences,Inc',                       237_600.00],
    ['GP Strategies (Thailand) Co., Ltd.',          5_432.00],
    ['GP Strategies Limited GBR 402',               8_564.00],
    ['GP Strategies Middle East Training LLC',      9_650.00],
    ['GP Strategies Singapore (Asia) Pte. Ltd.',   36_585.00],
    ['GP Strategies Taiwan Ltd',                    3_260.00],
    ['MERCK HEALTHCARE VIETNAM LIMITED',            5_336.00],
    ['Nokia Solutions and Networks Gmbh& Co.KG',   10_250.00],
    ['Novo Nordisk Inc.',                          89_400.00],
    ['Novo Nordisk Pharma (Singapore) Pte Ltd',    14_920.00],
    ['Sixt Se .',                                  16_659.24],
    ['Viatris Middle EastFZ-LLC',                   7_230.00],
  ];
  let running = 0;
  const dataRows = lines.map(([customer, amount]) => {
    running = cents(running + amount);
    return {
      label: '05/22/2026',
      level: 1,
      cells: {
        type: 'Invoice',
        num: '',
        customer,
        desc: 'Opening Balance',
        qty: '',
        price: '',
        amount,
        balance: running,
        item: 'Services',
      },
    };
  });
  const grand = sum(dataRows, 'amount');
  return {
    columns: [
      { key: 'label',    label: 'Transaction date',   align: 'left'  },
      { key: 'type',     label: 'Transaction type',   align: 'left'  },
      { key: 'num',      label: 'Num',                align: 'left'  },
      { key: 'customer', label: 'Customer full name', align: 'left'  },
      { key: 'desc',     label: 'Description',        align: 'left'  },
      { key: 'qty',      label: 'Quantity',           align: 'right' },
      { key: 'price',    label: 'Sales price',        align: 'right' },
      { key: 'amount',   label: 'Amount',             align: 'right' },
      { key: 'balance',  label: 'Balance',            align: 'right' },
      { key: 'item',     label: 'Product/Service',    align: 'left'  },
    ],
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [
      { label: `Services (${lines.length})`, isHeader: true, level: 0 },
      ...dataRows,
      subtotal('Total for Services', { amount: grand }),
      total('TOTAL', { amount: grand }),
    ],
  };
}

export function expensesByVendor() {
  return singlePeriodTable('Vendor', [
    ['WeWork Bandra',         12, 168_000],
    ['AWS',                   24, 124_820],
    ['Google Workspace',       6,  18_400],
    ['Bharti Airtel Ltd.',    11,  82_420],
    ['Upender Traders',        9,  64_080],
    ['Stripe Atlas',           4,  18_900],
  ]);
}

export function expensesByVendorSummary() {
  // QuickBooks "Expenses by Vendor Summary": a single "Total" column listing
  // each vendor's total spend, then a grand "TOTAL" row — mirroring QBO.
  const vendors = [
    ['Anthropic',                                      200.00],
    ['BUNNYWAY, informacijske storitve d.o.o.',     54_965.12],
    ['Corix Insurance Services LLC',                 3_828.00],
    ['Daily',                                       30_350.84],
    ['Elevenlabs',                                   4_983.21],
    ['Fly.io, Inc',                                  1_188.74],
    ['Freeman',                                     22_482.29],
    ['HeyGen',                                          537.00],
    ['Life Sciences Trainers and Educators Network', 9_500.00],
    ['Mailgun Technologies',                             0.00],
    ['Mailgun Technologies, Inc',                      332.53],
    ['Minfy Technologies Private Limited',          10_524.78],
    ['OpenAI, LLC',                                  5_644.07],
    ['Oremus Corporation NA',                          600.00],
    ['Pipedrive OU',                                 2_016.00],
    ['Regus',                                        7_390.38],
    ['Saleswinnr Technology Solutions Pvt Ltd - Cr',  -461.92],
    ['SKYLINE Northeast',                           33_040.06],
  ];
  const dataRows = vendors.map(([name, amount]) => data(name, { total: amount }));
  return {
    columns: [
      { key: 'label', label: '',      align: 'left'  },
      { key: 'total', label: 'Total', align: 'right' },
    ],
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [
      ...dataRows,
      total('TOTAL', { total: sum(dataRows, 'total') }),
    ],
  };
}

export function purchasesByVendor() {
  return singlePeriodTable('Vendor', [
    ['Foxconn Components',     8, 312_400],
    ['Reliance Industries',    6, 268_900],
    ['Tata Steel',             4, 184_200],
    ['Allied Hardware',       12,  82_400],
    ['Office Depot',           5,  18_400],
  ]);
}

export function unpaidBills() {
  const cols = [
    { key: 'label',  label: 'Vendor',       align: 'left' },
    { key: 'ref',    label: 'Bill #',       align: 'left' },
    { key: 'date',   label: 'Bill date',    align: 'left' },
    { key: 'due',    label: 'Due date',     align: 'left' },
    { key: 'amount', label: 'Open amount',  align: 'right' },
  ];
  const rows = [
    ['WeWork Bandra',      'BILL-04-014', '2026-04-04', '2026-05-04',  168_000],
    ['AWS',                'BILL-04-022', '2026-04-12', '2026-05-12',   42_400],
    ['Bharti Airtel Ltd.', 'BILL-04-031', '2026-04-18', '2026-05-18',    8_900],
    ['Upender Traders',    'BILL-04-040', '2026-04-22', '2026-05-22',    6_400],
    ['Stripe Atlas',       'BILL-04-044', '2026-04-26', '2026-05-26',    1_900],
  ];
  const dataRows = rows.map(([label, ref, date, due, amount]) =>
    data(label, { ref, date, due, amount }));
  return {
    columns: cols,
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [...dataRows, total('Total', { amount: sum(dataRows, 'amount') })],
  };
}

// ----------------------------------------------------------------------------
// Chart of Accounts / Account List

export function accountList() {
  const cols = [
    { key: 'label',   label: 'Account',      align: 'left' },
    { key: 'type',    label: 'Type',         align: 'left' },
    { key: 'balance', label: 'Balance',      align: 'right' },
  ];
  const rows = [
    ['Cash',                   'Bank',                  1_204_000],
    ['Accounts Receivable',    'Asset',                   486_000],
    ['Inventory',              'Asset',                   238_000],
    ['Property & Equipment',   'Fixed Asset',             612_000],
    ['Accounts Payable',       'Liability',               228_000],
    ['Sales Tax Payable',      'Liability',                41_000],
    ['Long-term Debt',         'Liability',               348_000],
    ['Retained Earnings',      'Equity',                1_618_000],
    ['Revenue',                'Income',                2_499_000],
    ['Cost of Sales',          'Cost of Goods Sold',      704_300],
    ['Operating Expenses',     'Expense',                 672_700],
  ];
  const dataRows = rows.map(([label, type, balance]) =>
    data(label, { type, balance }));
  return {
    columns: cols,
    renderMode: 'normal',
    currency: CURRENCY,
    rows: dataRows,
  };
}

// ----------------------------------------------------------------------------
// Executive Summary (Xero-style)

export function executiveSummary() {
  const cols = [
    { key: 'label', label: '',          align: 'left' },
    { key: 'cur',   label: 'This month', align: 'right' },
    { key: 'prv',   label: 'Last month', align: 'right' },
    { key: 'var',   label: 'Variance',   align: 'right' },
  ];
  const round2 = (n) => Math.round(n * 100) / 100;
  // Xero Executive Summary is grouped into sections; each leaf carries a unit so
  // the viewer can format currency vs %, days and ratios correctly. Variance is
  // the change from last month to this month.
  const sec = (label) => ({ label, level: 0, isHeader: true, cells: {} });
  const row = (label, cur, prv, unit = 'currency', emphasize = false) => ({
    label,
    level: 1,
    unit,
    ...(emphasize && { isSubtotal: true }),
    cells: { cur, prv, var: round2(cur - prv) },
  });
  const rows = [
    sec('Cash'),
    row('Cash received',            1_864_000,   1_412_000),
    row('Cash spent',               1_492_000,   1_184_000),
    row('Cash surplus (deficit)',     372_000,     228_000, 'currency', true),
    row('Closing bank balance',     1_204_000,     942_000),

    sec('Profitability'),
    row('Income',                   2_499_000,   2_000_000),
    row('Direct costs',               704_300,     581_900),
    row('Gross profit (loss)',      1_794_700,   1_418_100, 'currency', true),
    row('Other income',                18_000,      14_500),
    row('Expenses',                   672_700,     549_000),
    row('Profit (loss)',            1_140_000,     883_600, 'currency', true),

    sec('Balance Sheet'),
    row('Debtors',                  3_471_674.91, 3_471_674.91),
    row('Creditors',                8_013_907.73, 8_013_907.73),
    row('Net Equity',              -2_854_749.71,-2_854_749.71, 'currency', true),

    sec('Sales'),
    row('Number of invoices issued',      128,         112,  'number'),
    row('Average value of invoices',   19_520,      17_860),

    sec('Performance'),
    row('Gross profit margin (%)',       71.8,        70.9,  'percent'),
    row('Net profit margin (%)',         45.6,        44.2,  'percent'),
    row('Return on investment (p.a.) (%)', 18.4,      16.9,  'percent'),

    sec('Position'),
    row('Average debtor days',             32,          38,  'days'),
    row('Average creditor days',           28,          30,  'days'),
    row('Short term cash forecast',  -4_542_232.82, -4_542_232.82),
    row('Current assets to liabilities',  0.61,        0.61, 'ratio'),
    row('Term assets to liabilities',     1.42,        1.38, 'ratio'),
  ];
  return { columns: cols, renderMode: 'normal', currency: CURRENCY, rows };
}

// ----------------------------------------------------------------------------
// Budget Summary — Xero-style monthly budget across a fiscal year (Jan–Dec)
// plus a Total column. Rows follow a P&L shape (Income → Gross Profit → Net
// Profit). The dedicated BudgetSummaryViewer renders all month columns.

export function budgetSummary() {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const year = 2026;
  const monthKeys = MONTHS.map((_, i) => `m${i + 1}`);
  const cols = [
    { key: 'label', label: '', align: 'left' },
    ...MONTHS.map((m, i) => ({ key: monthKeys[i], label: `${m} ${year}`, align: 'right' })),
    { key: 'total', label: 'Total', align: 'right' },
  ];

  // Build a row from a base monthly amount with a small deterministic ripple,
  // then append a Total = sum of months.
  const rnd = seeded('budget-summary');
  const lineFrom = (base, drift = 0.06) => {
    const cells = {};
    let total = 0;
    monthKeys.forEach((k) => {
      const v = Math.round(base * (1 + (rnd() - 0.5) * 2 * drift));
      cells[k] = v;
      total += v;
    });
    cells.total = total;
    return cells;
  };
  const combine = (rowsArr, op = 1) => {
    const cells = {};
    [...monthKeys, 'total'].forEach((k) => {
      cells[k] = rowsArr.reduce((acc, r) => acc + op * (r.cells[k] || 0), 0);
    });
    return cells;
  };
  const sales = data('Sales', lineFrom(420_000));
  const otherRevenue = data('Other Revenue', lineFrom(36_000));
  const totalIncome = subtotal('Total Income', combine([sales, otherRevenue]));

  const cogs = data('Cost of Goods Sold', lineFrom(168_000));
  const totalCos = subtotal('Total Cost of Sales', combine([cogs]));

  const grossProfit = { label: 'Gross Profit', isSubtotal: true, cells: combine([totalIncome, totalCos], 1) };
  // Gross Profit = Income − Cost of Sales
  [...monthKeys, 'total'].forEach((k) => { grossProfit.cells[k] = (totalIncome.cells[k] || 0) - (totalCos.cells[k] || 0); });

  const rent = data('Rent', lineFrom(48_000, 0.01));
  const wages = data('Wages & Salaries', lineFrom(132_000));
  const marketing = data('Marketing', lineFrom(28_000));
  const utilities = data('Utilities', lineFrom(9_000));
  const general = data('General Expenses', lineFrom(21_000));
  const opexRows = [rent, wages, marketing, utilities, general];
  const totalOpex = subtotal('Total Operating Expenses', combine(opexRows));

  const netProfit = { label: 'Net Profit', isTotal: true, cells: {} };
  [...monthKeys, 'total'].forEach((k) => { netProfit.cells[k] = (grossProfit.cells[k] || 0) - (totalOpex.cells[k] || 0); });

  const rows = [
    header('Income'),
    sales,
    otherRevenue,
    totalIncome,
    header('Less Cost of Sales'),
    cogs,
    totalCos,
    grossProfit,
    header('Less Operating Expenses'),
    ...opexRows,
    totalOpex,
    netProfit,
  ];

  return { columns: cols, renderMode: 'normal', currency: CURRENCY, budgetName: 'Overall Budget', rows };
}

// ----------------------------------------------------------------------------
// Budget Variance — Xero-style actuals-vs-budget with Variance + Variance % for
// both the selected month and the year-to-date window. Each row carries the four
// base figures (month actual/budget, YTD actual/budget); the dedicated
// BudgetVarianceViewer derives the variance columns and period labels live.

export function budgetVariance() {
  const round2 = (n) => Math.round(n * 100) / 100;
  const YTD_MONTHS = 6; // Jan–Jun window in the reference layout.

  // A leaf line: monthly actual + monthly budget; YTD = monthly × window.
  const line = (label, actM, budM) => ({
    label,
    cells: { actM, budM, actY: round2(actM * YTD_MONTHS), budY: round2(budM * YTD_MONTHS) },
  });
  const sumCells = (rowsArr) => {
    const c = {};
    ['actM', 'budM', 'actY', 'budY'].forEach((k) => {
      c[k] = round2(rowsArr.reduce((acc, r) => acc + (r.cells[k] || 0), 0));
    });
    return c;
  };
  const diffCells = (a, b) => {
    const c = {};
    ['actM', 'budM', 'actY', 'budY'].forEach((k) => { c[k] = round2((a.cells[k] || 0) - (b.cells[k] || 0)); });
    return c;
  };

  const income = [line('Management Charge', 88_644, 90_000)];
  const totalIncome = { label: 'Total Trading Income', isSubtotal: true, cells: sumCells(income) };

  const cos = [line('Consulting', 124_783, 110_000)];
  const totalCos = { label: 'Total Cost of Sales', isSubtotal: true, cells: sumCells(cos) };

  const grossProfit = { label: 'Gross Profit', isSubtotal: true, cells: diffCells(totalIncome, totalCos) };

  const opex = [
    line('Accounting fees', 52_000, 50_000),
    line('CAM Charges/Housekeeping Expenses', 81_982, 78_000),
    line('Electricity Charges', 10_537, 12_000),
    line('Meal Coupon Service charges', 481, 600),
    line('Non Claimable GST', 87, 100),
    line('Office expenses', 3_936, 4_500),
    line('Professional Fees', 833, 1_000),
    line('Recruitment fees', 86_359, 60_000),
    line('Rent', 365_462, 360_000),
    line('Repairs & Maintenance', 14_029, 12_000),
    line('ROC Charges', 800, 1_000),
    line('Telephone & Internet', 1_416, 1_500),
    line('Water Charges', 351, 400),
  ];
  const totalOpex = { label: 'Total Operating Expenses', isSubtotal: true, cells: sumCells(opex) };

  const netProfit = { label: 'Net Profit', isTotal: true, cells: diffCells(grossProfit, totalOpex) };

  // Placeholder labels; the viewer overrides month/YTD labels from the filters.
  const cols = [
    { key: 'label', label: '',                    align: 'left'  },
    { key: 'actM',  label: 'This month',          align: 'right' },
    { key: 'budM',  label: 'Budget',              align: 'right' },
    { key: 'varM',  label: 'Variance',            align: 'right' },
    { key: 'varpM', label: 'Variance %',          align: 'right' },
    { key: 'actY',  label: 'Year to date',        align: 'right' },
    { key: 'budY',  label: 'Budget',              align: 'right' },
    { key: 'varY',  label: 'Variance',            align: 'right' },
    { key: 'varpY', label: 'Variance %',          align: 'right' },
  ];

  const rows = [
    header('Trading Income'),
    ...income,
    totalIncome,
    header('Cost of Sales'),
    ...cos,
    totalCos,
    grossProfit,
    header('Operating Expenses'),
    ...opex,
    totalOpex,
    netProfit,
  ];

  return { columns: cols, renderMode: 'normal', currency: CURRENCY, budgetName: 'Overall Budget', rows };
}

// ----------------------------------------------------------------------------
// Sales Tax Liability / Summary

export function taxLiability() {
  const cols = [
    { key: 'label',    label: 'Tax agency',     align: 'left' },
    { key: 'taxable',  label: 'Taxable sales',  align: 'right' },
    { key: 'rate',     label: 'Rate',           align: 'left' },
    { key: 'collected',label: 'Collected',      align: 'right' },
    { key: 'owed',     label: 'Owed',           align: 'right' },
  ];
  const rows = [
    ['State of California',  812_000, '7.25%',  58_870,  58_870],
    ['State of New York',    412_000, '8.875%', 36_565,  36_565],
    ['Karnataka GST',        298_000, '18%',    53_640,  53_640],
    ['Maharashtra GST',      184_000, '18%',    33_120,  33_120],
  ];
  const dataRows = rows.map(([label, taxable, rate, collected, owed]) =>
    data(label, { taxable, rate, collected, owed }));
  return {
    columns: cols,
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [
      ...dataRows,
      total('Total', {
        taxable: sum(dataRows, 'taxable'),
        collected: sum(dataRows, 'collected'),
        owed: sum(dataRows, 'owed'),
      }),
    ],
  };
}

// ----------------------------------------------------------------------------
// Generic fallback — deterministic table built from the report name.

export function genericReport(name) {
  const rng = seeded(name);
  const baseLabels = [
    'Operating Group A', 'Operating Group B', 'Operating Group C',
    'Strategic Initiatives', 'Recurring Items', 'One-time Items',
    'External Services', 'Internal Allocation',
  ];
  const rowCount = 6 + Math.floor(rng() * 4); // 6–9 rows
  const rows = Array.from({ length: rowCount }, (_, i) => {
    const cur = Math.round(10_000 + rng() * 240_000);
    const prv = Math.round(cur * (0.6 + rng() * 0.6));
    return data(`${baseLabels[i % baseLabels.length]} ${i + 1}`, { cur, prv });
  });
  const totalRow = total('Total', {
    cur: sum(rows, 'cur'),
    prv: sum(rows, 'prv'),
  });

  return {
    columns: periodCols(),
    renderMode: 'normal',
    currency: CURRENCY,
    rows: [header(name), ...rows, totalRow],
  };
}

// ----------------------------------------------------------------------------
// Dispatcher — match by canonical report name, with aliases for the variants
// used by QuickBooks Online and Xero so we don't have to duplicate generators.

const REGISTRY = {
  // Profit and Loss family
  'Profit and Loss':                       profitAndLoss,
  'Profit and Loss Comparison':            profitAndLoss,
  'Profit and Loss Detail':                profitAndLoss,
  'Profit and Loss YTD Comparison':        profitAndLoss,
  'Profit and Loss by Branch':             profitAndLoss,
  'Comparative P&L':                       profitAndLoss,
  'YoY Trend':                             profitAndLoss,
  'Horizontal Balance Sheet':              balanceSheet,

  // Balance Sheet family
  'Balance Sheet':                         balanceSheet,
  'Balance Sheet Comparison':              balanceSheet,
  'Balance Sheet Detail':                  balanceSheet,
  'Balance Sheet Summary':                 balanceSheet,
  'Movements in Equity':                   balanceSheet,
  'Movement of Equity':                    balanceSheet,

  // Cash flow family
  'Cash Flow Statement':                   cashFlow,
  'Statement of Cash Flows':               cashFlow,
  'Statement of Cash Flows - Direct':      cashFlowsDirect,
  'Statement of Cash Flows - Indirect':    cashFlow,
  'Cash Summary':                          cashSummary,
  'Future Cash Flow':                      cashFlow,
  'Daily Cash Position':                   cashFlow,

  // Foreign currency
  'Foreign Currency Gains and Losses':     foreignCurrencyGains,
  'Realized Gain or Loss':                 realizedGainLoss,
  'Realised FX Gain or Loss':              realizedGainLoss,

  // Trial balance / journals / GL
  'Trial Balance':                         trialBalance,
  'Adjusted Trial Balance':                trialBalance,
  'General Ledger':                        generalLedger,
  'Journal':                               trialBalance,
  'Journal Report':                        trialBalance,
  'Manual Journals':                       trialBalance,
  'Adjusting Journal Entries':             trialBalance,
  'Account Transactions':                  trialBalance,
  'Detailed Account Transactions':         trialBalance,
  'Transaction Detail by Account':         transactionDetailByAccount,
  'Transaction List by Vendor':            expensesByVendor,

  // Aging
  'AR Aging Summary':                      arAgingSummary,
  'AR Aging Detail':                       arAgingDetail,
  'A/R Aging Summary':                     arAgingSummary,
  'A/R Aging Detail':                      arAgingDetail,
  'Aged Receivables Summary':              arAgingSummary,
  'Aged Receivables Detail':               arAgingDetail,

  'AP Aging Summary':                      apAgingSummary,
  'AP Aging Detail':                       apAgingDetail,
  'A/P Aging Summary':                     apAgingSummary,
  'A/P Aging Detail':                      apAgingDetail,
  'A/P Aging Summary Report':              apAgingSummary,
  'A/P Aging Detail Report':               apAgingDetail,
  'Aged Payables Summary':                 apAgingSummary,
  'Aged Payables Detail':                  apAgingDetail,

  // Sales / expenses / purchases grouped reports
  'Sales by Customer':                     salesByCustomer,
  'Sales by Customer Summary':             salesByCustomer,
  'Sales by Customer Detail':              salesByCustomer,
  'Customer Balance Summary':              salesByCustomer,
  'Customer Balance Detail':               salesByCustomer,
  'Income by Customer Summary':            salesByCustomer,
  'Sales by Product / Service Detail':     salesByProductDetail,
  'Sales by Product/Service Detail':       salesByProductDetail,
  'Sales by Product / Service Summary':    salesByProductDetail,
  'Receivable Invoice Summary':            salesByCustomer,
  'Receivable Invoice Detail':             salesByCustomer,
  'Customer Invoice Summary':              salesByCustomer,
  'Customer Invoice Detail':               salesByCustomer,
  'Customer Invoice Activity':             salesByCustomer,

  // Inventory
  'Inventory Item Summary':                inventoryItemSummary,

  // Zoho detail reports (native Zoho viewer)
  'Credit Notes':                          creditNoteDetails,
  'Credit Note Details':                   creditNoteDetails,
  'Recurring Invoices':                    recurringInvoiceDetails,
  'Recurring Invoice Details':             recurringInvoiceDetails,

  'Expenses by Vendor':                    expensesByVendor,
  'Expenses by Vendor Summary':            expensesByVendorSummary,
  'Expenses by Vendor Detail':             expensesByVendor,
  'Vendor Balance Summary':                expensesByVendor,
  'Vendor Balance Detail':                 expensesByVendor,
  'Supplier Invoice Summary':              expensesByVendor,
  'Supplier Invoice Detail':               expensesByVendor,
  'Supplier Invoice Activity':             expensesByVendor,
  'Payable Invoice Summary':               expensesByVendor,
  'Payable Invoice Detail':                expensesByVendor,
  'Vendor Contact List':                   vendorContactList,

  'Purchases by Vendor':                   purchasesByVendor,
  'Purchases by Vendor Detail':            purchasesByVendor,
  'Purchases by Item':                     purchasesByItem,
  'Purchases by Class Detail':             purchasesByVendor,
  'Purchases by Location Detail':          purchasesByVendor,
  'Purchases by Product/Service Detail':   purchasesByVendor,

  'Unpaid Bills':                          unpaidBills,
  'Bills by Vendor':                       unpaidBills,
  'Bill Payment List':                     unpaidBills,
  'Bills and Applied Payments':            unpaidBills,

  // Account lists
  'Chart of Accounts':                     accountList,
  'Account List':                          accountList,

  // Executive / snapshot
  'Executive Summary':                     executiveSummary,
  'Business Snapshot':                     executiveSummary,
  'Business Performance Ratios':           executiveSummary,

  // Budget
  'Budget Summary':                        budgetSummary,
  'Budget Overview':                       budgetSummary,
  'Budget vs Actuals':                     budgetSummary,
  'Budget Variance':                       budgetVariance,

  // Tax
  'Tax Summary':                           taxLiability,
  'Tax Liability':                         taxSummary,
  'Sales Tax Liability Report':            taxLiability,
  'Tax Summary Report':                    taxLiability,
  'Tax Detail Report':                     taxLiability,
  'Taxable Sales Detail':                  taxLiability,
  'Taxable Sales Summary':                 taxLiability,
  'Sales Tax Report':                      taxLiability,
  'GST Returns Workbook':                  gstReturnsWorkbook,
  'TDS Summary':                           tdsSummary,

  // Banking
  'Bank Reconciliation':                   bankReconciliation,
};

export function generateReport(name) {
  const gen = REGISTRY[name];
  return gen ? gen() : genericReport(name);
}
