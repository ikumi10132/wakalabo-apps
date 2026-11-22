import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { SsoApp } from './SsoApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SsoApp />
  </StrictMode>,
);
