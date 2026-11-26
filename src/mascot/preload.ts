import { contextBridge, ipcRenderer } from 'electron';
import type { ShotAngle } from '../engine/types/staging';
import type { MascotBridge } from '../viewer/shell-bridge';

/**
 * The mascot window's preload: the calls of `MascotBridge`, each sent to the
 * main process as it is, and the angle it sends back, kept for late listeners.
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
  'mascot:scale-by': [factor: number];
  'mascot:turn-to': [yaw: number, pitch: number];
}

/** The channel the main process sends the angle to show on. */
export const SHOT_CHANNEL = 'mascot:shot';

/** The angle in a payload from the main process, or null unless both numbers are finite. */
export function shotFrom(value: unknown): ShotAngle | null {
  if (typeof value !== 'object' || value === null) return null;
  const { yaw, pitch } = value as Partial<Record<keyof ShotAngle, unknown>>;
  return typeof yaw === 'number' &&
    typeof pitch === 'number' &&
    Number.isFinite(yaw) &&
    Number.isFinite(pitch)
    ? { yaw, pitch }
    : null;
}

function send<C extends keyof MascotCalls>(channel: C, ...args: MascotCalls[C]): void {
  ipcRenderer.send(channel, ...args);
}

let latest: ShotAngle | null = null;
const listeners = new Set<(angle: ShotAngle) => void>();

ipcRenderer.on(SHOT_CHANNEL, (_event, payload: unknown) => {
  const angle = shotFrom(payload);
  if (angle === null) return;
  latest = angle;
  for (const listener of listeners) listener(angle);
});

const bridge: MascotBridge = {
  setInteractive: (on) => send('mascot:set-interactive', on),
  moveBy: (dx, dy) => send('mascot:move-by', dx, dy),
  scaleBy: (factor) => send('mascot:scale-by', factor),
  turnTo: ({ yaw, pitch }) => send('mascot:turn-to', yaw, pitch),
  onShot: (fn) => {
    listeners.add(fn);
    if (latest !== null) fn(latest);
    return () => {
      listeners.delete(fn);
    };
  },
};

contextBridge.exposeInMainWorld('hashidateMascot', bridge);
