import * as Icons from 'lucide-react';

export default function Placeholder({ title, icon = 'Construction', description = 'This module is coming soon.' }) {
  const Icon = Icons[icon] || Icons.Construction;
  return (
    <div className="p-6 lg:p-10 max-w-[1200px] mx-auto">
      <div className="rounded-2xl border border-dashed border-navy-200 dark:border-navy-800 bg-white/60 dark:bg-navy-900/40 p-12 text-center">
        <div className="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-br from-brand-500 to-cyan-500 text-white grid place-items-center mb-4">
          <Icon size={26} />
        </div>
        <h2 className="text-[22px] font-bold text-navy-900 dark:text-white mb-1">{title}</h2>
        <p className="text-[13px] text-navy-500 max-w-md mx-auto">{description}</p>
      </div>
    </div>
  );
}
