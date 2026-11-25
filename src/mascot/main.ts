import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  type IpcMainEvent,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  Tray,
} from 'electron';
import { ControlClient } from '../control/client';
import { getLocale } from '../i18n/locale';
import { translate } from '../i18n/translate';
import { type Command, snapshotSchema } from '../protocol';
import {
  CONTROL_LOG_NAME,
  checkoutPaths,
  controlPort,
  expectedRoots,
  loopbackURL,
  MASCOT_PATH,
  mascotPageURL,
  TTS_LOG_NAME,
} from '../shell/config';
import type { DisplayInfo } from '../shell/displays';
import { ControlProcess, TtsProcess } from '../shell/process';
import { claimProfile, guardNavigation, LOCK_HELD_EXIT_CODE, logDirectory } from '../shell/profile';
import { type MascotMode, type MascotState, ShellState, STATE_FILE_NAME } from '../shell/state';
import {
  DEFAULT_MASCOT_STATE,
  DRAG_SETTLE_MS,
  type MascotAction,
  nextMascotState,
  placeMascot,
} from './bounds';
import { contextMenu, type MascotMenuHandlers, type MascotMenuModel, trayMenu } from './menu';
import type { MascotCalls } from './preload';

/**
 * The character on the desktop: one transparent window over everything else,
 * and a tray icon to reach it by.
 *
 * It shares the broadcast shell's profile, and so its lock. The two are the
 * same renderer and the same voice opened two ways, and both running would say
 * every line twice — so whichever starts second stops, and this one says so
 * with an exit code, because what starts a mascot is usually another program
 * that has to tell "one is already up" from a crash.
 *
 * Like the shell it is a launcher for a development checkout: it resolves the
 * repository from its own source and loads one exact loopback address.
 */

const paths = checkoutPaths();
const locked = claimProfile(paths.root);
// Nothing has been opened yet, so there is nothing to wind down. A second
// launch is not forwarded anywhere either: the one already running keeps going.
if (!locked) app.exit(LOCK_HELD_EXIT_CODE);

const appIcon = join(paths.root, 'src/shell/assets/hashidate-icon.png');
const preload = join(paths.dist, 'mascot/preload.cjs');
const port = controlPort();
const logs = logDirectory();
const tts = new TtsProcess({
  paths,
  ...(logs === null ? {} : { logFile: join(logs, TTS_LOG_NAME) }),
});
const control = new ControlProcess({
  paths,
  port,
  roots: expectedRoots(paths),
  ...(logs === null ? {} : { logFile: join(logs, CONTROL_LOG_NAME) }),
});
const client = new ControlClient(loopbackURL(port, '/api'));

/** The tray icon's edge, in points. */
const TRAY_ICON_SIZE = 18;

/**
 * How long a menu waits for the control server to say what avatars and outfits
 * there are. A menu that has not opened looks like a click that was missed, so
 * past this it opens without them.
 */
const MENU_FETCH_TIMEOUT_MS = 1_000;

let store: ShellState | null = null;
let state: MascotState = DEFAULT_MASCOT_STATE;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

/** The connected displays in the shape `bounds.ts` reads, the primary one first. */
function displays(): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay().id;
  return screen
    .getAllDisplays()
    .map(({ id, label, internal, bounds, workArea }) => ({
      id,
      label,
      internal,
      bounds: { ...bounds },
      workArea: { ...workArea },
    }))
    .sort((a, b) => Number(b.id === primary) - Number(a.id === primary));
}

function liveWindow(): BrowserWindow | null {
  return window !== null && !window.isDestroyed() ? window : null;
}

/** Put the window where the state says it goes. Sized in one step, never dragged out. */
function place(): void {
  liveWindow()?.setBounds(placeMascot(state, displays()));
}

function save(): void {
  store?.setMascot(state);
}

/** Take the save a drag is still waiting on, so nothing after it works from a stale point. */
function settle(): void {
  if (settleTimer === null) return;
  clearTimeout(settleTimer);
  settleTimer = null;
  save();
  // Dropped over an edge, it is pushed back to where it was saved.
  place();
}

