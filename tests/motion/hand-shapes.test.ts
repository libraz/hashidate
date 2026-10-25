import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { fingerCurl } from '@/engine/anatomy';
import {
  both,
  clasp,
  one,
  pair,
  reach,
  reachBoth,
  reachPair,
} from '@/engine/motion/gestures/builders';
import {
  CHOP_HAND,
  countHand,
  FIST,
  mixHand,
  NO_SPREAD,
  OPEN_HAND,
  PEACE_HAND,
  shape,
  THUMB_UP,
} from '@/engine/motion/gestures/hands';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import { FINGER_TIP_EXTENSION } from '@/engine/rig/hand-geometry';
import { composeFingerRotation } from '@/engine/rig/hands';
import type {
  FingerName,
  GestureVariation,
  HandShape,
  Pose,
  ReachSpec,
  Side,
} from '@/engine/types';
import { buildRig, type RigOptions } from '../helpers/scene';

/**
 * Formed hand shapes, measured on the synthetic rig.
 *
 * Each shape is posed through `curlHand` and read back in the hand's own frame
 * (along the hand, across it from the index side, out of the palm), so a thumb
 * that curls out of the palm instead of across it fails here and not on a
 * stream. The same rows are run against a thumb hinged like a finger, which
 * must fail the fist and the chop: that is what keeps the rows from passing
 * on any rig.
 */

/** Metres the synthetic thumb stands further out of the palm, so a folded tip rests on the fingers as it does on both validation avatars. */
const THUMB_STAND_OFF = 0.003;

const NAMED_SHAPES = {
  FIST,
  OPEN_HAND,
  PEACE_HAND,
  THUMB_UP,
  CHOP_HAND,
  countOne: countHand(1),
  countTwo: countHand(2),
  countThree: countHand(3),
  countFour: countHand(4),
  countFive: countHand(5),
} satisfies Record<string, HandShape>;
type ShapeName = keyof typeof NAMED_SHAPES;

interface Row {
  shape: ShapeName;
  side: Side;
  naming: NonNullable<RigOptions['naming']>;
  armatureScale: number;
  wristRoll: number;
}

const r = (
  shapeName: ShapeName,
  side: Side,
  naming: Row['naming'],
  armatureScale: number,
  wristRoll: number,
): Row => ({ shape: shapeName, side, naming, armatureScale, wristRoll });

/** Pairwise over shape x side x naming x armatureScale x wristRoll (coverwise, strength 2, seed 7). */
const ROWS: Row[] = [
  r('countFour', 'R', 'unity', 1, 0.5),
  r('countFive', 'R', 'vrm', 0.01, 0),
  r('CHOP_HAND', 'L', 'vrm', 1, 0.5),
  r('PEACE_HAND', 'L', 'unity', 0.01, 0),
  r('countThree', 'L', 'vrchat', 1, 0),
  r('countThree', 'R', 'vrchat', 0.01, 0.5),
  r('FIST', 'L', 'vrm', 0.01, 0),
  r('OPEN_HAND', 'R', 'vrchat', 0.01, 0),
  r('countFour', 'L', 'vrm', 0.01, 0),
  r('OPEN_HAND', 'L', 'unity', 1, 0.5),
  r('countOne', 'L', 'vrchat', 0.01, 0.5),
  r('THUMB_UP', 'L', 'vrchat', 1, 0.5),
  r('THUMB_UP', 'R', 'vrm', 0.01, 0),
  r('countTwo', 'L', 'vrchat', 1, 0.5),
  r('countTwo', 'L', 'vrm', 0.01, 0),
  r('CHOP_HAND', 'R', 'unity', 0.01, 0),
  r('countOne', 'R', 'unity', 1, 0),
  r('FIST', 'R', 'unity', 1, 0.5),
  r('PEACE_HAND', 'L', 'vrm', 0.01, 0.5),
  r('countFive', 'L', 'vrchat', 1, 0),
  r('PEACE_HAND', 'R', 'vrchat', 1, 0),
  r('countOne', 'R', 'vrm', 0.01, 0.5),
  r('CHOP_HAND', 'L', 'vrchat', 0.01, 0.5),
  r('countTwo', 'R', 'vrchat', 0.01, 0),
  r('countFive', 'L', 'vrm', 0.01, 0.5),
  r('FIST', 'R', 'vrchat', 1, 0.5),
  r('countFour', 'L', 'vrchat', 1, 0),
  r('countFive', 'L', 'unity', 0.01, 0.5),
  r('OPEN_HAND', 'L', 'vrm', 1, 0),
  r('countTwo', 'L', 'unity', 1, 0),
  r('countThree', 'R', 'vrm', 0.01, 0),
  r('countThree', 'R', 'unity', 1, 0.5),
  r('THUMB_UP', 'R', 'unity', 1, 0),
];

