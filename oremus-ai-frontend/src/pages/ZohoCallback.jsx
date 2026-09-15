import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import axiosClient from '../services/axiosClient.js';
import {
  connectZoho,
  markZohoConnected,
  selectZohoStatus,
  selectZohoError,
} from '../features/zoho/zohoSlice.js';

export default function ZohoCallback() {
  const dispatch       = useDispatch();
  const navigate       = useNavigate();
  const [params]       = useSearchParams();
  const status         = useSelector(selectZohoStatus);
  const error          = useSelector(selectZohoError);
  const exchanged      = useRef(false);
  const handled        = useRef(false);
  const isClientRef    = useRef(false);   // admin connecting on behalf of a client

  const code        = params.get('code');
  const stateParam  = params.get('state');          // OAuth state — carries the user JWT
  const statusParam = params.get('status');         // from backend flow: 'success' | 'error'
  const messageParam = params.get('message');       // error message from backend flow
  const orgId       = params.get('organizationId');
  const oauthError  = params.get('error');          // Zoho direct error param
  const errorDesc   = params.get('error_description');

  useEffect(() => {
    // Backend flow returned an error
    if (statusParam === 'error') return;
    // Zoho returned an explicit error (user denied access)
    if (oauthError) return;

    const connectingForClient = sessionStorage.getItem('oremus_connect_for_client');
    const clientState = sessionStorage.getItem('oremus_client_connect_token') || stateParam;

    // Backend callback flow completed successfully
    if (statusParam === 'success') {
      if (handled.current) return;
      handled.current = true;

      if (connectingForClient) {
        // Admin connected Zoho on behalf of a client — don't update admin's own state
        sessionStorage.removeItem('oremus_connect_for_client');
        sessionStorage.removeItem('oremus_client_connect_token');
        navigate('/clients', { replace: true });
        return;
      }
      // Normal self-connect: mark admin as connected and sync
      dispatch(markZohoConnected(orgId));
      axiosClient.post('/sync/all').catch(() => {/* sync failure is non-fatal */});
      return;
    }

    // Frontend flow: exchange the code exactly once via backend /auth/zoho/exchange
    if (!code || exchanged.current) return;
    exchanged.current = true;

    if (connectingForClient) {
      // Admin-for-client flow: pass the client's JWT as 'state' so the backend
      // saves tokens for the client user (not the admin).
      isClientRef.current = true;
      dispatch(connectZoho({ code, state: clientState || stateParam }))
        .unwrap()
        .finally(() => {
          sessionStorage.removeItem('oremus_connect_for_client');
          sessionStorage.removeItem('oremus_client_connect_token');
          navigate('/clients', { replace: true });
        });
      return;
    }

    // Normal self-connect
    dispatch(connectZoho({ code, state: stateParam }));
  }, [code, statusParam, orgId, oauthError, dispatch, stateParam, navigate]);

  // Redirect to settings after a successful self-connect.
  useEffect(() => {
    if (status === 'succeeded' && !isClientRef.current) {
      const t = setTimeout(() => navigate('/settings', { replace: true }), 1200);
      return () => clearTimeout(t);
    }
  }, [status, navigate]);

  // ── Derived UI state ──────────────────────────────────────────────────────
  const hasError = statusParam === 'error' || !!oauthError || status === 'failed';
  const isSuccess = status === 'succeeded';
  // Loading only when we have a code being processed, or backend success is in flight
  const isLoading = !hasError && !isSuccess && (
    status === 'loading' ||
    (statusParam === 'success' && status !== 'succeeded') ||
    (!!code && status === 'idle')
  );

  const errorMsg = messageParam
    ?? (oauthError ? (errorDesc ?? `Zoho returned: ${oauthError}`) : null)
    ?? error
    ?? 'Something went wrong. Please try again.';

  return (
    <div className="min-h-screen bg-navy-50 dark:bg-navy-950 flex items-center justify-center p-6">
      <div className="bg-white dark:bg-navy-900 rounded-2xl border border-navy-200 dark:border-navy-800 shadow-xl w-full max-w-sm p-10 flex flex-col items-center gap-5 text-center">

        {/* ── Loading ── */}
        {isLoading && (
          <>
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-cyan-500 grid place-items-center">
              <Loader2 size={30} className="text-white animate-spin" />
            </div>
            <div>
              <h2 className="text-[18px] font-bold text-navy-900 dark:text-white mb-1">
                Connecting Zoho Books
              </h2>
              <p className="text-[13px] text-navy-500">
                Exchanging authorization code…
              </p>
            </div>
          </>
        )}

        {/* ── Success ── */}
        {isSuccess && (
          <>
            <div className="w-16 h-16 rounded-2xl bg-emerald-500 grid place-items-center">
              <CheckCircle2 size={30} className="text-white" />
            </div>
            <div>
              <h2 className="text-[18px] font-bold text-navy-900 dark:text-white mb-1">
                Zoho Books connected!
              </h2>
              <p className="text-[13px] text-navy-500">
                Syncing your data in the background…
              </p>
            </div>
          </>
        )}

        {/* ── Error ── */}
        {hasError && (
          <>
            <div className="w-16 h-16 rounded-2xl bg-red-500 grid place-items-center">
              <XCircle size={30} className="text-white" />
            </div>
            <div>
              <h2 className="text-[18px] font-bold text-navy-900 dark:text-white mb-1">
                Connection failed
              </h2>
              <p className="text-[13px] text-red-500 dark:text-red-400 mb-4 break-words">
                {errorMsg}
              </p>
            </div>
            <button
              onClick={() => navigate('/settings', { replace: true })}
              className="w-full h-10 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-[13px] font-semibold transition"
            >
              Back to Settings
            </button>
          </>
        )}

      </div>
    </div>
  );
}
