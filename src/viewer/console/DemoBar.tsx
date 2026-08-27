import { useEffect, useRef, useState } from 'react';
import type { Session } from '@/engine/session';
import { Demo, type DemoState } from '../demo';
import styles from './DemoBar.module.css';

/**
 * Start and stop the self-test, and say where it has got to.
 *
 * One strip rather than a tab, because it has two controls and because it is
 * checked *while looking at the render* — a demo behind a tab is a demo whose
 * progress readout is hidden exactly when it is being watched.
 *
 * ## It is driven from here, not from the render loop
 *
 * `requestAnimationFrame` rather than a `setInterval`, and the distinction is
 * not stylistic: a walk that ran on a timer would keep advancing in a
 * backgrounded tab, firing thirty poses into a renderer drawing none of them and
 * finishing with a clean report on a test nobody saw. rAF stops with the tab, so
 * the demo resumes where it was rather than having silently completed.
 *
 * It is also why this does not live in `AvatarRuntime`: the demo drives the
 * *session*, and the session is rebuilt on every avatar swap while the runtime
 * is not. Hanging it here means it is torn down and rebuilt on the same boundary
 * as the thing it drives.
 */

export function DemoBar({ session }: { session: Session | null }) {
  const [state, setState] = useState<DemoState>({
    running: false,
    index: -1,
    label: '',
    total: 0,
  });
  const demo = useRef<Demo | null>(null);

  useEffect(() => {
    if (!session) {
      demo.current = null;
      setState({ running: false, index: -1, label: '', total: 0 });
      return;
    }
    const instance = new Demo(session);
    demo.current = instance;
    const off = instance.on(setState);

    let frame = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      instance.tick(dt);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      off();
      // Stopping on teardown, not merely dropping the reference: an avatar
      // swapped mid-walk would otherwise leave the outgoing session's last pose
      // — a held gesture, a close-up — applied to whatever loads next.
      instance.stop();
      demo.current = null;
    };
  }, [session]);

  const running = state.running;

  return (
    <div className={`${styles.bar} ${running ? styles.running : ''}`}>
      <button
        type="button"
        className={styles.button}
        disabled={!session}
        onClick={() => (running ? demo.current?.stop() : demo.current?.start())}
      >
        {running ? '中止' : '自動デモ'}
      </button>
      <span className={styles.label} title={running ? state.label : '語彙を一通り実演します'}>
        {running ? state.label : '語彙を一通り実演します'}
      </span>
      {running ? (
        <span className={styles.count}>
          {state.index + 1}/{state.total}
        </span>
      ) : null}
      {running ? (
        <span className={styles.track} aria-hidden="true">
          <span
            className={styles.fill}
            style={{ width: `${state.total ? ((state.index + 1) / state.total) * 100 : 0}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}
