import { useLocation, useNavigate } from 'react-router-dom';

const TABS = [
  { label: 'Dashboard',          path: '/dashboard'      },
  { label: 'Ratios',             path: '/ratios'         },
  { label: 'Key Ratios Summary', path: '/ratios/summary' },
];

export default function DashboardTabs() {
  const { pathname } = useLocation();
  const navigate     = useNavigate();

  return (
    <div className="flex gap-6 mb-6 border-b border-navy-100 dark:border-navy-800">
      {TABS.map(({ label, path }) => {
        // Exact match only — none of these three routes has sub-routes, and
        // "/ratios/summary" would otherwise also satisfy "/ratios"'s old
        // startsWith(path + '/') check, lighting up two tabs at once.
        const active = pathname === path;
        return (
          <button
            key={path}
            onClick={() => navigate(path)}
            className={`
              pb-3 text-[14px] border-b-[2.5px] -mb-px transition-colors whitespace-nowrap
              ${active
                ? 'border-blue-500 text-navy-900 dark:text-white font-medium'
                : 'border-transparent text-navy-400 dark:text-navy-500 font-normal hover:text-navy-700 dark:hover:text-navy-300'}
            `}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
