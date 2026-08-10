import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ToastLayerApp } from './ToastLayerApp.js';
import './toasts.css';

const root = document.getElementById('root');
if (!root) throw new Error('Не найден корневой элемент');

createRoot(root).render(
  <StrictMode>
    <ToastLayerApp />
  </StrictMode>,
);
