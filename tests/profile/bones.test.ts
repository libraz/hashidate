import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import {
  buildRestDirections,
  chainDirection,
  childDirection,
  collectBones,
  deriveSideSign,
  measureLimbs,
  resolveBones,
  resolveFingers,
} from '@/engine/profile/bones';
import type { BoneSlot, FingerKey, LegBoneSlot } from '@/engine/types';
import { must } from '../helpers/must';
import { buildRig, type RigOptions } from '../helpers/scene';

/** Every slot the profile is expected to fill on a complete humanoid. */
const SLOTS: Array<Exclude<BoneSlot, LegBoneSlot>> = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'eye.L',
  'eye.R',
  'shoulder.L',
  'shoulder.R',
  'upperArm.L',
  'upperArm.R',
  'lowerArm.L',
  'lowerArm.R',
  'hand.L',
  'hand.R',
];

const FINGER_KEYS: FingerKey[] = [
  'thumb.L',
  'index.L',
  'middle.L',
  'ring.L',
  'little.L',
  'thumb.R',
  'index.R',
  'middle.R',
  'ring.R',
  'little.R',
];

const LEG_SLOTS: LegBoneSlot[] = [
  'upperLeg.L',
  'upperLeg.R',
  'lowerLeg.L',
  'lowerLeg.R',
  'foot.L',
  'foot.R',
  'toe.L',
  'toe.R',
];

/** What each naming family calls the slot the profile has to land on. */
const FAMILIES: Array<
  [NonNullable<RigOptions['naming']>, Record<Exclude<BoneSlot, LegBoneSlot>, string>]
> = [
  [
    'vrchat',
    {
      hips: 'Hips',
      spine: 'Spine',
      // The rig also carries a lower `Chest`; the upper one is the answer.
      chest: 'UpperChest',
      neck: 'Neck',
      head: 'Head',
      'eye.L': 'Eye_L',
      'eye.R': 'Eye_R',
      'shoulder.L': 'Shoulder_L',
      'shoulder.R': 'Shoulder_R',
      'upperArm.L': 'UpperArm_L',
      'upperArm.R': 'UpperArm_R',
      'lowerArm.L': 'LowerArm_L',
      'lowerArm.R': 'LowerArm_R',
      'hand.L': 'Hand_L',
      'hand.R': 'Hand_R',
    },
  ],
  [
    'unity',
    {
      hips: 'Hips',
      spine: 'Spine',
      chest: 'Chest',
      neck: 'Neck',
      head: 'Head',
      'eye.L': 'LeftEye',
      'eye.R': 'RightEye',
      'shoulder.L': 'LeftShoulder',
      'shoulder.R': 'RightShoulder',
      'upperArm.L': 'LeftUpperArm',
      'upperArm.R': 'RightUpperArm',
      'lowerArm.L': 'LeftLowerArm',
      'lowerArm.R': 'RightLowerArm',
      'hand.L': 'LeftHand',
      'hand.R': 'RightHand',
    },
  ],
  [
    'vrm',
    {
      hips: 'J_Bip_C_Hips',
      spine: 'J_Bip_C_Spine',
      chest: 'J_Bip_C_UpperChest',
      neck: 'J_Bip_C_Neck',
      head: 'J_Bip_C_Head',
      'eye.L': 'J_Bip_L_Eye',
      'eye.R': 'J_Bip_R_Eye',
      'shoulder.L': 'J_Bip_L_Shoulder',
      'shoulder.R': 'J_Bip_R_Shoulder',
      'upperArm.L': 'J_Bip_L_UpperArm',
      'upperArm.R': 'J_Bip_R_UpperArm',
      'lowerArm.L': 'J_Bip_L_LowerArm',
      'lowerArm.R': 'J_Bip_R_LowerArm',
      'hand.L': 'J_Bip_L_Hand',
      'hand.R': 'J_Bip_R_Hand',
    },
  ],
];

