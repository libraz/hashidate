/**
 * V02 wardrobe and secondary-motion descriptor profiles.
 *
 * This remains deliberately unregistered while its motion behaviour is under
 * review.  The face, material and preset mappings are the same mappings used
 * by the V02 eye-surface runtime probe; the wardrobe and secondary-motion
 * declarations are new here.
 */

import type { AvatarDescriptor, PresetSpec } from '../engine/types';

const original01: AvatarDescriptor = {
  id: 'original-01-v02-spring-probe',
  label: { en: 'Original 01 V02 motion probe', ja: 'Original 01 V02 揺れ検査' },
  url: '/models/original-01-v02-boots-heel-v003.glb',

  // The V02 face contract carried by the eye-surface probe.
  separator: /^_{2,}(.+?)_{2,}$/,
  gaze: {
    eyeYaw: 0.07,
    eyePitch: 0.05,
    headYaw: 0.5,
    headPitch: 0.32,
    neckYaw: 0.3,
    neckPitch: 0.22,
  },
  materials: {
    doubleSided:
      /doubleS|Wig_alpha|lantern|Ribbon|Skirt|^R024_(?:Ivory|Fog|Ash)$|^V02_Stocking_(?:Fog|Lace)$|^V02_FaceFX_CoolDrop$/i,
    faceDecal: /Face_alpha|_eyeline|_eyelash|highlight|^V02_FaceFX_CoolDrop$/i,
    blendTransparent: /^V054_Main_Cloth$/,
    preserveImported: /^V02_20260909_(?:PolishedPlatinum|StarPinkGold)$/,
  },
  shapes: {
    blink: {
      both: ['vrc.Blink'],
      L: ['eyeBlinkLeft'],
      R: ['eyeBlinkRight'],
    },
    viseme: {
      a: ['vrc.v_aa'],
      i: ['vrc.v_ih'],
      u: ['vrc.v_ou'],
      e: ['vrc.v_e'],
      o: ['vrc.v_oh'],
    },
  },
  presets: { group: 'V02', hideGroup: 'V02_Hide' },

  wardrobe: {
    slots: {
      legwear: {
        label: { en: 'Legwear', ja: 'レッグウェア' },
        items: [
          {
            id: 'stockings',
            label: { en: 'Stockings', ja: 'ストッキング' },
            meshes: ['V02_Main_Stocking_L_Mesh', 'V02_Main_Stocking_R_Mesh'],
            hide: [
              'lowerthighHide_LT',
              'lowerthighHide_RT',
              'kneeHide_LT',
              'kneeHide_RT',
              'shinHide_LT',
              'shinHide_RT',
              'instepHide_LT',
              'instepHide_RT',
              'toeHide_LT',
              'toeHide_RT',
              'heelHide_LT',
              'heelHide_RT',
            ],
          },
        ],
      },
      footwear: {
        label: { en: 'Footwear', ja: 'フットウェア' },
        items: [
          {
            id: 'boots',
            label: { en: 'Ankle boots', ja: 'アンクルブーツ' },
            meshes: ['V02_Main_Boot_L_Mesh', 'V02_Main_Boot_R_Mesh'],
            hide: [
              'V02_BootHide',
              'V02_BootPitch',
              'instepHide_LT',
              'instepHide_RT',
              'toeHide_LT',
              'toeHide_RT',
              'heelHide_LT',
              'heelHide_RT',
            ],
          },
        ],
      },
    },
    presets: {
      default: {
        label: { en: 'Default', ja: '標準' },
        set: { legwear: 'stockings', footwear: 'boots' },
      },
    },
  },

  // The tiered Main skirt stands away from the hips; the hands rest on it
  // rather than inside it. Set so the idle fingertips sit 0.23-0.26 m from the
  // body axis at fingertip height, level with the skirt's outer surface.
  armRest: {
    upperArm: [0.5, -0.85, 0.14],
    lowerArm: [0.34, -0.92, 0.22],
    hand: [0.26, -0.94, 0.2],
  },

  sway: {
    // Measured in V04 bone-local metres. Tail drive remains deliberately absent
    // while this first passive-contact fit is reviewed.
    colliders: {
      head: [{ bone: 'Head', offset: [0, 0.075, 0.005], radius: 0.078 }],
      chestBack: [
        { bone: 'Chest', offset: [0, 0.015, -0.012], tail: [0, 0.135, -0.012], radius: 0.02 },
        {
          bone: 'Chest',
          offset: [-0.065, 0.095, -0.012],
          tail: [0.065, 0.095, -0.012],
          radius: 0.02,
        },
      ],
      upperArmL: [
        {
          bone: 'UpperArm_L',
          offset: [0.001, 0.012, 0.001],
          tail: [0.001, 0.07, -0.001],
          radius: 0.025,
        },
        {
          bone: 'UpperArm_L',
          offset: [0.001, 0.07, -0.001],
          tail: [0.001, 0.125, -0.002],
          radius: 0.022,
        },
      ],
      upperArmR: [
        {
          bone: 'UpperArm_R',
          offset: [-0.001, 0.012, 0.001],
          tail: [-0.001, 0.07, -0.001],
          radius: 0.025,
        },
        {
          bone: 'UpperArm_R',
          offset: [-0.001, 0.07, -0.001],
          tail: [-0.001, 0.125, -0.002],
          radius: 0.022,
        },
      ],
      hips: [
        {
          bone: 'Hips',
          offset: [-0.05, -0.01, -0.008],
          tail: [0.05, -0.01, -0.008],
          radius: 0.055,
        },
      ],
      upperLegL: [
        {
          bone: 'UpperLeg_L',
          offset: [0.014, 0.045, 0.006],
          tail: [0.008, 0.13, 0.001],
          radius: 0.046,
        },
        {
          bone: 'UpperLeg_L',
          offset: [0.008, 0.13, 0.001],
          tail: [0.005, 0.215, -0.001],
          radius: 0.038,
        },
      ],
      upperLegR: [
        {
          bone: 'UpperLeg_R',
          offset: [-0.014, 0.045, 0.006],
          tail: [-0.008, 0.13, 0.001],
          radius: 0.046,
        },
        {
          bone: 'UpperLeg_R',
          offset: [-0.008, 0.13, 0.001],
          tail: [-0.005, 0.215, -0.001],
          radius: 0.038,
        },
      ],
      chokerChest: [
        { bone: 'Chest', offset: [0, 0.105, -0.004], tail: [0, 0.15, -0.004], radius: 0.024 },
      ],
      tailBase: [
        {
          bone: 'Hips',
          offset: [-0.045, 0.005, -0.015],
          tail: [0.045, 0.005, -0.015],
          radius: 0.05,
        },
      ],
    },
    groups: [
      {
        id: 'hairFront',
        label: { en: 'Fringe', ja: '前髪' },
        stiffness: 2.2,
        drag: 0.94,
        gravity: 0,
        radius: 0.012,
        roots: ['Hair_front_C_001', 'Hair_front_L_001', 'Hair_front_R_001'],
        colliders: ['head'],
      },
      {
        id: 'hairAhoge',
        label: { en: 'Cowlick', ja: 'アホ毛' },
        stiffness: 0.7,
        drag: 0.8,
        gravity: 0,
        radius: 0.006,
        roots: ['Hair_front_ahoge_001'],
      },
      {
        id: 'hairSide',
        label: { en: 'Side hair', ja: 'サイドの髪' },
        stiffness: 0.95,
        drag: 0.9,
        gravity: 0.05,
        radius: 0.018,
        roots: ['Hair_side_A_L_001', 'Hair_side_B_L_001', 'Hair_side_A_R_001', 'Hair_side_B_R_001'],
        colliders: ['head'],
      },
      {
        id: 'hairSideUp',
        label: { en: 'Side ties', ja: 'サイドの結び' },
        stiffness: 1.4,
        drag: 0.92,
        gravity: 0,
        radius: 0.015,
        roots: ['Hair_sideup_L_001', 'Hair_sideup_R_001'],
        colliders: ['head'],
      },
      {
        id: 'hairBack',
        label: { en: 'Back hair', ja: '後ろ髪' },
        stiffness: 1.15,
        drag: 0.945,
        gravity: 0.14,
        radius: 0.028,
        roots: [
          'Hair_back_A_L_001',
          'Hair_back_B_L_001',
          'Hair_back_C_L_001',
          'Hair_back_D_001',
          'Hair_back_A_R_001',
          'Hair_back_B_R_001',
          'Hair_back_C_R_001',
        ],
        colliders: ['head', 'chestBack', 'upperArmL', 'upperArmR'],
      },
      {
        id: 'bowTail14',
        label: { en: 'Bow tails 14', ja: 'リボン垂れ 14' },
        stiffness: 12,
        drag: 0.94,
        gravity: 0.04,
        radius: 0.006,
        roots: ['V02_BowTail14_L_001', 'V02_BowTail14_R_001'],
        colliders: ['head'],
      },
      {
        id: 'bowTail16',
        label: { en: 'Bow tails 16', ja: 'リボン垂れ 16' },
        stiffness: 10,
        drag: 0.92,
        gravity: 0.06,
        radius: 0.006,
        roots: ['V02_BowTail16_L_001', 'V02_BowTail16_R_001'],
        colliders: ['head'],
      },
      {
        id: 'bowCharm',
        label: { en: 'Bow charms', ja: 'リボン飾り' },
        stiffness: 0.9,
        drag: 0.82,
        gravity: 0.08,
        radius: 0.003,
        roots: ['V02_BowCharm_L_001', 'V02_BowCharm_R_001'],
        colliders: ['head'],
      },
      {
        id: 'halfTwin',
        label: { en: 'Half twins', ja: 'ハーフツイン' },
        stiffness: 8,
        drag: 0.94,
        gravity: 0.06,
        radius: 0.005,
        roots: ['V02_HalfTwin_L_001', 'V02_HalfTwin_R_001'],
        colliders: ['head'],
      },
      {
        id: 'breast',
        label: { en: 'Chest', ja: '胸' },
        stiffness: 0.7,
        drag: 0.18,
        gravity: 0,
        radius: 0.02,
        roots: ['Breast_L', 'Breast_R'],
      },
      {
        id: 'tail',
        label: { en: 'Tail', ja: '尻尾' },
        stiffness: 0.6,
        drag: 0.35,
        gravity: 0,
        radius: 0.035,
        roots: ['Tail_001'],
        colliders: ['tailBase', 'upperLegL', 'upperLegR'],
      },
      {
        id: 'mainSkirt',
        label: { en: 'Main skirt frill', ja: 'メインスカートのフリル' },
        stiffness: 3,
        drag: 0.93,
        gravity: 0.1,
        radius: 0.012,
        childrenOf: ['Tops_frill'],
        colliders: ['hips', 'upperLegL', 'upperLegR'],
      },
      {
        id: 'choker',
        label: { en: 'Choker chain', ja: 'チョーカーのチェーン' },
        stiffness: 0.9,
        drag: 0.82,
        gravity: 0.08,
        radius: 0.003,
        roots: ['Choker_001'],
        colliders: ['head', 'chokerChest'],
      },
    ],
  },
};

