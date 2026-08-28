import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  BASE_FINGERS,
  BASE_PALM,
  BASE_POSE,
  GESTURE_GROUPS,
  GESTURES,
  GESTURES_BY_GROUP,
  type GestureId,
  POINT_HAND,
  pointHand,
} from '@/engine/motion/gestures';
import { BODY_ANCHORS, FACE_ANCHORS } from '@/engine/profile';
import type {
  FingerName,
  GestureDef,
  GestureVariation,
  Pose,
  ReachSpec,
  Side,
} from '@/engine/types';

/**
 * Table invariants.
 *
 * Nothing here poses a rig: the gesture table is data plus a pure `build`, and
 * what these check is that a newly added gesture cannot be added wrong — a
 * misspelled anchor, a raw vector that skipped the normalising helper, a group
 * that no longer exists, a finger name the rig has never heard of.
 */

/**
 * The table read through its declared interface.
 *
 * `GESTURES` is written with `satisfies`, so each entry keeps the literal type
 * of the pose its own `build` happens to return. That is what the runtime wants
 * and the wrong view for a table-wide check, which has to see every entry as the
 * same `GestureDef`.
 */
const TABLE: Record<GestureId, GestureDef> = GESTURES;

const IDS = Object.keys(TABLE) as GestureId[];
const SIDES: Side[] = ['L', 'R'];
const FINGERS: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];
const SPINE_SLOTS = ['hips', 'spine', 'chest', 'neck', 'head'];
const ARM_VECTORS = ['shoulder', 'upperArm', 'lowerArm', 'hand', 'palm'] as const;

const RIGHT: GestureVariation = { rate: 1, scale: 1, side: 1 };
const LEFT: GestureVariation = { rate: 1, scale: 1, side: -1 };

/** Enough of a playthrough to catch a term that only misbehaves once moving. */
const TIMES = [0, 0.017, 0.25, 0.9, 2.5, 6];

const posesOf = (id: GestureId, v: GestureVariation = RIGHT): Pose[] =>
  TIMES.map((t) => TABLE[id].build(t, v));

const reachesOf = (pose: Pose): ReachSpec[] => Object.values(pose.reach ?? {});

const sidesUsed = (pose: Pose): string =>
  SIDES.filter((s) => pose.arms?.[s] !== undefined || pose.reach?.[s] !== undefined).join('');

const each = <T>(rows: T[]) => it.each(rows);

/** Gestures that author arm directions, that solve a reach, and that do neither. */
const ARM_IDS = IDS.filter((id) => Object.keys(TABLE[id].build(0.3, RIGHT).arms ?? {}).length);
const REACH_IDS = IDS.filter((id) => reachesOf(TABLE[id].build(0.3, RIGHT)).length);
const FINGER_IDS = IDS.filter(
  (id) => Object.keys(TABLE[id].build(0.3, RIGHT).fingers ?? {}).length,
);

describe('gesture table', () => {
  it('holds exactly 34 gestures, each under its own id', () => {
    // Pinned so a dropped or duplicated entry is a failure rather than a
    // silently shorter menu.
    expect(IDS.length).toBe(34);
    expect(new Set(IDS).size).toBe(IDS.length);
  });

  each(IDS)('%s names a group that exists', (id) => {
    expect(Object.keys(GESTURE_GROUPS)).toContain(TABLE[id].group);
  });

  each(IDS)('%s has a label and a usable timing', (id) => {
    const g = TABLE[id];
    expect(g.label.en.length).toBeGreaterThan(0);
    expect(g.label.ja.length).toBeGreaterThan(0);
    expect(g.lead).toBeGreaterThanOrEqual(0);
    expect(g.hold).toBeGreaterThan(0);
    expect(Number.isFinite(g.lead)).toBe(true);
    expect(Number.isFinite(g.hold)).toBe(true);
  });

  it('holds every gesture until released only in the pose group', () => {
    for (const id of IDS) {
      expect(TABLE[id].sustain === true).toBe(TABLE[id].group === 'pose');
    }
  });
});

