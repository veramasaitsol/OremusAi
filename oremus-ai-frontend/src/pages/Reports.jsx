import { useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import ZohoReportsLayout from '../components/reports/zoho/ZohoReportsLayout.jsx';import { setProvider, openReport, closeReport, selectOpenReport,
} from '../features/reports/reportsSlice.js';
import { isValidProvider, DEFAULT_PROVIDER, providerFromConnections } from '../features/reports/data/providers.js';
import { findReportBySlug } from '../features/reports/data/slugs.js';
import { selectUser, selectRole } from '../features/auth/authSlice.js';
import { selectViewAsClientId, selectViewAsProvider } from '../features/viewAs/viewAsSlice.js';
import { selectAllClients, selectClientsStatus, fetchClients } from '../features/clients/clientsSlice.js';
   
export default function Reports() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { reportSlug } = useParams();
  const user = useSelector(selectUser);
  const role = useSelector(selectRole);
  const viewAsClientId = useSelector(selectViewAsClientId);
  const viewAsProvider = useSelector(selectViewAsProvider);
  const clients = useSelector(selectAllClients);
  const clientsStatus = useSelector(selectClientsStatus);
  const openRep = useSelector(selectOpenReport);
  const wasOpenRef = useRef(null); // { provider } while a report is open

  // When an admin is viewing as a client, the client list carries the
  // connection flags that pick the report engine — make sure it's loaded.
  useEffect(() => {
    if (role === 'admin' && clientsStatus === 'idle') dispatch(fetchClients(''));
  }, [role, clientsStatus, dispatch]);

  // Provider = the VIEWED CLIENT's connection when admin is viewing as a
  // client (the backend keys everything off X-Client-Id); otherwise the
  // logged-in user's own integration type. Using the admin's own account
  // here made QB/Xero client reports hit the Zoho engine and fail.
  // Prefer the provider persisted with the view-as selection (synchronous,
  // no async client-list race on deep links); fall back to the clients list
  // for selections made before the provider was persisted.
  let effective = DEFAULT_PROVIDER;
  if (viewAsClientId) {
    if (viewAsProvider && isValidProvider(viewAsProvider)) {
      effective = viewAsProvider;
    } else {
      const c = clients.find((x) => String(x.id) === String(viewAsClientId));
      effective = providerFromConnections(c) || DEFAULT_PROVIDER;
    }
  } else {
    const connected = user?.integrationType;
    effective = connected && isValidProvider(connected) ? connected : DEFAULT_PROVIDER;
  }

  // Sync the slice provider whenever the resolved provider changes.
  useEffect(() => {
    dispatch(setProvider(effective));
  }, [dispatch, effective]);

  // URL -> state: open the report named by the slug (or close when there's no
  // slug). Invalid slugs redirect to the clean Reports grid. Compares BOTH name
  // and provider: a provider switch (admin viewing a different client's
  // platform) re-opens the same-named report under the new engine — and the
  // openReport deps make this re-run after setProvider clears the stale one.
  useEffect(() => {
    if (reportSlug) {
      const rep = findReportBySlug(effective, reportSlug);
      if (!rep) {
        navigate('/reports', { replace: true });
        return;
      }
      const matches = openRep?.name === rep.name && openRep?.provider === effective;
      if (!matches) {
        dispatch(openReport({ name: rep.name, category: rep.category }));
      }
    } else if (openRep) {
      dispatch(closeReport());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportSlug, effective, openRep?.name, openRep?.provider]);

  useEffect(() => {
    if (openRep) {
      wasOpenRef.current = { provider: openRep.provider };
    } else if (wasOpenRef.current && reportSlug) {
      if (wasOpenRef.current.provider === effective) {
        wasOpenRef.current = null;
        navigate('/reports', { replace: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRep, effective]);

  return <ZohoReportsLayout />;
}