const FOUR: readonly FingerName[] = ['index', 'middle', 'ring', 'little'];
const FINGER_NAMES: readonly FingerName[] = ['thumb', ...FOUR];

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`synthetic rig has no ${what}`);
  return value;
}

const wp = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

/** Nearest point on segment a-b to p. */
function nearest(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  const ab = b.clone().sub(a);
  const t = Math.min(1, Math.max(0, p.clone().sub(a).dot(ab) / ab.lengthSq()));
  return a.clone().addScaledVector(ab, t);
}

interface Hand {
  rig: Rig;
  profile: ReturnType<typeof buildProfile>;
  side: Side;
  pitch: number;
  frame: { along: THREE.Vector3; across: THREE.Vector3; normal: THREE.Vector3 };
  /** A tip bone on the thumb's distal bone, so that bone has a direction of its own. */
  thumbTip: THREE.Bone;
  /** Thumb axes as a finger would have them, for the control. */
  fingerLike: { axes: THREE.Vector3[]; splay: THREE.Vector3 };
}

function buildHand(row: Row): Hand {
  const built = buildRig({
    naming: row.naming,
    armatureScale: row.armatureScale,
    fingerGeometry: { thumb: { rootOffset: [0, -THUMB_STAND_OFF, 0] } },
  });
  const sign = row.side === 'L' ? 1 : -1;
  const wrist = need(buildProfile(built.root, built.descriptor).bones[`hand.${row.side}`], 'wrist');
  wrist.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), sign * row.wristRoll);
  built.root.updateMatrixWorld(true);
  // The synthetic distal bone has no child, so its own direction would be a fallback; give it the
  // tip bone a real avatar has, along the proximal phalanx and as long as the engine tip extends it.
  const bare = buildProfile(built.root, built.descriptor);
  const bareThumb = need(bare.fingerBones[`thumb.${row.side}`], 'thumb');
  const thumbTip = new THREE.Bone();
  const ip = wp(bareThumb[2]);
  const reach = ip.clone().sub(wp(bareThumb[1])).multiplyScalar(FINGER_TIP_EXTENSION);
  thumbTip.position.copy(bareThumb[2].worldToLocal(ip.add(reach)));
  bareThumb[2].add(thumbTip);
  built.root.updateMatrixWorld(true);
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  const { side } = row;

  const handBone = need(profile.bones[`hand.${side}`], `hand.${side}`);
  const normal = need(rig.palmLocal[side], 'palm')
    .clone()
    .applyQuaternion(handBone.getWorldQuaternion(new THREE.Quaternion()))
    .normalize();
  const chain = (f: FingerName) => need(profile.fingerBones[`${f}.${side}`], `${f}.${side}`);
  const flat = (v: THREE.Vector3) => v.addScaledVector(normal, -v.dot(normal));
  const along = flat(wp(chain('middle')[0]).sub(wp(handBone))).normalize();
  const across = flat(wp(chain('little')[0]).sub(wp(chain('index')[0])))
    .addScaledVector(along, 0)
    .normalize();
  across.addScaledVector(along, -across.dot(along)).normalize();

  // The thumb hinged about the finger axis, signed so a positive curl lifts the tip to the palm.
  const axes = chain('thumb').map((bone, i) => {
    const boneQ = bone.getWorldQuaternion(new THREE.Quaternion());
    const nLocal = normal.clone().applyQuaternion(boneQ.clone().invert()).normalize();
    const dir = need(profile.restDir[`thumb.${side}.${i}`], 'thumb dir');
    const axis = new THREE.Vector3().crossVectors(dir, nLocal).normalize();
    const segLen = chain('thumb')[i + 1]?.position.length() ?? 1;
    const at = wp(bone);
    const q = new THREE.Quaternion().setFromAxisAngle(axis, 0.4);
    const moved = dir
      .clone()
      .applyQuaternion(q)
      .sub(dir)
      .applyQuaternion(boneQ)
      .multiplyScalar(segLen);
    if (moved.dot(normal) < 0) axis.negate();
    void at;
    return axis;
  });
  const bone0 = chain('thumb')[0];
  const q0 = bone0.getWorldQuaternion(new THREE.Quaternion());
  const splay = normal.clone().applyQuaternion(q0.invert()).normalize();
  const dir0 = need(profile.restDir[`thumb.${side}.0`], 'thumb dir');
  const turn = new THREE.Vector3().crossVectors(
    normal,
    dir0.clone().applyQuaternion(bone0.getWorldQuaternion(new THREE.Quaternion())),
  );
  if (turn.dot(across) < 0) splay.negate();

  return {
    rig,
    profile,
    side,
    pitch: need(profile.limb?.[`pitch.${side}`], 'pitch'),
    frame: { along, across, normal },
    thumbTip,
    fingerLike: { axes, splay },
  };
}

