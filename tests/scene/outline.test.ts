import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { setupMaterials } from '@/engine/scene/materials';
import { buildOutlineChild, OUTLINE_HIDDEN } from '@/engine/scene/outline';
import { LilToonMaterial, type TextureSource } from '@/engine/scene/toon';
import type { AvatarDescriptor, MaterialRules, ToonSpec } from '@/engine/types';
import { buildRig, type SyntheticRig } from '../helpers/scene';

const shade = (extra: Partial<ToonSpec> = {}): ToonSpec => ({
  shadow: { color: [0.9, 0.8, 0.8], border: 0.4, blur: 0.2, strength: 1, normalStrength: 1 },
  ...extra,
});

const lined = (mask?: string): ToonSpec =>
  shade({
    outline: {
      width: 0.08,
      color: [0.3, 0.2, 0.2, 1],
      fixWidth: 0.5,
      ...(mask ? { mask } : {}),
    },
  });

/** One texture per ask, every one kept so a test can watch it being freed. */
const source = (): { textures: TextureSource; made: Map<string, THREE.Texture> } => {
  const made = new Map<string, THREE.Texture>();
  const textures: TextureSource = (file, kind) => {
    const texture = new THREE.Texture();
    made.set(`${kind}:${file}`, texture);
    return texture;
  };
  return { textures, made };
};

const withRules = (rig: SyntheticRig, materials: MaterialRules): AvatarDescriptor => ({
  ...rig.descriptor,
  materials,
});

const outlinesOf = (mesh: THREE.Object3D): THREE.Mesh[] =>
  mesh.children.filter((c): c is THREE.Mesh => c.userData.outline === true);

const mesh = (rig: SyntheticRig, name: string): THREE.SkinnedMesh => {
  const found = rig.meshes.get(name);
  if (!found) throw new Error(`the rig has no ${name}`);
  return found;
};