const LEG_FAMILIES: Array<[NonNullable<RigOptions['naming']>, Record<LegBoneSlot, string>]> = [
  [
    'vrchat',
    {
      'upperLeg.L': 'UpperLeg_L',
      'upperLeg.R': 'UpperLeg_R',
      'lowerLeg.L': 'LowerLeg_L',
      'lowerLeg.R': 'LowerLeg_R',
      'foot.L': 'Foot_L',
      'foot.R': 'Foot_R',
      'toe.L': 'Toe_L',
      'toe.R': 'Toe_R',
    },
  ],
  [
    'unity',
    {
      'upperLeg.L': 'LeftUpperLeg',
      'upperLeg.R': 'RightUpperLeg',
      'lowerLeg.L': 'LeftLowerLeg',
      'lowerLeg.R': 'RightLowerLeg',
      'foot.L': 'LeftFoot',
      'foot.R': 'RightFoot',
      'toe.L': 'LeftToes',
      'toe.R': 'RightToes',
    },
  ],
  [
    'vrm',
    {
      'upperLeg.L': 'J_Bip_L_UpperLeg',
      'upperLeg.R': 'J_Bip_R_UpperLeg',
      'lowerLeg.L': 'J_Bip_L_LowerLeg',
      'lowerLeg.R': 'J_Bip_R_LowerLeg',
      'foot.L': 'J_Bip_L_Foot',
      'foot.R': 'J_Bip_R_Foot',
      'toe.L': 'J_Bip_L_ToeBase',
      'toe.R': 'J_Bip_R_ToeBase',
    },
  ],
];

const world = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3());

describe('resolveBones', () => {
  it.each(FAMILIES)('fills every canonical slot on a %s rig', (naming, expected) => {
    const rig = buildRig({ naming });
    const { value: bones, missing } = resolveBones(collectBones(rig.root));

    for (const slot of SLOTS) expect(must(bones[slot], slot).name).toBe(expected[slot]);
    expect(missing).toEqual([]);
  });

  it.each(LEG_FAMILIES)('fills the optional leg slots on a %s rig', (naming, expected) => {
    const rig = buildRig({ naming, legs: true });
    const { value: bones, missing } = resolveBones(collectBones(rig.root));

    for (const slot of SLOTS) expect(must(bones[slot], slot)).toBeDefined();
    for (const slot of LEG_SLOTS) expect(must(bones[slot], slot).name).toBe(expected[slot]);
    expect(missing).toEqual([]);
  });

  it('does not report absent optional legs as missing bones', () => {
    const rig = buildRig();

    expect(resolveBones(collectBones(rig.root)).missing).toEqual([]);
  });

  it('reports one diagnostic for a partial leg core', () => {
    const rig = buildRig({ legs: true });
    must(rig.bones.get('Foot_L'), 'Foot_L').removeFromParent();

    const { missing } = resolveBones(collectBones(rig.root));

    expect(missing).toEqual(['legs:incomplete(foot.L)']);
  });

  it('accepts a complete core when optional toes are absent', () => {
    const rig = buildRig({ legs: true });
    must(rig.bones.get('Toe_L'), 'Toe_L').removeFromParent();
    must(rig.bones.get('Toe_R'), 'Toe_R').removeFromParent();

    const { value: bones, missing } = resolveBones(collectBones(rig.root));

    expect(bones['foot.L']).toBeDefined();
    expect(bones['foot.R']).toBeDefined();
    expect(bones['toe.L']).toBeUndefined();
    expect(bones['toe.R']).toBeUndefined();
    expect(missing).toEqual([]);
  });

  it('prefers VRChat leg candidates when every naming family is present', () => {
    const rig = buildRig({ legs: true });
    const bonesByName = collectBones(rig.root);
    const candidates: Record<LegBoneSlot, readonly [string, string, string]> = {
      'upperLeg.L': ['UpperLeg_L', 'LeftUpperLeg', 'J_Bip_L_UpperLeg'],
      'upperLeg.R': ['UpperLeg_R', 'RightUpperLeg', 'J_Bip_R_UpperLeg'],
      'lowerLeg.L': ['LowerLeg_L', 'LeftLowerLeg', 'J_Bip_L_LowerLeg'],
      'lowerLeg.R': ['LowerLeg_R', 'RightLowerLeg', 'J_Bip_R_LowerLeg'],
      'foot.L': ['Foot_L', 'LeftFoot', 'J_Bip_L_Foot'],
      'foot.R': ['Foot_R', 'RightFoot', 'J_Bip_R_Foot'],
      'toe.L': ['Toe_L', 'LeftToes', 'J_Bip_L_ToeBase'],
      'toe.R': ['Toe_R', 'RightToes', 'J_Bip_R_ToeBase'],
    };

    for (const names of Object.values(candidates)) {
      for (const name of names.slice(1)) {
        const alias = new THREE.Bone();
        alias.name = name;
        bonesByName.set(name, alias);
      }
    }

    const { value: bones } = resolveBones(bonesByName);

    for (const slot of LEG_SLOTS) expect(must(bones[slot], slot).name).toBe(candidates[slot][0]);
  });

  it('prefers UpperChest over Chest when the rig carries both', () => {
    const rig = buildRig({ naming: 'vrchat' });
    expect(rig.bones.has('Chest')).toBe(true);
    expect(rig.bones.has('UpperChest')).toBe(true);

    const { value: bones } = resolveBones(collectBones(rig.root));

    // The arms hang off the upper chest; aiming from the lower one drops a link
    // out of the chain.
    expect(must(bones.chest, 'chest').name).toBe('UpperChest');
    const shoulder = must(bones['shoulder.L'], 'shoulder.L');
    expect(shoulder.parent).toBe(bones.chest);
  });

  it('prefers the vrm upper chest over the vrm lower one', () => {
    const rig = buildRig({ naming: 'vrm' });
    expect(rig.bones.has('J_Bip_C_Chest')).toBe(true);

    const { value: bones } = resolveBones(collectBones(rig.root));

    expect(must(bones.chest, 'chest').name).toBe('J_Bip_C_UpperChest');
  });

  it('takes the only chest a rig without an upper one has', () => {
    const rig = buildRig({ naming: 'unity' });
    const { value: bones } = resolveBones(collectBones(rig.root));

    expect(must(bones.chest, 'chest').name).toBe('Chest');
  });

  it('reports the eye slots a rig without eye bones cannot fill', () => {
    const rig = buildRig({ eyes: false });
    const { missing } = resolveBones(collectBones(rig.root));

    expect(missing).toEqual(['bone:eye.L', 'bone:eye.R']);
  });
});

