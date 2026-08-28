import { useEffect, useRef, useState } from 'react';
import { AVATARS, getAvatar } from '@/avatars';
import { useT } from '@/i18n';
import styles from './App.module.css';
import { initialAvatar, rememberAvatar } from './avatar-selection';
import { Console } from './console/Console';
import { ControlClient, type ControlStatus, type RendererControls } from './control-client';
import { Hud } from './scene/Hud';
import { AvatarRuntime, type RuntimeStatus } from './scene/runtime';
import { Telemetry } from './scene/Telemetry';
import { stageMode } from './stage-mode';

/**
 * Read once, at module load.
 *
 * The mode is a property of how the page was opened, and re-reading it per
 * render would let a history change swap the console in halfway through a
 * stream. Nothing navigates this page — `rememberAvatar` uses `replaceState` —
 * so once is also all that is ever needed.
 */
const MODE = stageMode();

/**
 * The key that brings the telemetry up and takes it down.
 *
 * Backquote, on the convention every game console in thirty years has used, and
 * because it is the one key on a keyboard that is never part of anything typed
 * into this page. Matched on `key` rather than `code`, so a layout that puts it
 * behind a modifier — JIS, where it is shift and `@` — still reaches it.
 *
 * A key at all, and not only the URL, because of when the readout is wanted: a
 * question about the frame rate or the gaze arrives while a broadcast is
 * running, and the answer is not worth reloading the browser source for.
 */
const TELEMETRY_KEY = '`';

