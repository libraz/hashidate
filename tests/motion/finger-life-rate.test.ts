import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FingerLife, type HandSensePose } from '@/engine/motion/finger-life';
import { buildProfile } from '@/engine/profile';
import { buildRig } from '../helpers/scene';

const STEP = 0.02;
const pose = (x = 0, z = 0): HandSensePose => ({
  knuckle: new THREE.Vector3(x, 0, z),
  palm: new THREE.Vector3(0, 0, 1),
  forearm: new THREE.Vector3(0, 1, 0),
  index: new THREE.Vector3(-0.02, 0, 0),
  little: new THREE.Vector3(0.02, 0, 0),
});
const target = pose(0.025, 0.02);
const makeLife = () => {
  const built = buildRig();
  const life = new FingerLife(buildProfile(built.root, built.descriptor), {});
  life.sense('R', STEP, pose());
  return life;
};
// Vertical palm and fixed wrist remove gravity and tenodesis; these calls
// remove idle/breath and leave the middle finger's full lag and splay.
const read = (life: FingerLife) => [
  life.offset('R', 'middle', 0.5, 0, 0, 0, 1),
  life.spread('R', 'middle', 0, 1),
];

const checkpoints = [0.02, 0.06, 0.1, 0.16, 0.22, 0.3, 0.4, 0.6, 0.8];
function trace(partition: readonly number[]): number[][] {
  const life = makeLife();
  const result: number[][] = [];
  let elapsed = 0;
  let frame = 0;
  for (const end of checkpoints) {
    while (end - elapsed > 1e-12) {
      const dt = Math.min(partition[frame++ % partition.length], end - elapsed);
      life.sense('R', dt, target);
      elapsed += dt;
    }
    result.push(read(life));
  }
  return result;
}

describe('FingerLife lag time partition', () => {
  it.each([
    ['30 Hz', [1 / 30]],
    ['50 Hz', [1 / 50]],
    ['60 Hz', [1 / 60]],
    ['144 Hz', [1 / 144]],
    ['irregular', [0.007, 0.043, 0.011, 0.029, 0.05]],
  ] as const)('preserves transient curl and splay at %s', (_name, partition) => {
    const reference = trace([STEP]);
    const actual = trace(partition);
    for (let i = 0; i < reference.length; i++) {
      for (let axis = 0; axis < 2; axis++) {
        expect(actual[i][axis]).toBeCloseTo(reference[i][axis], 12);
      }
    }
    for (const axis of [0, 1]) {
      expect(actual[0][axis]).toBeLessThan(-0.01);
      expect(Math.max(...actual.map((sample) => sample[axis]))).toBeGreaterThan(0.001);
    }
  });

  it('retains the old 50 Hz discrete trace, including follow-through', () => {
    const life = makeLife();
    let point = 0;
    let velocity = 0;
    let peak = 0;
    // Independent scalar recurrence of the original implicit update, with a
    // unit target; both world axes scale this same response before saturation.
    for (let frame = 0; frame < 40; frame++) {
      velocity =
        (velocity + (1 - point) * 22 * 22 * STEP) /
        (1 + 2 * 0.6 * 22 * STEP + 22 * 22 * STEP * STEP);
      point += velocity * STEP;
      life.sense('R', STEP, target);
      const actual = read(life);
      expect(actual[0]).toBeCloseTo(0.15 * Math.tanh((9.7 * 0.02 * (point - 1)) / 0.15), 14);
      expect(actual[1]).toBeCloseTo(0.14 * Math.tanh((3.5 * 0.025 * (point - 1)) / 0.14), 14);
      peak = Math.max(peak, actual[0]);
    }
    expect(peak).toBeGreaterThan(0.001);
  });

  it.each(['stale', 'teleport'] as const)('reseeds lag and carried state after %s', (reason) => {
    const life = makeLife();
    life.sense('R', STEP, target);
    expect(read(life)[0]).toBeLessThan(-0.01);
    const destination = reason === 'teleport' ? pose(1, 1) : target;
    life.sense('R', reason === 'stale' ? 0.101 : STEP, destination);
    expect(read(life)).toEqual([0, 0]);
    life.sense('R', STEP, destination);
    expect(read(life)).toEqual([0, 0]);
  });

  it('ignores nonpositive dt and null poses without changing carried state', () => {
    const life = makeLife();
    const control = makeLife();
    life.sense('R', STEP, target);
    control.sense('R', STEP, target);
    const before = read(life);
    life.sense('R', 0, pose(1, 1));
    life.sense('R', -STEP, pose(1, 1));
    life.sense('R', 0.2, null);
    expect(read(life)).toEqual(before);
    life.sense('R', STEP, target);
    control.sense('R', STEP, target);
    expect(read(life)).toEqual(read(control));
  });
});
