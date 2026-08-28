import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  screen,
  session,
  shell,
} from 'electron';
import { ControlClient } from '../control/client';
import { loadScript, ScriptError } from '../script';
import { runScript } from '../script/run';
import {
  CONTROL_LOG_NAME,
  CONTROL_PATH,
  CONTROL_TITLE,
  checkoutPaths,
  controlPort,
  expectedRoots,
  isAllowedPageURL,
  loopbackURL,
  STAGE_PATH,
  STAGE_TITLE,
  stageURL,
  TTS_LOG_NAME,
} from './config';
import { ControlProcess, TtsProcess } from './process';
import { type DisplayBounds, ShellState, STATE_FILE_NAME } from './state';
import type { WindowBounds } from './types';

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

for (const [name, value] of CHROMIUM_SWITCHES) {
  if (value === undefined) app.commandLine.appendSwitch(name);
  else app.commandLine.appendSwitch(name, value);
}
// Electron otherwise defaults to a generic `Electron` profile. Apart from
// producing opaque SQLite warnings, that makes separate checkout runs share
// state and window geometry.
app.setName('hashidate');
app.setPath('userData', join(app.getPath('appData'), 'hashidate'));
app.setAppLogsPath();
const singleInstance = app.requestSingleInstanceLock();

const paths = checkoutPaths();
const appIcon = join(paths.root, 'src/shell/assets/hashidate-icon.png');
const port = controlPort();
const logs = logDirectory();
// Where the sidecar answers is deliberately not passed to the control child.
// Both work it out from their own copy of this checkout — see `speechEndpoint`
// — so the launcher has nothing to keep in step, and a server an operator
// started themselves reaches the same voice as one started from here.
const tts = new TtsProcess({
  paths,
  ...(logs === null ? {} : { logFile: join(logs, TTS_LOG_NAME) }),
});
const control = new ControlProcess({
  paths,
  port,
  // What a server already on this port has to say it is serving before this
  // one will use it instead of starting its own. See `ControlProbe`.
  roots: expectedRoots(paths),
  ...(logs === null ? {} : { logFile: join(logs, CONTROL_LOG_NAME) }),
});
const client = new ControlClient(loopbackURL(port, '/api'));

const DEFAULT_BOUNDS: Record<WindowKind, WindowBounds> = {
  control: { x: 100, y: 100, width: 1_200, height: 800 },
  stage: { x: 180, y: 150, width: 1_280, height: 720 },
};

type WindowKind = 'control' | 'stage';

const WINDOW_SPEC: Record<WindowKind, { title: string; path: string }> = {
  control: { title: CONTROL_TITLE, path: CONTROL_PATH },
  stage: { title: STAGE_TITLE, path: STAGE_PATH },
};

/**
 * What a page is allowed to ask the operating system for.
 *
 * Everything is refused except writing to the clipboard, which is not a
 * concession so much as the cost of having taken the address bar away: the
 * panel composes one URL for OBS and a button is the only way to get it out of
 * a window that has no way to select from, so a blanket refusal turned that
 * button into one that silently did nothing. Sanitised write only — reading the
 * clipboard is something no page here has any business doing.
 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write']);

// `app` can already be ready while the first instance is still waiting for the
// control server. A second launch may arrive in that interval, so this stays
// nullable until the rest of startup has made window creation safe.
let state: ShellState | null = null;
let controlWindow: BrowserWindow | null = null;
let stageWindow: BrowserWindow | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;
let shutdown: Promise<void> | null = null;

/**
 * How often the menu's status lines are refreshed.
 *
 * Slower than the panel's own polling on purpose. The panel is the surface an
 * operator reads during a broadcast and it is looking at the queue; this is
 * three lines behind a menu somebody opens when something already seems wrong,
 * and a full snapshot fetch a second for it is a round trip nobody reads.
 */
const STATUS_INTERVAL_MS = 2_000;

interface Status {
  control: string;
  speech: string;
  renderers: string;
}

const STARTING_STATUS: Status = {
  control: '● Control: starting',
  speech: '● Speech: unknown',
  // A connection only proves that a renderer is attached. The always-open
  // stage window is one too, so calling this "on-air" would falsely claim OBS
  // is live; OBS has no distinct identity on the control protocol.
  renderers: '● Renderers: disconnected',
};

let status: Status = STARTING_STATUS;

/** Where a child's output goes, or null when the directory cannot be made. */
function logDirectory(): string | null {
  try {
    const directory = app.getPath('logs');
    mkdirSync(directory, { recursive: true });
    return directory;
  } catch {
    return null;
  }
}

function installPermissionPolicy(): void {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionCheckHandler((_contents, permission) =>
    ALLOWED_PERMISSIONS.has(permission),
  );
  defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  defaultSession.setDevicePermissionHandler(() => false);
}

function displayBounds(): DisplayBounds[] {
  return screen.getAllDisplays().map((display) => ({ ...display.bounds }));
}