function apply(action: MascotAction): void {
  settle();
  state = nextMascotState(state, action, displays());
  save();
  place();
}

/**
 * Silence the mascot, or let it speak.
 *
 * On the address, as the stage window's is, so it costs a reload: a renderer
 * that is quiet has to be quiet for a reason that can be read off its URL.
 */
function setMuted(muted: boolean): void {
  settle();
  state = { ...state, muted };
  save();
  void liveWindow()
    ?.loadURL(mascotPageURL(port, { muted }))
    .catch((error: unknown) => {
      if (!isSupersededLoad(error)) console.error(`could not reopen the mascot: ${reason(error)}`);
    });
}

function setVisible(visible: boolean): void {
  const target = liveWindow();
  if (target === null) return;
  // Shown without being activated: the character appears, the keyboard stays
  // with whatever the person was typing into.
  if (visible) target.showInactive();
  else target.hide();
}

const handlers: MascotMenuHandlers = {
  setVisible,
  setMode: (mode: MascotMode) => apply({ type: 'mode', mode }),
  stepScale: (dir) => apply({ type: 'stepScale', dir }),
  setAvatar: (id) => void send({ cmd: 'avatar', id }),
  setOutfit: (id) => void send({ cmd: 'wear', preset: id }),
  setMuted,
  resetPosition: () => apply({ type: 'reset' }),
  quit: () => app.quit(),
};

async function send(command: Command): Promise<void> {
  try {
    await client.command(command);
  } catch (error) {
    console.error(`could not send ${command.cmd}: ${reason(error)}`);
  }
}

/** What the menus show, with the lists only the control server knows. */
async function menuModel(): Promise<MascotMenuModel> {
  const base = { state, visible: liveWindow()?.isVisible() ?? false };
  try {
    const snapshot = snapshotSchema.parse(
      await client.request('/state', undefined, MENU_FETCH_TIMEOUT_MS),
    );
    return {
      ...base,
      avatars: snapshot.avatars,
      avatar: snapshot.avatar?.id ?? null,
      outfits: snapshot.vocabulary.wardrobePresets ?? [],
    };
  } catch {
    // No server, or no renderer attached yet: the rest of the menu still works.
    return { ...base, avatars: [], avatar: null, outfits: [] };
  }
}

async function openTrayMenu(): Promise<void> {
  const menu = Menu.buildFromTemplate(trayMenu(await menuModel(), handlers));
  tray?.popUpContextMenu(menu);
}

async function openContextMenu(): Promise<void> {
  const menu = Menu.buildFromTemplate(contextMenu(await menuModel(), handlers));
  const target = liveWindow();
  if (target !== null) menu.popup({ window: target });
}

/** Refuse every permission: the mascot's page asks the operating system for nothing. */
function installPermissionPolicy(): void {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionCheckHandler(() => false);
  defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  defaultSession.setDevicePermissionHandler(() => false);
}

/**
 * Hear one of the bridge's calls, from the mascot's own page and no other.
 *
 * The arguments are checked by each handler: they crossed a process boundary,
 * and what the preload's types say about them is a promise the page made.
 */
function onCall<C extends keyof MascotCalls>(
  channel: C,
  handle: (target: BrowserWindow, ...args: unknown[]) => void,
): void {
  ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
    const target = liveWindow();
    if (target === null || event.sender !== target.webContents) return;
    if (event.senderFrame !== target.webContents.mainFrame) return;
    handle(target, ...args);
  });
}

