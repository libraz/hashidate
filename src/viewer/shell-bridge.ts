/**
 * The mascot window's bridge to the process that owns it, and the only module
 * that may refer to it.
 *
 * Letting the mouse through and moving the window are decided on the page and
 * carried out by the shell, and the round trip through the control server is
 * too slow for a pointer crossing an outline. So the mascot's preload exposes
 * these calls and nothing else: they carry the window's business only, never
 * anything that could be a command or a report.
 *
 * It is absent everywhere but the mascot window — OBS, a browser, the stage —
 * and a page without it behaves exactly as it did before.
 */
export interface MascotBridge {
  /** Whether the window takes the mouse, or lets it through to what is under it. */
  setInteractive(on: boolean): void;
  /** Move the window by this many screen pixels. */
  moveBy(dx: number, dy: number): void;
  /** Make the window one step larger (`1`) or smaller (`-1`). */
  stepScale(dir: 1 | -1): void;
}

declare global {
  interface Window {
    hashidateMascot?: MascotBridge;
  }
}

/** The bridge, or undefined on a page no mascot window opened. */
export const mascotBridge = (): MascotBridge | undefined => window.hashidateMascot;
