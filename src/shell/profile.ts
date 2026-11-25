import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app, type BrowserWindow } from 'electron';
import { checkoutProfileId, isAllowedPageURL } from './config';

/**
 * The Electron profile of a checkout, shared by everything launched from it.
 *
 * The broadcast shell and the mascot are two applications over one renderer
 * and one voice, so they take the same profile and with it the same
 * single-instance lock: whichever starts second finds the lock held and does
 * not open a second renderer that would say every line again.
 */

/**
 * The stage must keep rendering and its audio context must be allowed to start
 * while the control window has focus. These switches are process-wide and have
 * to be installed before Electron becomes ready.
 *
 * The autoplay policy is one of them rather than a line of its own, so that the
 * list is the list: a switch applied outside it is a switch nobody reading this
 * knows about. It is what lets the stage window make a sound without anybody
 * having clicked it first — in a browser that click is the operator's to give,
 * and here there is no page for them to give it to.
 */
export const CHROMIUM_SWITCHES: ReadonlyArray<readonly [string, string?]> = [
  ['disable-background-timer-throttling'],
  ['disable-renderer-backgrounding'],
  ['disable-backgrounding-occluded-windows'],
  ['autoplay-policy', 'no-user-gesture-required'],
];

/**
 * What a launch that found the lock held exits with, where it reports that at
 * all: `EX_TEMPFAIL`, so a supervisor can tell "another one is running" from a
 * crash and not start it again.
 */
export const LOCK_HELD_EXIT_CODE = 75;

/**
 * Install the switches, name the profile after the checkout and ask for its
 * lock. Has to run before Electron becomes ready.
 *
 * @returns Whether this process holds the lock.
 */
export function claimProfile(root: string): boolean {
  for (const [name, value] of CHROMIUM_SWITCHES) {
    if (value === undefined) app.commandLine.appendSwitch(name);
    else app.commandLine.appendSwitch(name, value);
  }
  // Electron otherwise defaults to a generic `Electron` profile. Apart from
  // producing opaque SQLite warnings, that makes separate checkout runs share
  // state and window geometry. One profile per checkout also gives each its own
  // single-instance lock, which Electron keys on the profile directory.
  const profileId = checkoutProfileId(root);
  app.setName('hashidate');
  app.setPath('userData', join(app.getPath('appData'), 'hashidate', profileId));
  app.setAppLogsPath();
  app.setAppLogsPath(join(app.getPath('logs'), profileId));
  return app.requestSingleInstanceLock();
}

/** Where a child's output goes, or null when the directory cannot be made. */
export function logDirectory(): string | null {
  try {
    const directory = app.getPath('logs');
    mkdirSync(directory, { recursive: true });
    return directory;
  } catch {
    return null;
  }
}

/**
 * Keep top-level pages on the exact loopback entry point the window was opened
 * on. The monitor's own iframe is a child frame and is intentionally left
 * alone; its viewer URL is part of the monitor page's contract.
 */
export function guardNavigation(window: BrowserWindow, expectedPath: string, port: number): void {
  const { webContents } = window;
  const allowed = (url: string) => isAllowedPageURL(url, expectedPath, port);

  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  webContents.on('will-redirect', (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  webContents.on('will-attach-webview', (event) => {
    // No page in this application needs a webview. Blocking one also prevents
    // a future page edit from bypassing the navigation and permission policy.
    event.preventDefault();
  });
}
