import { describe, expect, it } from 'vitest';
import { AVATARS, getAvatar } from '@/avatars';
import original01, {
  createOriginal01AllOutfitsRootHingeMainCuffs,
  createOriginal01AllOutfitsRootHingeMainCuffsRearBowConnector,
  createOriginal01AllOutfitsRootHingeMainCuffsRearBowConnectorMidFrill,
  createOriginal01MainCuffCharmGravity,
  createOriginal01MainCuffLaceGravity,
  createOriginal01MainOverskirtCharmGravity,
  createOriginal01MainOverskirtFrontSpring,
  createOriginal01MainPoutSpeechCorrective,
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
      'V02_SpeechNeutralizer_Joy',
      'V02_SpeechNeutralizer_StarHeart',
    ]);
    expect(original01AllOutfitsRootHinge.presets?.composition).toEqual({
      // biome-ignore lint/style/useNamingConvention: Authored morph target name.
      V02_02_Joy: { speechNeutralizer: 'V02_SpeechNeutralizer_Joy' },
      // biome-ignore lint/style/useNamingConvention: Authored morph target name.
      V02_03_ClosedEyeSmile: { speechNeutralizer: 'V02_SpeechNeutralizer_Joy' },
      // biome-ignore lint/style/useNamingConvention: Authored morph target name.
      V02_12_StarEyes: { speechNeutralizer: 'V02_SpeechNeutralizer_StarHeart' },
      // biome-ignore lint/style/useNamingConvention: Authored morph target name.
      V02_13_HeartEyes: { speechNeutralizer: 'V02_SpeechNeutralizer_StarHeart' },
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
      V02_20260909_PolishedPlatinum: { metalness: 0.8, roughness: 0.3, reflection: 0.7 },
      // biome-ignore lint/style/useNamingConvention: Imported material name.
      V02_20260909_StarPinkGold: { metalness: 0.8, roughness: 0.3, reflection: 0.7 },
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

  it('builds the main-cuffs roster from an explicit exported URL', () => {
    const url = '/models/main-cuffs.glb';
    const descriptor = createOriginal01AllOutfitsRootHingeMainCuffs(url);
    const base = mainDress(original01AllOutfitsRootHinge);
    const main = mainDress(descriptor);
    const cuffs = [
      'V097_Main_SleeveCuffBow_L',
      'V097_Main_SleeveCuffBow_R',
      'V097_Main_SleeveCuffLace_L',
      'V097_Main_SleeveCuffLace_R',
      'V125_Main_SleeveCuffBinding_L_Dist',
      'V125_Main_SleeveCuffBinding_L_Prox',
      'V125_Main_SleeveCuffBinding_R_Dist',
      'V125_Main_SleeveCuffBinding_R_Prox',
    ];

    expect(descriptor.id).toBe('original-01-v02-all-outfits-root-hinge-main-cuffs');
    expect(descriptor.url).toBe(url);
    expect(main.meshes).toEqual([
      'V02_Main_Bodice_R034',
      'V052_Main_Skirt_Upper',
      'V052_Main_Skirt_Mid',
      'V052_Main_Skirt_Lower',
      'V052_Main_Skirt_Upper_Frill_v009',
      'V052_Main_Skirt_Mid_Frill_v009',
      'V052_Main_Skirt_Lower_Frill_v009',
      'V052_Main_Skirt_Lining',
      'V053_Main_NeckLace_Upper',
      'V053_Main_NeckLace_Lower',
      'V02_Main_Sleeve_L',
      'V02_Main_Sleeve_R',
      'V02_Main_Undershort',
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
      ...cuffs,
    ]);
    expect(new Set(main.meshes).size).toBe(main.meshes.length);
    expect(main.meshes.filter((mesh) => cuffs.includes(mesh))).toEqual(cuffs);
    expect(base.meshes).not.toContain(cuffs[0]);
    expect(main.meshes).not.toContain('V02_Main_Skirt_Inner');
    expect(main.meshes).not.toContain('V02_Main_Skirt_Outer');
    const alternateItems = descriptor.wardrobe?.slots.outfit.items.slice(1) ?? [];
    expect(alternateItems).toEqual(
      original01AllOutfitsRootHinge.wardrobe?.slots.outfit.items.slice(1),
    );
    expect(alternateItems.every((item) => !item.meshes.some((mesh) => cuffs.includes(mesh)))).toBe(
      true,
    );
    expect(descriptor.sway).toBe(original01AllOutfitsRootHinge.sway);
    expect(descriptor.presets).toBe(original01AllOutfitsRootHinge.presets);
    expect(descriptor.materials).toBe(original01AllOutfitsRootHinge.materials);
    expect(() => createOriginal01AllOutfitsRootHingeMainCuffs('')).toThrow('nonempty GLB URL');
    expect(() => createOriginal01AllOutfitsRootHingeMainCuffs('   ')).toThrow('nonempty GLB URL');
  });

  it('appends exactly one rear-bow connector to Main while preserving shared descriptor objects', () => {
    const url = '/models/rear-bow.glb';
    const base = createOriginal01AllOutfitsRootHingeMainCuffs(url);
    const descriptor = createOriginal01AllOutfitsRootHingeMainCuffsRearBowConnector(url);
    const baseMain = mainDress(base);
    const main = mainDress(descriptor);
    const connector = 'V02WaistPreview_Back_Connector';

    expect(descriptor.id).toBe('original-01-v02-all-outfits-root-hinge-main-cuffs-rear-bow');
    expect(descriptor.url).toBe(url);
    expect(main.meshes.filter((mesh) => mesh === connector)).toEqual([connector]);
    expect(main.meshes).toEqual([...baseMain.meshes, connector]);
    expect(new Set(main.meshes).size).toBe(main.meshes.length);
    expect(baseMain.meshes).not.toContain(connector);
    expect(descriptor.wardrobe?.slots.outfit?.items.slice(1)).toEqual(
      base.wardrobe?.slots.outfit?.items.slice(1),
    );
    for (const item of descriptor.wardrobe?.slots.outfit?.items.slice(1) ?? []) {
      expect(item.meshes).not.toContain(connector);
    }

    expect(descriptor.sway).toBe(base.sway);
    expect(descriptor.presets).toBe(base.presets);
    expect(descriptor.materials).toBe(base.materials);
    expect(() => createOriginal01AllOutfitsRootHingeMainCuffsRearBowConnector('')).toThrow(
      'nonempty GLB URL',
    );
    expect(() => createOriginal01AllOutfitsRootHingeMainCuffsRearBowConnector('   ')).toThrow(
      'nonempty GLB URL',
    );
  });

  it('appends exactly one Mid-band frill to the rear-bow main dress', () => {
    const url = '/models/mid-frill.glb';
    const base = createOriginal01AllOutfitsRootHingeMainCuffsRearBowConnector(url);
    const descriptor = createOriginal01AllOutfitsRootHingeMainCuffsRearBowConnectorMidFrill(url);
    const frill = 'V477_Main_Skirt_Mid_Frill_Upper';

    expect(descriptor.id).toBe(
      'original-01-v02-all-outfits-root-hinge-main-cuffs-rear-bow-mid-frill',
    );
    expect(descriptor.url).toBe(url);
    expect(mainDress(descriptor).meshes).toEqual([...mainDress(base).meshes, frill]);
    for (const item of descriptor.wardrobe?.slots.outfit?.items.slice(1) ?? []) {
      expect(item.meshes).not.toContain(frill);
    }
    expect(descriptor.sway).toBe(base.sway);
    expect(descriptor.armRest).toBe(base.armRest);
    expect(() => createOriginal01AllOutfitsRootHingeMainCuffsRearBowConnectorMidFrill('')).toThrow(
      'nonempty GLB URL',
    );
  });
});

