import * as Lucide from 'lucide-react';

// Resolve a Lucide icon component by name with a sensible fallback.
export function resolveIcon(name) {
  return Lucide[name] || Lucide.Circle;
}

// Per-report icon (varies by topic so cards aren't a wall of identical icons).
const NAME_ICON_MAP = [
  [/profit|loss|income/i, 'TrendingUp'],
  [/balance/i,            'Scale'],
  [/cash/i,               'Banknote'],
  [/trial|ledger|journal|chart of/i, 'BookOpen'],
  [/aging|aged/i,         'Clock'],
  [/customer|client|sales|invoice/i, 'Users'],
  [/vendor|payable|bill/i,'Truck'],
  [/payment|receipt|refund/i, 'CreditCard'],
  [/tax|gst|tds/i,        'Percent'],
  [/bank|reconciliation/i,'Landmark'],
  [/project/i,            'FolderKanban'],
  [/currency|fx/i,        'Coins'],
  [/audit|activity|login|user/i, 'Activity'],
  [/workflow|automation|schedule|webhook/i, 'Zap'],
  [/recurring|subscription/i, 'RotateCcw'],
  [/purchase|order/i,     'ShoppingCart'],
  [/estimate|quote/i,     'FileText'],
  [/equity/i,             'PiggyBank'],
  [/ratio|performance|trend|comparative|horizontal/i, 'BarChart3'],
];

export function iconForReport(name) {
  for (const [pattern, iconName] of NAME_ICON_MAP) {
    if (pattern.test(name)) return resolveIcon(iconName);
  }
  return Lucide.FileBarChart;
}