/** Pose the hand through the rig; `fingerThumb` replaces the thumb's hinge with a finger's. */
function pose(hand: Hand, shapeValue: HandShape, fingerThumb: boolean): void {
  const { rig, profile, side } = hand;
  rig.reset();
  rig.curlHand(side, shapeValue.curl, shapeValue.spread);
  if (fingerThumb) {
    const scratch = new THREE.Quaternion();
    for (const [i, bone] of need(profile.fingerBones[`thumb.${side}`], 'thumb').entries()) {
      composeFingerRotation(
        bone.quaternion,
        need(rig.rest.get(bone), 'rest'),
        hand.fingerLike.axes[i],
        fingerCurl(rig.joints.thumb, i, shapeValue.curl.thumb),
        i === 0 ? hand.fingerLike.splay : undefined,
        i === 0 ? (shapeValue.spread.thumb ?? 0) : 0,
        undefined,
        0,
        scratch,
      );
    }
  }
  profile.root.updateMatrixWorld(true);
}

interface Digit {
  joints: THREE.Vector3[];
  tip: THREE.Vector3;
  /** Direction of the last bone. */
  dir: THREE.Vector3;
}

function digit(hand: Hand, f: FingerName): Digit {
  const joints = need(hand.profile.fingerBones[`${f}.${hand.side}`], f).map(wp);
  const [, p, last] = joints;
  const delta = last.clone().sub(p);
  return {
    joints,
    tip: last.clone().addScaledVector(delta, FINGER_TIP_EXTENSION),
    dir: delta.normalize(),
  };
}

/** The thumb as the mesh shows it: the distal bone's own direction and the tip it points to. */
function fold(hand: Hand): { dir: THREE.Vector3; tip: THREE.Vector3 } {
  const ip = need(hand.profile.fingerBones[`thumb.${hand.side}`], 'thumb')[2];
  const tip = wp(hand.thumbTip);
  return { dir: tip.clone().sub(wp(ip)).normalize(), tip };
}

interface Check {
  name: string;
  ok: boolean;
  value: number;
}

