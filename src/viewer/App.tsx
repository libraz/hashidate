import { useEffect, useRef, useState } from 'react';
import { getAvatar } from '@/avatars';
import styles from './App.module.css';
import { initialAvatar, rememberAvatar } from './avatar-selection';
import { Console } from './console/Console';
import { ControlClient, type ControlStatus } from './control-client';
import { Hud } from './scene/Hud';
import { AvatarRuntime, type RuntimeStatus } from './scene/runtime';

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

  return (
    <div className={styles.app}>
      <div className={styles.stage} ref={hostRef}>
        {status.phase === 'ready' && runtime ? (
          <Hud runtime={runtime} avatar={status.loaded.avatar} />
        ) : null}
        {status.phase === 'loading' ? (
          <div className={styles.loading}>{status.avatar.label} を読み込み中…</div>
        ) : null}
      </div>
      <div className={styles.console}>
        <Console
          runtime={runtime}
          status={status}
          control={control}
          rejected={rejected}
          onSwitch={switchTo}
        />
      </div>
    </div>
  );
}
