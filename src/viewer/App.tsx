import { useEffect, useRef, useState } from 'react';
import { getAvatar } from '@/avatars';
import styles from './App.module.css';
import { initialAvatar, rememberAvatar } from './avatar-selection';
import { Console } from './console/Console';
import { ControlClient, type ControlStatus } from './control-client';
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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rt = new AvatarRuntime(host);
    setRuntime(rt);
    const off = rt.onStatus(setStatus);
    void rt.load(initialAvatar());
    return () => {
      off();
      rt.dispose();
      setRuntime(null);
    };
  }, []);

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
    if (status.phase !== 'ready') return;
    const { session } = status.loaded;
    const existing = controlRef.current;
    if (existing) {
      existing.bind(session);
      return;
    }
    const client = new ControlClient(session, {
      onStatus: setControl,
      onRejected: () => setRejected((n) => n + 1),
    });
    client.start();
    controlRef.current = client;
  }, [status]);

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
    const next = getAvatar(id);
    if (!(next && runtime)) return;
    rememberAvatar(id);
    void runtime.load(next);
  };

  // A fixed render size is applied to the host element rather than to the
  // canvas: the runtime's ResizeObserver watches the host, so one style handles
  // both the initial size and any later change without a second path.
  const sized = MODE.size
    ? { width: `${MODE.size.width}px`, height: `${MODE.size.height}px`, flex: '0 0 auto' }
    : undefined;

  return (
    <div className={`${styles.app} ${MODE.stage ? styles.staged : ''}`}>
      <div className={styles.stage} ref={hostRef} style={sized}>
        {/* The HUD is a measurement readout. On a stream it is text over the
            character's face, so stage mode is the one place it must not appear
            — including while the model is still arriving. */}
        {!MODE.stage && status.phase === 'ready' && runtime ? (
          <Hud runtime={runtime} avatar={status.loaded.avatar} />
        ) : null}
        {!MODE.stage && status.phase === 'loading' ? (
          <div className={styles.loading}>{status.avatar.label} を読み込み中…</div>
        ) : null}
      </div>
      {MODE.stage ? null : (
        <div className={styles.console}>
          <Console
            runtime={runtime}
            status={status}
            control={control}
            rejected={rejected}
            onSwitch={switchTo}
          />
        </div>
      )}
    </div>
  );
}
