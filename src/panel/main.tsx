import { createRoot } from 'react-dom/client';
import '@/styles/global.css';
import { Panel } from './Panel';

const host = document.getElementById('root');
if (!host) throw new Error('#root missing from panel/index.html');

/**
 * `StrictMode` is on here, unlike in the viewer.
 *
 * The viewer leaves it off because its mount builds a WebGL context and
 * downloads a 12–16 MB model, and paying for two of each on every hot reload
 * makes the tool unpleasant to work on. This page mounts a polling loop and some
 * forms — the double effect costs one extra request and is worth having, because
 * a poll that survives its own teardown is exactly the bug it catches.
 */
createRoot(host).render(<Panel />);
