import { useEffect } from 'react';
import { useSelector } from 'react-redux';
import AppRoutes from './routes/AppRoutes.jsx';
import Toaster from './components/ui/Toaster.jsx';

export default function App() {
  const theme = useSelector((s) => s.ui.theme);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  return (
    <>
      <AppRoutes />
      <Toaster />
    </>
  );
}
