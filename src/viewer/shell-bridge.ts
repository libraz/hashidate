import type { ShotAngle } from '../engine/types/staging';

/**
 * The mascot window's bridge to the process that owns it, and the only module
 * that may refer to it.
 *
 * Letting the mouse through, moving and resizing the window are decided on the
 * page and carried out by the shell, and the round trip through the control
 * server is too slow for a pointer crossing an outline. So the mascot's preload
 * exposes these calls and nothing else: they carry the window's business only,
 * never anything that could be a command or a report.
 *
 * The angle the character is seen from is part of that business. A shot sent
 * over the wire is followed by every renderer, so it would swing the panel's
 * preview and OBS along with the mascot; the angle belonging to this one window
 * travels here instead, kept by the shell and handed back on each load.
 *
 * It is absent everywhere but the mascot window — OBS, a browser, the stage —
 * and a page without it behaves exactly as it did before.
 */
export interface MascotBridge {
  /** Whether the window takes the mouse, or lets it through to what is under it. */
  setInteractive(on: boolean): void;
  /** Move the window by this many screen pixels. */
  moveBy(dx: number, dy: number): void;
  /** Multiply the size by `factor`, within `SCALE_BY_LIMITS`. */
  scaleBy(factor: number): void;
  /** The angle a turn settled on, for the main process to keep. */
  turnTo(angle: ShotAngle): void;
  /** Hear the angle to show: the kept one after each load, the front after a reset. Replays the latest. */
  onShot(fn: (angle: ShotAngle) => void): () => void;
}

declare global {
  interface Window {
    hashidateMascot?: MascotBridge;
  }
}

/** The bridge, or undefined on a page no mascot window opened. */
export const mascotBridge = (): MascotBridge | undefined => window.hashidateMascot;
