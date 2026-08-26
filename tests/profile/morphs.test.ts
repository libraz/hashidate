import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { readGroups, routeMorphs } from '@/engine/profile/morphs';
import type { AvatarDescriptor, MorphTarget } from '@/engine/types';
import { ARKIT_SHAPES, buildRig } from '../helpers/scene';

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the rig has no ${what}`);
  return value;
}

const names = (targets: MorphTarget[] | undefined): string[] =>
  (targets ?? []).map((t) => t.mesh.name);

/** The whole shape list of one mesh, in the order it was authored. */
const authored = (mesh: THREE.Mesh): string[] =>
  Object.entries(mesh.morphTargetDictionary ?? {})
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);

describe('routeMorphs', () => {
  it('routes a name that lives on two meshes to both (mesh, index) pairs', () => {
    const rig = buildRig({
      groups: [['EYE', ['Wink', 'Shrink_Bust']]],
      ungrouped: ['Shrink_Bust', 'NeckHide'],
    });
    const face = must(rig.meshes.get('Face'), 'Face');
    const body = must(rig.meshes.get('Body'), 'Body');

    const { morphTargets } = routeMorphs(rig.root);
    const shared = must(morphTargets.get('Shrink_Bust'), 'Shrink_Bust');

    expect(shared).toHaveLength(2);
    expect(names(shared)).toEqual(['Face', 'Body']);
    expect(shared[0].index).toBe(must(face.morphTargetDictionary, 'face dict').Shrink_Bust);
    expect(shared[1].index).toBe(must(body.morphTargetDictionary, 'body dict').Shrink_Bust);
    // The two meshes number their shapes independently, which is exactly why a
    // single index cannot be the route.
    expect(shared[0].index).not.toBe(shared[1].index);
  });

  it('keeps a name that lives on one mesh to a single pair', () => {
    const rig = buildRig();
    const { morphTargets } = routeMorphs(rig.root);

    expect(names(morphTargets.get('jawOpen'))).toEqual(['Face']);
    expect(names(morphTargets.get('NeckHide'))).toEqual(['Body']);
  });

  it('reports the first landing in dict while the route keeps every landing', () => {
    const rig = buildRig({
      groups: [['EYE', ['Shrink_Bust']]],
      ungrouped: ['Shrink_Bust'],
    });
    const { morphTargets, dict } = routeMorphs(rig.root);
    const shared = must(morphTargets.get('Shrink_Bust'), 'Shrink_Bust');

    expect(dict.Shrink_Bust).toBe(shared[0].index);
    expect(dict.Shrink_Bust).not.toBe(shared[1].index);
    // dict is a flat report: one number per name, whatever the routing found.
    expect(Object.keys(dict).sort()).toEqual([...morphTargets.keys()].sort());
  });

  it('picks the face meshes by expression vocabulary, not by shape count', () => {
    const hides = Array.from({ length: 24 }, (_, i) => `Region${i}Hide`);
    const rig = buildRig({ arkit: false, ungrouped: hides });
    const face = must(rig.meshes.get('Face'), 'Face');
    const body = must(rig.meshes.get('Body'), 'Body');

    const { faceMeshes } = routeMorphs(rig.root);

    // The body carries more shapes than the face and is still not the face.
    expect(authored(body).length).toBeGreaterThan(authored(face).length);
    expect(faceMeshes).toEqual([face]);
  });

  it('skips a mesh with no shapes at all', () => {
    const rig = buildRig({ garments: ['Skirt'] });
    const { morphTargets, faceMeshes } = routeMorphs(rig.root);

    expect(must(rig.meshes.get('Skirt'), 'Skirt').morphTargetDictionary).toBeUndefined();
    expect(faceMeshes.map((m) => m.name)).toEqual(['Face']);
    for (const targets of morphTargets.values()) {
      expect(targets.map((t) => t.mesh.name)).not.toContain('Skirt');
    }
  });
});

describe('readGroups', () => {
  const groups = (descriptor: Partial<AvatarDescriptor>, root: THREE.Object3D) =>
    buildProfile(root, descriptor).groups;

  it('reads underscore-delimited groups in the order they were authored', () => {
    const rig = buildRig({
      groups: [
        ['YOKA', ['F_NIKONIKO', 'F_PUNPUN', 'F_IYAIYA']],
        ['BSL52', ['Fcl_ALL_Joy']],
      ],
    });

    const found = groups(rig.descriptor, rig.root);

    expect([...found.keys()]).toEqual(['YOKA', 'BSL52']);
    expect(found.get('YOKA')).toEqual(['F_NIKONIKO', 'F_PUNPUN', 'F_IYAIYA']);
    expect(found.get('BSL52')).toEqual(['Fcl_ALL_Joy']);
  });

  it('reads asterisk-delimited groups through the pattern the avatar states', () => {
    const rig = buildRig({
      separator: 'asterisk',
      groups: [['EYE MORPH', ['E_HOSHI', 'E_HEART']]],
    });

    const found = groups(rig.descriptor, rig.root);

    expect(rig.descriptor.separator).toBeInstanceOf(RegExp);
    expect(found.get('EYE MORPH')).toEqual(['E_HOSHI', 'E_HEART']);
  });

  it('finds no groups in an asterisk avatar read with the default pattern', () => {
    const rig = buildRig({
      separator: 'asterisk',
      groups: [['EYE MORPH', ['E_HOSHI', 'E_HEART']]],
    });

    // One mechanism, two spellings: the pattern has to come from the avatar.
    expect(buildProfile(rig.root).groups.size).toBe(0);
    expect(buildProfile(rig.root).dict.E_HOSHI).toBeGreaterThan(0);
  });

  it('leaves the shapes above the first separator in no group', () => {
    const rig = buildRig({ groups: [['YOKA', ['F_NIKONIKO']]] });
    const face = must(rig.meshes.get('Face'), 'Face');

    const found = groups(rig.descriptor, rig.root);
    const grouped = [...found.values()].flat();

    // Everything the exporter wrote before the first separator: ARKit, visemes,
    // the blink shapes.
    expect(authored(face).indexOf('jawOpen')).toBeLessThan(authored(face).indexOf('___YOKA___'));
    expect(grouped).toEqual(['F_NIKONIKO']);
    for (const shape of ['jawOpen', 'blink', 'vrc.v_aa']) expect(grouped).not.toContain(shape);
  });

  it('does not repeat a name the face carries on more than one mesh', () => {
    const rig = buildRig({ groups: [['YOKA', ['F_NIKONIKO', 'F_PUNPUN']]] });
    // The face arrives split per material, each split carrying the whole list.
    const split = must(rig.meshes.get('Face'), 'Face').clone();
    split.name = 'Face__Alpha';
    rig.root.add(split);

    const found = groups(rig.descriptor, rig.root);

    expect(split.morphTargetDictionary).toBeDefined();
    expect(names(routeMorphs(rig.root).morphTargets.get('F_PUNPUN'))).toEqual([
      'Face',
      'Face__Alpha',
    ]);
    expect(found.get('YOKA')).toEqual(['F_NIKONIKO', 'F_PUNPUN']);
  });

  it('keeps a separator shape itself out of its own group', () => {
    const rig = buildRig({ groups: [['YOKA', ['F_NIKONIKO']]] });

    const found = readGroups(rig.root, /^_{2,}(.+?)_{2,}$/);

    expect(found.get('YOKA')).not.toContain('___YOKA___');
  });
});

describe('arkit detection', () => {
  it('counts an avatar with the 51-shape set as supported', () => {
    const rig = buildRig({ arkit: true });
    const profile = buildProfile(rig.root, rig.descriptor);

    expect(ARKIT_SHAPES).toHaveLength(51);
    expect(profile.arkit.count).toBe(51);
    expect(profile.arkit.supported).toBe(true);
    expect(profile.arkit.names.has('jawOpen')).toBe(true);
    // tongueOut is the 52nd and routinely absent on Japanese avatars.
    expect(profile.arkit.names.has('tongueOut')).toBe(false);
    expect(profile.missing.filter((m) => m.startsWith('arkit'))).toEqual([]);
  });

  it('counts an avatar well under the bar as unsupported and says so', () => {
    const rig = buildRig({ arkit: false });
    const profile = buildProfile(rig.root, rig.descriptor);

    expect(profile.arkit.count).toBe(0);
    expect(profile.arkit.supported).toBe(false);
    expect(profile.missing).toContain('arkit(0/52)');
  });

  it('does not report arkit as a gap for an avatar that brings its own vocabulary', () => {
    const rig = buildRig({ arkit: false, groups: [['YOKA', ['F_NIKONIKO']]] });
    const profile = buildProfile(rig.root, {
      ...rig.descriptor,
      emotionShapes: { joy: { F_NIKONIKO: 1 } },
    });

    expect(profile.arkit.supported).toBe(false);
    expect(profile.missing.filter((m) => m.startsWith('arkit'))).toEqual([]);
  });
});

describe('viseme and blink resolution', () => {
  it('resolves the visemes an avatar spells the vrc way', () => {
    const profile = buildProfile(buildRig().root);

    expect(profile.viseme).toEqual({
      a: 'vrc.v_aa',
      i: 'vrc.v_ih',
      u: 'vrc.v_ou',
      e: 'vrc.v_e',
      o: 'vrc.v_oh',
      n: 'vrc.v_nn',
    });
    // `sil` is optional on a rig, so its absence is not a gap.
    expect(profile.missing.filter((m) => m.startsWith('viseme'))).toEqual([]);
  });

  it('reports the vowels an avatar has no mouth shape for', () => {
    const rig = buildRig();
    const face = must(rig.meshes.get('Face'), 'Face');
    const dict = must(face.morphTargetDictionary, 'face dict');
    delete dict['vrc.v_aa'];
    delete dict['vrc.v_oh'];

    const profile = buildProfile(rig.root);

    expect(profile.viseme.a).toBeUndefined();
    expect(profile.missing).toContain('viseme:a');
    expect(profile.missing).toContain('viseme:o');
    expect(profile.missing).not.toContain('viseme:n');
  });

  it('lets an avatar own name override the generic viseme list', () => {
    const rig = buildRig({ groups: [['MOUTH', ['M_AA']]] });

    const profile = buildProfile(rig.root, {
      ...rig.descriptor,
      shapes: { viseme: { a: ['M_AA'] } },
    });

    expect(profile.viseme.a).toBe('M_AA');
    // Stating one name overrides detection; it does not disable it.
    expect(profile.viseme.i).toBe('vrc.v_ih');
  });

  it('falls back to the generic list when the stated name is not on the rig', () => {
    const rig = buildRig();

    const profile = buildProfile(rig.root, {
      ...rig.descriptor,
      shapes: { viseme: { a: ['M_AA_that_does_not_exist'] } },
    });

    expect(profile.viseme.a).toBe('vrc.v_aa');
  });

  it('prefers the arkit blink names over the avatar generic ones', () => {
    const profile = buildProfile(buildRig({ arkit: true }).root);

    expect(profile.blink).toEqual({ both: 'blink', L: 'eyeBlinkLeft', R: 'eyeBlinkRight' });
    expect(profile.missing).not.toContain('blink');
  });

  it('falls to the plain per-eye names on a rig with no arkit set', () => {
    const profile = buildProfile(buildRig({ arkit: false }).root);

    expect(profile.blink).toEqual({ both: 'blink', L: 'blinkLeft', R: 'blinkRight' });
  });

  it('lets an avatar own blink name override the generic list', () => {
    const rig = buildRig({ groups: [['EYE', ['E_MABATAKI']]] });

    const profile = buildProfile(rig.root, {
      ...rig.descriptor,
      shapes: { blink: { both: ['E_MABATAKI'] } },
    });

    expect(profile.blink.both).toBe('E_MABATAKI');
    expect(profile.blink.L).toBe('eyeBlinkLeft');
  });

  it('reports blink as missing when the rig closes its eyes no way at all', () => {
    const rig = buildRig({ arkit: false });
    const dict = must(must(rig.meshes.get('Face'), 'Face').morphTargetDictionary, 'face dict');
    for (const shape of ['blink', 'blinkLeft', 'blinkRight']) delete dict[shape];

    const profile = buildProfile(rig.root);

    expect(profile.blink).toEqual({ both: null, L: null, R: null });
    expect(profile.missing).toContain('blink');
  });
});
