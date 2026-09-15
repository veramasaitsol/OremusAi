import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { Bell, CheckCheck, RefreshCw, Trash2, Loader2 } from 'lucide-react';
import { metaFor, relativeTime } from '../features/notifications/notifMeta.js';
import {
  loadNotifications,
  generateNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  removeNotification,
  selectNotifications,
  selectUnreadCount,
  selectNotifStatus,
} from '../features/notifications/notificationsSlice.js';

const TABS = [
  { id: 'all',    label: 'All' },
  { id: 'unread', label: 'Unread' },
];

export default function Notifications() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const items   = useSelector(selectNotifications);
  const unread  = useSelector(selectUnreadCount);
  const status  = useSelector(selectNotifStatus);
  const [tab, setTab] = useState('all');
  const [refreshing, setRefreshing] = useState(false);

  // On first visit, derive notifications from live data (idempotent), then load.
  useEffect(() => {
    dispatch(generateNotifications());
  }, [dispatch]);

  const refresh = async () => {
    setRefreshing(true);
    try { await dispatch(generateNotifications()); }
    finally { setRefreshing(false); }
  };

  const shown = tab === 'unread' ? items.filter((n) => !n.read_at) : items;

  const onItemClick = (n) => {
    if (!n.read_at) dispatch(markNotificationRead(n.id));
    if (n.link) navigate(n.link);
  };

  const loading = status === 'loading' && items.length === 0;

  return (
    <div className="p-6 lg:p-10 max-w-[860px] mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-brand-500 to-cyan-500 text-white grid place-items-center">
          <Bell size={20} />
        </div>
        <div className="flex-1">
          <h1 className="text-[20px] font-bold text-navy-900 dark:text-white leading-tight">Notifications</h1>
          <p className="text-[12.5px] text-navy-500">
            {unread > 0 ? `${unread} unread` : 'You are all caught up'}
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="h-9 px-3 rounded-lg border border-navy-200 dark:border-navy-700 text-navy-600 dark:text-navy-300 hover:bg-navy-50 dark:hover:bg-navy-800 text-[12.5px] font-medium flex items-center gap-1.5 transition disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Check for updates
        </button>
        {unread > 0 && (
          <button
            onClick={() => dispatch(markAllNotificationsRead())}
            className="h-9 px-3 rounded-lg bg-gradient-to-r from-brand-500 to-cyan-500 text-white text-[12.5px] font-medium flex items-center gap-1.5 transition hover:opacity-90"
          >
            <CheckCheck size={14} /> Mark all read
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-navy-100 dark:border-navy-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3.5 py-2 text-[13px] font-medium -mb-px border-b-2 transition ${
              tab === t.id
                ? 'border-brand-500 text-brand-600 dark:text-brand-300'
                : 'border-transparent text-navy-500 hover:text-navy-800 dark:hover:text-navy-200'
            }`}
          >
            {t.label}
            {t.id === 'unread' && unread > 0 && (
              <span className="ml-1.5 text-[10px] font-bold bg-red-500 text-white rounded-full px-1.5 py-0.5">{unread}</span>
            )}
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <div className="py-20 text-center text-navy-400">
          <Loader2 size={22} className="mx-auto animate-spin mb-2" /> Loading…
        </div>
      ) : shown.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-navy-200 dark:border-navy-800 bg-white/60 dark:bg-navy-900/40 p-14 text-center">
          <Bell size={28} className="mx-auto mb-3 text-navy-300" />
          <h2 className="text-[15px] font-semibold text-navy-800 dark:text-navy-100">
            {tab === 'unread' ? 'No unread notifications' : 'No notifications yet'}
          </h2>
          <p className="text-[12.5px] text-navy-500 mt-1">We'll let you know when something needs your attention.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {shown.map((n) => {
            const m = metaFor(n.type);
            const Icon = Icons[m.icon] || Icons.Info;
            return (
              <div
                key={n.id}
                className={`group flex gap-3 rounded-xl border p-3.5 transition ${
                  n.read_at
                    ? 'border-navy-100 dark:border-navy-800 bg-white dark:bg-navy-900/40'
                    : 'border-brand-200 dark:border-brand-500/30 bg-brand-50/50 dark:bg-brand-500/5'
                }`}
              >
                <div className={`w-9 h-9 rounded-lg grid place-items-center shrink-0 ${m.wrap}`}>
                  <Icon size={16} />
                </div>
                <button onClick={() => onItemClick(n)} className="flex-1 min-w-0 text-left">
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-semibold text-navy-900 dark:text-white leading-tight">{n.title}</span>
                    {!n.read_at && <span className="w-2 h-2 rounded-full bg-brand-500 shrink-0" />}
                  </div>
                  {n.body && <p className="text-[12.5px] text-navy-600 dark:text-navy-400 mt-0.5">{n.body}</p>}
                  <div className="text-[11px] text-navy-400 mt-1.5">{relativeTime(n.created_at)}</div>
                </button>
                <div className="flex flex-col items-center gap-1.5 opacity-0 group-hover:opacity-100 transition shrink-0">
                  {!n.read_at && (
                    <button
                      onClick={() => dispatch(markNotificationRead(n.id))}
                      title="Mark as read"
                      className="w-7 h-7 rounded-md grid place-items-center text-navy-400 hover:text-brand-600 hover:bg-navy-100 dark:hover:bg-navy-800 transition"
                    >
                      <CheckCheck size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => dispatch(removeNotification(n.id))}
                    title="Delete"
                    className="w-7 h-7 rounded-md grid place-items-center text-navy-400 hover:text-red-500 hover:bg-navy-100 dark:hover:bg-navy-800 transition"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
