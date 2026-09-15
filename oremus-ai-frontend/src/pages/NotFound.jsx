import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import Button from '../components/ui/Button.jsx';
import Logo from '../components/ui/Logo.jsx';

export default function NotFound() {
  return (
    <div className="min-h-screen grid place-items-center bg-navy-50 dark:bg-navy-950 px-6">
      <div className="text-center">
        <Logo size={48} />
        <div className="text-[72px] font-bold tracking-tighter text-navy-900 dark:text-white mt-4 leading-none">404</div>
        <p className="text-[14px] text-navy-500 mt-2 mb-6">The page you’re looking for doesn’t exist.</p>
        <Link to="/dashboard">
          <Button variant="primary" icon={ArrowLeft}>Back to dashboard</Button>
        </Link>
      </div>
    </div>
  );
}