export default original01;

/**
 * Isolated all-outfits probe declaration. The legacy default above remains
 * bound to its existing GLB, while this declaration is loaded only with an
 * explicit all-outfits model override in its dedicated runtime probe.
 */
export const original01AllOutfits: AvatarDescriptor = {
  ...original01,
  id: 'original-01-v02-all-outfits-probe',
  label: { en: 'Original 01 V02 all outfits probe', ja: 'Original 01 V02 全衣装検査' },
  wardrobe: {
    slots: {
      outfit: {
        label: { en: 'Outfit', ja: '衣装' },
        items: [
          {
            id: 'v02-main-dress',
            label: { en: 'Main dress', ja: 'メインドレス' },
            meshes: [
              'V02_Main_Bodice_R034',
              'V02_Main_Skirt_Inner',
              'V02_Main_Skirt_Outer',
              'V02_Main_Sleeve_L',
              'V02_Main_Sleeve_R',
              'V02_Main_Undershort',
            ],
          },
          {
            id: 'v02-everyday-separates',
            label: { en: 'Everyday separates', ja: '普段着セパレート' },
            meshes: ['V02_Everyday_Top_Mesh', 'V02_Everyday_Shorts_Mesh'],
          },
          {
            id: 'v02-stargazer-layered',
            label: { en: 'Stargazer layered', ja: '星見レイヤード' },
            meshes: ['V02_Everyday_Top_Mesh', 'V02_Everyday_Shorts_Mesh', 'V02_CapeJacket_Shell'],
          },
        ],
      },
      ...original01.wardrobe!.slots,
    },
    presets: {
      ...original01.wardrobe!.presets,
      default: {
        label: { en: 'Default', ja: '標準' },
        set: {
          ...original01.wardrobe!.presets?.default?.set,
          outfit: 'v02-main-dress',
        },
      },
    },
  },
};

