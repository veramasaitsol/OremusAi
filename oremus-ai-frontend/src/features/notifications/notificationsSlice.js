import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import * as api from './notificationsAPI.js';

export const loadNotifications = createAsyncThunk(
  'notifications/load',
  async ({ status } = {}) => api.fetchNotifications({ status, limit: 50 }),
);

export const loadUnreadCount = createAsyncThunk(
  'notifications/unreadCount',
  async () => api.fetchUnreadCount(),
);

export const generateNotifications = createAsyncThunk(
  'notifications/generate',
  async (_, { dispatch }) => {
    const res = await api.generateNotifications();
    dispatch(loadNotifications());
    return res;
  },
);

export const markNotificationRead = createAsyncThunk(
  'notifications/markRead',
  async (id) => { await api.markRead(id); return id; },
);

export const markAllNotificationsRead = createAsyncThunk(
  'notifications/markAllRead',
  async () => { await api.markAllRead(); },
);

export const removeNotification = createAsyncThunk(
  'notifications/remove',
  async (id) => { await api.deleteNotification(id); return id; },
);

const notificationsSlice = createSlice({
  name: 'notifications',
  initialState: {
    items: [],
    unread: 0,
    status: 'idle', // idle | loading | succeeded | failed
    error: null,
  },
  reducers: {},
  extraReducers: (b) => {
    b.addCase(loadNotifications.pending, (s) => { s.status = 'loading'; s.error = null; })
     .addCase(loadNotifications.fulfilled, (s, a) => {
       s.status = 'succeeded';
       s.items = a.payload.data || [];
       s.unread = a.payload.unread ?? 0;
     })
     .addCase(loadNotifications.rejected, (s, a) => { s.status = 'failed'; s.error = a.error.message; })

     .addCase(loadUnreadCount.fulfilled, (s, a) => { s.unread = a.payload; })

     .addCase(markNotificationRead.fulfilled, (s, a) => {
       const n = s.items.find((x) => x.id === a.payload);
       if (n && !n.read_at) { n.read_at = new Date().toISOString(); s.unread = Math.max(0, s.unread - 1); }
     })
     .addCase(markAllNotificationsRead.fulfilled, (s) => {
       const now = new Date().toISOString();
       s.items.forEach((n) => { if (!n.read_at) n.read_at = now; });
       s.unread = 0;
     })
     .addCase(removeNotification.fulfilled, (s, a) => {
       const n = s.items.find((x) => x.id === a.payload);
       if (n && !n.read_at) s.unread = Math.max(0, s.unread - 1);
       s.items = s.items.filter((x) => x.id !== a.payload);
     });
  },
});

export const selectNotifications = (s) => s.notifications.items;
export const selectUnreadCount   = (s) => s.notifications.unread;
export const selectNotifStatus   = (s) => s.notifications.status;

export default notificationsSlice.reducer;