describe('resolveFingers', () => {
  it.each(FAMILIES)('resolves all ten chains on a %s rig', (naming) => {
    const rig = buildRig({ naming });
    const { value: fingers, missing } = resolveFingers(collectBones(rig.root));

    for (const key of FINGER_KEYS) expect(must(fingers[key], key)).toHaveLength(3);
    expect(missing).toEqual([]);
  });

  it('stores a chain proximal first', () => {
    const rig = buildRig();
    const { value: fingers } = resolveFingers(collectBones(rig.root));
    const hand = must(rig.bones.get('Hand_L'), 'Hand_L');
    const chain = must(fingers['index.L'], 'index.L');

    const fromWrist = chain.map((b) => world(hand).distanceTo(world(b)));
    expect(fromWrist[0]).toBeLessThan(fromWrist[1]);
    expect(fromWrist[1]).toBeLessThan(fromWrist[2]);
  });

  it('reports fingers:none matched for a rig with no finger bones at all', () => {
    const rig = buildRig({ fingers: false });
    const { value: fingers, missing } = resolveFingers(collectBones(rig.root));

    expect(fingers).toEqual({});
    expect(missing).toEqual(['fingers:none matched']);
  });

  it('says nothing about fingers when every chain resolved', () => {
    const profile = buildProfile(buildRig({ fingers: true }).root);

    expect(profile.missing.filter((m) => m.startsWith('fingers'))).toEqual([]);
  });

  it('refuses a chain whose two segments come from different pattern families', () => {
    const rig = buildRig({ naming: 'vrchat' });
    const bonesByName = collectBones(rig.root);
    // The intermediate segment now spells itself the VRM way while the proximal
    // keeps the VRChat spelling. Neither pattern sees a whole chain.
    const stray = must(bonesByName.get('IndexIntermediate_L'), 'IndexIntermediate_L');
    bonesByName.delete('IndexIntermediate_L');
    bonesByName.set('J_Bip_L_Index2', stray);

    const { value: fingers, missing } = resolveFingers(bonesByName);

    expect(fingers['index.L']).toBeUndefined();
    expect(missing).toEqual(['fingers:index.L']);
    // The other nine are untouched: the rejection is per chain, not per rig.
    for (const key of FINGER_KEYS.filter((k) => k !== 'index.L')) {
      expect(must(fingers[key], key)).toHaveLength(3);
    }
  });

  it('accepts a chain missing only its distal segment', () => {
    const rig = buildRig({ naming: 'vrchat' });
    const bonesByName = collectBones(rig.root);
    bonesByName.delete('RingDistal_R');

    const { value: fingers, missing } = resolveFingers(bonesByName);

    expect(must(fingers['ring.R'], 'ring.R')).toHaveLength(2);
    expect(missing).toEqual([]);
  });
});

