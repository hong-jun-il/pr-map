import { createRoot } from 'react-dom/client';
import type { ViewerData } from '../shared/types';
import { App } from './App';
import './styles.css';

declare global {
  interface Window {
    __PR_MAP__: ViewerData | null;
  }
}

createRoot(document.getElementById('root')!).render(<App data={window.__PR_MAP__} />);