describe('neru registration', () => {
  it('registers the latest main-dress profile under the character name', () => {
    const neru = getAvatar('neru');
    const profile = createOriginal01MainCuffLaceGravity('/models/neru.glb');
    expect(neru).not.toBeNull();
    expect(neru?.label).toEqual({ en: 'Yonagi Neru', ja: '夜凪ねる' });
    expect(neru?.url).toBe('/models/neru.glb');
    expect(neru?.wardrobe).toEqual(profile.wardrobe);
    expect(neru?.sway).toEqual(profile.sway);
    expect(neru?.presets).toEqual(profile.presets);
    expect(neru?.presets?.exclude).toContain('V02_SpeechNeutralizer_Pout');
    expect(neru?.presets?.composition?.V02_06_Pout).toEqual({
      speechNeutralizer: 'V02_SpeechNeutralizer_Pout',
    });
    expect(AVATARS[0]?.id).toBe('yoka');
  });
});

describe('Main overskirt front spring candidate', () => {
  it('adds one independent chain while preserving the existing spring groups', () => {
    const base = createOriginal01AllOutfitsRootHingeMainCuffsRearBowConnectorMidFrill('/base.glb');
    const candidate = createOriginal01MainOverskirtFrontSpring('/candidate.glb');
    expect(candidate.sway?.groups.slice(0, -1)).toEqual(base.sway?.groups);
    expect(candidate.sway?.colliders).toEqual(base.sway?.colliders);
    expect(candidate.sway?.groups.at(-1)).toEqual({
      id: 'mainOverskirtFrontL',
      label: { en: 'Main overskirt front left', ja: '上掛けの左前角' },
      roots: ['V02_OverskirtFront_L_001'],
      stiffness: 3,
      drag: 0.93,
      gravity: 0,
      radius: 0.003,
      colliders: ['hips', 'upperLegL'],
    });
    expect(candidate.wardrobe).toEqual(base.wardrobe);
    expect(candidate.url).toBe('/candidate.glb');
    expect(base.sway?.groups.some((group) => group.id === 'mainOverskirtFrontL')).toBe(false);
  });
});

