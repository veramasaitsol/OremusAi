import Tile from './Tile.jsx';

const Sk = ({ className = '' }) => <div className={`rounded skeleton ${className}`} />;

// Shimmer placeholder for the overview bento — shown only on the very first
// load (before any KPI data exists), so the layout doesn't pop in empty.
export default function DashboardSkeleton() {
  return (
    <div className="grid grid-cols-12 gap-3 mb-5">
      {/* Hero */}
      <div className="col-span-12 xl:col-span-7 xl:row-span-2">
        <Tile padding="p-6" className="h-full">
          <Sk className="h-3 w-40 mb-3" />
          <Sk className="h-10 w-56 mb-2" />
          <Sk className="h-3 w-72 mb-6" />
          <Sk className="h-[260px] w-full rounded-xl" />
        </Tile>
      </div>

      {/* KPI 2×2 */}
      <div className="col-span-12 xl:col-span-5 xl:row-span-2 grid grid-cols-2 grid-rows-2 gap-3 auto-rows-fr">
        {[0, 1, 2, 3].map((i) => (
          <Tile key={i} padding="p-4" className="h-full">
            <Sk className="h-3 w-24 mb-3" />
            <Sk className="h-7 w-28 mb-3" />
            <Sk className="h-3 w-20" />
          </Tile>
        ))}
      </div>

      {/* Row of 3 chart tiles */}
      {[0, 1, 2].map((i) => (
        <div key={i} className="col-span-12 md:col-span-6 xl:col-span-4">
          <Tile padding="p-4" className="h-full">
            <Sk className="h-3 w-28 mb-3" />
            <Sk className="h-[140px] w-full rounded-xl" />
          </Tile>
        </div>
      ))}

      {/* Quick stats */}
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="col-span-6 md:col-span-3">
          <Tile padding="p-4">
            <div className="flex items-center gap-3">
              <Sk className="w-10 h-10 rounded-lg" />
              <div className="flex-1">
                <Sk className="h-3 w-16 mb-2" />
                <Sk className="h-4 w-20" />
              </div>
            </div>
          </Tile>
        </div>
      ))}
    </div>
  );
}
