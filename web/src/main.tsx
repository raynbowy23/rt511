import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';

const host = document.querySelector<HTMLElement>('#app');
if (!host) throw new Error('#app is missing');

// StrictMode is on deliberately: it double-invokes every effect in development, which is exactly the pressure that catches a player or an observer that is not torn down.
createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
