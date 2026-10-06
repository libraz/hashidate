import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SkinPointAnchor } from '@/engine/secondary/skin-point-anchor';
import type { SkinPointAnchorSpec } from '@/engine/types';
import { skinnedPoint } from '../helpers/skinned-point';

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
      weight: weights[index]!,
      position: encoded
        .clone()
        .applyMatrix4(skeleton.boneInverses[index + 1]!)
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

function worldMarker(
  scene: THREE.Scene,
  mesh: THREE.SkinnedMesh,
  skeleton: THREE.Skeleton,
): THREE.Vector3 {
  scene.updateMatrixWorld(true);
  skeleton.update();
  return mesh.getVertexPosition(0, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
}

/** Bone lookup over the fixture's own name map, for `skinnedPoint`. */
function boneOf(fixture: ReturnType<typeof makeSkinFixture>) {
  return (name: string) => fixture.bonesByName.get(name)?.[0];
}

describe('SkinPointAnchor', () => {
  it('matches a real four-weight skinned point through 0.01 scale and moved ancestors', () => {
    const fixture = makeSkinFixture();
    fixture.avatar.position.set(-1.7, 0.6, 2.2);
    fixture.avatar.quaternion.setFromEuler(new THREE.Euler(-0.27, 0.42, -0.19));
    fixture.hips.rotation.set(0.2, -0.13, 0.34);
    fixture.sources[0]!.rotation.set(0.18, 0.12, -0.3);
    fixture.sources[1]!.position.x += 7;
    fixture.sources[2]!.rotation.set(-0.24, 0.31, 0.16);
    fixture.sources[3]!.position.z -= 5;

    const sourceNodes: THREE.Object3D[] = [
      fixture.scene,
      fixture.avatar,
      fixture.hips,
      ...fixture.sources,
    ];
    fixture.scene.updateMatrixWorld(true);
    const before = sourceNodes.map((node) => ({
      matrix: node.matrix.toArray(),
      world: node.matrixWorld.toArray(),
      dirty: node.matrixWorldNeedsUpdate,
    }));

    fixture.anchor.place();
    const after = sourceNodes.map((node) => ({
      matrix: node.matrix.toArray(),
      world: node.matrixWorld.toArray(),
      dirty: node.matrixWorldNeedsUpdate,
    }));
    expect(after).toEqual(before);

    const actual = worldMarker(fixture.scene, fixture.mesh, fixture.skeleton);
    const oracle = skinnedPoint(fixture.scene, fixture.spec.influences, boneOf(fixture));
    // The shared oracle agrees with real skinning, which is what lets the
    // other anchor tests use it where there is no mesh to skin.
    expect(oracle.distanceTo(actual)).toBeLessThan(2e-6);
    expect(fixture.anchor.targetWorld.distanceTo(actual)).toBeLessThan(2e-6);
    expect(
      fixture.anchor.rootWorld.distanceTo(
        skinnedPoint(fixture.scene, fixture.spec.influences, boneOf(fixture)),
      ),
    ).toBeLessThan(2e-6);
    expect(fixture.anchor.error).toBeLessThan(2e-6);

    const dominantOnly = fixture.encoded
      .clone()
      .applyMatrix4(fixture.skeleton.boneInverses[4]!)
      .applyMatrix4(fixture.sources[3]!.matrixWorld);
    expect(dominantOnly.distanceTo(actual)).toBeGreaterThan(1e-3);
    expect(fixture.anchor.diagnostics.targetWorld).toEqual(fixture.anchor.targetWorld.toArray());
  });

  it('accepts measured Float32 ppm scale and stays stable through rotation without touching sources', () => {
    const fixture = makeSkinFixture();
    // Encoded values from a measured static CharmRoot: about 6.081 ppm anisotropy.
    fixture.anchorRoot.scale.set(
      Math.fround(1),
      Math.fround(0.9999998807907104),
      Math.fround(1.0000059604644775),
    );
    const encodedQuaternion = [
      Math.fround(-0.5785567164421082),
      Math.fround(0.5854491591453552),
      Math.fround(-0.5619037747383118),
      Math.fround(-0.08237501978874207),
    ] as const;
    fixture.anchorRoot.quaternion.set(...encodedQuaternion);
    const quaternionLength = fixture.anchorRoot.quaternion.length();
    expect(Math.abs(quaternionLength - 1)).toBeGreaterThan(4e-8);
    expect(Math.abs(quaternionLength - 1)).toBeLessThan(5e-8);

    const sourceNodes: THREE.Object3D[] = [
      fixture.scene,
      fixture.avatar,
      fixture.hips,
      ...fixture.sources,
    ];
    const snapshotSources = () =>
      sourceNodes.map((node) => ({
        matrix: node.matrix.toArray(),
        world: node.matrixWorld.toArray(),
        dirty: node.matrixWorldNeedsUpdate,
      }));
    const before = snapshotSources();
    const anchor = new SkinPointAnchor(fixture.anchorRoot, fixture.spec, fixture.bonesByName);
    const meanScale = (rotation: THREE.Quaternion) => {
      const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(),
        rotation,
        fixture.anchorRoot.scale,
      );
      const elements = matrix.elements;
      return (
        (Math.hypot(...elements.slice(0, 3)) +
          Math.hypot(...elements.slice(4, 7)) +
          Math.hypot(...elements.slice(8, 11))) /
        3
      );
    };
    const initialMeanScale = meanScale(fixture.anchorRoot.quaternion);

    const rotated = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 100,
    );
    const rotatedMeanScale = meanScale(
      new THREE.Quaternion(
        rotated.x * quaternionLength,
        rotated.y * quaternionLength,
        rotated.z * quaternionLength,
        rotated.w * quaternionLength,
      ),
    );
    expect(Math.abs(rotatedMeanScale - initialMeanScale)).toBeGreaterThan(1e-7);
    fixture.anchorRoot.quaternion.set(
      rotated.x * quaternionLength,
      rotated.y * quaternionLength,
      rotated.z * quaternionLength,
      rotated.w * quaternionLength,
    );
    expect(() => anchor.place()).not.toThrow();
    expect(snapshotSources()).toEqual(before);
    expect(
      anchor.rootWorld.distanceTo(
        skinnedPoint(fixture.scene, fixture.spec.influences, boneOf(fixture)),
      ),
    ).toBeLessThan(2e-6);
  });

  it('rejects local shear and animated source scale', () => {
    const sheared = makeSkinFixture();
    sheared.link.updateMatrix();
    sheared.link.matrix.elements[4] = 2e-6;
    sheared.link.matrixAutoUpdate = false;
    expect(
      () => new SkinPointAnchor(sheared.anchorRoot, sheared.spec, sheared.bonesByName),
    ).toThrow(/does not support shear/);

    const animated = makeSkinFixture();
    const animatedSource = animated.sources.at(0);
    if (!animatedSource) throw new Error('fixture requires a source bone');
    animatedSource.scale.multiplyScalar(1.001);
    expect(() => animated.anchor.place()).toThrow(/scale changed after resolution/);

    const subToleranceChange = makeSkinFixture();
    const subToleranceSource = subToleranceChange.sources[0]!;
    subToleranceSource.scale.x += 1e-7;
    // The old composed mean-scale tolerance accepted this real per-axis change.
    expect(() => subToleranceChange.anchor.place()).toThrow(/scale changed after resolution/);

    const subToleranceSubtree = makeSkinFixture();
    subToleranceSubtree.link.scale.x += 1e-7;
    expect(() => subToleranceSubtree.anchor.place()).toThrow(/scale changed after resolution/);

    const subToleranceRoot = makeSkinFixture();
    subToleranceRoot.anchorRoot.scale.x += 1e-7;
    expect(() => subToleranceRoot.anchor.place()).toThrow(/scale changed after resolution/);
  });

  it('rejects malformed, ambiguous and unsupported source contracts', () => {
    const fixture = makeSkinFixture();
    const make = (spec: SkinPointAnchorSpec, map = fixture.bonesByName) =>
      new SkinPointAnchor(fixture.anchorRoot, spec, map);

    expect(() => make({ influences: [] })).toThrow(/1–4 influences/);
    expect(() =>
      make({
        influences: [
          { ...fixture.spec.influences[0]!, weight: Number.NaN },
          ...fixture.spec.influences.slice(1),
        ],
      }),
    ).toThrow(/weight is invalid/);
    expect(() =>
      make({
        influences: [fixture.spec.influences[0]!, { ...fixture.spec.influences[0]!, weight: 0.9 }],
      }),
    ).toThrow(/duplicate influence/);
    expect(() =>
      make({
        influences: [
          ...fixture.spec.influences.slice(0, 3),
          { ...fixture.spec.influences[3]!, weight: 0.2 },
        ],
      }),
    ).toThrow(/sum to one/);

    const missing = new Map(fixture.bonesByName);
    missing.delete(fixture.spec.influences[0]!.bone);
    expect(() => make(fixture.spec, missing)).toThrow(/resolve uniquely/);
    const duplicate = new Map(fixture.bonesByName);
    duplicate.set(fixture.spec.influences[0]!.bone, [fixture.sources[0]!, new THREE.Bone()]);
    expect(() => make(fixture.spec, duplicate)).toThrow(/resolve uniquely/);

    fixture.avatar.scale.set(0.01, 0.02, 0.01);
    expect(() => make(fixture.spec)).toThrow(/nonuniform scale/);
    fixture.avatar.scale.setScalar(0.01);
    fixture.avatar.matrixWorldAutoUpdate = false;
    expect(() => make(fixture.spec)).toThrow(/manual matrixWorld override/);

    const changedWorldMode = makeSkinFixture();
    changedWorldMode.sources[0]!.matrixWorldAutoUpdate = false;
    expect(() => changedWorldMode.anchor.place()).toThrow(/manual matrixWorld override/);

    const movedSource = makeSkinFixture();
    movedSource.avatar.add(movedSource.sources[0]!);
    expect(() => movedSource.anchor.place()).toThrow(/path was reparented/);

    const movedRoot = makeSkinFixture();
    const replacementParent = new THREE.Bone();
    movedRoot.avatar.add(replacementParent);
    replacementParent.add(movedRoot.anchorRoot);
    expect(() => movedRoot.anchor.place()).toThrow(/root was reparented/);

    const rootWorldOverride = makeSkinFixture();
    rootWorldOverride.anchorRoot.matrixWorldAutoUpdate = false;
    expect(() => rootWorldOverride.anchor.place()).toThrow(/manual matrixWorld override/);
  });
});
