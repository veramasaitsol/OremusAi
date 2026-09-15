import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import {
  markXeroConnected,
  selectXeroStatus,
  selectXeroError,
} from '../features/xero/xeroSlice.js';

export default function XeroCallback() {
  const dispatch        = useDispatch();
  const navigate        = useNavigate();
  const [params]        = useSearchParams();
  const status          = useSelector(selectXeroStatus);
  const error           = useSelector(selectXeroError);

  const statusParam   = params.get('status');
  const messageParam  = params.get('message');
  const tenantId      = params.get('tenantId');
  const oauthError    = params.get('error');
  const errorDesc     = params.get('error_description');

  useEffect(() => {
    if (statusParam === 'error' || oauthError) return;

    if (statusParam === 'success') {
      const connectingForClient = sessionStorage.getItem('oremus_connect_for_client');
      if (connectingForClient) {
        sessionStorage.removeItem('oremus_connect_for_client');
        sessionStorage.removeItem('oremus_client_connect_token');
        navigate('/clients', { replace: true });
        return;
      }
      dispatch(markXeroConnected({ tenantId }));
    }
  }, [statusParam, oauthError, tenantId, dispatch, navigate]);

  useEffect(() => {
    if (statusParam === 'success') {
      const t = setTimeout(() => navigate('/settings', { replace: true }), 1200);
      return () => clearTimeout(t);
    }
  }, [statusParam, navigate]);

  const hasError  = statusParam === 'error' || !!oauthError || status === 'failed';
  const isSuccess = statusParam === 'success';
  const isLoading = !hasError && !isSuccess;

  const errorMsg = messageParam
    ?? (oauthError ? (errorDesc ?? `Xero returned: ${oauthError}`) : null)
    ?? error
    ?? 'Something went wrong. Please try again.';

  return (
    <div className="min-h-screen bg-navy-50 dark:bg-navy-950 flex items-center justify-center p-6">
      <div className="bg-white dark:bg-navy-900 rounded-2xl border border-navy-200 dark:border-navy-800 shadow-xl w-full max-w-sm p-10 flex flex-col items-center gap-5 text-center">

        {isLoading && (
          <>
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#13B5EA] to-cyan-600 grid place-items-center">
              <Loader2 size={30} className="text-white animate-spin" />
            </div>
            <div>
              <h2 className="text-[18px] font-bold text-navy-900 dark:text-white mb-1">
                Connecting Xero
              </h2>
              <p className="text-[13px] text-navy-500">
                Finalising connection with Xero…
              </p>
            </div>
          </>
        )}

        {isSuccess && (
          <>
            <div className="w-16 h-16 rounded-2xl bg-emerald-500 grid place-items-center">
              <CheckCircle2 size={30} className="text-white" />
            </div>
            <div>
              <h2 className="text-[18px] font-bold text-navy-900 dark:text-white mb-1">
                Xero connected!
              </h2>
              <p className="text-[13px] text-navy-500">
                Syncing your data in the background…
              </p>
            </div>
          </>
        )}

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