describe('outline children', () => {
  it('outlines only the meshes whose materials ask for it, sharing what the body deforms with', () => {
    const rig = buildRig({ materialGroups: { Body: ['Skin', 'Cloth'] }, garments: ['Ribbon'] });
    const { textures } = source();
    const materials = setupMaterials(
      rig.root,
      withRules(rig, { toon: { Skin: lined(), Face: lined(), Cloth: shade() } }),
      () => null,
      textures,
    );
    materials.apply(true);
    materials.installOutlines();

    const body = mesh(rig, 'Body');
    const face = mesh(rig, 'Face');
    expect(outlinesOf(mesh(rig, 'Ribbon'))).toHaveLength(0);
    const [hull] = outlinesOf(body);
    expect(outlinesOf(body)).toHaveLength(1);
    expect(outlinesOf(face)).toHaveLength(1);

    expect(hull).toBeInstanceOf(THREE.SkinnedMesh);
    const skinned = hull as THREE.SkinnedMesh;
    expect(skinned.geometry).toBe(body.geometry);
    expect(skinned.skeleton).toBe(body.skeleton);
    expect(skinned.bindMatrix.equals(body.bindMatrix)).toBe(true);
    expect(skinned.morphTargetInfluences).toBe(body.morphTargetInfluences);
    expect(skinned.morphTargetDictionary).toBe(body.morphTargetDictionary);
    expect(skinned.castShadow).toBe(false);
    expect(skinned.receiveShadow).toBe(false);
    expect(skinned.frustumCulled).toBe(false);
    expect(skinned.name).toBe('Body#outline');

    // The cloth group has no outline, so its slot holds the shared hidden material.
    const slots = skinned.material as THREE.Material[];
    expect(slots).toHaveLength(2);
    expect(slots[0]).toBeInstanceOf(LilToonMaterial);
    expect(slots[1]).toBe(OUTLINE_HIDDEN);
    expect(OUTLINE_HIDDEN.visible).toBe(false);

    // A weight written to the face moves its hull with it.
    const faceHull = outlinesOf(face)[0];
    expect(faceHull.material).toBeInstanceOf(LilToonMaterial);
    const influences = face.morphTargetInfluences;
    if (!influences) throw new Error('the face has no morphs');
    influences[0] = 1;
    expect(faceHull.morphTargetInfluences?.[0]).toBe(1);

    materials.dispose();
  });

  it('builds the hull material as the inverted outline variant of the toon one', () => {
    const rig = buildRig({ materialGroups: { Body: ['Skin', 'Cloth'] } });
    const body = mesh(rig, 'Body');
    const [skin] = body.material as THREE.MeshBasicMaterial[];
    skin.map = new THREE.Texture();
    skin.alphaMap = new THREE.Texture();
    skin.transparent = true;
    const { textures } = source();
    const materials = setupMaterials(
      rig.root,
      withRules(rig, { toon: { Skin: lined() } }),
      () => null,
      textures,
    );
    materials.apply(true);
    materials.installOutlines();

    const toon = (body.material as THREE.Material[])[0] as LilToonMaterial;
    const hull = (outlinesOf(body)[0].material as THREE.Material[])[0] as LilToonMaterial;
    expect(hull).not.toBe(toon);
    expect(hull.side).toBe(THREE.BackSide);
    expect(hull.defines).toHaveProperty('LIL_OUTLINE');
    expect(toon.defines).not.toHaveProperty('LIL_OUTLINE');
    expect(hull.map).toBe(toon.map);
    expect(hull.alphaMap).toBe(toon.alphaMap);
    // The cutout the toon variant was given, carried rather than re-derived.
    expect(toon.alphaTest).toBeGreaterThan(0);
    expect(hull.alphaTest).toBe(toon.alphaTest);
    expect(hull.alphaToCoverage).toBe(toon.alphaToCoverage);
    expect(hull.transparent).toBe(toon.transparent);
    expect(hull.depthWrite).toBe(toon.depthWrite);

    materials.dispose();
  });

  it('gives a face decal and a blended material no outline', () => {
    const rig = buildRig({ materialGroups: { Body: ['Skin', 'Sleeve'] } });
    const { textures } = source();
    const materials = setupMaterials(
      rig.root,
      withRules(rig, {
        faceDecal: /^Face$/,
        blendTransparent: /^Sleeve$/,
        toon: { Face: lined(), Sleeve: lined() },
      }),
      () => null,
      textures,
    );
    materials.apply(true);
    materials.installOutlines();

    expect(outlinesOf(mesh(rig, 'Face'))).toHaveLength(0);
    expect(outlinesOf(mesh(rig, 'Body'))).toHaveLength(0);
    materials.dispose();
  });

  it('shows the hull only with the toon set, and installs once', () => {
    const rig = buildRig();
    const { textures } = source();
    const materials = setupMaterials(
      rig.root,
      withRules(rig, { toon: { Body: lined() } }),
      () => null,
      textures,
    );
    materials.apply(false);
    materials.installOutlines();
    const body = mesh(rig, 'Body');
    const [hull] = outlinesOf(body);
    expect(hull.visible).toBe(false);

    materials.apply(true);
    expect(hull.visible).toBe(true);
    materials.installOutlines();
    expect(outlinesOf(body)).toEqual([hull]);
    materials.apply(false);
    expect(hull.visible).toBe(false);

    materials.dispose();
  });

  it('detaches the hulls and frees their materials, but not what they borrowed', () => {
    const rig = buildRig();
    const { textures, made } = source();
    const materials = setupMaterials(
      rig.root,
      withRules(rig, { toon: { Body: lined('line.png') } }),
      () => null,
      textures,
    );
    materials.apply(true);
    materials.installOutlines();

    const body = mesh(rig, 'Body');
    const [hull] = outlinesOf(body);
    const hullMaterial = hull.material as LilToonMaterial;
    const mask = made.get('data:line.png');
    if (!mask) throw new Error('the outline mask was never asked for');
    expect(hullMaterial.lilOutlineMask).toBe(mask);
    const hullDispose = vi.spyOn(hullMaterial, 'dispose');
    const maskDispose = vi.spyOn(mask, 'dispose');
    const geometryDispose = vi.spyOn(body.geometry, 'dispose');
    const skeletonDispose = vi.spyOn(body.skeleton, 'dispose');

    materials.dispose();

    expect(hull.parent).toBeNull();
    expect(outlinesOf(body)).toHaveLength(0);
    expect(hullDispose).toHaveBeenCalledOnce();
    expect(maskDispose).toHaveBeenCalledOnce();
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(skeletonDispose).not.toHaveBeenCalled();
  });
});

describe('buildOutlineChild', () => {
  it('builds nothing when no slot has an outline', () => {
    const plain = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    expect(buildOutlineChild(plain, [null])).toBeNull();
  });

  it('builds a plain mesh for a mesh that is not skinned', () => {
    const plain = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    plain.name = 'Prop';
    const line = new THREE.MeshBasicMaterial();
    const child = buildOutlineChild(plain, [line]);
    expect(child).not.toBeNull();
    expect(child).not.toBeInstanceOf(THREE.SkinnedMesh);
    expect(child?.geometry).toBe(plain.geometry);
    expect(child?.material).toBe(line);
    expect(child?.name).toBe('Prop#outline');
    expect(child?.userData.outline).toBe(true);
  });
});
