import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { collectBones, resolveBones, resolveFingers } from '@/engine/profile/bones';
import { BLINK_CANDIDATES, VISEME_CANDIDATES } from '@/engine/profile/candidates';

/** A scene holding bones with exactly these names, as the loader would name them. */
function sceneWith(...names: string[]): Map<string, THREE.Bone> {
  const root = new THREE.Group();
  for (const name of names) {
    const bone = new THREE.Bone();
    bone.name = name;
    root.add(bone);
  }
  return collectBones(root);
}

describe('bone names', () => {
  it('resolves a Mixamo rig once its prefix is stripped', () => {
    const name = (n: string) => THREE.PropertyBinding.sanitizeNodeName(`mixamorig:${n}`);
    const bones = sceneWith(
      name('Hips'),
      name('LeftArm'),
      name('LeftForeArm'),
      name('LeftHand'),
      name('LeftUpLeg'),
    );
    const { value } = resolveBones(bones);

    expect(value.hips?.name).toBe('mixamorigHips');
    expect(value['upperArm.L']?.name).toBe('mixamorigLeftArm');
    expect(value['lowerArm.L']?.name).toBe('mixamorigLeftForeArm');
    expect(value['hand.L']?.name).toBe('mixamorigLeftHand');
    expect(value['upperLeg.L']?.name).toBe('mixamorigLeftUpLeg');
  });

  it('resolves Mixamo fingers', () => {
    const bones = sceneWith(
      'mixamorigLeftHandIndex1',
      'mixamorigLeftHandIndex2',
      'mixamorigLeftHandIndex3',
    );
    expect(resolveFingers(bones).value['index.L']).toHaveLength(3);
  });

  it('matches a candidate that the loader would have sanitised', () => {
    const bones = sceneWith('Left_Index_Proximal', 'Left_Index_Intermediate');
    expect(resolveFingers(bones).value['index.L']).toHaveLength(2);
  });

  it('prefers a stated name to a generic one, and falls back to the generic one', () => {
    const bones = sceneWith('Hips', 'Pelvis', 'Spine');
    const { value } = resolveBones(bones, { hips: ['Pelvis'], spine: ['Nope'] });

    expect(value.hips?.name).toBe('Pelvis');
    expect(value.spine?.name).toBe('Spine');
  });

  it('sanitises a stated name the way the loader does', () => {
    const bones = sceneWith('Neck_Base001');
    const { value } = resolveBones(bones, { neck: ['Neck Base.001'] });

    expect(value.neck?.name).toBe('Neck_Base001');
  });

  it('uses a stated finger chain, and ignores one that does not resolve', () => {
    const bones = sceneWith('F1', 'F2', 'F3', 'ThumbProximal_L', 'ThumbIntermediate_L');
    const { value } = resolveFingers(bones, {
      'index.L': ['F1', 'F2', 'F3'],
      'thumb.L': ['Gone', 'Gone2'],
    });

    expect(value['index.L']?.map((b) => b.name)).toEqual(['F1', 'F2', 'F3']);
    expect(value['thumb.L']?.map((b) => b.name)).toEqual([
      'ThumbProximal_L',
      'ThumbIntermediate_L',
    ]);
  });
});

describe('VRoid shapes', () => {
  it('lists the Fcl visemes and blink shapes', () => {
    expect(VISEME_CANDIDATES.a).toContain('Fcl_MTH_A');
    expect(VISEME_CANDIDATES.e).toContain('Fcl_MTH_E');
    expect(BLINK_CANDIDATES.both).toContain('Fcl_EYE_Close');
    expect(BLINK_CANDIDATES.L).toContain('Fcl_EYE_Close_L');
    expect(BLINK_CANDIDATES.R).toContain('Fcl_EYE_Close_R');
  });
});
