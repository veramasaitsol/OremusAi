import { useSelector, useDispatch } from 'react-redux';
import { logout, selectUser, selectRole, selectIsAuthed } from '../features/auth/authSlice.js';

export function useAuth() {
  const dispatch = useDispatch();
  return {
    user: useSelector(selectUser),
    role: useSelector(selectRole),
    isAuthed: useSelector(selectIsAuthed),
    logout: () => dispatch(logout()),
  };
}
