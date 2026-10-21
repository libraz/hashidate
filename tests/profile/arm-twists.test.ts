import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import type { BoneSlot } from '@/engine/types';
import { buildRig, type RigOptions, type SyntheticRig } from '../helpers/scene';

type TwistMode = 'twist' | 'rotate';
type ArmTwistSlot = Extract<BoneSlot, 'upperArm.L' | 'upperArm.R' | 'lowerArm.L' | 'lowerArm.R'>;
type ArmTwistBinding = {
  primary: THREE.Bone;
  next: THREE.Bone;
  helper: THREE.Bone;
};
type ArmTwists = Partial<Record<ArmTwistSlot, ArmTwistBinding>>;
type TwistRigOptions = RigOptions & { armTwistHelpers?: TwistMode };

const SLOTS: Array<{
  slot: ArmTwistSlot;
  primary: string;
  next: string;
  helper: (mode: TwistMode) => string;
}> = [
  {
    slot: 'upperArm.L',
    primary: 'UpperArm_L',
    next: 'LowerArm_L',
    helper: (mode) => `UpperArm_${mode === 'twist' ? 'twist' : 'Rotate'}_L`,
  },
  {
    slot: 'upperArm.R',
    primary: 'UpperArm_R',
    next: 'LowerArm_R',
    helper: (mode) => `UpperArm_${mode === 'twist' ? 'twist' : 'Rotate'}_R`,
  },
  {
    slot: 'lowerArm.L',
    primary: 'LowerArm_L',
    next: 'Hand_L',
    helper: (mode) => `LowerArm_${mode === 'twist' ? 'twist' : 'Rotate'}_L`,
  },
  {
    slot: 'lowerArm.R',
    primary: 'LowerArm_R',
    next: 'Hand_R',
    helper: (mode) => `LowerArm_${mode === 'twist' ? 'twist' : 'Rotate'}_R`,
  },
];

function buildTwistRig(options: TwistRigOptions): SyntheticRig {
  return (buildRig as unknown as (options: TwistRigOptions) => SyntheticRig)(options);
}

function armTwists(profile: ReturnType<typeof buildProfile>): ArmTwists | undefined {
  return Reflect.get(profile, 'armTwists') as ArmTwists | undefined;
}

function bone(rig: SyntheticRig, name: string): THREE.Bone {
  const value = rig.bones.get(name);
  if (!value) throw new Error(`synthetic rig has no ${name}`);
  return value;
}

function rigBones(rig: SyntheticRig) {
  return [...rig.bones.entries()].map(([name, value]) => ({
    name,
    parent: value.parent?.name,
    children: value.children.map((child) => child.name),
    position: value.position.toArray(),
    quaternion: value.quaternion.toArray(),
    scale: value.scale.toArray(),
  }));
}

