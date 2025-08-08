import ReactDOM from 'react-dom/client';
import App from './app.tsx';
import './style.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  // StrictMode triggers double effects in dev, causing flicker and duplicate timers
  // Remove it in extension popup to stabilize UX.
  <App />
);