const rootHingeBaseSway = original01AllOutfits.sway;
if (!rootHingeBaseSway) throw new Error('Root-hinge profile requires secondary motion');

const rootHingeBaseWardrobe = original01AllOutfits.wardrobe;
if (!rootHingeBaseWardrobe) throw new Error('Root-hinge profile requires wardrobe data');

const rootHingeMainSlot = rootHingeBaseWardrobe.slots.outfit;
if (!rootHingeMainSlot) throw new Error('Root-hinge profile requires the outfit slot');

const rootHingeMainItem = rootHingeMainSlot.items.find((item) => item.id === 'v02-main-dress');
if (!rootHingeMainItem) throw new Error('Root-hinge profile requires the main dress item');

const rootHingeMainMeshes = [
  ...rootHingeMainItem.meshes,
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
];

const rootHingeWardrobe = {
  ...rootHingeBaseWardrobe,
  slots: {
    ...rootHingeBaseWardrobe.slots,
    outfit: {
      ...rootHingeMainSlot,
      items: rootHingeMainSlot.items.map((item) =>
        item.id === rootHingeMainItem.id ? { ...item, meshes: rootHingeMainMeshes } : item,
      ),
    },
  },
};

const rootHingeBasePresets = original01AllOutfits.presets;
if (!rootHingeBasePresets) throw new Error('Root-hinge profile requires preset data');

