import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BGM_DEFAULT_LOOP,
  BGM_DEFAULT_VOLUME,
  BGM_DSP_DEFAULTS,
  BGM_FADE_DEFAULTS,
  type BgmDsp,
  type BgmState,
  type Snapshot,
} from '@/protocol';
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

/** A stable first render, even before a renderer has reported BGM state. */
export const EMPTY_BGM: BgmState = {
  track: null,
  volume: BGM_DEFAULT_VOLUME,
  loop: BGM_DEFAULT_LOOP,
  dsp: {
    ...BGM_DSP_DEFAULTS,
    reverb: { ...BGM_DSP_DEFAULTS.reverb },
    pitch: { ...BGM_DSP_DEFAULTS.pitch },
    presence: { ...BGM_DSP_DEFAULTS.presence },
  },
  fade: { ...BGM_FADE_DEFAULTS },
  transport: 'stopped',
  position: 0,
  revision: 0,
  at: 0,
  duration: null,
  blocked: false,
  error: null,
  dspDegraded: false,
};

type ReportedBgmDsp = Omit<BgmDsp, 'reverb' | 'pitch' | 'presence'> & {
  reverb?: Partial<BgmDsp['reverb']>;
  pitch?: Partial<BgmDsp['pitch']>;
  presence?: Partial<BgmDsp['presence']>;
};

type ReportedBgmState = Omit<BgmState, 'dsp'> & { dsp?: ReportedBgmDsp };

/** Fill DSP groups omitted by a server from before the newer BGM controls. */
export function normalizeBgmState(state: BgmState | undefined): BgmState | undefined {
  if (state === undefined) return undefined;
  const reported = state as unknown as ReportedBgmState;
  const dsp = reported.dsp;
  return {
    ...state,
    dsp: {
      toneDb: dsp?.toneDb ?? BGM_DSP_DEFAULTS.toneDb,
      compression: dsp?.compression ?? BGM_DSP_DEFAULTS.compression,
      width: dsp?.width ?? BGM_DSP_DEFAULTS.width,
      reverb: { ...BGM_DSP_DEFAULTS.reverb, ...dsp?.reverb },
      pitch: { ...BGM_DSP_DEFAULTS.pitch, ...dsp?.pitch },
      presence: { ...BGM_DSP_DEFAULTS.presence, ...dsp?.presence },
    },
  };
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
  airing: [],
  paused: false,
  recording: null,
  bgm: EMPTY_BGM,
  bgmTracks: [],
};

interface ReaderSinks {
  alive: () => boolean;
  onFailure: (message: string) => void;
  onSnapshot: (snapshot: Snapshot) => void;
}

/**
 * One `/state` read at a time.
 *
 * A request arriving while a read is in flight does not start another: it asks
 * for one follow-up read, so a burst of mutations costs one extra round trip
 * rather than a fan-out whose answers land in any order. A snapshot older than
 * the one shown is dropped; after a failure the floor is forgotten, because a
 * restarted server counts from zero again.
 */
export function singleFlight(
  read: () => Promise<Snapshot | { error: string }>,
  sinks: ReaderSinks,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let again = false;
  let shown = -1;

  const once = async (): Promise<void> => {
    const result = await read();
    if (!sinks.alive()) return;
    if (isFailure(result)) {
      shown = -1;
      sinks.onFailure(result.error);
    } else if (result.seq >= shown) {
      shown = result.seq;
      sinks.onSnapshot(result);
    }
  };

  return () => {
    if (inFlight !== null) {
      again = true;
      return inFlight;
    }
    const run = (async () => {
      try {
        do {
          again = false;
          await once();
        } while (again && sinks.alive());
      } finally {
        inFlight = null;
      }
    })();
    inFlight = run;
    return run;
  };
}

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

  const reader = useRef<(() => Promise<void>) | null>(null);
  if (reader.current === null) {
    reader.current = singleFlight(readState, {
      alive: () => alive.current,
      onFailure: (message) => {
        // The last snapshot is kept rather than cleared. A restarted server means
        // the panel goes blank for half a second otherwise, and a queue that
        // flickers empty is one an operator will click on by mistake.
        setError(message);
      },
      onSnapshot: (next) => {
        setError(null);
        setSnapshot({ ...next, bgm: normalizeBgmState(next.bgm) });
      },
    });
  }

  const poll = useCallback(() => (reader.current as () => Promise<void>)(), []);

  const refresh = useCallback(() => {
    void poll();
  }, [poll]);

  useEffect(() => {
    alive.current = true;
    // Chained timeouts rather than an interval: a slow or hung request must not
    // let a second one start behind it, which on a restarting server is how a
    // panel ends up with a dozen sockets waiting on a port nothing is on.
    // Per-mount flag: under StrictMode the first mount's loop outlives its
    // cleanup, and the shared `alive` is true again by then.
    let stopped = false;
    const loop = async (): Promise<void> => {
      await poll();
      if (stopped || !alive.current) return;
      timer.current = setTimeout(() => void loop(), POLL_INTERVAL);
    };
    void loop();
    return () => {
      stopped = true;
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [poll]);

  return { snapshot, error, refresh };
}