/** Evaluate the formed-shape rows for `name` on the posed hand. */
function rows(hand: Hand, name: ShapeName): Check[] {
  const { along, across, normal } = hand.frame;
  const { pitch } = hand;
  const d = Object.fromEntries(FINGER_NAMES.map((f) => [f, digit(hand, f)])) as Record<
    FingerName,
    Digit
  >;
  const thumb = d.thumb;
  const acrossOf = (v: THREE.Vector3) => v.dot(across);
  const indexRoot = acrossOf(d.index.joints[0]);
  const dN = (finger: FingerName, segment: 0 | 1): number => {
    const j = d[finger].joints;
    return thumb.tip
      .clone()
      .sub(nearest(thumb.tip, j[segment], j[segment + 1]))
      .dot(normal);
  };
  const out: Check[] = [];
  const check = (label: string, value: number, ok: boolean) => out.push({ name: label, ok, value });
  const between = (label: string, v: number, lo: number, hi: number) =>
    check(label, v, v >= lo && v <= hi);
  const atLeast = (label: string, v: number, lo: number) => check(label, v, v >= lo);
  const atMost = (label: string, v: number, hi: number) => check(label, v, v <= hi);

  // The thumb folds down onto the fingers: its tip turns toward the palm and ends over the middle
  // finger. A count has the same thumb under its raised fingers.
  const countThumb = () => {
    const seen = fold(hand);
    atMost('thumb tip dir . normal', seen.dir.dot(normal), -0.15);
    between('true tip past index root (pitch)', (acrossOf(seen.tip) - indexRoot) / pitch, 1.2, 2.2);
    atLeast('thumb dir . across', thumb.dir.dot(across), 0.4);
    atMost('thumb dir . normal', thumb.dir.dot(normal), 0.6);
  };
  // A fist's tip also rests on the middle finger's middle phalanx, the pad proud of the index and
  // middle ones. Raised fingers leave a count nothing to rest on, so only a fist is held to this.
  const fistThumb = () => {
    countThumb();
    const seen = fold(hand);
    const mid = (f: FingerName) => d[f].joints[1].clone().add(d[f].joints[2]).multiplyScalar(0.5);
    const pad = thumb.joints[2].clone().add(seen.tip).multiplyScalar(0.5);
    const off = pad.sub(mid('index').add(mid('middle')).multiplyScalar(0.5)).divideScalar(pitch);
    const middle = d.middle.joints;
    between(
      'dN true tip vs middle middle phalanx (pitch)',
      seen.tip
        .clone()
        .sub(nearest(seen.tip, middle[1], middle[2]))
        .dot(normal) / pitch,
      0.3,
      0.9,
    );
    atMost('|pad along vs index/middle middle phalanges| (pitch)', Math.abs(off.dot(along)), 0.7);
    between('pad across vs index/middle middle phalanges (pitch)', off.dot(across), 0.3, 1.3);
    between('pad normal vs index/middle middle phalanges (pitch)', off.dot(normal), 0.3, 1.1);
  };
  const extended = (f: FingerName) => atLeast(`${f} along`, d[f].dir.dot(along), 0.9);
  const folded = (f: FingerName) => atMost(`${f} along`, d[f].dir.dot(along), 0.3);

  switch (name) {
    case 'FIST':
      fistThumb();
      break;
    case 'OPEN_HAND':
    case 'countFive':
      for (const f of FINGER_NAMES) atMost(`${f} curl`, NAMED_SHAPES[name].curl[f], 0.12);
      atMost(
        'thumb tip across vs index root (pitch)',
        (acrossOf(thumb.tip) - indexRoot) / pitch,
        -0.5,
      );
      atLeast('thumb dir . along', thumb.dir.dot(along), 0.9);
      break;
    case 'PEACE_HAND':
      atLeast('thumb dir . across', thumb.dir.dot(across), 0.8);
      between('dN ring mid (pitch)', dN('ring', 1) / pitch, 0.3, 0.9);
      atLeast('index-middle tip gap (pitch)', d.index.tip.distanceTo(d.middle.tip) / pitch, 0.9);
      break;
    case 'THUMB_UP':
      atLeast('thumb dir . along', thumb.dir.dot(along), 0.85);
      atMost('dN index mid (pitch)', dN('index', 1) / pitch, 0);
      break;
    case 'CHOP_HAND': {
      atLeast('thumb dir . along', thumb.dir.dot(along), 0.9);
      // The synthetic thumb leaves the palm more steeply and answers splay ~0.6 as far as a real
      // one: it reads 1.25 where the validation avatars read 0.1-0.6, 0.5 where they had crossed
      // onto the back of the hand, and 1.8 unsplayed.
      between('dN index prox (pitch)', dN('index', 0) / pitch, 0.8, 1.5);
      for (const f of FOUR) atMost(`${f} straight`, 1 - d[f].dir.dot(along), 1e-6);
      break;
    }
    default: {
      const n = { countOne: 1, countTwo: 2, countThree: 3, countFour: 4 }[name];
      countThumb();
      for (const [i, f] of FOUR.entries()) (i < n ? extended : folded)(f);
    }
  }
  return out;
}

const failing = (checks: Check[]) => checks.filter((c) => !c.ok);

describe('formed hand shapes', () => {
  it.each(ROWS)(
    'forms $shape on the $side hand ($naming, scale $armatureScale, roll $wristRoll)',
    (row) => {
      const hand = buildHand(row);
      const value = NAMED_SHAPES[row.shape];

      pose(hand, value, false);
      expect(failing(rows(hand, row.shape))).toEqual([]);

      // The fist and the chop exist to rule out a thumb hinged like a finger.
      if (row.shape === 'FIST' || row.shape === 'CHOP_HAND') {
        pose(hand, value, true);
        expect(failing(rows(hand, row.shape)).length, 'finger-hinged thumb').toBeGreaterThan(0);
      }
    },
  );

  it('covers every named shape and both sides in the table', () => {
    expect(new Set(ROWS.map((row) => row.shape))).toEqual(new Set(Object.keys(NAMED_SHAPES)));
    expect(new Set(ROWS.map((row) => row.side))).toEqual(new Set(['L', 'R']));
  });
});

