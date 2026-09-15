// Shared browser chrome for all product mocks so they line up perfectly when
// swapped inside the product tabs. Pure markup — safe in server components.
export default function Frame({ url = 'app.oremusai.com', children }) {
  return (
    <div className="browser-frame mx-auto w-full">
      <div className="flex items-center gap-2 border-b border-navy-100 bg-navy-50/70 px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-red-400" />
        <span className="h-3 w-3 rounded-full bg-amber-400" />
        <span className="h-3 w-3 rounded-full bg-green-400" />
        <div className="ml-3 hidden flex-1 sm:block">
          <div className="mx-auto w-72 rounded-md bg-white px-3 py-1 text-center text-xs text-navy-400 shadow-soft">
            {url}
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}
