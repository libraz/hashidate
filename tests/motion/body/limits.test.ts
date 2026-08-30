import { describe, expect, it } from 'vitest';
import { gestureEntries } from '@/engine/motion';
import type { Side } from '@/engine/types';
import { DT, harness, wristOf } from './harness';

/**
 * That the anatomical limiter cannot teleport a hand.
 *
 * The clamp is a projection onto the poses a joint allows, and that set is not
 * convex — the humeral rotation is bounded to half a circle, so a request that
 * drifts past the far side of it is equally near both stops and the nearer one
 * changes between two frames. The forearm used to answer by swinging half a
 * turn on the switch frame, which is the one artefact a viewer reads as the
 * character being replaced rather than moving. `Rig.slew` is what stops it, and
 * this is what says so.
 *
 * Measured at the wrist and per frame, because a teleport is a distance covered
 * in no time and nothing else. The bound is physical rather than tuned: these
 * avatars have an arm a third of a metre long, the movement layer's own peak is
 * two to three metres a second, and nothing a body does carries a wrist at eight.
 */

/** Far enough above the movement's own peak that only a jump can reach it. */
const TELEPORT = 8;

/**
 * The poses that sit against a stop, which is where the seams are. Every one of
 * them was over the bound before the slew existed, `listen` at twenty-six.
 */
const AGAINST_A_STOP = [
  'listen',
  'think',
  'catPaw',
  'chin',
  'handsClasp',
  'beg',
  'clap',
  'stretch',
  'cheekPoke',
  'whisper',
];

/** The fastest wrist speed either hand reaches over a switch, in m/s. */
function switchSpeed(from: string | null, to: string): number {
  const h = harness();
  h.rig.reset();
  h.body.update(DT);
  if (from) h.body.play(from);
  // Long enough for the outgoing pose to have settled onto its stop, which is
  // the state a switch has to leave from.
  for (let i = 0; i < 180; i++) {
    h.rig.reset();
    h.body.update(DT);
  }
  h.body.play(to);

  const was: Record<Side, ReturnType<typeof wristOf>> = {
    L: wristOf(h.profile, 'L'),
    R: wristOf(h.profile, 'R'),
  };
  let worst = 0;
  for (let i = 0; i < 120; i++) {
    h.rig.reset();
    h.body.update(DT);
    for (const side of ['L', 'R'] as Side[]) {
      const now = wristOf(h.profile, side);
      worst = Math.max(worst, was[side].distanceTo(now) / DT);
      was[side] = now;
    }
  }
  return worst;
}

/**
 * Long enough for a hundred switches on a shared runner under coverage.
 *
 * Every ordered pair below is five seconds of simulated body, and the layer it
 * exercises is the one the coverage provider instruments — three seconds here,
 * half a minute on a cold CI machine, against a default of five. The number is
 * not a budget for the suite: it is only what keeps a slow machine from
 * reporting a timeout where the property under test is what it always was.
 */
const SLOW = 120_000;

describe('the anatomical limiter', () => {
  it(
    'never carries a wrist faster than a body can, on any switch between poses',
    () => {
      const over: string[] = [];
      for (const from of [null, ...AGAINST_A_STOP] as Array<string | null>) {
        for (const to of AGAINST_A_STOP) {
          if (from === to) continue;
          const speed = switchSpeed(from, to);
          if (speed > TELEPORT) over.push(`${from ?? 'rest'} -> ${to}: ${speed.toFixed(1)} m/s`);
        }
      }
      expect(over).toEqual([]);
    },
    SLOW,
  );

  it('still lets every held pose arrive inside its own entrance', () => {
    // The other half of the bargain, and the one a cap set too low would break:
    // slowing the limiter must not slow the movement. Every sustained pose has
    // to be where it is going by the time its entrance is over, which is the
    // property `entrance.test.ts` states for one pose and this one states for
    // all of them — a link the cap was riding would arrive after its lead
    // instead of during it.
    const late: string[] = [];
    for (const [id, def] of gestureEntries()) {
      if (!def.sustain) continue;
      const h = harness();
      h.rig.reset();
      h.body.update(DT);
      h.body.play(id);
      const lead = h.body.gesture?.lead ?? 0;
      const track = [];
      for (let i = 0; i < 150; i++) {
        h.rig.reset();
        h.body.update(DT);
        track.push(wristOf(h.profile, 'R'));
      }
      const end = track[track.length - 1];
      const far = Math.max(...track.map((p) => p.distanceTo(end)));
      // A pose this hand does not move for has nothing to arrive at.
      if (far < 0.02) continue;
      const settled = track.findIndex((p) => p.distanceTo(end) < far * 0.05);
      if (!(settled > 0 && settled * DT < lead)) late.push(`${id}: ${(settled * DT).toFixed(2)}s`);
    }
    expect(late).toEqual([]);
  });
});
