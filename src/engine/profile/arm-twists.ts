import type * as THREE from 'three';
import type { Profile } from '../types';

type ArmTwistSlot = 'upperArm.L' | 'upperArm.R' | 'lowerArm.L' | 'lowerArm.R';
type ArmTwists = NonNullable<Profile['armTwists']>;

const CANDIDATES: Record<ArmTwistSlot, readonly [string, string]> = {
  'upperArm.L': ['UpperArm_twist_L', 'UpperArm_Rotate_L'],
  'upperArm.R': ['UpperArm_twist_R', 'UpperArm_Rotate_R'],
  'lowerArm.L': ['LowerArm_twist_L', 'LowerArm_Rotate_L'],
  'lowerArm.R': ['LowerArm_twist_R', 'LowerArm_Rotate_R'],
};

const NEXT: Record<ArmTwistSlot, keyof Profile['bones']> = {
  'upperArm.L': 'lowerArm.L',
  'upperArm.R': 'lowerArm.R',
  'lowerArm.L': 'hand.L',
  'lowerArm.R': 'hand.R',
};

/** Resolve only known helper names whose rest hierarchy brackets one arm link. */
export function resolveArmTwists(
  bonesByName: Map<string, THREE.Bone>,
  bones: Profile['bones'],
): { value: ArmTwists; missing: string[] } {
  const value: ArmTwists = {};
  const missing: string[] = [];

  for (const slot of Object.keys(CANDIDATES) as ArmTwistSlot[]) {
    const helper = CANDIDATES[slot]
      .map((name) => bonesByName.get(name))
      .find((bone): bone is THREE.Bone => bone !== undefined);
    if (!helper) continue;

    const primary = bones[slot];
    const next = bones[NEXT[slot]];
    if (
      !(primary && next) ||
      helper === next ||
      helper.parent !== primary ||
      helper.children.length > 0 ||
      next.parent !== primary
    ) {
      missing.push(`armTwist:${slot}:unsupported hierarchy`);
      continue;
    }
    value[slot] = { primary, next, helper };
  }

  return { value, missing };
}
