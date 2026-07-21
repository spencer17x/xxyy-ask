import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { AdminApp } from './AdminApp.js';
import './styles.css';
import './admin.css';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Unable to mount XXYY Ask: #root is missing.');
}

createRoot(root).render(
  <StrictMode>{window.location.pathname.startsWith('/admin') ? <AdminApp /> : <App />}</StrictMode>,
);