describe('deriveSideSign', () => {
  it('reads the sign off where the left hand actually is', () => {
    const rig = buildRig();
    const profile = buildProfile(rig.root);
    const handL = must(profile.bones['hand.L'], 'hand.L');

    expect(world(handL).x).toBeLessThan(0);
    expect(profile.sideSign).toBe(-1);
    expect(profile.sideSign).toBe(Math.sign(world(handL).x));
  });

  it('follows a rig that is turned to face the other way', () => {
    const rig = buildRig();
    rig.root.rotateY(Math.PI);
    rig.root.updateMatrixWorld(true);
    const profile = buildProfile(rig.root);

    expect(world(must(profile.bones['hand.L'], 'hand.L')).x).toBeGreaterThan(0);
    expect(profile.sideSign).toBe(1);
  });

  it('falls back to +1 when there is no left hand to measure', () => {
    const rig = buildRig();
    const { value: bones } = resolveBones(collectBones(rig.root));
    delete bones['hand.L'];

    expect(deriveSideSign(rig.root, bones)).toBe(1);
  });
});

describe('measureLimbs', () => {
  const measure = (armatureScale: number) => {
    const rig = buildRig({ armatureScale });
    const bonesByName = collectBones(rig.root);
    const { value: bones } = resolveBones(bonesByName);
    const { value: fingers } = resolveFingers(bonesByName);
    return { rig, bones, fingers, limb: measureLimbs(rig.root, bones, fingers) };
  };

  it('measures the upper arm in world units, not in the armature own units', () => {
    const metres = measure(1);
    const centimetres = measure(0.01);

    // A local translation is in the parent's units: read that way, the 0.01
    // armature reports 17 where the arm is 0.17 m long, and the reach solver
    // clamps every target to the arm's minimum extent.
    expect(metres.limb['upper.L']).toBeCloseTo(0.17, 9);
    expect(centimetres.limb['upper.L']).toBeCloseTo(metres.limb['upper.L'], 9);
    expect(centimetres.limb['upper.L']).toBeLessThan(1);
  });

  it('measures every arm segment identically at both armature scales', () => {
    const metres = measure(1);
    const centimetres = measure(0.01);

    for (const key of Object.keys(metres.limb)) {
      expect(centimetres.limb[key]).toBeCloseTo(metres.limb[key], 9);
    }
    expect(Object.keys(metres.limb).sort()).toEqual(Object.keys(centimetres.limb).sort());
  });

  it('mirrors the arm segments between the two sides', () => {
    const { limb } = measure(1);

    expect(limb['upper.R']).toBeCloseTo(limb['upper.L'], 12);
    expect(limb['lower.R']).toBeCloseTo(limb['lower.L'], 12);
    expect(limb['lower.L']).toBeCloseTo(0.15, 9);
  });

  it('runs the fingertip length past the wrist-to-proximal distance', () => {
    const { bones, fingers, limb } = measure(1);
    const hand = must(bones['hand.L'], 'hand.L');
    const chain = must(fingers['index.L'], 'index.L');

    const wristToProximal = world(hand).distanceTo(world(chain[0]));
    const seg1 = world(chain[0]).distanceTo(world(chain[1]));
    const seg2 = world(chain[1]).distanceTo(world(chain[2]));

    // Wrist to fingertip, with the unmeasurable last phalanx estimated at three
    // quarters of the one above it.
    expect(limb['tip.L.index']).toBeCloseTo(wristToProximal + seg1 + seg2 * 1.75, 12);
    expect(limb['tip.L.index']).toBeGreaterThan(wristToProximal);
  });

  it('measures the fingertip length to the child bone when the chain has one', () => {
    const rig = buildRig();
    const bonesByName = collectBones(rig.root);
    const { value: bones } = resolveBones(bonesByName);
    const { value: fingers } = resolveFingers(bonesByName);
    const distal = must(bonesByName.get('MiddleDistal_L'), 'MiddleDistal_L');
    const tip = new THREE.Bone();
    tip.name = 'MiddleTip_L';
    tip.position.set(-0.02, 0, 0);
    distal.add(tip);
    rig.root.updateMatrixWorld(true);

    const limb = measureLimbs(rig.root, bones, fingers);
    const chain = must(fingers['middle.L'], 'middle.L');
    const hand = must(bones['hand.L'], 'hand.L');
    const measured =
      world(hand).distanceTo(world(chain[0])) +
      world(chain[0]).distanceTo(world(chain[1])) +
      world(chain[1]).distanceTo(world(chain[2])) +
      world(chain[2]).distanceTo(world(tip));

    expect(limb['tip.L.middle']).toBeCloseTo(measured, 12);
  });

  it('leaves out an arm whose links are not all present', () => {
    const rig = buildRig();
    const bonesByName = collectBones(rig.root);
    const { value: bones } = resolveBones(bonesByName);
    const { value: fingers } = resolveFingers(bonesByName);
    delete bones['lowerArm.R'];

    const limb = measureLimbs(rig.root, bones, fingers);

    expect(limb['upper.R']).toBeUndefined();
    expect(limb['upper.L']).toBeCloseTo(0.17, 9);
    // The hand is still there, so its fingertips are still measurable.
    expect(limb['tip.R.index']).toBeGreaterThan(0);
  });

  it('measures complete leg cores in world units at both armature scales', () => {
    const measure = (armatureScale: number) => {
      const rig = buildRig({ armatureScale, legs: true });
      const bonesByName = collectBones(rig.root);
      const { value: bones } = resolveBones(bonesByName);
      const { value: fingers } = resolveFingers(bonesByName);
      return measureLimbs(rig.root, bones, fingers);
    };

    const metres = measure(1);
    const centimetres = measure(0.01);

    expect(metres['thigh.L']).toBeCloseTo(Math.hypot(0.25, 0.025), 9);
    expect(metres['shin.L']).toBeCloseTo(Math.hypot(0.24, 0.025), 9);
    expect(metres['thigh.R']).toBeCloseTo(metres['thigh.L'], 12);
    expect(metres['shin.R']).toBeCloseTo(metres['shin.L'], 12);
    expect(centimetres['thigh.L']).toBeCloseTo(metres['thigh.L'], 9);
    expect(centimetres['shin.L']).toBeCloseTo(metres['shin.L'], 9);
  });
});

