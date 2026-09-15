// Navigation items for the sidebar.
//
// `roles`      — if set, only those roles can see this item.
// `permission` — if set, client users also need this exact string in their
//                permissions array (set when the admin creates/edits the client).
//                Items with no `permission` key are always visible to all roles
//                that pass the `roles` check.
export const SIDEBAR_ITEMS = [
  { id: "dashboard",     label: "Dashboard",     icon: "Home",         to: "/dashboard",     permission: "Dashboard"     },
  { id: "analytics",     label: "AI Analytics",  icon: "Sparkles",     to: "/analytics",     badge: "New", permission: "AI Analytics" },
  // { id: 'ratios',     label: 'Ratios',        icon: 'Gauge',        to: '/ratios',        badge: 'New' },
  // { id: 'admin',      label: 'Admin Console', icon: 'Shield',       to: '/admin',         roles: ['admin'] },
  { id: "transactions",  label: "Transactions",  icon: "BookOpen",     to: "/transactions",  badge: "Day Book", permission: "Day Book" },
  { id: "accounts",      label: "Accounts",      icon: "Layers",       to: "/accounts",      permission: "Accounts"      },
  { id: 'reports', label: 'Reports', icon: 'FileBarChart', to: '/reports', permission: 'Reports' },
  { id: "customers",     label: "Customers",     icon: "Users",        to: "/customers",     permission: "Customers"     },
  { id: "vendors",       label: "Vendors",       icon: "Truck",        to: "/vendors",       permission: "Vendors"       },
  { id: "expenses",      label: "Expenses",      icon: "Wallet",       to: "/expenses",      permission: "Expenses"      },
  { id: "invoices",      label: "Invoices",      icon: "ReceiptText",  to: "/invoices",      permission: "Invoices"      },
  { id: "documents",     label: "Documents",     icon: "Folder",       to: "/documents",     permission: "Documents"     },
  { id: "notifications", label: "Notifications", icon: "Bell",         to: "/notifications", permission: "Notifications" },
  { id: "clients",       label: "Clients",       icon: "Building2",    to: "/clients",       roles: ["admin"]            },
  { id: "employees",     label: "Employees",     icon: "Briefcase",    to: "/employees",     roles: ["admin"]            },
  { id: "billing",       label: "Billing",       icon: "Wallet",       to: "/billing",       roles: ["client"],  permission: "Billing"      },
  { id: "settings",      label: "Settings",      icon: "Settings",     to: "/settings"                                   },
];
