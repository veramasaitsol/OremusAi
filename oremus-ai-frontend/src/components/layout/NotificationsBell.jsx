import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { Bell, CheckCheck } from 'lucide-react';
import Popover from '../ui/Popover.jsx';
import { metaFor, relativeTime } from '../../features/notifications/notifMeta.js';
import {
  loadNotifications,
  loadUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  selectNotifications,
  selectUnreadCount,
} from '../../features/notifications/notificationsSlice.js';

export default function NotificationsBell() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const items  = useSelector(selectNotifications);
  const unread = useSelector(selectUnreadCount);
  const [open, setOpen] = useState(false);

  // Poll the unread count so the badge stays current without opening the panel.
  useEffect(() => {
    dispatch(loadUnreadCount());
    const t = setInterval(() => dispatch(loadUnreadCount()), 60000);
    return () => clearInterval(t);
  }, [dispatch]);

  // Load the list when the panel opens.
  useEffect(() => {
    if (open) dispatch(loadNotifications());
  }, [open, dispatch]);

  const recent = items.slice(0, 8);

  const onItemClick = (n) => {
    if (!n.read_at) dispatch(markNotificationRead(n.id));
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      width={360}
      className="!p-0 overflow-hidden"
      trigger={
        <button
          className="h-9 w-9 rounded-lg hover:bg-navy-100 dark:hover:bg-navy-800 text-navy-500 grid place-items-center relative transition"
          aria-label="Notifications"
        >
          <Bell size={16} />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold grid place-items-center ring-2 ring-white dark:ring-navy-900">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      }
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-navy-100 dark:border-navy-800">
        <div className="text-[13px] font-bold text-navy-900 dark:text-white">
          Notifications {unread > 0 && <span className="text-navy-400 font-medium">({unread})</span>}
        </div>
        {unread > 0 && (
          <button
            onClick={() => dispatch(markAllNotificationsRead())}
            className="text-[11px] font-medium text-brand-600 dark:text-brand-300 hover:underline flex items-center gap-1"
          >
            <CheckCheck size={13} /> Mark all read
          </button>
        )}
      </div>

      {/* List */}
      <div className="max-h-[380px] overflow-y-auto">
        {recent.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-navy-400">
            <Bell size={22} className="mx-auto mb-2 opacity-40" />
            You're all caught up.
          </div>
        ) : (
          recent.map((n) => {
            const m = metaFor(n.type);
            const Icon = Icons[m.icon] || Icons.Info;
            return (
              <button
                key={n.id}
                onClick={() => onItemClick(n)}
                className={`w-full text-left flex gap-2.5 px-4 py-3 border-b border-navy-50 dark:border-navy-800/50 hover:bg-navy-50 dark:hover:bg-navy-800/40 transition ${n.read_at ? '' : 'bg-brand-50/40 dark:bg-brand-500/5'}`}
              >
                <div className={`w-7 h-7 rounded-lg grid place-items-center shrink-0 ${m.wrap}`}>
                  <Icon size={14} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12.5px] font-semibold text-navy-900 dark:text-white leading-tight truncate">{n.title}</span>
                    {!n.read_at && <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0" />}
                  </div>
                  {n.body && <p className="text-[11.5px] text-navy-500 dark:text-navy-400 mt-0.5 line-clamp-2">{n.body}</p>}
                  <div className="text-[10.5px] text-navy-400 mt-1">{relativeTime(n.created_at)}</div>
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Footer */}
      <button
        onClick={() => { setOpen(false); navigate('/notifications'); }}
        className="w-full text-center py-2.5 text-[12px] font-semibold text-brand-600 dark:text-brand-300 hover:bg-navy-50 dark:hover:bg-navy-800/40 border-t border-navy-100 dark:border-navy-800 transition"
      >
        View all notifications
      </button>
    </Popover>
  );
}
