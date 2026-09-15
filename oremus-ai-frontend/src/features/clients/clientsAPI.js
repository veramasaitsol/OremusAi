import axiosClient from '../../services/axiosClient.js';

export const fetchClients   = (search = '') =>
  axiosClient.get('/clients', { params: { search } }).then((r) => r.data);

export const createClient   = (payload) =>
  axiosClient.post('/clients', payload).then((r) => r.data);

export const updateClient   = (id, payload) =>
  axiosClient.put(`/clients/${id}`, payload).then((r) => r.data);

export const deleteClient   = (id) =>
  axiosClient.delete(`/clients/${id}`).then((r) => r.data);

/** Returns { url, clientToken } — navigate to url to begin Zoho OAuth for this client. */
export const getClientZohoConnectURL = (id) =>
  axiosClient.post(`/clients/${id}/connect-zoho`).then((r) => r.data);

export const disconnectClientZoho = (id) =>
  axiosClient.post(`/clients/${id}/disconnect-zoho`).then((r) => r.data);

/** Returns { url, clientToken } — navigate to url to begin QuickBooks OAuth for this client. */
export const getClientQBOConnectURL = (id) =>
  axiosClient.post(`/clients/${id}/connect-quickbooks`).then((r) => r.data);

export const disconnectClientQBO = (id) =>
  axiosClient.post(`/clients/${id}/disconnect-quickbooks`).then((r) => r.data);

/** Returns { url, clientToken } — navigate to url to begin Xero OAuth for this client. */
export const getClientXeroConnectURL = (id) =>
  axiosClient.post(`/clients/${id}/connect-xero`).then((r) => r.data);

export const disconnectClientXero = (id) =>
  axiosClient.post(`/clients/${id}/disconnect-xero`).then((r) => r.data);