describe('Main ornament gravity candidate', () => {
  it('adds cuff pendulums without changing the accepted overskirt or wardrobe', () => {
    const base = createOriginal01MainOverskirtCharmGravity('/base.glb', true);
    const candidate = createOriginal01MainCuffCharmGravity('/candidate.glb');
    expect(candidate.sway?.groups.slice(0, -2)).toEqual(base.sway?.groups);
    expect(candidate.sway?.colliders).toEqual(base.sway?.colliders);
    expect(candidate.wardrobe).toEqual(base.wardrobe);
    expect(candidate.materials).toEqual(base.materials);
    expect(candidate.sway?.groups.slice(-2).map((group) => group.roots)).toEqual([
      ['V02_CuffCharm_L_001'],
      ['V02_CuffCharm_R_001'],
    ]);
    expect(candidate.sway?.groups.slice(-2).every((group) => !group.anchor)).toBe(true);
    expect(candidate.url).toBe('/candidate.glb');
  });
  it('removes only the belt crescent from the explicit candidate wardrobe', () => {
    const base = createOriginal01MainOverskirtCharmGravity('/base.glb');
    const candidate = createOriginal01MainOverskirtCharmGravity('/candidate.glb', true);
    expect(mainDress(base).meshes).toContain('V02WaistPreview_Front_Moon');
    expect(mainDress(candidate).meshes).toEqual(
      mainDress(base).meshes.filter((name) => name !== 'V02WaistPreview_Front_Moon'),
    );
    expect(mainDress(candidate).meshes).toContain('V02_Main_Waist_Belt');
    expect(mainDress(candidate).meshes).toContain('V02WaistPreview_Front_Knot');
    expect(candidate.sway).toEqual(base.sway);
    expect(candidate.materials).toEqual(base.materials);
  });
  it('appends four metadata attachments without changing the existing descriptor', () => {
    const base = createOriginal01AllOutfitsRootHingeMainCuffsRearBowConnectorMidFrill('/base.glb');
    const candidate = createOriginal01MainOverskirtCharmGravity('/candidate.glb');
    expect(candidate.sway?.groups.slice(0, -4)).toEqual(base.sway?.groups);
    expect(candidate.sway?.colliders).toEqual(base.sway?.colliders);
    expect(candidate.wardrobe).toEqual(base.wardrobe);
    expect(candidate.url).toBe('/candidate.glb');
    expect(
      candidate.sway?.groups.slice(-4).map((group) => ({
        id: group.id,
        roots: group.roots,
        anchor: group.anchor,
        stiffness: group.stiffness,
        gravity: group.gravity,
        gravityDir: group.gravityDir,
      })),
    ).toEqual(
      ['LF', 'LB', 'RB', 'RF'].map((side) => ({
        id: `mainOverskirtCharm${side}`,
        roots: [`V02_OverskirtCharm_${side}_001`],
        anchor: { source: 'bone-metadata' },
        stiffness: 0,
        gravity: 0.16,
        gravityDir: [0, -1, 0],
      })),
    );
  });
});
