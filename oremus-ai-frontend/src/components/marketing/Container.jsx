// Server component. Consistent page gutter + max width for all marketing sections.
export default function Container({ children, className = '' }) {
  return (
    <div className={`mx-auto w-full max-w-7xl px-5 sm:px-6 lg:px-8 ${className}`}>
      {children}
    </div>
  );
}
