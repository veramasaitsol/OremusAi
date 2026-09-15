import axiosClient from '../../services/axiosClient.js';

export async function loginRequest({ email, password }) {
  const { data } = await axiosClient.post('/auth/login', { email, password });
  return data;
}

// Quick-login kept for dev convenience — uses hardcoded credentials
const QUICK_CREDS = {
  admin:  { email: 'admin@oremus.com',        password: 'admin123'  },
  client: { email: 'finance@acmelogistics.in', password: 'acme123'  },
};

export async function quickLoginRequest({ role }) {
  const creds = QUICK_CREDS[role] ?? QUICK_CREDS.admin;
  return loginRequest(creds);
}

export async function forgotPasswordRequest({ email }) {
  const { data } = await axiosClient.post('/auth/forgot-password', { email });
  return data;
}

export async function resetPasswordRequest({ token, password }) {
  const { data } = await axiosClient.post('/auth/reset-password', { token, password });
  return data;
}
