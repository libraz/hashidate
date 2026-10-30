import { useEffect, useRef, useState } from 'react';
import { avatarReplaces } from '@/engine/session/folds';
import type { AvatarDescriptor } from '@/engine/types';
import { useT } from '@/i18n';
import { isTyping } from '@/ui/typing';
import styles from './App.module.css';
import { chooseAvatar, pinnedAvatar, rememberAvatar, rememberedAvatar } from './avatar-selection';
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
  /** What the control server listed. Empty until the first stream open answers. */
  const [roster, setRoster] = useState<AvatarDescriptor[]>([]);

  /**
   * The runtime again, reachable without a render.
   *
   * The control channel is built once and outlives every avatar, so what it
   * holds has to be stable — a callback closed over `runtime` from state would
   * be the one captured on the render the client happened to be built on.
   */
  const runtimeRef = useRef<AvatarRuntime | null>(null);
  /** The roster again, for the same reason as `runtimeRef`. */
  const rosterRef = useRef<AvatarDescriptor[]>([]);
  /** An `avatar` command that arrived before there was a roster to look it up in. */
  const pendingRef = useRef<string | null>(null);
  /** Set by the first load, whoever asked for it; a later roster never reloads. */
  const startedRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the useRef value is stable for the page lifetime
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rt = new AvatarRuntime(host);
    runtimeRef.current = rt;
    setRuntime(rt);
    // The stream belongs to the page, not to the GLB. Start it while the first
    // model is still loading so a slow or missing avatar is observable and can
    // keep receiving commands without making the control server guess whether
    // this renderer ever existed.
    const client = new ControlClient(null, {
      onStatus: setControl,
      onRejected: () => setRejected((n) => n + 1),
      renderer: rendererControls,
    });
    controlRef.current = client;
    const off = rt.onStatus((next) => {
      setStatus(next);
      if (next.phase === 'failed') {
        client.setAvatarStatus({ phase: 'failed', id: next.avatar.id, error: next.message });
        // A failed load cannot end the hold that was waiting for it. The old
        // session, when there is one, remains usable for subsequent commands.
        // With another avatar queued behind it the hold is for that one.
        if (!rt.hasQueuedLoad) client.discardHeld();
      } else if (next.phase === 'ready') {
        client.setAvatarStatus({
          phase: 'ready',
          id: next.loaded.avatar.id,
          problems: next.loaded.problems,
        });
        client.bind(next.loaded.session, next.loaded.avatar.id);
      } else if (next.phase === 'loading') {
        client.setAvatarStatus({ phase: 'loading', id: next.avatar.id });
      } else {
        client.setAvatarStatus({ phase: next.phase });
      }
    });
    client.start();
    return () => {
      off();
      client.stop();
      if (controlRef.current === client) controlRef.current = null;
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
    setDebug,
    /**
     * The roster arrives after the page does, so the first avatar is chosen
     * here. Once one is loading, a later roster only refreshes the picker.
     */
    setAvatars: (list) => {
      rosterRef.current = list;
      setRoster(list);
      const rt = runtimeRef.current;
      if (!rt || startedRef.current) return;
      const pending = pendingRef.current;
      const first = chooseAvatar(list, {
        pending,
        pinned: pinnedAvatar(),
        remembered: rememberedAvatar(),
      });
      if (!first) {
        // An empty roster cannot honour a pending avatar either.
        if (pending !== null) controlRef.current?.discardHeld();
        pendingRef.current = null;
        return;
      }
      pendingRef.current = null;
      startedRef.current = true;
      // The channel is holding commands for a pending avatar the roster does
      // not have; nothing will ever end that hold.
      if (pending !== null && pending !== first.id) controlRef.current?.discardHeld();
      if (pending === first.id) rememberAvatar(first.id);
      void rt.load(first);
    },
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
    setBgm: (command) => {
      runtimeRef.current?.setBgm(command);
    },
    bgmReport: () => runtimeRef.current?.bgmReport ?? null,
    load: (id) => {
      const rt = runtimeRef.current;
      if (!rt) return false;
      // Setup is delivered the moment the stream opens, before the roster has
      // been fetched. Honour it once the roster arrives rather than refuse it.
      if (rosterRef.current.length === 0) {
        if (startedRef.current) return false;
        pendingRef.current = id;
        return true;
      }
      const next = rosterRef.current.find((a) => a.id === id);
      if (!next) return false;
      // Already there, on its way, or queued behind one that is: the swap would
      // do nothing, and saying otherwise leaves the channel holding commands
      // for a load that will never land. The setup a viewer is handed on
      // connect names the avatar it is usually already showing, so this is the
      // ordinary case rather than the odd one.
      if (!avatarReplaces(rt.avatarId, id)) return false;
      rememberAvatar(id);
      startedRef.current = true;
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
            avatars={roster}
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