describe('arm twist profile bindings', () => {
  it.each(['twist', 'rotate'] as const)(
    'resolves bilateral direct leaf helpers from the %s family',
    (mode) => {
      const rig = buildTwistRig({ armTwistHelpers: mode });
      const profile = buildProfile(rig.root);
      const bindings = armTwists(profile);

      expect(bindings).toBeDefined();
      if (!bindings) return;
      expect(Object.keys(bindings).sort()).toEqual(SLOTS.map(({ slot }) => slot).sort());

      for (const { slot, primary: primaryName, next: nextName, helper: helperName } of SLOTS) {
        const primary = bone(rig, primaryName);
        const next = bone(rig, nextName);
        const helper = bone(rig, helperName(mode));
        const binding = bindings[slot];

        expect(binding?.primary).toBe(primary);
        expect(binding?.next).toBe(next);
        expect(binding?.helper).toBe(helper);
        expect(helper.parent).toBe(primary);
        expect(helper.children).toHaveLength(0);
        expect(next.parent).toBe(primary);
        expect(helper.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(1e-5);
        const expectedPosition = next.position.clone();
        if (mode === 'rotate') expectedPosition.multiplyScalar(0.5);
        expect(helper.position.distanceTo(expectedPosition)).toBeLessThan(1e-8);
      }
    },
  );

  it.each(['twist', 'rotate'] as const)(
    'buildRig makes %s helpers a leaf of each arm link',
    (mode) => {
      const rig = buildTwistRig({ armTwistHelpers: mode });

      for (const { primary: primaryName, next: nextName, helper: helperName } of SLOTS) {
        const primary = bone(rig, primaryName);
        const next = bone(rig, nextName);
        const helper = rig.bones.get(helperName(mode));

        expect(helper).toBeDefined();
        if (!helper) return;
        expect(helper.parent).toBe(primary);
        expect(helper.children).toHaveLength(0);
        expect(next.parent).toBe(primary);
        const expectedPosition = next.position.clone();
        if (mode === 'rotate') expectedPosition.multiplyScalar(0.5);
        expect(helper.position.distanceTo(expectedPosition)).toBeLessThan(1e-8);
        expect(helper.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(1e-5);
      }
    },
  );

  it('leaves the default fixture and profile unchanged when helpers are absent', () => {
    const baseline = buildRig();
    const disabled = buildTwistRig({ armTwistHelpers: undefined });
    const profile = buildProfile(disabled.root);

    expect(rigBones(disabled)).toEqual(rigBones(baseline));
    expect(SLOTS.some(({ helper }) => disabled.bones.has(helper('twist')))).toBe(false);
    expect(SLOTS.some(({ helper }) => disabled.bones.has(helper('rotate')))).toBe(false);
    expect(armTwists(profile)).toBeUndefined();
    expect(profile.missing.filter((entry) => entry.startsWith('armTwist:'))).toEqual([]);
  });

  it('does not report an absent helper and retains the other partial bindings', () => {
    const rig = buildTwistRig({ armTwistHelpers: 'rotate' });
    const absent = bone(rig, 'UpperArm_Rotate_L');
    absent.parent?.remove(absent);
    const profile = buildProfile(rig.root);
    const bindings = armTwists(profile);

    expect(bindings).toBeDefined();
    if (!bindings) return;
    expect(bindings['upperArm.L']).toBeUndefined();
    expect(Object.keys(bindings).sort()).toEqual(
      SLOTS.filter(({ slot }) => slot !== 'upperArm.L')
        .map(({ slot }) => slot)
        .sort(),
    );
    expect(profile.missing.filter((entry) => entry.startsWith('armTwist:'))).toEqual([]);
  });

  it('omits malformed helper hierarchies and reports each candidate once', () => {
    const rig = buildTwistRig({ armTwistHelpers: 'twist' });
    const upperLeft = bone(rig, 'UpperArm_twist_L');
    const child = new THREE.Bone();
    child.name = 'TwistChild';
    upperLeft.add(child);

    const upperRight = bone(rig, 'UpperArm_twist_R');
    upperRight.parent?.remove(upperRight);
    bone(rig, 'Shoulder_R').add(upperRight);

    const lowerLeft = bone(rig, 'LowerArm_L');
    const handLeft = bone(rig, 'Hand_L');
    lowerLeft.remove(handLeft);
    const inserted = new THREE.Bone();
    inserted.name = 'InsertedArmLink';
    lowerLeft.add(inserted);
    inserted.add(handLeft);

    const profile = buildProfile(rig.root);
    const bindings = armTwists(profile) ?? {};
    const expectedInvalid: ArmTwistSlot[] = ['upperArm.L', 'upperArm.R', 'lowerArm.L'];
    const diagnostics = profile.missing.filter((entry) => entry.startsWith('armTwist:'));

    for (const slot of expectedInvalid) expect(bindings[slot]).toBeUndefined();
    expect(bindings['lowerArm.R']?.helper === bone(rig, 'LowerArm_twist_R')).toBe(true);
    expect(diagnostics).toHaveLength(expectedInvalid.length);
    for (const slot of expectedInvalid) {
      expect(diagnostics.filter((entry) => entry.includes(slot))).toHaveLength(1);
    }
  });

  it('validates the twist candidate before considering the Rotate fallback', () => {
    const rig = buildTwistRig({ armTwistHelpers: 'rotate' });
    const unsupported = new THREE.Bone();
    unsupported.name = 'UpperArm_twist_L';
    bone(rig, 'Shoulder_L').add(unsupported);
    const profile = buildProfile(rig.root);
    const bindings = armTwists(profile) ?? {};
    const diagnostics = profile.missing.filter((entry) => entry.startsWith('armTwist:'));

    expect(bindings['upperArm.L']).toBeUndefined();
    expect(bindings['upperArm.R']?.helper === bone(rig, 'UpperArm_Rotate_R')).toBe(true);
    expect(diagnostics.filter((entry) => entry.includes('upperArm.L'))).toHaveLength(1);
    expect(diagnostics.filter((entry) => entry.includes('upperArm.R'))).toHaveLength(0);
  });

  it('rejects a helper selected as the canonical next bone by a descriptor override', () => {
    const rig = buildTwistRig({ armTwistHelpers: 'twist' });
    const helper = bone(rig, 'LowerArm_twist_L');
    const profile = buildProfile(rig.root, { bones: { 'hand.L': ['LowerArm_twist_L'] } });
    const bindings = armTwists(profile) ?? {};
    const diagnostics = profile.missing.filter((entry) => entry.startsWith('armTwist:'));

    expect(profile.bones['hand.L']).toBe(helper);
    expect(bindings['lowerArm.L']).toBeUndefined();
    expect(diagnostics).toEqual(['armTwist:lowerArm.L:unsupported hierarchy']);
  });

  it('ignores helper-like names outside the two supported families', () => {
    const rig = buildRig();
    const unsupported = new THREE.Bone();
    unsupported.name = 'UpperArmTwist_L';
    bone(rig, 'UpperArm_L').add(unsupported);
    const profile = buildProfile(rig.root);

    expect(armTwists(profile)).toBeUndefined();
    expect(profile.missing.filter((entry) => entry.startsWith('armTwist:'))).toEqual([]);
  });
});
