// Server component. Maps the icon-name strings used in data.js to lucide-react
// icons. Importing only what we use keeps the marketing bundle lean.
import {
  LayoutDashboard, ArrowLeftRight, Gauge, Sparkles, Plug, ShieldCheck,
  Workflow, LineChart, Users, Headphones, Building2, Rocket, Factory,
  ShoppingCart, Briefcase, Landmark, Check, X, ArrowRight, Zap, Lock,
} from 'lucide-react';

const MAP = {
  LayoutDashboard, ArrowLeftRight, Gauge, Sparkles, Plug, ShieldCheck,
  Workflow, LineChart, Users, Headphones, Building2, Rocket, Factory,
  ShoppingCart, Briefcase, Landmark, Check, X, ArrowRight, Zap, Lock,
};

export default function Icon({ name, ...props }) {
  const Cmp = MAP[name] || Sparkles;
  return <Cmp {...props} />;
}
