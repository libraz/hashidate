import type { DisplayBounds } from './state';
import type { WindowBounds } from './types';

/**
 * Which display the stage goes to, named the way an operator would name it.
 *
 * Pure so the menu wording and the placement arithmetic can be checked without
 * Electron; `main.ts` feeds it `screen.getAllDisplays()`.
 */

/** The parts of an Electron `Display` the menu needs. */
export interface DisplayInfo {
  id: number;
  label: string;
  internal: boolean;
  bounds: DisplayBounds;
  workArea: DisplayBounds;
}

/**
 * `DELL U2720Q — 2560×1440`, or `Display 2 — …` when the platform gives no
 * name. The built-in screen says so, since that is the one a broadcast is
 * almost never meant to go to.
 */
export function displayLabel(display: DisplayInfo, index: number): string {
  const name = display.label.trim() || `Display ${index + 1}`;
  const size = `${display.bounds.width}×${display.bounds.height}`;
  return `${name} — ${size}${display.internal ? ' (built-in)' : ''}`;
}

/**
 * The window's size, clamped to the display's work area and centred in it.
 *
 * Moved onto the display before going full screen, because full screen fills
 * whichever display the window is on and has no say in which one that is.
 */
export function boundsOn(window: WindowBounds, display: DisplayInfo): WindowBounds {
  const area = display.workArea;
  const width = Math.min(window.width, area.width);
  const height = Math.min(window.height, area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

/** The display the window's centre is over, or null when it is over none. */
export function displayUnder(
  window: WindowBounds,
  displays: readonly DisplayInfo[],
): DisplayInfo | null {
  const cx = window.x + window.width / 2;
  const cy = window.y + window.height / 2;
  return (
    displays.find(
      ({ bounds: b }) => cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height,
    ) ?? null
  );
}