function installBridge(): void {
  onCall('mascot:set-interactive', (target, on) => {
    if (typeof on !== 'boolean') return;
    // Forwarded while ignored, so the page still sees the pointer arrive over
    // the character and can ask for the mouse back.
    target.setIgnoreMouseEvents(!on, { forward: true });
  });

  onCall('mascot:move-by', (target, dx, dy) => {
    if (typeof dx !== 'number' || typeof dy !== 'number') return;
    if (!(Number.isFinite(dx) && Number.isFinite(dy))) return;
    const [x = 0, y = 0] = target.getPosition();
    target.setPosition(Math.round(x + dx), Math.round(y + dy));
    // Free from the first movement. The bridge never reports the release, so
    // the drag has ended when this long passes with no further movement.
    state = nextMascotState(state, { type: 'move', bounds: target.getBounds() }, displays());
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      save();
      place();
    }, DRAG_SETTLE_MS);
  });

  onCall('mascot:step-scale', (_target, dir) => {
    if (dir !== 1 && dir !== -1) return;
    apply({ type: 'stepScale', dir });
  });
}

function makeWindow(): BrowserWindow {
  const created = new BrowserWindow({
    ...placeMascot(state, displays()),
    transparent: true,
    frame: false,
    hasShadow: false,
    // A panel floats over other applications' windows without becoming the
    // active application when it is clicked.
    type: 'panel',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Per window: the mascot is behind something for most of its life and
      // has to keep speaking there.
      backgroundThrottling: false,
    },
  });
  created.setAlwaysOnTop(true, 'floating');
  // Every desktop, but not over another application's full-screen space.
  created.setVisibleOnAllWorkspaces(true);
  // Let through until the page says the pointer is on the character.
  created.setIgnoreMouseEvents(true, { forward: true });

  // The one address it was opened on, silenced or not.
  guardNavigation(created, MASCOT_PATH, port);
  created.webContents.on('context-menu', () => void openContextMenu());
  created.webContents.once('did-finish-load', () => {
    if (!created.isDestroyed()) created.showInactive();
  });
  created.on('closed', () => {
    if (window === created) window = null;
  });
  void created.loadURL(mascotPageURL(port, { muted: state.muted })).catch((error: unknown) => {
    if (!isSupersededLoad(error)) console.error(`could not load the mascot: ${reason(error)}`);
  });
  return created;
}

function makeTray(): Tray {
  const icon = nativeImage
    .createFromPath(appIcon)
    .resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
  const created = new Tray(icon);
  created.setToolTip(translate('mascot.tray.tooltip', getLocale()));
  // Built when it is opened rather than kept: the avatar and outfit lists are
  // the control server's, and a menu made at startup would show none.
  created.on('click', () => void openTrayMenu());
  created.on('right-click', () => void openTrayMenu());
  return created;
}

/** A navigation replaced by a newer one rejects with `ERR_ABORTED` (-3). */
function isSupersededLoad(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: unknown }).code === 'ERR_ABORTED' ||
      (error as { errno?: unknown }).errno === -3)
  );
}

async function stopChildren(): Promise<void> {
  settle();
  await Promise.all([tts.stop(), control.stop()]);
}

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  // Zero is "the person quit it", which is what tells a supervisor not to
  // start it again.
  void stopChildren()
    .catch(() => {})
    .finally(() => app.exit(0));
});

// A hidden mascot is still running: the tray is how it comes back.
app.on('window-all-closed', () => {});

if (locked) {
  app
    .whenReady()
    .then(async () => {
      // The tray is the application's whole presence; a Dock icon beside the
      // one of whatever launched it would be a second thing to quit.
      app.dock?.hide();
      installPermissionPolicy();
      await control.start({ speechExpected: await tts.expected() });
      // Not on the critical path, as in the shell: the page works without a voice.
      void tts.start();

      store = new ShellState(join(app.getPath('userData'), STATE_FILE_NAME));
      state = store.mascot ?? DEFAULT_MASCOT_STATE;
      installBridge();
      // A display unplugged or a dock moved changes where the same state goes.
      // The state itself is left alone, so the mascot returns with the display.
      screen.on('display-added', place);
      screen.on('display-removed', place);
      screen.on('display-metrics-changed', place);
      tray = makeTray();
      window = makeWindow();
    })
    .catch(async (error: unknown) => {
      console.error(`hashidate mascot could not start: ${reason(error)}`);
      shuttingDown = true;
      await stopChildren().catch(() => {});
      app.exit(1);
    });
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
