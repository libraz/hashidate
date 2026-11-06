import { describe, expect, it } from 'vitest';
import { GESTURES } from '@/engine/motion/gestures';
import { FIST } from '@/engine/motion/gestures/hands';
import { minJerk } from '@/engine/motion/timing';
import type { GestureDef, GesturePhase, GestureVariation, Side } from '@/engine/types';

const VARIATION: GestureVariation = { rate: 1, scale: 1, side: 1 };
const ENTRANCE: GesturePhase = { entrance: 0.5, held: 0 };
const SIDES: Side[] = ['L', 'R'];

function arm(def: GestureDef, t: number, phase?: GesturePhase, side = 1) {
  const pose = def.build(t, { ...VARIATION, side }, phase);
  const right = pose.arms?.R;
  const left = pose.arms?.L;
  if (!(right && left)) throw new Error('gesture should pose both arms');
  return { pose, right, left };
}

const horizontalReach = (direction: { x: number; z: number } | undefined): number => {
  if (!direction || direction.z === 0) throw new Error('arm has no forward direction');
  return direction.x / direction.z;
};

describe('gesture preparation follows the actual entrance', () => {
  it.each(SIDES)('comeHere stays compact on the %s side until it has arrived', (side) => {
    const def = GESTURES.comeHere as GestureDef;
    const { right, left } = arm(def, 2, ENTRANCE, side === 'R' ? 1 : -1);
    const pose = side === 'R' ? right : left;

    expect(horizontalReach(pose.lowerArm)).toBeCloseTo(0.14 / 0.95, 12);
  });

  it('comeHere opens after the entrance, then curls on its held clock', () => {
    const def = GESTURES.comeHere as GestureDef;
    for (const side of SIDES) {
      const {
        pose: opening,
        right,
        left,
      } = arm(def, 2, { entrance: 1, held: 0 }, side === 'R' ? 1 : -1);
      const openArm = side === 'R' ? right : left;
      expect(horizontalReach(openArm.lowerArm)).toBeCloseTo(0.14 / 0.95, 12);
      expect(opening.fingers?.[side]?.index).toBeCloseTo(0.14, 12);

      const {
        pose: openHold,
        right: openRight,
        left: openLeft,
      } = arm(def, 2, { entrance: 1, held: 0.9 }, side === 'R' ? 1 : -1);
      const extended = side === 'R' ? openRight : openLeft;
      expect(horizontalReach(extended.lowerArm)).toBeCloseTo(0.22 / 0.95, 12);
      expect(openHold.fingers?.[side]?.index).toBeCloseTo(0.14, 12);

      const { pose: curl } = arm(def, 2, { entrance: 1, held: 1.35 }, side === 'R' ? 1 : -1);
      expect(curl.fingers?.[side]?.index).toBeCloseTo(FIST.curl.index, 12);
    }
  });

  it.each(SIDES)('bravo stays compact on the %s side until it has arrived', (side) => {
    const def = GESTURES.bravo as GestureDef;
    const { right, left } = arm(def, 2, ENTRANCE, side === 'R' ? 1 : -1);
    const pose = side === 'R' ? right : left;

    expect(horizontalReach(pose.lowerArm)).toBeCloseTo(0.2 / 0.9, 12);
  });

  it('bravo completes its sweep on held time', () => {
    const def = GESTURES.bravo as GestureDef;
    const { right, left } = arm(def, 2, { entrance: 1, held: 0.7 });
    expect(horizontalReach(right.lowerArm)).toBeCloseTo(0.33 / 0.9, 12);
    expect(horizontalReach(left.lowerArm)).toBeCloseTo(0.33 / 0.9, 12);
  });

  it('uses a minimum-jerk sweep on each held clock', () => {
    const comeHere = GESTURES.comeHere as GestureDef;
    const bravo = GESTURES.bravo as GestureDef;
    const half = minJerk(0.5);

    expect(
      horizontalReach(arm(comeHere, 0, { entrance: 1, held: 0.45 }).right.lowerArm),
    ).toBeCloseTo((0.14 + 0.08 * half) / 0.95, 12);
    expect(horizontalReach(arm(bravo, 0, { entrance: 1, held: 0.35 }).right.lowerArm)).toBeCloseTo(
      (0.2 + 0.13 * half) / 0.9,
      12,
    );
  });

  it('direct build calls retain the authored lead as the preparation clock', () => {
    const comeHere = GESTURES.comeHere as GestureDef;
    const bravo = GESTURES.bravo as GestureDef;
    const atHome = arm(comeHere, 0.4);
    expect(horizontalReach(atHome.right.lowerArm)).toBeCloseTo(0.14 / 0.95, 12);
    expect(horizontalReach(atHome.left.lowerArm)).toBeCloseTo(0.14 / 0.95, 12);
    expect(atHome.pose.fingers?.R?.index).toBeCloseTo(0.14, 12);

    const bravoHome = arm(bravo, 0.46);
    expect(horizontalReach(bravoHome.right.lowerArm)).toBeCloseTo(0.2 / 0.9, 12);
    expect(horizontalReach(bravoHome.left.lowerArm)).toBeCloseTo(0.2 / 0.9, 12);
    expect(horizontalReach(arm(comeHere, 1.3).right.lowerArm)).toBeCloseTo(0.22 / 0.95, 12);
    expect(horizontalReach(arm(bravo, 1.16).right.lowerArm)).toBeCloseTo(0.33 / 0.9, 12);
  });
});