const rootHingePresets: PresetSpec = {
  ...rootHingeBasePresets,
  exclude: [
    ...(rootHingeBasePresets.exclude ?? []),
    'V02_SpeechNeutralizer_SymbolO',
    'V02_SpeechNeutralizer_Joy',
    'V02_SpeechNeutralizer_StarHeart',
  ],
  composition: {
    ...(rootHingeBasePresets.composition ?? {}),
    // The open-mouth faces leave their lower lip behind under the canonical close; each GLB
    // that carries the exact inverse returns the mouth to rest while speaking instead.
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
      blink: 'preserve' as const,
      speechNeutralizer: 'V02_SpeechNeutralizer_SymbolO',
    },
    // biome-ignore lint/style/useNamingConvention: Authored morph target name.
    V02_16_Shock: {
      blink: 'preserve' as const,
      speechNeutralizer: 'V02_SpeechNeutralizer_SymbolO',
    },
    // biome-ignore lint/style/useNamingConvention: Authored morph target name.
    V02_11_Spiral: { speechNeutralizer: 'V02_SpeechNeutralizer_SymbolO' },
    // biome-ignore lint/style/useNamingConvention: Authored morph target name.
    V02_09_ChevronSmile: { speechNeutralizer: 'V02_SpeechNeutralizer_SymbolO' },
  },
};

