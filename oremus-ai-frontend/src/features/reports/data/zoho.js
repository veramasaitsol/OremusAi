// Unified Zoho Books report catalog — the finalized report set only.
// This catalog matches the agreed client report sheet (Reports_v3, 15 Jun 26).
// Reports flagged with a `liveType` use the backend /api/zb-reports/<liveType>
// endpoint and render real Zoho data. Reports without a liveType fall back to
// the mock generator.

export const ZOHO_CATEGORIES = [
  { id: 'all',        label: 'All reports',           icon: 'LayoutGrid' },
  { id: 'financials', label: 'Financials',            icon: 'TrendingUp' },
  { id: 'sales',      label: 'Sales',                 icon: 'ShoppingBag' },
  { id: 'arap',       label: 'Receivables and Payables', icon: 'ArrowLeftRight' },
  { id: 'purchases',  label: 'Purchases and Expenses', icon: 'ShoppingCart' },
  { id: 'inventory',  label: 'Inventory',             icon: 'Boxes' },
  { id: 'tax',        label: 'Taxes',                 icon: 'Percent' },
  { id: 'banking',    label: 'Banking',               icon: 'Landmark' },
  { id: 'ledger',     label: 'Ledger and Accounts',   icon: 'BookOpen' },
  { id: 'currency',   label: 'Currency',              icon: 'Coins' },
];

export const ZOHO_REPORTS_BY_CAT = {
  financials: [
    { name: 'Profit and Loss',                    liveType: 'profitandloss', fav: true, desc: 'Revenue, expenses, and net income for the period.' },
    { name: 'Executive Summary',                  liveType: 'executivesummary', desc: 'High-level snapshot of financial performance and position.' },
    { name: 'Budget Summary',                     liveType: 'budgetsummary', desc: 'Budgeted totals by account for the period.' },
    { name: 'Budget Variance',                    liveType: 'budgetvariance', desc: 'Actuals vs budget with variance per account.' },
    { name: 'Balance Sheet',                      liveType: 'balancesheet', fav: true, desc: 'Assets, liabilities, and equity as of a date.' },
    { name: 'Cash Flow Statement',                liveType: 'cashflow', fav: true, desc: 'Operating, investing & financing cash flows.' },
    { name: 'Statement of Cash Flows - Direct',   liveType: 'cashflowstatement', desc: 'Direct-method statement of cash flows.' },
  ],

  sales: [
    { name: 'Sales by Customer Detail',           liveType: 'salesbycustomerdetail', desc: 'Line-level sales transactions grouped by customer.' },
    { name: 'Sales by Product / Service Detail',  liveType: 'salesbyproductdetail', desc: 'Line-level revenue per product or service.' },
    { name: 'Credit Notes',                       liveType: 'creditnotedetails', desc: 'Credit notes issued and applied.' },
    { name: 'Recurring Invoices',                 liveType: 'recurringinvoicedetails', desc: 'Active recurring invoice schedules.' },
  ],

  arap: [
    { name: 'AR Aging Summary',                   liveType: 'aragingsummary', fav: true, desc: 'Outstanding receivables by ageing bucket.' },
    { name: 'AR Aging Detail',                    liveType: 'aragingdetail', desc: 'Line-level breakdown of overdue invoices.' },
    { name: 'AP Aging Summary',                   liveType: 'apagingsummary', fav: true, desc: 'Payables grouped by ageing bucket.' },
    { name: 'AP Aging Detail',                    liveType: 'apagingdetail', desc: 'Line-level breakdown of unpaid bills.' },
    { name: 'Vendor Balance Detail',              liveType: 'vendorbalancedetail', desc: 'Open bills and credits per vendor with a running balance.' },
  ],

  purchases: [
    { name: 'Supplier Invoice Summary',           liveType: 'supplierinvoicesummary', desc: 'Every supplier bill in the period with payable, balance and status.' },
    { name: 'Purchases by Item',                  liveType: 'purchasesbyitem', desc: 'Items procured with quantity and cost.' },
    { name: 'Expenses by Vendor Summary',         liveType: 'expensesbyvendorsummary', desc: 'Total spend grouped by vendor.' },
    { name: 'Vendor Contact List',               liveType: 'vendorcontactlist', desc: 'Contact card, address and tax details for every vendor.' },
  ],

  inventory: [
    { name: 'Inventory Item Summary',             liveType: 'inventoryitemsummary', desc: 'On-hand quantity and value per item.' },
  ],

  tax: [
    { name: 'GST Returns Workbook',               liveType: 'gstreturnsworkbook', desc: 'Consolidated GST return workbook (GSTR-1/2/3B).' },
    { name: 'TDS Summary',                        liveType: 'tdssummary', desc: 'Tax deducted at source per section.' },
    { name: 'Tax Liability',                      liveType: 'taxliability', desc: 'Net tax payable for the period by tax type.' },
  ],

  banking: [
    { name: 'Bank Reconciliation',                liveType: 'bankreconciliation', fav: true, desc: 'Statement vs ledger reconciliation.' },
  ],

  ledger: [
    { name: 'Transaction Detail by Account',      liveType: 'transactiondetailbyaccount', desc: 'Every posting line grouped under its account.' },
    { name: 'Transaction List by Vendor',         liveType: 'transactionlistbyvendor', desc: 'Every transaction grouped under its vendor.' },
    { name: 'Trial Balance',                      liveType: 'trialbalance', fav: true, desc: 'Debits and credits across every ledger.' },
    { name: 'General Ledger',                     liveType: 'generalledger', desc: 'Every posted transaction grouped by account.' },
    { name: 'Chart of Accounts',                  liveType: 'chartofaccounts', desc: 'All accounts with type and balance.' },
  ],

  currency: [
    { name: 'Foreign Currency Gains and Losses',  liveType: 'foreigncurrencygainsandlosses', desc: 'Realised and unrealised FX results for the period.' },
    { name: 'Realized Gain or Loss',              liveType: 'realizedgainorloss', desc: 'Settled FX gains and losses.' },
  ],
};
