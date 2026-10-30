import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SkinPointAnchor } from '@/engine/secondary/skin-point-anchor';
import type { SkinPointAnchorSpec } from '@/engine/types';
import { must } from '../helpers/must';

function makeSkinFixture() {
  const scene = new THREE.Scene();
  const avatar = new THREE.Group();
  avatar.name = 'AvatarPlacement';
  avatar.position.set(2.3, -1.2, 0.7);
  avatar.quaternion.setFromEuler(new THREE.Euler(0.31, -0.22, 0.48));
  avatar.scale.setScalar(0.01);
  scene.add(avatar);

  const hips = new THREE.Bone();
  hips.name = 'Hips';
  hips.position.set(2, 90, -1);
  avatar.add(hips);

  const names = ['SkirtLF', 'SkirtRB', 'RearBowL', 'RearTailR'];
  const sources = names.map((name, index) => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(-22 + index * 13, 4 + index * 5, -9 + index * 7);
    hips.add(bone);
    return bone;
  });

  const anchorRoot = new THREE.Bone();
  anchorRoot.name = 'CharmRoot';
  hips.add(anchorRoot);
  const link = new THREE.Bone();
  link.name = 'Charm002';
  link.position.set(0, -3.5, 0);
  anchorRoot.add(link);
  const end = new THREE.Bone();
  end.name = 'CharmEnd';
  end.position.set(0, -3.5, 0);
  link.add(end);

  const geometry = new THREE.BufferGeometry();
  const encoded = new THREE.Vector3(12.3, 94.5, 2.1);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(encoded.toArray(), 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([1, 2, 3, 4], 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([0.1, 0.2, 0.3, 0.4], 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.name = 'ClothMarker';
  avatar.add(mesh);

  scene.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton([hips, ...sources]);
  mesh.bind(skeleton, new THREE.Matrix4());
  scene.updateMatrixWorld(true);

  const weights = Array.from(geometry.getAttribute('skinWeight').array as Float32Array);
  const spec: SkinPointAnchorSpec = {
    influences: sources.map((bone, index) => ({
      bone: bone.name,
      weight: must(weights[index], 'weights[index]'),
      position: encoded
        .clone()
        .applyMatrix4(must(skeleton.boneInverses[index + 1], 'boneInverses[index + 1]'))
        .toArray() as [number, number, number],
    })),
  };
  const bonesByName = new Map<string, THREE.Bone[]>(
    [hips, ...sources, anchorRoot, link, end].map((bone) => [bone.name, [bone]]),
  );
  const anchor = new SkinPointAnchor(anchorRoot, spec, bonesByName);
  return {
    scene,
    avatar,
    hips,
    sources,
    anchorRoot,
    link,
    end,
    mesh,
    skeleton,
    anchor,
    spec,
    encoded,
    bonesByName,
  };
}

describe('SkinPointAnchor', () => {
  it('resolves influence bone names through the loader-sanitised spelling', () => {
    const fixture = makeSkinFixture();
    const byName = new Map(fixture.bonesByName);
    byName.set('Skirt_LF001', byName.get('SkirtLF') ?? []);
    const spec = {
      influences: [
        { bone: 'Skirt LF.001', weight: 1, position: [0, 0, 0] as [number, number, number] },
      ],
    };
    expect(() => new SkinPointAnchor(fixture.anchorRoot, spec, byName)).not.toThrow();
  });

  it('rejects local shear', () => {
    const sheared = makeSkinFixture();
    sheared.link.updateMatrix();
    sheared.link.matrix.elements[4] = 2e-6;
    sheared.link.matrixAutoUpdate = false;
    expect(
      () => new SkinPointAnchor(sheared.anchorRoot, sheared.spec, sheared.bonesByName),
    ).toThrow(/does not support shear/);
  });

  it('rejects malformed, ambiguous and unsupported source contracts', () => {
    const fixture = makeSkinFixture();
    const make = (spec: SkinPointAnchorSpec, map = fixture.bonesByName) =>
      new SkinPointAnchor(fixture.anchorRoot, spec, map);

    expect(() => make({ influences: [] })).toThrow(/1–4 influences/);
    expect(() =>
      make({
        influences: [
          { ...must(fixture.spec.influences[0], 'influences[0]'), weight: Number.NaN },
          ...fixture.spec.influences.slice(1),
        ],
      }),
    ).toThrow(/weight is invalid/);
    expect(() =>
      make({
        influences: [
          must(fixture.spec.influences[0], 'influences[0]'),
          { ...must(fixture.spec.influences[0], 'influences[0]'), weight: 0.9 },
        ],
      }),
    ).toThrow(/duplicate influence/);
    expect(() =>
      make({
        influences: [
          ...fixture.spec.influences.slice(0, 3),
          { ...must(fixture.spec.influences[3], 'influences[3]'), weight: 0.2 },
        ],
      }),
    ).toThrow(/sum to one/);

    const missing = new Map(fixture.bonesByName);
    missing.delete(must(fixture.spec.influences[0], 'influences[0]').bone);
    expect(() => make(fixture.spec, missing)).toThrow(/resolve uniquely/);
    const duplicate = new Map(fixture.bonesByName);
    duplicate.set(must(fixture.spec.influences[0], 'influences[0]').bone, [
      must(fixture.sources[0], 'sources[0]'),
      new THREE.Bone(),
    ]);
    expect(() => make(fixture.spec, duplicate)).toThrow(/resolve uniquely/);

    fixture.avatar.scale.set(0.01, 0.02, 0.01);
    expect(() => make(fixture.spec)).toThrow(/nonuniform scale/);
    fixture.avatar.scale.setScalar(0.01);
    fixture.avatar.matrixWorldAutoUpdate = false;
    expect(() => make(fixture.spec)).toThrow(/manual matrixWorld override/);
  });
});
