import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot } from '@/protocol';
import { isFailure, POLL_INTERVAL, readState } from './api';

/**
 * The runtime, as the panel sees it: one snapshot, re-read on a timer.
 *
 * Polling rather than the SSE stream the viewer uses, and the reason is the
 * direction of the traffic. That stream carries commands *down* to a renderer;
 * a panel subscribing to it would receive every command it just sent and would
 * have to ignore them all. What the panel wants is the other direction — what
 * the renderer reported — and that only exists as state on the server.
 *
 * Nothing here is on a frame. The queue changes when somebody changes it, and
 * the meters update once a line, so half a second is not a compromise.
 */

export interface Runtime {
  snapshot: Snapshot | null;
  /** Null while everything is fine. The panel shows it and keeps its last data. */
  error: string | null;
  /** Re-read now, without waiting for the timer. Every mutation calls it. */
  refresh: () => void;
}

/**
 * An empty snapshot is not the same as no snapshot.
 *
 * The panel draws a queue editor either way, so it needs a shape to render
 * against before the first poll lands — otherwise every field would need its own
 * "not loaded yet" branch, and half of them would get it wrong.
 */
export const EMPTY: Snapshot = {
  connected: false,
  viewers: 0,
  seq: 0,
  state: {},
  vocabulary: {},
  events: [],
  voice: null,
  tuning: null,
  placement: null,
  avatars: [],
  decks: [],
  slides: null,
  speech: 'absent',
  queue: [],
};

export function useRuntime(): Runtime {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set on unmount, and checked after every await.
   *
   * A poll in flight when the component goes away would otherwise call
   * `setState` on something that no longer exists — which React only warns
   * about, and which here would also restart the timer.
   */
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    const result = await readState();
    if (!alive.current) return;
    if (isFailure(result)) {
      // The last snapshot is kept rather than cleared. A restarted server means
      // the panel goes blank for half a second otherwise, and a queue that
      // flickers empty is one an operator will click on by mistake.
      setError(result.error);
    } else {
      setError(null);
      setSnapshot(result);
    }
  }, []);

  const refresh = useCallback(() => {
    void poll();
  }, [poll]);

  useEffect(() => {
    alive.current = true;
    // Chained timeouts rather than an interval: a slow or hung request must not
    // let a second one start behind it, which on a restarting server is how a
    // panel ends up with a dozen sockets waiting on a port nothing is on.
    const loop = async (): Promise<void> => {
      await poll();
      if (!alive.current) return;
      timer.current = setTimeout(() => void loop(), POLL_INTERVAL);
    };
    void loop();
    return () => {
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [poll]);

  return { snapshot, error, refresh };
}