/** Versioned root-hinge integration profile; the two legacy declarations stay unchanged. */
export const original01AllOutfitsRootHinge: AvatarDescriptor = {
  ...original01AllOutfits,
  id: 'original-01-v02-all-outfits-root-hinge-probe',
  url: '/models/v02-ribbon-hair-flow-v011-27d76898.glb',
  presets: rootHingePresets,
  materials: {
    ...original01AllOutfits.materials,
    preservedPbrOverrides: {
      // biome-ignore lint/style/useNamingConvention: Imported material name.
      V02_20260909_PolishedPlatinum: { metalness: 0.65, roughness: 0.28 },
      // biome-ignore lint/style/useNamingConvention: Imported material name.
      V02_20260909_StarPinkGold: { metalness: 0.55, roughness: 0.3 },
    },
  },
  wardrobe: rootHingeWardrobe,
  sway: {
    ...rootHingeBaseSway,
    colliders: {
      ...rootHingeBaseSway.colliders,
      chokerChest: [
        {
          bone: 'Chest',
          offset: [-0.03, 0.136291687, 0.015586248],
          tail: [0.03, 0.136291687, 0.015586248],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [-0.03, 0.1294857752934797, 0.019735296798715635],
          tail: [-0.018, 0.12906898004434017, 0.022147212195628183],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [-0.018, 0.12906898004434017, 0.022147212195628183],
          tail: [0, 0.129886849, 0.017414359],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [0, 0.129886849, 0.017414359],
          tail: [0.018, 0.12906898004434017, 0.022147212195628183],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [0.018, 0.12906898004434017, 0.022147212195628183],
          tail: [0.03, 0.1294857752934797, 0.019735296798715635],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [-0.03, 0.12272740933047271, 0.023609214880308736],
          tail: [-0.018, 0.12247940108464034, 0.025044391763728763],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [-0.018, 0.12247940108464034, 0.025044391763728763],
          tail: [0, 0.123141972, 0.021210219],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [0, 0.123141972, 0.021210219],
          tail: [0.018, 0.12247940108464034, 0.025044391763728763],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [0.018, 0.12247940108464034, 0.025044391763728763],
          tail: [0.03, 0.12272740933047271, 0.023609214880308736],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [-0.03, 0.11605745397771126, 0.026971512961309452],
          tail: [-0.018, 0.11589265602253138, 0.02792516760660278],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [-0.018, 0.11589265602253138, 0.02792516760660278],
          tail: [0, 0.11626217, 0.02578686],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [0, 0.11626217, 0.02578686],
          tail: [0.018, 0.11589265602253138, 0.02792516760660278],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [0.018, 0.11589265602253138, 0.02792516760660278],
          tail: [0.03, 0.11605745397771126, 0.026971512961309452],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [-0.030000059701928, 0.108992479454639, 0.032619711630504],
          tail: [0.029999940298072, 0.108992479454639, 0.032619711630504],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [-0.030000059701928, 0.102796076250015, 0.033241653207924],
          tail: [0.029999940298072, 0.102796076250015, 0.033241653207924],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [-0.024000059701928, 0.122063693092567, 0.027450013957366],
          tail: [-0.012000059701928, 0.121935810605434, 0.028190045760389],
          radius: 0.008,
        },
        {
          bone: 'Chest',
          offset: [0.011999940298072, 0.121935810605434, 0.028190045760389],
          tail: [0.023999940298072, 0.122063693092567, 0.027450013957366],
          radius: 0.008,
        },
      ],
    },
    groups: [
      ...rootHingeBaseSway.groups.map((group) =>
        group.id === 'choker'
          ? {
              ...group,
              roots: ['V02_Choker_Root'],
              stiffness: 0.45,
              drag: 0.82,
              gravity: 0.25,
            }
          : group,
      ),
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
    ],
  },
};

const tieredMainSkirtMeshes = [
  'V052_Main_Skirt_Upper',
  'V052_Main_Skirt_Mid',
  'V052_Main_Skirt_Lower',
  'V052_Main_Skirt_Upper_Frill_v009',
  'V052_Main_Skirt_Mid_Frill_v009',
  'V052_Main_Skirt_Lower_Frill_v009',
  'V052_Main_Skirt_Lining',
  'V053_Main_NeckLace_Upper',
  'V053_Main_NeckLace_Lower',
];

const mainCuffMeshes = [
  'V097_Main_SleeveCuffBow_L',
  'V097_Main_SleeveCuffBow_R',
  'V097_Main_SleeveCuffLace_L',
  'V097_Main_SleeveCuffLace_R',
  'V125_Main_SleeveCuffBinding_L_Dist',
  'V125_Main_SleeveCuffBinding_L_Prox',
  'V125_Main_SleeveCuffBinding_R_Dist',
  'V125_Main_SleeveCuffBinding_R_Prox',
];

/**
 * Build the V128 descriptor for a GLB exported with `--main-cuffs --tiered-skirt`
 * from `all-outfits-stockings-boots-waist-tail`, the all-outfits root-hinge /
 * tail-compatible profile. The caller supplies the actual exported GLB URL;
 * this factory never invents or reuses one.
 */
