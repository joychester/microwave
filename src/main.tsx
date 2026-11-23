import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';
import { startChangeLog } from './ui/changeLog';

startChangeLog();

createRoot(document.getElementById('root')!).render(<App />);
