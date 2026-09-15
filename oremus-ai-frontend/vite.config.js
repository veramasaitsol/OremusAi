import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react':   ['react', 'react-dom', 'react-router-dom'],
          'vendor-redux':   ['@reduxjs/toolkit', 'react-redux'],
          'vendor-charts':  ['recharts'],
          'vendor-axios':   ['axios'],
          'vendor-lucide':  ['lucide-react'],
        },
      },
    },
  },
  server: {
    port: 5174,
    host: true,
    proxy: {
      // Proxies /zoho-token → https://accounts.zoho.in/oauth/v2/token
      // Avoids CORS errors when exchanging the OAuth code in the browser.
      // In production, move the token exchange to your backend.
      '/zoho-token': {
        target: 'https://accounts.zoho.in',
        changeOrigin: true,
        rewrite: () => '/oauth/v2/token',
        secure: true,
      },
      // Proxies /api → local Node.js backend (dev only; prod uses VITE_API_URL in .env.production)
      '/api': {
        target: process.env.VITE_DEV_API || 'http://localhost:5001',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
