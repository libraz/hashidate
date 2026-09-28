import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { setupMaterials } from '@/engine/scene/materials';
import type { AvatarDescriptor, MaterialRules } from '@/engine/types';

const avatar = (materials?: MaterialRules): AvatarDescriptor => ({
  id: 'materials-test',
  label: { en: 'Materials test', ja: 'マテリアル検査' },
  url: '/materials-test.glb',
  ...(materials ? { materials } : {}),
});

const mesh = (material: THREE.Material | THREE.Material[]): THREE.Mesh =>
  new THREE.Mesh(new THREE.BufferGeometry(), material);

describe('avatar material conversion', () => {
  it('converts every imported slot when no preserve rule is supplied', () => {
    const source = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.2 });
    source.name = 'V02_20260909_PolishedPlatinum';
    const object = mesh(source);
    const root = new THREE.Group();
    root.add(object);

    const materials = setupMaterials(root, avatar());
    materials.apply(true);

    expect(object.material).toBeInstanceOf(THREE.MeshToonMaterial);
    materials.dispose();
  });

  it('preserves only exact per-slot imported names in toon mode', () => {
    const platinum = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.2 });
    platinum.name = 'V02_20260909_PolishedPlatinum';
    const star = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.22 });
    star.name = 'V02_20260909_StarPinkGold';
    const cloth = new THREE.MeshStandardMaterial();
    cloth.name = 'V02_20260909_PolishedPlatinumCloth';
    const lookalike = new THREE.MeshStandardMaterial();
    lookalike.name = 'Trim_V02_20260909_StarPinkGold';
    const object = mesh([platinum, cloth, star, lookalike]);
    const root = new THREE.Group();
    root.add(object);

    const materials = setupMaterials(
      root,
      avatar({ preserveImported: /^V02_20260909_(?:PolishedPlatinum|StarPinkGold)$/ }),
    );
    materials.apply(true);
    const converted = object.material as THREE.Material[];

    expect(converted[0]).toBe(platinum);
    expect(converted[2]).toBe(star);
    expect(converted[1]).toBeInstanceOf(THREE.MeshToonMaterial);
    expect(converted[3]).toBeInstanceOf(THREE.MeshToonMaterial);
    expect(platinum.metalness).toBe(1);
    expect(platinum.roughness).toBe(0.2);
    expect(star.metalness).toBe(1);
    expect(star.roughness).toBe(0.22);

    materials.dispose();
  });

  it('applies scalar overrides only when preserve and exact own-name rules both match', () => {
    const metal = new THREE.MeshStandardMaterial({ metalness: 0.8, roughness: 0.35 });
    metal.name = 'Metal';
    const suffix = new THREE.MeshStandardMaterial({ metalness: 0.7, roughness: 0.4 });
    suffix.name = 'MetalTrim';
    const overrideOnly = new THREE.MeshStandardMaterial({ metalness: 0.6, roughness: 0.5 });
    overrideOnly.name = 'OverrideOnly';
    const object = mesh([metal, suffix, overrideOnly]);
    const root = new THREE.Group();
    root.add(object);

    const materials = setupMaterials(
      root,
      avatar({
        preserveImported: /^Metal$/,
        preservedPbrOverrides: {
          Metal: { metalness: 0.2, roughness: 0.9 },
          OverrideOnly: { metalness: 0.1, roughness: 0.8 },
        },
      }),
    );
    materials.apply(true);
    const converted = object.material as THREE.Material[];
    const overridden = converted[0] as THREE.MeshStandardMaterial;

    expect(overridden).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(overridden).not.toBe(metal);
    expect(overridden.metalness).toBe(0.2);
    expect(overridden.roughness).toBe(0.9);
    expect(converted[1]).toBeInstanceOf(THREE.MeshToonMaterial);
    expect(converted[2]).toBeInstanceOf(THREE.MeshToonMaterial);
    expect(metal.metalness).toBe(0.8);
    expect(metal.roughness).toBe(0.35);

    materials.dispose();
  });

  it('retains absent overrides and unsupported preserved materials by reference', () => {
    const standard = new THREE.MeshStandardMaterial({ metalness: 0.8, roughness: 0.35 });
    standard.name = 'Standard';
    const unsupported = new THREE.MeshBasicMaterial();
    unsupported.name = 'Unsupported';
    const object = mesh([standard, unsupported]);
    const root = new THREE.Group();
    root.add(object);

    const materials = setupMaterials(
      root,
      avatar({
        preserveImported: /^(?:Standard|Unsupported)$/,
        preservedPbrOverrides: {
          Unsupported: { metalness: 0.2, roughness: 0.9 },
        },
      }),
    );
    materials.apply(true);

    const converted = object.material as THREE.Material[];
    expect(converted[0]).toBe(standard);
    expect(converted[1]).toBe(unsupported);

    materials.dispose();
  });

  it('preserves Standard and Physical clone fidelity while changing two scalars', () => {
    const map = new THREE.Texture();
    const standard = new THREE.MeshStandardMaterial({
      map,
      metalness: 0.8,
      roughness: 0.35,
      side: THREE.DoubleSide,
    });
    standard.name = 'Standard';
    const physical = new THREE.MeshPhysicalMaterial({
      map,
      metalness: 0.7,
      roughness: 0.4,
      clearcoat: 0.65,
      transmission: 0.2,
    });
    physical.name = 'Physical';
    const object = mesh([standard, physical]);
    const root = new THREE.Group();
    root.add(object);

    const materials = setupMaterials(
      root,
      avatar({
        preserveImported: /^(?:Standard|Physical)$/,
        doubleSided: /^(?:Standard|Physical)$/,
        preservedPbrOverrides: {
          Standard: { metalness: 0.2, roughness: 0.9 },
          Physical: { metalness: 0.1, roughness: 0.85 },
        },
      }),
    );
    materials.apply(true);

    const converted = object.material as THREE.Material[];
    const standardClone = converted[0] as THREE.MeshStandardMaterial;
    const physicalClone = converted[1] as THREE.MeshPhysicalMaterial;
    expect(standardClone).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(physicalClone).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(standardClone.map).toBe(map);
    expect(physicalClone.map).toBe(map);
    expect(standardClone.side).toBe(THREE.DoubleSide);
    expect(physicalClone.clearcoat).toBe(0.65);
    expect(physicalClone.transmission).toBe(0.2);
    expect(standardClone.metalness).toBe(0.2);
    expect(standardClone.roughness).toBe(0.9);
    expect(physicalClone.metalness).toBe(0.1);
    expect(physicalClone.roughness).toBe(0.85);
    expect(standard.metalness).toBe(0.8);
    expect(standard.roughness).toBe(0.35);
    expect(physical.metalness).toBe(0.7);
    expect(physical.roughness).toBe(0.4);

    materials.dispose();
  });

  it('builds preserved clones after source alpha and cull fixups and restores exact refs', () => {
    const source = new THREE.MeshStandardMaterial({
      metalness: 0.8,
      roughness: 0.35,
      side: THREE.DoubleSide,
      transparent: true,
    });
    source.name = 'Metal';
    const object = mesh(source);
    const root = new THREE.Group();
    root.add(object);

    const materials = setupMaterials(
      root,
      avatar({
        preserveImported: /^Metal$/,
        preservedPbrOverrides: { Metal: { metalness: 0.2, roughness: 0.9 } },
      }),
    );
    materials.apply(true);
    const clone = object.material;
    expect(clone).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect((clone as THREE.MeshStandardMaterial).side).toBe(THREE.FrontSide);
    expect((clone as THREE.MeshStandardMaterial).transparent).toBe(false);
    expect((clone as THREE.MeshStandardMaterial).alphaTest).toBe(0.25);

    materials.apply(false);
    expect(object.material).toBe(source);
    expect(source.metalness).toBe(0.8);
    expect(source.roughness).toBe(0.35);
    materials.apply(true);
    expect(object.material).toBe(clone);

    materials.dispose();
  });

  it('rejects invalid scalar values before traversing or mutating the root', () => {
    const source = new THREE.MeshStandardMaterial({ metalness: 0.8, roughness: 0.35 });
    source.name = 'Metal';
    const object = mesh(source);
    object.frustumCulled = true;
    object.renderOrder = 7;
    const root = new THREE.Group();
    root.add(object);
    const traverse = vi.spyOn(root, 'traverse');

    expect(() =>
      setupMaterials(
        root,
        avatar({
          preserveImported: /^Metal$/,
          preservedPbrOverrides: {
            Metal: { metalness: 0.2, roughness: Number.NaN },
          },
        }),
      ),
    ).toThrowError(
      'Invalid preserved PBR override for material "Metal" field "roughness": expected a finite number in [0, 1], got NaN',
    );
    expect(traverse).not.toHaveBeenCalled();
    expect(object.material).toBe(source);
    expect(object.frustumCulled).toBe(true);
    expect(object.renderOrder).toBe(7);
    expect(source.metalness).toBe(0.8);
    expect(source.roughness).toBe(0.35);
  });

  it('gives a reflecting override the shared environment and never disposes it', () => {
    const environment = new THREE.Texture();
    const metal = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.2 });
    metal.name = 'Metal';
    const matte = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.2 });
    matte.name = 'Matte';
    const reflecting = mesh(metal);
    const plain = mesh(matte);
    const root = new THREE.Group();
    root.add(reflecting, plain);

    const materials = setupMaterials(
      root,
      avatar({
        preserveImported: /^(?:Metal|Matte)$/,
        preservedPbrOverrides: {
          Metal: { metalness: 0.8, roughness: 0.3, reflection: 0.6 },
          Matte: { metalness: 0.8, roughness: 0.3 },
        },
      }),
      environment,
    );
    materials.apply(true);
    const clone = reflecting.material as THREE.MeshStandardMaterial;
    const plainClone = plain.material as THREE.MeshStandardMaterial;

    expect(clone.envMap).toBe(environment);
    expect(clone.envMapIntensity).toBe(0.6);
    expect(metal.envMap).toBeNull();
    expect(plainClone.envMap).toBeNull();

    const environmentDispose = vi.spyOn(environment, 'dispose');
    materials.dispose();
    expect(environmentDispose).not.toHaveBeenCalled();
  });

  it('rejects a negative or non-finite reflection', () => {
    const source = new THREE.MeshStandardMaterial();
    source.name = 'Metal';
    const root = new THREE.Group();
    root.add(mesh(source));

    expect(() =>
      setupMaterials(
        root,
        avatar({
          preserveImported: /^Metal$/,
          preservedPbrOverrides: { Metal: { metalness: 0.2, roughness: 0.3, reflection: -1 } },
        }),
      ),
    ).toThrowError(
      'Invalid preserved PBR override for material "Metal" field "reflection": expected a finite number >= 0, got -1',
    );
  });

  it('shares identity-cached clones and disposes shared materials and textures once', () => {
    const map = new THREE.Texture();
    const shared = new THREE.MeshStandardMaterial({ map, metalness: 0.8, roughness: 0.35 });
    shared.name = 'Metal';
    const cloth = new THREE.MeshStandardMaterial({ map });
    cloth.name = 'Cloth';
    const singleton = mesh(shared);
    const arrayObject = mesh([shared, cloth]);
    const root = new THREE.Group();
    root.add(singleton, arrayObject);

    const materials = setupMaterials(
      root,
      avatar({
        preserveImported: /^Metal$/,
        preservedPbrOverrides: { Metal: { metalness: 0.2, roughness: 0.9 } },
      }),
    );
    materials.apply(true);
    const clone = singleton.material as THREE.MeshStandardMaterial;
    expect((arrayObject.material as THREE.Material[])[0]).toBe(clone);

    const sharedDispose = vi.spyOn(shared, 'dispose');
    const cloneDispose = vi.spyOn(clone, 'dispose');
    const clothDispose = vi.spyOn(cloth, 'dispose');
    const mapDispose = vi.spyOn(map, 'dispose');
    materials.dispose();

    expect(sharedDispose).toHaveBeenCalledOnce();
    expect(cloneDispose).toHaveBeenCalledOnce();
    expect(clothDispose).toHaveBeenCalledOnce();
    expect(mapDispose).toHaveBeenCalledOnce();
  });

  it('keeps mixed singleton and array references stable across toggles', () => {
    const metal = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.2 });
    metal.name = 'V02_20260909_PolishedPlatinum';
    const cloth = new THREE.MeshStandardMaterial();
    cloth.name = 'V02_Everyday_Shorts_Fabric';
    const originalArray = [metal, cloth];
    const singleton = mesh(metal);
    const arrayObject = mesh(originalArray);
    const root = new THREE.Group();
    root.add(singleton, arrayObject);

    const materials = setupMaterials(
      root,
      avatar({ preserveImported: /^V02_20260909_(?:PolishedPlatinum|StarPinkGold)$/ }),
    );
    materials.apply(true);
    const toonArray = arrayObject.material;

    expect(singleton.material).toBe(metal);
    expect(toonArray).not.toBe(originalArray);
    expect((toonArray as THREE.Material[])[0]).toBe(metal);
    expect((toonArray as THREE.Material[])[1]).toBeInstanceOf(THREE.MeshToonMaterial);

    materials.apply(false);
    expect(singleton.material).toBe(metal);
    expect(arrayObject.material).toBe(originalArray);
    materials.apply(true);
    expect(singleton.material).toBe(metal);
    expect(arrayObject.material).toBe(toonArray);

    materials.dispose();
  });

  it('retains the existing alpha, cull and decal fixups for preserved slots', () => {
    const metal = new THREE.MeshStandardMaterial({
      metalness: 1,
      roughness: 0.2,
      side: THREE.DoubleSide,
      transparent: true,
    });
    metal.name = 'Metal';
    const decal = new THREE.MeshBasicMaterial({ transparent: true });
    decal.name = 'Decal';
    const flat = new THREE.MeshBasicMaterial({ transparent: true });
    flat.name = 'Flat';
    const metalObject = mesh(metal);
    const decalObject = mesh(decal);
    const flatObject = mesh(flat);
    const root = new THREE.Group();
    root.add(metalObject, decalObject, flatObject);

    const materials = setupMaterials(
      root,
      avatar({
        doubleSided: /^Flat$/,
        faceDecal: /^Decal$/,
        preserveImported: /^Metal$/,
      }),
    );
    materials.apply(true);

    expect(metalObject.material).toBe(metal);
    expect(metal.side).toBe(THREE.FrontSide);
    expect(metal.transparent).toBe(false);
    expect(metal.alphaTest).toBe(0.25);
    expect(metal.depthWrite).toBe(true);
    expect(metal.metalness).toBe(1);
    expect(metal.roughness).toBe(0.2);

    expect(decalObject.material).toBeInstanceOf(THREE.MeshToonMaterial);
    expect((decalObject.material as THREE.MeshToonMaterial).transparent).toBe(true);
    expect((decalObject.material as THREE.MeshToonMaterial).alphaTest).toBe(0.35);
    expect(decalObject.renderOrder).toBe(1);

    expect(flatObject.material).toBeInstanceOf(THREE.MeshToonMaterial);
    expect((flatObject.material as THREE.MeshToonMaterial).side).toBe(THREE.DoubleSide);
    expect((flatObject.material as THREE.MeshToonMaterial).alphaTest).toBe(0.25);

    materials.dispose();
  });

  it('blends fractional V054 cloth while preserving alpha-one legacy handling', () => {
    const alpha = 0.58;
    const map = new THREE.Texture();
    const sleeve = new THREE.MeshStandardMaterial({
      map,
      opacity: alpha,
      side: THREE.DoubleSide,
      transparent: true,
    });
    sleeve.name = 'V054_Main_Cloth';
    const legacyAlpha = 0.9999998;
    const legacySleeve = new THREE.MeshStandardMaterial({
      opacity: legacyAlpha,
      transparent: true,
    });
    legacySleeve.name = 'V054_Main_Cloth';
    const unrelated = new THREE.MeshStandardMaterial({ opacity: 0.5, transparent: true });
    unrelated.name = 'Unrelated_Transparent';
    const left = mesh(sleeve);
    const right = mesh(sleeve);
    const legacyObject = mesh(legacySleeve);
    const unrelatedObject = mesh(unrelated);
    const root = new THREE.Group();
    root.add(left, right, legacyObject, unrelatedObject);

    const materials = setupMaterials(root, avatar({ blendTransparent: /^V054_Main_Cloth$/ }));

    for (const object of [left, right]) {
      expect(object.material).toBe(sleeve);
      expect(sleeve.opacity).toBe(alpha);
      expect(sleeve.transparent).toBe(true);
      expect(sleeve.alphaTest).toBe(0);
      expect(sleeve.depthWrite).toBe(false);
      expect(sleeve.side).toBe(THREE.FrontSide);
      expect(object.renderOrder).toBe(0);
    }
    expect(legacySleeve.opacity).toBe(legacyAlpha);
    expect(legacySleeve.transparent).toBe(false);
    expect(legacySleeve.alphaTest).toBe(0.25);
    expect(legacySleeve.depthWrite).toBe(true);
    expect(unrelated.transparent).toBe(false);
    expect(unrelated.alphaTest).toBe(0.25);
    expect(unrelated.depthWrite).toBe(true);

    materials.apply(true);
    const leftToon = left.material as THREE.MeshToonMaterial;
    const rightToon = right.material as THREE.MeshToonMaterial;
    expect(leftToon).toBeInstanceOf(THREE.MeshToonMaterial);
    expect(rightToon).toBeInstanceOf(THREE.MeshToonMaterial);
    for (const toon of [leftToon, rightToon]) {
      expect(toon.opacity).toBe(alpha);
      expect(toon.transparent).toBe(true);
      expect(toon.alphaTest).toBe(0);
      expect(toon.depthWrite).toBe(false);
      expect(toon.side).toBe(THREE.FrontSide);
    }
    const legacyToon = legacyObject.material as THREE.MeshToonMaterial;
    expect(legacyToon.opacity).toBe(legacyAlpha);
    expect(legacyToon.transparent).toBe(false);
    expect(legacyToon.alphaTest).toBe(0.25);
    expect(legacyToon.depthWrite).toBe(true);
    expect((unrelatedObject.material as THREE.MeshToonMaterial).transparent).toBe(false);
    expect((unrelatedObject.material as THREE.MeshToonMaterial).alphaTest).toBe(0.25);
    expect((unrelatedObject.material as THREE.MeshToonMaterial).depthWrite).toBe(true);

    materials.apply(false);
    expect(left.material).toBe(sleeve);
    expect(right.material).toBe(sleeve);
    expect(legacyObject.material).toBe(legacySleeve);
    expect(unrelatedObject.material).toBe(unrelated);

    const sleeveDispose = vi.spyOn(sleeve, 'dispose');
    const mapDispose = vi.spyOn(map, 'dispose');
    const leftToonDispose = vi.spyOn(leftToon, 'dispose');
    const rightToonDispose = vi.spyOn(rightToon, 'dispose');
    materials.dispose();

    expect(sleeveDispose).toHaveBeenCalledOnce();
    expect(mapDispose).toHaveBeenCalledOnce();
    expect(leftToonDispose).toHaveBeenCalledOnce();
    expect(rightToonDispose).toHaveBeenCalledOnce();
  });

  it('disposes a shared preserved original and its map once', () => {
    const map = new THREE.Texture();
    const shared = new THREE.MeshStandardMaterial({ map, metalness: 1, roughness: 0.2 });
    shared.name = 'V02_20260909_PolishedPlatinum';
    const root = new THREE.Group();
    root.add(mesh(shared), mesh([shared]));

    const materials = setupMaterials(
      root,
      avatar({ preserveImported: /^V02_20260909_(?:PolishedPlatinum|StarPinkGold)$/ }),
    );
    materials.apply(true);
    const materialDispose = vi.spyOn(shared, 'dispose');
    const mapDispose = vi.spyOn(map, 'dispose');

    materials.dispose();

    expect(materialDispose).toHaveBeenCalledOnce();
    expect(mapDispose).toHaveBeenCalledOnce();
  });
});
