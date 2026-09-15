import axiosClient from '../../services/axiosClient.js';

export async function fetchNotifications({ status, page = 1, limit = 30 } = {}) {
  const params = { page, limit };
  if (status) params.status = status;
  const { data } = await axiosClient.get('/notifications', { params });
  return data; // { data, total, unread, page, limit }
}

export async function fetchUnreadCount() {
  const { data } = await axiosClient.get('/notifications/unread-count');
  return data.count ?? 0;
}

export async function generateNotifications() {
  const { data } = await axiosClient.post('/notifications/generate');
  return data; // { created }
}

export async function markRead(id) {
  const { data } = await axiosClient.patch(`/notifications/${id}/read`);
  return data;
}

export async function markAllRead() {
  const { data } = await axiosClient.post('/notifications/read-all');
  return data; // { updated }
}

export async function deleteNotification(id) {
  const { data } = await axiosClient.delete(`/notifications/${id}`);
  return data;
}