/** Anything the operator could be typing into. The stage page has none. */
const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function App() {
  const { t, tx, locale } = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<ControlClient | null>(null);
  const [runtime, setRuntime] = useState<AvatarRuntime | null>(null);
  const [status, setStatus] = useState<RuntimeStatus>({ phase: 'idle' });
  const [control, setControl] = useState<ControlStatus>('offline');
  const [rejected, setRejected] = useState(0);
  /**
   * The telemetry readout, which the URL opens and the key toggles.
   *
   * State rather than the module constant every other part of the mode is read
   * from, because this is the one thing about how the page presents itself that
   * may change while it is on air — and deliberately not written back to the
   * address bar. See `StageMode.debug`.
   */
  const [debug, setDebug] = useState(MODE.debug);

  /**
   * The runtime again, reachable without a render.
   *
   * The control channel is built once and outlives every avatar, so what it
   * holds has to be stable — a callback closed over `runtime` from state would
   * be the one captured on the render the client happened to be built on.
   */
  const runtimeRef = useRef<AvatarRuntime | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rt = new AvatarRuntime(host);
    runtimeRef.current = rt;
    setRuntime(rt);
    const off = rt.onStatus(setStatus);
    void rt.load(initialAvatar());
    return () => {
      off();
      rt.dispose();
      runtimeRef.current = null;
      setRuntime(null);
    };
  }, []);

  /**
   * What the control API can ask of the page rather than of the scene.
   *
   * The avatar picker in the console makes the same call, which is deliberate:
   * the panel and the console switch avatars by the same path, so the choice is
   * remembered and pinned to the URL either way. See `avatar-selection.ts`.
   */
  const rendererControls = useRef<RendererControls>({
    avatars: AVATARS.map((a) => ({ id: a.id, label: a.label })),
    setDebug,
    /**
     * A `record` command reaches every renderer attached, and only one of them
     * is the one going to air. The mute is what tells them apart, and it is not
     * a proxy for the answer — it *is* the answer: a monitor is a page that
     * makes no sound, and what a take is supposed to contain is what the room
     * heard. See `recordCommandSchema`.
     */
    setRecording: (on, take) => {
      if (MODE.muted) return;
      runtimeRef.current?.setRecording(on, take);
    },
    load: (id) => {
      const next = getAvatar(id);
      const rt = runtimeRef.current;
      if (!(next && rt)) return false;
      // Already there, on its way, or queued behind one that is: the swap would
      // do nothing, and saying otherwise leaves the channel holding commands
      // for a load that will never land. The setup a viewer is handed on
      // connect names the avatar it is usually already showing, so this is the
      // ordinary case rather than the odd one.
      if (rt.avatarId === id) return false;
      rememberAvatar(id);
      void rt.load(next);
      return true;
    },
  }).current;

  /**
   * The tab's own name, which the document carries before React exists.
   *
   * `index.html` states it in English so that the first paint is not in a
   * language nobody chose; from here it follows the switch, because a browser
   * source is picked out of a list of window titles. `lang` moves with it, so
   * the document never claims a language its text is not in.
   */
  useEffect(() => {
    document.title = t('console.documentTitle');
    document.documentElement.lang = locale;
  }, [t, locale]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A modifier makes it somebody else's shortcut — the browser's own
      // console is on one of them. Shift is not checked: on a JIS layout it is
      // how this character is reached at all.
      if (e.key !== TELEMETRY_KEY || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e.target)) return;
      e.preventDefault();
      setDebug((on) => !on);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  /**
   * The control channel outlives the avatar.
   *
   * It holds the connection to the orchestrator, and that connection is not
   * something a swap should interrupt — the session under it is replaced
   * instead.
   */
  useEffect(() => {
    // A load that produced nothing still ends the swap. Without this the client
    // would hold every later command waiting for a session that is not coming.
    if (status.phase === 'failed') controlRef.current?.discardHeld();
    if (status.phase !== 'ready') return;
    const { session } = status.loaded;
    const existing = controlRef.current;
    if (existing) {
      existing.bind(session, status.loaded.avatar.id);
      return;
    }
    const client = new ControlClient(session, {
      onStatus: setControl,
      onRejected: () => setRejected((n) => n + 1),
      renderer: rendererControls,
    });
    client.start();
    controlRef.current = client;
    // `rendererControls` is a ref's value and never changes identity; it is
    // listed because the rule cannot tell that, not because a change would mean
    // anything here.
  }, [status, rendererControls]);

  useEffect(
    () => () => {
      controlRef.current?.stop();
      controlRef.current = null;
    },
    [],
  );

  /**
   * A handle on the live scene, for the console.
   *
   * Development only. Half of what this tool is for is answering "why does that
   * pose look wrong", and the answer usually comes from measuring the rig by
   * hand — `__hashidate.loaded.director.rig.measure('R')` — which is not something
   * a panel can be built to anticipate.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as typeof window & { __hashidate?: unknown };
    w.__hashidate = { runtime, ...(status.phase === 'ready' ? { loaded: status.loaded } : {}) };
  }, [runtime, status]);

  const switchTo = (id: string) => {
    rendererControls.load(id);
  };

  // A fixed render size is applied to the host element rather than to the
  // canvas: the runtime's ResizeObserver watches the host, so one style handles
  // both the initial size and any later change without a second path.
  const sized = MODE.size
    ? { width: `${MODE.size.width}px`, height: `${MODE.size.height}px`, flex: '0 0 auto' }
    : undefined;

  return (
    <div className={`${styles.app} ${MODE.console ? '' : styles.staged}`}>
      <div className={styles.stage} ref={hostRef} style={sized}>
        {/* The HUD is a measurement readout — text over the character's face —
            so it belongs with the console rather than beside it. Including
            while the model is still arriving: a stream that opens on
            「読み込み中…」 (loading…) has put that on the stream. */}
        {MODE.console && !debug && status.phase === 'ready' && runtime ? (
          <Hud runtime={runtime} avatar={status.loaded.avatar} />
        ) : null}
        {/* The same measurements, printed as a shell. It takes over from the
            HUD rather than joining it: two readouts of one set of numbers on
            one frame is a page arguing with itself, and this one says
            everything the HUD does and the state of the document besides. */}
        {debug && status.phase === 'ready' && runtime ? (
          <Telemetry
            runtime={runtime}
            avatar={status.loaded.avatar}
            problems={status.loaded.problems.length}
            mode={MODE}
          />
        ) : null}
        {MODE.console && status.phase === 'loading' ? (
          <div className={styles.loading}>
            {t('console.load.avatar', { name: tx(status.avatar.label) })}
          </div>
        ) : null}
      </div>
      {MODE.console ? (
        <div className={styles.console}>
          <Console
            runtime={runtime}
            status={status}
            control={control}
            rejected={rejected}
            onSwitch={switchTo}
          />
        </div>
      ) : null}
    </div>
  );
}
