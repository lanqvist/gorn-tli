import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { OverlayApp } from './OverlayApp.js';
import './overlay.css';

const root = document.getElementById('root');
if (!root) throw new Error('Не найден корневой элемент');

createRoot(root).render(
  <StrictMode>
    <OverlayApp />
  </StrictMode>,
);
