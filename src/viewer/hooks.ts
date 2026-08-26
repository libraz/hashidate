import { useEffect, useState } from 'react';
import type { Session } from '@/engine/session';
import type { SessionState } from '@/engine/types';

/**
 * Follow the session rather than only pushing to it.
 *
 * The autopilot changes the very things the console displays — the mood, the
 * face, the gesture — so a panel that only wrote would sit showing whatever the
 * operator last clicked while the character did something else. Polled at 5 Hz
 * because this is an operator console, not an instrument: hanging it off the
 * frame loop would reconcile the whole tree sixty times a second to move a
 * number nobody is reading that fast.
 */
export function useSessionState(session: Session | null, hz = 5): SessionState | null {
  const [state, setState] = useState<SessionState | null>(null);

  useEffect(() => {
    if (!session) {
      setState(null);
      return;
    }
    setState(session.state());
    const id = setInterval(() => setState(session.state()), 1000 / hz);
    return () => clearInterval(id);
  }, [session, hz]);

  return state;
}

/**
 * A bare repaint clock, for readouts that are measured on demand rather than
 * carried in the session state — the joint strain table asks the rig to measure
 * an arm, which allocates, so it is pulled at a low rate instead of pushed.
 */
export function useTick(hz: number, active = true): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000 / hz);
    return () => clearInterval(id);
  }, [hz, active]);
  return tick;
}
