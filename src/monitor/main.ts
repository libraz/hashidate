/**
 * The stage: the viewer page, letterboxed, and nothing else.
 *
 * It exists so that the renderer an operator watches is the renderer OBS opens,
 * pixel for pixel, without either application's code around it. The bars are
 * the parent document's, so the frame inside always receives 16:9 whatever
 * shape the window is dragged into.
 */

import './monitor.css';

const host = document.getElementById('root');
if (!host) throw new Error('#root missing from monitor/index.html');

const frame = document.createElement('iframe');
frame.className = 'viewer';
frame.title = 'hashidate stage';
frame.tabIndex = -1;
// The stage is the one in-app renderer that is allowed to play the voice.
frame.setAttribute('allow', 'autoplay');

/**
 * Open the viewer at the root while preserving the monitor's source settings.
 *
 * Everything is passed through rather than picked from, `mute` included — which
 * is how the native shell silences this window: it reopens the page at
 * `/monitor/?mute=1` and the flag arrives at the renderer exactly as it does
 * for a browser source. See `stageURL`.
 */
const viewer = new URL('/', window.location.href);
viewer.search = window.location.search;
frame.src = viewer.href;

host.append(frame);
