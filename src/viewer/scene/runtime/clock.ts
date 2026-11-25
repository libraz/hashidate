import type * as THREE from 'three';

/**
 * Capped at 50 ms whatever the frame took. Below 20 fps the simulation
 * deliberately runs slow rather than integrating a step large enough to
 * throw the sway chains, which is a far more visible failure than lag.
 */
export const MAX_DT = 0.05;

/** One frame's two clocks: `elapsed` is real time, `dt` the integrators' capped step. */
export interface FrameStep {
  readonly dt: number;
  readonly elapsed: number;
}

/**
 * Advances `timer` to the animation frame's timestamp and reads both clocks off it.
 *
 * The timestamp is the one rAF hands the frame, so a turn's clocks advance by
 * exactly the frame interval rather than by whenever the callback got to
 * `performance.now()`. It can precede the timer's last reading — a `reset()`
 * reads the wall clock after the frame began — so `elapsed` is floored at 0.
 * It has no upper bound: a turn keeps pace with its voice across a long frame.
 */
export function frameStep(timer: THREE.Timer, time?: number): FrameStep {
  timer.update(time);
  const elapsed = Math.max(0, timer.getDelta());
  return { dt: Math.min(elapsed, MAX_DT), elapsed };
}