describe('buildRestDirections', () => {
  const restOf = (rig = buildRig()) => {
    const bonesByName = collectBones(rig.root);
    const { value: bones } = resolveBones(bonesByName);
    const { value: fingers } = resolveFingers(bonesByName);
    return { rig, bones, restDir: buildRestDirections(bones, fingers) };
  };

  it('returns a unit vector for every slot and every finger segment', () => {
    const { restDir } = restOf();

    expect(Object.keys(restDir).length).toBe(SLOTS.length + FINGER_KEYS.length * 3);
    for (const [key, v] of Object.entries(restDir)) {
      expect(v.length(), key).toBeCloseTo(1, 9);
    }
  });

  it('aims a limb at the next link in the chain', () => {
    const { restDir } = restOf();

    expect(restDir['upperArm.L'].x).toBeCloseTo(-1, 12);
    expect(restDir['upperArm.R'].x).toBeCloseTo(1, 12);
    expect(restDir.neck.y).toBeCloseTo(1, 12);
  });

  it('aims the hand down the middle finger rather than at its first child', () => {
    const { rig, restDir } = restOf();
    const hand = must(rig.bones.get('Hand_L'), 'Hand_L');

    // The exporter lists the thumb first, and the thumb is fanned off the palm.
    expect(hand.children[0].name).toBe('ThumbProximal_L');
    expect(childDirection(hand).z).not.toBeCloseTo(0, 6);
    expect(restDir['hand.L'].z).toBeCloseTo(0, 12);
    expect(restDir['hand.L'].x).toBeCloseTo(-1, 12);
  });

  it('aims a limb past a twist helper the exporter happened to write first', () => {
    const rig = buildRig();
    const upper = must(rig.bones.get('UpperArm_L'), 'UpperArm_L');
    const twist = new THREE.Bone();
    twist.name = 'UpperArm_L_twist';
    twist.position.set(0, 0.05, 0);
    upper.add(twist);
    upper.children = [twist, ...upper.children.filter((c) => c !== twist)];
    rig.root.updateMatrixWorld(true);

    const { restDir } = restOf(rig);

    // "First child" would aim the upper arm at the twist helper.
    expect(childDirection(upper).y).toBeCloseTo(1, 12);
    expect(restDir['upperArm.L'].x).toBeCloseTo(-1, 12);
  });

  it('follows the explicit upper-leg to foot chain past twist helpers', () => {
    const rig = buildRig({ legs: true });
    const upper = must(rig.bones.get('UpperLeg_L'), 'UpperLeg_L');
    const lower = must(rig.bones.get('LowerLeg_L'), 'LowerLeg_L');
    const foot = must(rig.bones.get('Foot_L'), 'Foot_L');

    const upperTwist = new THREE.Bone();
    upperTwist.name = 'UpperLeg_L_twist';
    upperTwist.position.set(0, 0.05, 0);
    upper.add(upperTwist);
    upper.children = [upperTwist, ...upper.children.filter((c) => c !== upperTwist)];

    const lowerTwist = new THREE.Bone();
    lowerTwist.name = 'LowerLeg_L_twist';
    lowerTwist.position.set(0, 0.05, 0);
    lower.add(lowerTwist);
    lower.children = [lowerTwist, ...lower.children.filter((c) => c !== lowerTwist)];
    rig.root.updateMatrixWorld(true);

    const { restDir } = restOf(rig);

    for (const slot of LEG_SLOTS) {
      expect(must(restDir[slot], slot).length(), slot).toBeCloseTo(1, 9);
    }
    expect(childDirection(upper).y).toBeCloseTo(1, 12);
    expect(childDirection(lower).y).toBeCloseTo(1, 12);
    expect(restDir['upperLeg.L'].y).toBeLessThan(-0.99);
    expect(restDir['upperLeg.L'].z).toBeGreaterThan(0);
    expect(restDir['lowerLeg.L'].y).toBeLessThan(-0.99);
    expect(restDir['lowerLeg.L'].z).toBeLessThan(0);
    // Keep one direct assertion as a local sanity check for the chain helper;
    // the restDir assertions above prove NEXT_IN_CHAIN supplies these targets.
    expect(chainDirection(upper, lower).y).toBeLessThan(-0.99);
    expect(chainDirection(lower, foot).y).toBeLessThan(-0.99);
  });

  it('falls back to bone-local up for a slot with no child bone', () => {
    const { restDir } = restOf();

    // The eye bones end their chain, and an eye has nothing to aim at.
    expect(restDir['eye.L'].toArray()).toEqual([0, 1, 0]);
  });
});
