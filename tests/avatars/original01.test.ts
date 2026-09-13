import { describe, expect, it } from 'vitest';
import original01, {
  original01AllOutfits,
  original01AllOutfitsRootHinge,
} from '@/avatars/original01';

function mainDress(descriptor: typeof original01) {
  const item = descriptor.wardrobe?.slots.outfit?.items.find(
    (entry) => entry.id === 'v02-main-dress',
  );
  if (!item) throw new Error('main dress item is missing');
  return item;
}

describe('original01 root-hinge integration descriptor', () => {
  it('keeps legacy descriptor values and arrays unchanged', () => {
    expect(original01.presets).toEqual({ group: 'V02', hideGroup: 'V02_Hide' });
    expect(original01AllOutfits.presets).toEqual(original01.presets);
    expect(original01.materials?.preservedPbrOverrides).toBeUndefined();
    expect(original01AllOutfits.materials?.preservedPbrOverrides).toBeUndefined();
    for (const descriptor of [original01, original01AllOutfits, original01AllOutfitsRootHinge]) {
      expect(descriptor.materials?.blendTransparent).toEqual(/^V054_Main_Cloth$/);
      expect(descriptor.materials?.blendTransparent?.test('V054_Main_Cloth')).toBe(true);
      expect(descriptor.materials?.blendTransparent?.test('V054_Main_ClothTrim')).toBe(false);
    }
    expect(original01AllOutfits.sway?.groups).toHaveLength(13);
    expect(mainDress(original01AllOutfits).meshes).toEqual([
      'V02_Main_Bodice_R034',
      'V02_Main_Skirt_Inner',
      'V02_Main_Skirt_Outer',
      'V02_Main_Sleeve_L',
      'V02_Main_Sleeve_R',
      'V02_Main_Undershort',
    ]);
  });

  it('adds the named composition, PBR overrides, choker root hinge, and rear groups', () => {
    expect(original01AllOutfitsRootHinge.id).toBe('original-01-v02-all-outfits-root-hinge-probe');
    expect(original01AllOutfitsRootHinge.url).toBe(
      '/models/v02-ribbon-hair-flow-v011-27d76898.glb',
    );
    expect(original01AllOutfitsRootHinge.presets?.group).toBe('V02');
    expect(original01AllOutfitsRootHinge.presets?.hideGroup).toBe('V02_Hide');
    expect(original01AllOutfitsRootHinge.presets?.exclude).toEqual([
      'V02_SpeechNeutralizer_SymbolO',
    ]);
    expect(original01AllOutfitsRootHinge.presets?.composition).toEqual({
      // biome-ignore lint/style/useNamingConvention: Authored morph target name.
      V02_14_DotEyes: {
        blink: 'preserve',
        speechNeutralizer: 'V02_SpeechNeutralizer_SymbolO',
      },
      // biome-ignore lint/style/useNamingConvention: Authored morph target name.
      V02_16_Shock: {
        blink: 'preserve',
        speechNeutralizer: 'V02_SpeechNeutralizer_SymbolO',
      },
      // biome-ignore lint/style/useNamingConvention: Authored morph target name.
      V02_11_Spiral: { speechNeutralizer: 'V02_SpeechNeutralizer_SymbolO' },
      // biome-ignore lint/style/useNamingConvention: Authored morph target name.
      V02_09_ChevronSmile: { speechNeutralizer: 'V02_SpeechNeutralizer_SymbolO' },
    });
    expect(original01AllOutfitsRootHinge.materials?.preservedPbrOverrides).toEqual({
      // biome-ignore lint/style/useNamingConvention: Imported material name.
      V02_20260909_PolishedPlatinum: { metalness: 0.65, roughness: 0.28 },
      // biome-ignore lint/style/useNamingConvention: Imported material name.
      V02_20260909_StarPinkGold: { metalness: 0.55, roughness: 0.3 },
    });

    const baseGroups = original01AllOutfits.sway?.groups;
    const rootGroups = original01AllOutfitsRootHinge.sway?.groups;
    if (!(baseGroups && rootGroups)) throw new Error('secondary-motion groups are missing');
    expect(rootGroups).toHaveLength(15);
    expect(rootGroups.slice(0, 13).map((group) => group.id)).toEqual(
      baseGroups.map((group) => group.id),
    );
    for (const [index, group] of baseGroups.entries()) {
      if (group.id === 'choker') {
        expect(rootGroups[index]).toEqual({
          ...group,
          roots: ['V02_Choker_Root'],
          stiffness: 0.45,
          drag: 0.82,
          gravity: 0.25,
        });
      } else {
        expect(rootGroups[index]).toEqual(group);
      }
    }
    expect(rootGroups.slice(13)).toEqual([
      {
        id: 'rearBowLoops',
        label: { en: 'Rear bow loops', ja: '背中リボンのループ' },
        stiffness: 3,
        drag: 0.93,
        gravity: 0,
        roots: ['V02_RearBowLoop_L_001', 'V02_RearBowLoop_R_001'],
      },
      {
        id: 'rearBowTails',
        label: { en: 'Rear bow tails', ja: '背中リボンの垂れ' },
        stiffness: 1.6,
        drag: 0.9,
        gravity: 0,
        roots: ['V02_RearBowTail_L_001', 'V02_RearBowTail_R_001'],
      },
    ]);
    expect(new Set(rootGroups.map((group) => group.id)).size).toBe(15);

    const baseChoker = baseGroups.find((group) => group.id === 'choker');
    const rootChoker = rootGroups.find((group) => group.id === 'choker');
    if (!(baseChoker && rootChoker)) throw new Error('choker group is missing');
    expect(rootChoker.roots).toEqual(['V02_Choker_Root']);
    expect(rootChoker.radius).toBe(baseChoker.radius);
    expect(rootChoker.colliders).toEqual(baseChoker.colliders);

    const baseChokerColliders = original01AllOutfits.sway?.colliders?.chokerChest;
    const rootChokerColliders = original01AllOutfitsRootHinge.sway?.colliders?.chokerChest;
    if (!(baseChokerColliders && rootChokerColliders)) {
      throw new Error('choker colliders are missing');
    }
    expect(baseChokerColliders).toHaveLength(1);
    expect(rootChokerColliders).toHaveLength(17);
    expect(rootChokerColliders.every((collider) => collider.bone === 'Chest')).toBe(true);
    expect(rootChokerColliders.every((collider) => collider.radius === 0.008)).toBe(true);
    expect(rootChokerColliders[0]).toEqual({
      bone: 'Chest',
      offset: [-0.03, 0.136291687, 0.015586248],
      tail: [0.03, 0.136291687, 0.015586248],
      radius: 0.008,
    });
    expect(rootChokerColliders.at(-1)).toEqual({
      bone: 'Chest',
      offset: [0.011999940298072, 0.121935810605434, 0.028190045760389],
      tail: [0.023999940298072, 0.122063693092567, 0.027450013957366],
      radius: 0.008,
    });
  });

  it('extends only the root-hinge main-dress item without aliasing inherited arrays', () => {
    const baseWardrobe = original01AllOutfits.wardrobe;
    const rootWardrobe = original01AllOutfitsRootHinge.wardrobe;
    if (!(baseWardrobe && rootWardrobe)) throw new Error('wardrobe data is missing');
    const baseMain = mainDress(original01AllOutfits);
    const rootMain = mainDress(original01AllOutfitsRootHinge);

    expect(rootMain.meshes).toEqual([
      ...baseMain.meshes,
      'V02_Main_Waist_Belt',
      'V02WaistPreview_Back_Loop_L',
      'V02WaistPreview_Back_Loop_R',
      'V02WaistPreview_Back_Knot',
      'V02WaistPreview_Front_Loop_L',
      'V02WaistPreview_Front_Loop_R',
      'V02WaistPreview_Front_Tail_0',
      'V02WaistPreview_Front_Tail_1',
      'V02WaistPreview_Front_Knot',
      'V02WaistPreview_Front_Moon',
      'V02WaistPreview_Back_Tail_L',
      'V02WaistPreview_Back_Tail_R',
    ]);
    expect(rootMain.meshes).toHaveLength(18);
    expect(new Set(rootMain.meshes).size).toBe(18);
    expect(baseMain.meshes).toHaveLength(6);
    expect(rootMain).toEqual({ ...baseMain, meshes: rootMain.meshes });

    expect(rootWardrobe.slots.outfit).not.toBe(baseWardrobe.slots.outfit);
    expect(rootWardrobe.slots.outfit.items).not.toBe(baseWardrobe.slots.outfit.items);
    expect(rootWardrobe.slots.legwear).toBe(baseWardrobe.slots.legwear);
    expect(rootWardrobe.slots.footwear).toBe(baseWardrobe.slots.footwear);
    expect(rootWardrobe.presets).toBe(baseWardrobe.presets);
    expect(rootWardrobe.presets?.default?.set).toEqual({
      legwear: 'stockings',
      footwear: 'boots',
      outfit: 'v02-main-dress',
    });
    expect(rootWardrobe.slots.outfit.items.slice(1)).toEqual(
      baseWardrobe.slots.outfit.items.slice(1),
    );
  });
});
