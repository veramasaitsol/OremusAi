import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { store } from './app/store.js';
import './index.css';

// Dev helper — run window.__resetZoho() in browser console to force the
// Zoho connection popup to reappear (clears local token + session skip flag).
if (import.meta.env.DEV) {
  window.__resetZoho = () => {
    localStorage.removeItem('oremus_zoho_v1');
    sessionStorage.removeItem('oremus_zoho_modal_skipped');
    location.reload();
  };
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Provider store={store}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Provider>
  </React.StrictMode>
);
