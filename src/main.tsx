import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { loadDocs } from './lib/docs';
import './lib/install';

loadDocs();
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL;
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch((e) => console.warn('SW failed', e));
  });
}
// ask the browser to keep scans even under storage pressure
navigator.storage?.persist?.().catch(() => {});
