import { contextBridge, ipcRenderer } from 'electron';
import type { MascotBridge } from '../viewer/shell-bridge';

/**
 * The mascot window's preload: the three calls of `MascotBridge`, each sent to
 * the main process as it is.
 *
 * Nothing here decides anything. The page works out whether the pointer is on
 * the character and how far a drag has gone; the main process checks what
 * arrives and moves the window. Built to CommonJS by `vite.preload.config.ts`,
 * so the only runtime import this file may have is `electron`.
 */

/** The channels the bridge sends on, and what each carries. */
export interface MascotCalls {
  'mascot:set-interactive': [on: boolean];
  'mascot:move-by': [dx: number, dy: number];
  'mascot:step-scale': [dir: 1 | -1];
}

function send<C extends keyof MascotCalls>(channel: C, ...args: MascotCalls[C]): void {
  ipcRenderer.send(channel, ...args);
}

const bridge: MascotBridge = {
  setInteractive: (on) => send('mascot:set-interactive', on),
  moveBy: (dx, dy) => send('mascot:move-by', dx, dy),
  stepScale: (dir) => send('mascot:step-scale', dir),
};

contextBridge.exposeInMainWorld('hashidateMascot', bridge);