describe('countHand', () => {
  it('extends the named fingers and folds the rest with the fist', () => {
    const extended = { 1: ['index'], 2: ['index', 'middle'], 3: ['index', 'middle', 'ring'] };
    for (const n of [1, 2, 3, 4] as const) {
      const hand = countHand(n);
      const open = n === 4 ? FOUR : extended[n as 1 | 2 | 3];
      for (const f of FOUR) {
        expect(hand.curl[f] <= 0.02, `${n} ${f}`).toBe(open.includes(f));
        if (!open.includes(f)) expect(hand.curl[f]).toBe(FIST.curl[f]);
      }
      // A count's thumb is the fist's, since a count is the fist with fingers raised.
      expect(hand.curl.thumb).toBe(FIST.curl.thumb);
      expect(hand.spread.thumb).toBe(FIST.spread.thumb);
    }
    expect(countHand(5).curl).toBe(OPEN_HAND.curl);
    const { thumb: _thumb, ...fan } = countHand(4).spread;
    expect(countHand(5).spread).toEqual(fan);
  });

  it('fans the raised fingers of every count but one', () => {
    expect(countHand(2).spread).toEqual({ ...PEACE_HAND.spread, thumb: FIST.spread.thumb });
    // Three fans evenly about the middle finger rather than taking the V's split.
    const three = countHand(3).spread;
    expect(three.middle ?? 0).toBe(0);
    expect(three.ring).toBeCloseTo(-(three.index ?? 0), 12);
    expect(three.ring).toBeCloseTo(PEACE_HAND.spread.middle ?? 0, 12);
    expect(countHand(1).spread).toEqual({ thumb: FIST.spread.thumb });
    // Four fans outward, widest at the little finger, so it does not read as a chop.
    const four = countHand(4).spread;
    const fan = (['index', 'middle', 'ring', 'little'] as const).map((f) => four[f] ?? 0);
    for (let i = 1; i < fan.length; i++) expect(fan[i]).toBeGreaterThan(fan[i - 1]);
    expect(fan[3] - fan[2]).toBeGreaterThan(fan[1] - fan[0]);
  });
});

describe("builders carry a shape's splay", () => {
  const v: GestureVariation = { rate: 1, scale: 1, side: 1 };
  const arm = {
    upperArm: new THREE.Vector3(0, -1, 0),
    lowerArm: new THREE.Vector3(0, -1, 0),
    hand: new THREE.Vector3(0, -1, 0),
  };
  const spec: ReachSpec = { at: 'cheek', offset: [0, 0, 0], hand: [0, 1, 0] };
  const splayed = shape(FIST.curl, { thumb: 0.3 });
  const plain = shape(FIST.curl, NO_SPREAD);

  const builds: Record<string, (hand: HandShape, out?: Pose) => Pose> = {
    one: (hand, out) => one(out, v, arm, hand),
    both: (hand, out) => both(out, arm, hand),
    pair: (hand, out) => pair(out, arm, arm, hand, hand),
    reach: (hand, out) => reach(out, v, spec, hand),
    reachBoth: (hand, out) => reachBoth(out, spec, hand),
    reachPair: (hand, out) => reachPair(out, spec, spec, hand, hand),
    clasp: (hand, out) => clasp(out, v, spec, hand, 0.3),
  };

  it.each(Object.keys(builds))(
    '%s writes fingerSpread from the shape and drops it without one',
    (name) => {
      const build = builds[name];
      const pose = build(splayed);
      const sides = Object.values(pose.fingerSpread ?? {});
      expect(sides.length).toBeGreaterThan(0);
      for (const spread of sides) expect(spread).toEqual({ thumb: 0.3 });

      // Reusing the splayed pose for a shape without splay must not leave it behind.
      const reused = build(plain, pose);
      expect(reused.fingerSpread).toBeUndefined();
      expect(build(plain).fingerSpread).toBeUndefined();
    },
  );

  it('lerps curl and spread in mixHand, treating a missing spread as zero', () => {
    const mixed = mixHand(plain, shape(OPEN_HAND.curl, { thumb: 0.4, index: -0.2 }), 0.5);
    expect(mixed.spread.thumb).toBeCloseTo(0.2, 12);
    expect(mixed.spread.index).toBeCloseTo(-0.1, 12);
    expect(mixed.curl.index).toBeCloseTo((FIST.curl.index + OPEN_HAND.curl.index) / 2, 12);
    expect(mixHand(plain, plain, 0.5).spread).toEqual({});
  });
});