export function createOriginal01AllOutfitsRootHingeMainCuffs(url: string): AvatarDescriptor {
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new Error('Main-cuffs descriptor requires a nonempty GLB URL');
  }
  const baseWardrobe = original01AllOutfitsRootHinge.wardrobe;
  if (!baseWardrobe) throw new Error('Main-cuffs profile requires wardrobe data');
  const baseSlot = baseWardrobe.slots.outfit;
  if (!baseSlot) throw new Error('Main-cuffs profile requires the outfit slot');
  const baseItem = baseSlot.items.find((item) => item.id === 'v02-main-dress');
  if (!baseItem) throw new Error('Main-cuffs profile requires the main dress item');

  const skirtStart = baseItem.meshes.indexOf('V02_Main_Skirt_Inner');
  const skirtEnd = baseItem.meshes.indexOf('V02_Main_Skirt_Outer');
  if (skirtStart < 0 || skirtEnd !== skirtStart + 1) {
    throw new Error('Main-cuffs profile requires adjacent legacy skirt owners');
  }
  const mainMeshes = [
    ...baseItem.meshes.slice(0, skirtStart),
    ...tieredMainSkirtMeshes,
    ...baseItem.meshes.slice(skirtEnd + 1),
    ...mainCuffMeshes,
  ];
  const wardrobe = {
    ...baseWardrobe,
    slots: {
      ...baseWardrobe.slots,
      outfit: {
        ...baseSlot,
        items: baseSlot.items.map((item) =>
          item.id === baseItem.id ? { ...item, meshes: mainMeshes } : item,
        ),
      },
    },
  };
  return {
    ...original01AllOutfitsRootHinge,
    id: 'original-01-v02-all-outfits-root-hinge-main-cuffs-v128',
    url,
    wardrobe,
  };
}

/**
 * Build the V208 descriptor for the rear-bow connector addition.
 *
 * The connector belongs to the main dress only.  Keeping this as a second
 * factory means the V128 main-cuffs descriptor, its registry consumers, and
 * all shared motion/material/preset objects remain unchanged.
 */
export function createOriginal01AllOutfitsRootHingeMainCuffsRearBowConnector(
  url: string,
): AvatarDescriptor {
  return withMainDressMesh(
    createOriginal01AllOutfitsRootHingeMainCuffs(url),
    'V02WaistPreview_Back_Connector',
    'original-01-v02-all-outfits-root-hinge-main-cuffs-rear-bow-v208',
    'Rear-bow connector',
  );
}

/**
 * Build the V477 descriptor for a GLB exported with `--mid-upper-frill`: the
 * V208 main dress plus the extra ruffle tier on the skirt's Mid band.
 */
export function createOriginal01AllOutfitsRootHingeMainCuffsRearBowConnectorMidFrill(
  url: string,
): AvatarDescriptor {
  return withMainDressMesh(
    createOriginal01AllOutfitsRootHingeMainCuffsRearBowConnector(url),
    'V477_Main_Skirt_Mid_Frill_Upper',
    'original-01-v02-all-outfits-root-hinge-main-cuffs-rear-bow-mid-frill-v477',
    'Mid-band frill',
  );
}

/** Add one Main-only mesh to the main dress item of `base`. */
function withMainDressMesh(
  base: AvatarDescriptor,
  mesh: string,
  id: string,
  label: string,
): AvatarDescriptor {
  const baseWardrobe = base.wardrobe;
  if (!baseWardrobe) throw new Error(`${label} profile requires wardrobe data`);
  const baseSlot = baseWardrobe.slots.outfit;
  if (!baseSlot) throw new Error(`${label} profile requires the outfit slot`);
  const baseItem = baseSlot.items.find((item) => item.id === 'v02-main-dress');
  if (!baseItem) throw new Error(`${label} profile requires the main dress item`);

  if (baseItem.meshes.includes(mesh)) {
    throw new Error(`${label} is already present in the main dress`);
  }
  const mainMeshes = [...baseItem.meshes, mesh];
  const wardrobe = {
    ...baseWardrobe,
    slots: {
      ...baseWardrobe.slots,
      outfit: {
        ...baseSlot,
        items: baseSlot.items.map((item) =>
          item.id === baseItem.id ? { ...item, meshes: mainMeshes } : item,
        ),
      },
    },
  };

  return { ...base, id, wardrobe };
}
