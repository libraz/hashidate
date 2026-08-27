import { useEffect, useRef, useState } from 'react';
import { AVATARS, getAvatar } from '@/avatars';
import styles from './App.module.css';
import { initialAvatar, rememberAvatar } from './avatar-selection';
import { Console } from './console/Console';
import { ControlClient, type ControlStatus, type RendererControls } from './control-client';
import { onMonitorMute } from './monitor-link';
import { Hud } from './scene/Hud';
import { AvatarRuntime, type RuntimeStatus } from './scene/runtime';
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

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<ControlClient | null>(null);
  const [runtime, setRuntime] = useState<AvatarRuntime | null>(null);
  const [status, setStatus] = useState<RuntimeStatus>({ phase: 'idle' });
  const [control, setControl] = useState<ControlStatus>('offline');
  const [rejected, setRejected] = useState(0);

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
   * Which avatar is on screen, as a thing the control API can ask for.
   *
   * The same call the picker in the console makes, which is deliberate: the
   * panel and the console switch avatars by the same path, so the choice is
   * remembered and pinned to the URL either way. See `avatar-selection.ts`.
   */
  const rendererControls = useRef<RendererControls>({
    avatars: AVATARS.map((a) => ({ id: a.id, label: a.label })),
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
   * The embedder's mute, when this page is the panel's preview.
   *
   * Bound to the runtime and not to the session: it is about which speakers the
   * sound comes out of, which is a property of this renderer rather than of the
   * performance. See `monitor-link.ts` — on a page nobody framed, this attaches
   * nothing at all.
   */
  useEffect(() => {
    if (!runtime) return;
    return onMonitorMute((muted) => runtime.setMuted(muted));
  }, [runtime]);

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
   * hand — `__aituber.loaded.director.rig.measure('R')` — which is not something
   * a panel can be built to anticipate.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as typeof window & { __aituber?: unknown };
    w.__aituber = { runtime, ...(status.phase === 'ready' ? { loaded: status.loaded } : {}) };
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
            「読み込み中…」 has put that on the stream. */}
        {MODE.console && status.phase === 'ready' && runtime ? (
          <Hud runtime={runtime} avatar={status.loaded.avatar} />
        ) : null}
        {MODE.console && status.phase === 'loading' ? (
          <div className={styles.loading}>{status.avatar.label} を読み込み中…</div>
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
