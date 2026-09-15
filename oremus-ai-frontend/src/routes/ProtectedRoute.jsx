import { Navigate, useLocation } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { selectIsAuthed, selectRole, selectUser } from '../features/auth/authSlice.js';

export default function ProtectedRoute({ children, roles, permission }) {
  const isAuthed = useSelector(selectIsAuthed);
  const role = useSelector(selectRole);
  const user = useSelector(selectUser);
  const location = useLocation();

  if (!isAuthed) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (roles && roles.length && !roles.includes(role)) {
    return <Navigate to="/dashboard" replace />;
  }
  // Client users additionally need the matching permission for gated routes.
  if (permission && role === 'client') {
    const permissions = Array.isArray(user?.permissions)
      ? user.permissions
      : typeof user?.permissions === 'string'
        ? (() => { try { return JSON.parse(user.permissions); } catch { return []; } })()
        : [];
    if (!permissions.includes(permission)) {
      return <Navigate to="/dashboard" replace />;
    }
  }
  return children;
}