function windowURL(kind: WindowKind): string {
  if (kind === 'stage') return stageURL(port, state?.stageMuted ?? false);
  return loopbackURL(port, WINDOW_SPEC[kind].path);
}

function makeWindow(kind: WindowKind): BrowserWindow {
  if (state === null) throw new Error('windows were requested before shell startup completed');
  const store = state;
  const spec = WINDOW_SPEC[kind];
  const restored = store.restore(kind, DEFAULT_BOUNDS[kind], displayBounds());
  const window = new BrowserWindow({
    ...restored,
    title: spec.title,
    icon: appIcon,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  window.setTitle(spec.title);
  guardNavigation(window, spec.path);

  const remember = () => store.remember(kind, window.getBounds());
  window.on('move', remember);
  window.on('resize', remember);
  window.on('close', () => {
    remember();
    // The delayed write has to be taken now: a placement moved and then closed
    // has nothing left to trigger the timer it was waiting on.
    store.flush();
  });
  window.on('closed', () => {
    if (kind === 'control' && controlWindow === window) controlWindow = null;
    if (kind === 'stage' && stageWindow === window) stageWindow = null;
  });

  void window
    .loadURL(windowURL(kind))
    .then(() => {
      if (!window.isDestroyed()) window.show();
    })
    .catch((error: unknown) => {
      const message = `Could not load ${spec.title}: ${reason(error)}`;
      console.error(message);
      dialog.showErrorBox('hashidate could not open a window', message);
    });

  if (kind === 'control') controlWindow = window;
  else stageWindow = window;
  return window;
}

/**
 * Keep top-level pages on the two exact loopback entry points. The monitor's
 * own iframe is a child frame and is intentionally left alone; its viewer URL
 * is part of the monitor page's contract.
 */
function guardNavigation(window: BrowserWindow, expectedPath: string): void {
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
  // The page inside sets its own title, and both of these pages set one meant
  // for a browser tab strip — the panel says "hashidate panel", the viewer
  // follows the locale switch. In a window list two of those are hard to tell
  // apart, and the menu that raises them names them differently again. The
  // window keeps the name the menu uses.
  webContents.on('page-title-updated', (event) => {
    event.preventDefault();
  });
}

function showWindow(kind: WindowKind): void {
  // A second-instance notification is allowed while startup waits for control.
  // The first instance will create both windows once that wait completes.
  if (state === null) return;
  const existing = kind === 'control' ? controlWindow : stageWindow;
  if (existing === null || existing.isDestroyed()) {
    // A new window shows itself once its page has loaded, which is the whole
    // reason it was created hidden — raising it here would put an empty white
    // rectangle on screen for as long as the renderer takes to come up.
    makeWindow(kind);
    return;
  }
  if (existing.isMinimized()) existing.restore();
  existing.show();
  existing.focus();
}

/**
 * Silence the stage window, or let it speak.
 *
 * The stage is the one renderer in this application that makes a sound, and
 * whether it should is a property of the desk rather than of the broadcast: with
 * OBS monitoring its browser source, the room is already hearing the character
 * and this window makes it every line twice, a fraction of a second apart. With
 * monitoring off, this window is the only way to hear anything at all.
 *
 * Nothing outside this machine can answer that, so it is a switch, and it is
 * remembered. See `stageURL` for why it costs a reload.
 */
function setStageMuted(muted: boolean): void {
  if (state === null) return;
  state.setStageMuted(muted);
  rebuildMenu();
  const window = stageWindow;
  if (window === null || window.isDestroyed()) return;
  void window.loadURL(stageURL(port, muted)).catch((error: unknown) => {
    console.error(`could not reopen the stage: ${reason(error)}`);
  });
}

/**
 * The application menu, rebuilt rather than mutated.
 *
 * A status line changes a handful of times in an evening — the control server
 * coming up, a voice finishing its model, a renderer attaching — so building
 * the whole menu on each change costs nothing, and it is the one way of
 * changing a native menu that behaves the same on every platform.
 */
function buildMenu(): Menu {
  const disabled = (label: string): MenuItemConstructorOptions => ({ label, enabled: false });

  const windowMenu: MenuItemConstructorOptions[] = [
    { label: CONTROL_TITLE, click: () => showWindow('control') },
    { label: STAGE_TITLE, click: () => showWindow('stage') },
    {
      label: 'Mute Stage',
      type: 'checkbox',
      checked: state?.stageMuted ?? false,
      click: (item) => setStageMuted(item.checked),
    },
    { type: 'separator' },
    { label: 'Open Slides Folder', click: () => void openDirectory(paths.slides) },
    { label: 'Open Scripts Folder', click: () => void openDirectory(paths.scripts) },
    { label: 'Open Motions Folder', click: () => void openDirectory(paths.motions) },
    // The one of the four that is an output rather than something brought to
    // the broadcast, and the one an operator goes looking for straight after a
    // take rather than before one.
    { label: 'Open Recordings Folder', click: () => void openDirectory(paths.recordings) },
    { type: 'separator' },
    disabled(status.control),
    disabled(status.speech),
    disabled(status.renderers),
  ];

  // macOS turns the first submenu into the application menu whatever it is
  // called, so without this one `File` becomes it and Quit ends up somewhere
  // nobody looks for it. Elsewhere there is no such menu, and an empty first
  // one would be worse than none.
  const onMac = process.platform === 'darwin';

  return Menu.buildFromTemplate([
    ...(onMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Run Script…',
          accelerator: 'CommandOrControl+Shift+O',
          click: () => void chooseAndRunScript(),
        },
        // On macOS the application menu above already carries it, with the
        // accelerator this would be claiming a second time.
        ...(onMac
          ? []
          : ([{ type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[])),
      ],
    },
    // Not decoration. Without an Edit menu carrying these roles, macOS does not
    // wire up the shortcuts behind them at all — and the panel is a page an
    // operator writes lines into, so a window with no paste in it is a window a
    // script cannot be brought into.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: 'Window', submenu: windowMenu },
  ]);
}

function rebuildMenu(): void {
  Menu.setApplicationMenu(buildMenu());
}

async function openDirectory(path: string): Promise<void> {
  const error = await shell.openPath(path);
  if (error) console.error(`could not open ${path}: ${error}`);
}

async function chooseAndRunScript(): Promise<void> {
  const result = await dialog.showOpenDialog({
    title: 'Run Script',
    defaultPath: paths.scripts,
    properties: ['openFile'],
    filters: [{ name: 'Hashidate scripts', extensions: ['yaml', 'yml', 'json'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return;

  const selected = result.filePaths[0];
  if (selected === undefined) return;
  try {
    const loaded = await loadScript(selected);
    const run = await runScript(client, loaded);
    if (run.setup !== undefined && isRefused(run.setup)) {
      console.warn('script setup was not delivered: no viewer is connected');
    }
    console.log(
      `${loaded.script.lines.length} queued from ${loaded.id}: ${run.queue.queue.length} pending, ${run.queue.viewers} viewer(s)`,
    );
  } catch (error) {
    const message = error instanceof ScriptError ? error.message : reason(error);
    dialog.showErrorBox('Could not run script', message);
  }
}

function isRefused(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

async function refreshStatus(): Promise<void> {
  let next: Status;
  try {
    const snapshot = await client.state();
    next = {
      control: '● Control: online',
      speech: `● Speech: ${snapshot.speech}`,
      renderers: snapshot.connected
        ? `● Renderers: connected (${snapshot.viewers})`
        : '● Renderers: disconnected',
    };
  } catch {
    next = {
      control: '● Control: offline',
      speech: '● Speech: unknown',
      renderers: '● Renderers: disconnected',
    };
  }
  if (
    next.control === status.control &&
    next.speech === status.speech &&
    next.renderers === status.renderers
  ) {
    return;
  }
  status = next;
  rebuildMenu();
}

function beginStatusPolling(): void {
  void refreshStatus();
  statusTimer = setInterval(() => void refreshStatus(), STATUS_INTERVAL_MS);
  statusTimer.unref?.();
}

async function stopChildren(): Promise<void> {
  if (statusTimer !== null) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  // A placement changed in the last few hundred milliseconds is still sitting
  // on a timer that is about to be outlived.
  state?.flush();
  // TTS is optional, but if it was ours it is still part of the shell's
  // process tree and must not survive an application quit.
  await Promise.all([tts.stop(), control.stop()]);
}

function requestShutdown(): void {
  if (shutdown !== null) return;
  shutdown = stopChildren();
}

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  requestShutdown();
  void shutdown?.catch(() => {}).finally(() => app.exit(0));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Both, not whichever one is missing first. The stage is the window that makes
// the sound, so an application brought back to the front with only the panel
// showing is one that looks like it is running and cannot be heard.
app.on('activate', () => {
  showWindow('control');
  showWindow('stage');
});

app.on('second-instance', () => {
  if (!app.isReady()) return;
  showWindow('stage');
  // Raised last, so it is the one with focus: a second launch is somebody
  // looking for the controls.
  showWindow('control');
});

app
  .whenReady()
  .then(async () => {
    if (!singleInstance) {
      app.quit();
      return;
    }
    app.dock?.setIcon(appIcon);
    installPermissionPolicy();
    await control.start();
    // Model loading is intentionally not on the critical path. The viewer and
    // control API work without a voice, and SpeechWatch reports loading/absence.
    void tts.start();

    state = new ShellState(join(app.getPath('userData'), STATE_FILE_NAME));
    rebuildMenu();
    makeWindow('control');
    makeWindow('stage');
    beginStatusPolling();
  })
  .catch(async (error: unknown) => {
    const message = `hashidate shell could not start: ${reason(error)}`;
    console.error(message);
    dialog.showErrorBox('hashidate could not start', message);
    requestShutdown();
    await shutdown?.catch(() => {});
    app.exit(1);
  });

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