describe('GESTURES_BY_GROUP', () => {
  it('lists the groups in the order the group table declares them', () => {
    expect(GESTURES_BY_GROUP.map((g) => g.key)).toEqual(Object.keys(GESTURE_GROUPS));
    for (const entry of GESTURES_BY_GROUP) {
      expect(entry.label).toBe(GESTURE_GROUPS[entry.key]);
      expect(entry.ids.length).toBeGreaterThan(0);
    }
  });

  it('covers every gesture exactly once', () => {
    const listed = GESTURES_BY_GROUP.flatMap((g) => g.ids);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...IDS].sort());
  });

  it('files each id under its own group', () => {
    for (const entry of GESTURES_BY_GROUP) {
      for (const id of entry.ids) expect(TABLE[id].group).toBe(entry.key);
    }
  });
});

describe('poses the table builds', () => {
  it('splits the table between authored directions, reaches and spine-only', () => {
    // Every gesture is one of the three, and nothing is both.
    expect(ARM_IDS.length).toBe(20);
    expect(REACH_IDS.length).toBe(11);
    expect(ARM_IDS.filter((id) => REACH_IDS.includes(id))).toEqual([]);
    expect(ARM_IDS.length + REACH_IDS.length + 3).toBe(IDS.length);
    expect(FINGER_IDS.length).toBe(ARM_IDS.length + REACH_IDS.length);
  });

  each(ARM_IDS)('%s aims every arm link with a unit vector', (id) => {
    // The authoring helper normalises, so a raw literal that slipped past it —
    // or a component arithmetic that cancelled to zero — shows up here.
    for (const pose of posesOf(id)) {
      for (const side of SIDES) {
        const arm = pose.arms?.[side];
        if (!arm) continue;
        for (const slot of ARM_VECTORS) {
          const v = arm[slot];
          if (!v) continue;
          expect(v).toBeInstanceOf(THREE.Vector3);
          expect(v.length()).toBeCloseTo(1, 9);
        }
        if (arm.twist !== undefined) expect(Number.isFinite(arm.twist)).toBe(true);
      }
    }
  });

  each(FINGER_IDS)('%s curls only fingers that exist, and only within 0..1', (id) => {
    for (const pose of posesOf(id)) {
      for (const side of SIDES) {
        const fingers = pose.fingers?.[side];
        if (!fingers) continue;
        // All five, every time: a partial block leaves the missing fingers
        // wherever the previous gesture left them.
        expect(Object.keys(fingers).sort()).toEqual([...FINGERS].sort());
        for (const [name, curl] of Object.entries(fingers)) {
          expect(FINGERS).toContain(name as FingerName);
          expect(curl).toBeGreaterThanOrEqual(0);
          expect(curl).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  each(IDS)('%s offsets only spine slots that exist, by finite radians', (id) => {
    for (const pose of posesOf(id)) {
      for (const [slot, offset] of Object.entries(pose.spine ?? {})) {
        expect(SPINE_SLOTS).toContain(slot);
        expect(offset).toHaveLength(3);
        for (const a of offset) {
          expect(Number.isFinite(a)).toBe(true);
          // Spine offsets are additive and small; a degree figure that never
          // got converted would be an order of magnitude past this.
          expect(Math.abs(a)).toBeLessThan(1);
        }
      }
    }
  });

  each(IDS)('%s never poses one side by directions and by reach at once', (id) => {
    for (const pose of posesOf(id)) {
      for (const side of SIDES) {
        expect(pose.arms?.[side] !== undefined && pose.reach?.[side] !== undefined).toBe(false);
      }
    }
  });

  each(IDS)('%s gives every hand it poses a finger shape', (id) => {
    for (const pose of posesOf(id)) {
      for (const side of SIDES) {
        if (pose.arms?.[side] || pose.reach?.[side]) expect(pose.fingers?.[side]).toBeDefined();
      }
    }
  });
});

describe('reach specs', () => {
  each(REACH_IDS)('%s reaches for an anchor that exists', (id) => {
    for (const pose of posesOf(id)) {
      for (const spec of reachesOf(pose)) {
        const table = spec.space === 'body' ? BODY_ANCHORS : FACE_ANCHORS;
        expect(Object.keys(table)).toContain(spec.at);
      }
    }
  });

  each(REACH_IDS)('%s states a usable hand and palm direction on every reach', (id) => {
    for (const pose of posesOf(id)) {
      for (const spec of reachesOf(pose)) {
        // Authored near unit length but normalised downstream, so what matters
        // is that the vector has a direction at all.
        for (const key of ['hand', 'palm', 'pole'] as const) {
          const tuple = spec[key];
          if (!tuple) continue;
          expect(tuple).toHaveLength(3);
          const length = Math.hypot(...tuple);
          expect(length).toBeGreaterThan(0.5);
          expect(length).toBeLessThan(1.5);
        }
        expect(spec.offset).toBeDefined();
        for (const a of spec.offset ?? []) expect(Number.isFinite(a)).toBe(true);
      }
    }
  });

  it('draws the elbow somewhere explicit for every face reach', () => {
    // Near the face the cost surface has two near-level minima, so a reach left
    // to search the circle flips between them as the pose breathes. Body-space
    // reaches are far enough out that the search is unambiguous.
    let checked = 0;
    for (const id of REACH_IDS) {
      for (const pose of posesOf(id)) {
        for (const spec of reachesOf(pose)) {
          if (spec.space === 'body') continue;
          expect(spec.pole, `${id} reaches ${spec.at} without a pole`).toBeDefined();
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('which hand acts', () => {
  const TWO_HANDED: GestureId[] = [
    'shrug',
    'comeHere',
    'bow',
    'explain',
    'present',
    'clap',
    'cheer',
    'pout',
    'catPaw',
    'sparkle',
    'beg',
    'stretch',
    'armCross',
    'handsClasp',
    'bothPeace',
    'doze',
  ];
  const SPINE_ONLY: GestureId[] = ['nod', 'tilt', 'lean'];
  /** Authored on a fixed hand rather than through the side helper. */
  const FIXED_RIGHT: GestureId[] = ['wave'];
  const MIRRORED = IDS.filter((id) => ![...TWO_HANDED, ...SPINE_ONLY, ...FIXED_RIGHT].includes(id));

  it('accounts for every gesture in exactly one of the four kinds', () => {
    expect(TWO_HANDED.length + SPINE_ONLY.length + FIXED_RIGHT.length + MIRRORED.length).toBe(
      IDS.length,
    );
    expect(MIRRORED.length).toBe(14);
  });

  each(TWO_HANDED)('%s poses both arms whichever side is asked for', (id) => {
    expect(sidesUsed(TABLE[id].build(0.3, RIGHT))).toBe('LR');
    expect(sidesUsed(TABLE[id].build(0.3, LEFT))).toBe('LR');
  });

  each(SPINE_ONLY)('%s poses no arm at all', (id) => {
    expect(sidesUsed(TABLE[id].build(0.3, RIGHT))).toBe('');
    expect(TABLE[id].build(0.3, RIGHT).spine).toBeDefined();
  });

  each(MIRRORED)('%s follows the requested side', (id) => {
    expect(sidesUsed(TABLE[id].build(0.3, RIGHT))).toBe('R');
    expect(sidesUsed(TABLE[id].build(0.3, LEFT))).toBe('L');
  });

  each(FIXED_RIGHT)('%s stays on the right hand whichever side is asked for', (id) => {
    expect(sidesUsed(TABLE[id].build(0.3, RIGHT))).toBe('R');
    expect(sidesUsed(TABLE[id].build(0.3, LEFT))).toBe('R');
  });

  each(IDS)('%s produces the same shape of pose on either side', (id) => {
    const right = TABLE[id].build(0.3, RIGHT);
    const left = TABLE[id].build(0.3, LEFT);
    expect(Object.keys(right).sort()).toEqual(Object.keys(left).sort());
  });
});

/**
 * Every numeric leaf of a pose, in a stable order.
 *
 * Keys are visited sorted so two builds of the same gesture line up leaf for
 * leaf, and vectors are expanded into components. Strings — the anchor name,
 * the anchor space — carry no motion and are skipped.
 */
const leaves = (value: unknown, out: number[] = []): number[] => {
  if (typeof value === 'number') out.push(value);
  else if (value instanceof THREE.Vector3) out.push(value.x, value.y, value.z);
  else if (Array.isArray(value)) for (const item of value) leaves(item, out);
  else if (value && typeof value === 'object') {
    for (const key of Object.keys(value).sort()) {
      leaves((value as Record<string, unknown>)[key], out);
    }
  }
  return out;
};

describe('oscillations start at rest', () => {
  /**
   * The module docblock's second rule: `build` is called from t=0, so every
   * periodic term has to be written `sin(t · w · rate)` and never with a phase
   * offset, or the limb is already mid-swing on the first frame.
   *
   * Checked as a bound on how far a pose can travel in the first sliver of a
   * second. Build at t=0 and again at t=EPS, then compare the two poses leaf by
   * leaf: a term that is discontinuous at the origin, or that ramps at a rate no
   * animation could follow, moves further than BOUND across a window a hundredth
   * the length of one display frame. The fastest oscillation in the table
   * (`deny`, at 8.6 rad/s into a 0.34 coefficient) moves about 3e-4 here, so the
   * bound leaves a factor of three and still catches a snap.
   */
  const EPS = 1e-4;
  const BOUND = 1e-3;

  each(IDS)('%s has not moved a frame-fraction after t=0', (id) => {
    const start = leaves(TABLE[id].build(0, RIGHT));
    const just = leaves(TABLE[id].build(EPS, RIGHT));
    expect(just.length).toBe(start.length);
    expect(start.length).toBeGreaterThan(0);
    for (let i = 0; i < start.length; i++) {
      expect(Math.abs(just[i] - start[i])).toBeLessThan(BOUND);
    }
  });

  each(IDS)('%s builds a finite pose at every time it is sampled', (id) => {
    for (const v of [RIGHT, LEFT]) {
      for (const pose of posesOf(id, v)) {
        const values = leaves(pose);
        expect(values.length).toBeGreaterThan(0);
        for (const n of values) expect(Number.isFinite(n)).toBe(true);
      }
    }
  });

  each(IDS)('%s varies with rate rather than snapping to a new place', (id) => {
    // Variation is frequency and amplitude only. Doubling the rate must leave
    // the first frame where it was, since every term is still zero there.
    const slow = leaves(TABLE[id].build(0, { rate: 0.6, scale: 1, side: 1 }));
    const fast = leaves(TABLE[id].build(0, { rate: 1.8, scale: 1, side: 1 }));
    for (let i = 0; i < slow.length; i++) expect(fast[i]).toBeCloseTo(slow[i], 12);
  });
});

describe('the rest pose the table is authored against', () => {
  it('aims every base link and the base palm with a unit vector', () => {
    for (const v of Object.values(BASE_POSE)) expect(v.length()).toBeCloseTo(1, 9);
    expect(BASE_PALM.length()).toBeCloseTo(1, 9);
  });

  it('hangs the resting palm inward and back rather than forward', () => {
    // Palm-forward at the side is the standard tell of an unposed rig.
    expect(BASE_PALM.x).toBeLessThan(0);
    expect(BASE_PALM.z).toBeLessThan(0);
  });

  it('rests the arm down at the side', () => {
    expect(BASE_POSE.upperArm.y).toBeLessThan(-0.5);
    expect(BASE_POSE.lowerArm.y).toBeLessThan(-0.5);
  });

  it('curls the resting hand loosely, more toward the little finger', () => {
    expect(Object.keys(BASE_FINGERS).sort()).toEqual([...FINGERS].sort());
    for (const curl of Object.values(BASE_FINGERS)) {
      expect(curl).toBeGreaterThan(0);
      expect(curl).toBeLessThan(0.5);
    }
    expect(BASE_FINGERS.little).toBeGreaterThan(BASE_FINGERS.index);
  });

  it('keeps the pointing hand actually pointed', () => {
    // The fingertip solver aims by the index finger, so it has to be the
    // straight one or the coordinate names a fingertip inside the palm.
    expect(POINT_HAND.index).toBeLessThan(0.1);
    for (const name of ['middle', 'ring', 'little'] as const) {
      expect(POINT_HAND[name]).toBeGreaterThan(0.9);
    }
  });
});

describe('peace hand articulation', () => {
  it('adds the measured thumb, fan and palm to peace', () => {
    const pose = TABLE.peace.build(0, RIGHT);
    const arm = pose.arms?.R;
    const spread = pose.fingerSpread?.R;
    if (!(arm?.palm && spread)) throw new Error('peace omitted palm or spread');

    expect(pose.fingers?.R?.thumb).toBe(1);
    expect(spread.thumb).toBeCloseTo(THREE.MathUtils.degToRad(28), 12);
    expect(spread.index).toBeCloseTo(THREE.MathUtils.degToRad(-6), 12);
    expect(spread.middle).toBeCloseTo(THREE.MathUtils.degToRad(6), 12);
    expect(arm.palm.distanceTo(new THREE.Vector3(0, 0.05, 1).normalize())).toBeLessThan(1e-12);
  });

  it('applies the same fan and palm to both hands of bothPeace', () => {
    const pose = TABLE.bothPeace.build(0, RIGHT);
    for (const side of SIDES) {
      const arm = pose.arms?.[side];
      const spread = pose.fingerSpread?.[side];
      if (!(arm?.palm && spread)) throw new Error(`bothPeace omitted ${side} hand data`);
      expect(pose.fingers?.[side]?.thumb).toBe(1);
      expect(spread.thumb).toBeCloseTo(THREE.MathUtils.degToRad(28), 12);
      expect(spread.index).toBeCloseTo(THREE.MathUtils.degToRad(-6), 12);
      expect(spread.middle).toBeCloseTo(THREE.MathUtils.degToRad(6), 12);
      expect(arm.palm.distanceTo(new THREE.Vector3(0, 0.05, 1).normalize())).toBeLessThan(1e-12);
    }
  });
});

describe('pinky promise articulation', () => {
  it('keeps a fist while presenting only the little finger', () => {
    const pose = TABLE.promise.build(0, RIGHT);
    const arm = pose.arms?.R;
    const fingers = pose.fingers?.R;
    if (!(arm?.hand && arm.palm && fingers)) throw new Error('promise omitted hand data');

    expect(fingers.little).toBeLessThan(0.1);
    expect(fingers.thumb).toBeCloseTo(0.7, 12);
    expect(fingers.index).toBeCloseTo(0.92, 12);
    expect(fingers.middle).toBeCloseTo(0.94, 12);
    expect(fingers.ring).toBeCloseTo(0.95, 12);
    expect(pose.fingerSpread).toBeUndefined();
    // Both directions are normalised by V, leaving the measured component just
    // under the rounded 0.7 target; the old thumb-side roll is negative.
    expect(new THREE.Vector3().crossVectors(arm.hand, arm.palm).z).toBeGreaterThan(0.69);
  });
});

describe('pointHand', () => {
  each(FINGERS)('extends the %s and closes the rest', (finger) => {
    // The bug this pins: the aim used the index-pointing shape whatever finger
    // was asked for, so picking the little finger left the arm solving for a
    // fingertip curled into the palm while the index stayed out in front. Every
    // choice looked the same and none of them was the one requested.
    const hand = pointHand(finger);
    expect(Object.keys(hand).sort()).toEqual([...FINGERS].sort());
    expect(hand[finger]).toBeLessThan(0.1);
    for (const other of FINGERS) {
      if (other === finger) continue;
      // The thumb only ever goes slack, never closed — pinned flat it makes a
      // fist with something sticking out of it, which is a different gesture.
      expect(hand[other]).toBeGreaterThan(other === 'thumb' ? 0.2 : 0.9);
    }
  });

  it('is the index shape by default, and that shape is POINT_HAND', () => {
    expect(pointHand()).toEqual(POINT_HAND);
    expect(pointHand('index')).toEqual(POINT_HAND);
  });

  it('gives a different hand for every finger', () => {
    const shapes = FINGERS.map((f) => JSON.stringify(pointHand(f)));
    expect(new Set(shapes).size).toBe(FINGERS.length);
  });
});
