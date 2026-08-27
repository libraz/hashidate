import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@/styles/global.css';

const host = document.getElementById('root');
if (!host) throw new Error('#root missing from index.html');

/**
 * Deliberately not wrapped in `<StrictMode>`.
 *
 * Strict mode mounts every effect twice in development, and the effect here
 * builds a WebGL context and downloads a 12–16 MB GLB. The teardown path is
 * correct — that is what `AvatarRuntime.dispose` is for, and it is worth
 * exercising — but paying for a second context and a second model on every
 * hot reload makes the tool unpleasant to work on for a class of bug the
 * runtime does not have (it holds no React state).
 */
createRoot(host).render(<App />);
