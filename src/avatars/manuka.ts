/**
 * Avatar data — Manuka.
 *
 * The model itself: https://booth.pm/en/items/5058077
 *
 * The counterweight to `yoka.ts`, and the reason the engine has a profile layer
 * at all. Where the first avatar implements ARKit 51/52 under the standard
 * names, this one implements **none of it**: 0/52, measured. Its expression
 * vocabulary is romanised Japanese (`eye_nagomi`, `brow_trouble`,
 * `jaw_morph_rori`), its shape groups are delimited with asterisks rather than
 * underscores, and all 473 face shapes sit on a single mesh instead of being
 * split across fifteen.
 *
 * So nothing here is a variation on the first avatar's data — it exercises the
 * fallback path end to end.
 */

import type { AvatarDescriptor } from '../engine/types';

export default {
  id: 'manuka',
  label: { en: 'Manuka', ja: 'マヌカ' },
  author: { en: 'Jingo', ja: 'ジンゴ' },
  url: '/models/manuka.glb',

  // Shape groups are delimited by dummy shapes named **********GROUP**********.
  separator: /^\*{3,}(.+?)\*{3,}$/,

  /**
   * Unmeasured — inherits the engine defaults.
   *
   * The first avatar's figures were arrived at by sweeping the eye bone against
   * a front-on shot and watching for sclera, and they are a property of how
   * that face is drawn, so they do not transfer. This avatar also draws its eyes
   * differently enough that the mechanism may not be the right one at all: it
   * ships `eye_up` / `eye_down` / `eye_left` / `eye_right` blendshapes, i.e. a
   * gaze channel that moves the iris within the opening rather than rotating a
   * bone behind it. Worth measuring both ways before either number is trusted.
   */
  gaze: null,

  /**
   * Canonical slots this avatar names in its own way.
   *
   * Only blink needs stating. The visemes resolve on their own because the
   * VRChat set (`vrc.v_aa` …) is already in the engine's candidate list, and
   * all fifteen are present.
   *
   * Blink is per-eye here, which is the better of the two paths: it lets a
   * drawn face that has already lowered one lid keep it, and it makes a wink
   * expressible without a special case.
   */
  shapes: {
    blink: { both: ['eye_close'], L: ['eye_close_L'], R: ['eye_close_R'] },
  },

  // No finished whole-face drawings. The author's design is compositional —
  // eyes, brows and mouth are separate parts meant to be combined — so there is
  // nothing for the preset channel to fire and it stays empty.
  presets: null,

  /**
   * Emotion composition in the avatar's own vocabulary.
   *
   * The ARKit table in `engine/face/emotions.ts` is portable and this avatar
   * cannot use a line of it. This is the same idea rewritten in the words this
   * model speaks: part-level shapes that blend additively, so mixing joy and
   * relaxed still lands somewhere between the two rather than smearing one
   * drawing over another.
   *
   * Composed by eye against the shape list, not derived. The engine has no way
   * to know that `eye_nagomi` is a calm expression and `eye_jito` is a flat
   * stare — that judgement is what a profile is for.
   */
  emotionShapes: {
    neutral: {},

    joy: {
      eye_joy: 0.85,
      brow_joy: 0.7,
      mouth_smile: 0.7,
      'option_cheek 1': 0.25,
    },

    anger: {
      eye_angry: 0.85,
      brow_anger: 0.9,
      'mouth_∧': 0.5,
      eyelid_center_down: 0.3,
    },

    sadness: {
      eye_sad: 0.8,
      brow_sad: 0.9,
      mouth_sad: 0.7,
      eye_tare: 0.3,
    },

    surprise: {
      eye_big: 0.7,
      eyelid_up: 0.8,
      brow_surprised: 0.85,
      'mouth_○': 0.55,
      eye_pupil_small: 0.35,
    },

    relaxed: {
      eye_nagomi: 0.75,
      brow_nagomi: 0.6,
      mouth_smile: 0.4,
    },

    thinking: {
      eye_jito: 0.5,
      eye_up: 0.5,
      brow_straight: 0.5,
      brow_down: 0.3,
      mouth_narrow: 0.45,
    },

    shy: {
      eye_nagomi: 0.5,
      brow_trouble: 0.65,
      mouth_smile: 0.3,
      'option_cheek 2': 0.8,
    },
  },

  // Shapes the mouth layer owns while speaking. Held back rather than dropped,
  // so a smile survives a line instead of the emotion disappearing whenever the
  // character talks.
  mouthShapePattern: /^mouth_/,

  /**
   * Drawn effects, layered additively over whatever face is showing.
   *
   * This is the avatar's answer to the finished faces the first one ships: a
   * spiral iris, a heart pupil, a blush, tears, a sweat drop. They cannot be
   * synthesised from part shapes any more than a finished face can — but unlike
   * a finished face they are *overlays*, drawn on top of an expression rather
   * than replacing it, so they get their own channel instead of going through
   * the preset one.
   *
   * `option_neck_hole_shrink` is in the same group and is a fitting shape, not
   * an effect.
   */
  overlays: {
    group: 'OPTION',
    exclude: ['option_neck_hole_shrink'],
    label: (id: string) => id.replace(/^option_/, ''),
  },

  materials: {
    // Hair cards, the ears and the tail are flat pieces; so are the apron, tie
    // and ribbon, which all live on the costume sheet. Body and face stay
    // single-sided so the inside of the skull is not drawn.
    doubleSided: /Manuka_hair|Manuka_costume/i,
    // The drawn-effect layer is coplanar with the face and draws after it.
    faceDecal: /Manuka_option/i,
  },

  /**
   * Wardrobe.
   *
   * The fitting mechanism is the same idea as the first avatar's and is written
   * in different words, which is exactly the kind of thing that has to be
   * stated rather than detected. There are no `*Hide` shapes; the body carries
   * a `Shrink_*` family instead, and it works differently — the limb is thinned
   * so the garment sits over it, rather than the covered vertices being
   * collapsed. Only two of that family belong to a garment (`stocking`,
   * `tie`); the rest are body-proportion adjustment, chosen once at build time.
   *
   * The runtime does not care about the difference: both are "shapes this item
   * raises while worn", which is what the `hide` field means.
   *
   * The readme states the base outfit is authored to be worn with the underwear
   * meshes off, so the default preset leaves them off.
   */
  wardrobe: {
    slots: {
      top: {
        label: { en: 'Top', ja: 'トップス' },
        items: [
          { id: 'shirt', label: { en: 'Shirt', ja: 'シャツ' }, meshes: ['Manuka_costume_shirt'] },
        ],
      },
      bottom: {
        label: { en: 'Bottoms', ja: 'ボトムス' },
        items: [
          {
            id: 'shorts',
            label: { en: 'Shorts', ja: 'ショートパンツ' },
            meshes: ['Manuka_costume_shorts'],
          },
        ],
      },
      apron: {
        label: { en: 'Apron', ja: 'エプロン' },
        items: [
          {
            id: 'apron',
            label: { en: 'Apron', ja: 'エプロン' },
            meshes: ['Manuka_costume_apron', 'Manuka_costume_apron_nameplate'],
          },
        ],
      },
      neck: {
        label: { en: 'Neck', ja: '首' },
        items: [
          {
            id: 'tie',
            label: { en: 'Tie', ja: 'タイ' },
            meshes: ['Manuka_costume_tie'],
            hide: ['Shrink_tie (default)'],
          },
        ],
      },
      legs: {
        label: { en: 'Legs', ja: '脚' },
        items: [
          {
            id: 'stocking',
            label: { en: 'Stockings', ja: 'ストッキング' },
            meshes: ['Manuka_underwear_stocking'],
            hide: ['Shrink_stocking (default)'],
          },
        ],
      },
      shoes: {
        label: { en: 'Shoes', ja: '靴' },
        items: [
          { id: 'shoes', label: { en: 'Shoes', ja: '靴' }, meshes: ['Manuka_costume_shoes'] },
        ],
      },
      inner: {
        label: { en: 'Underwear', ja: 'インナー' },
        items: [
          {
            id: 'underwear',
            label: { en: 'Underwear', ja: '下着' },
            meshes: ['Manuka_underwear_bra', 'Manuka_underwear_panty'],
          },
        ],
      },
      hair: {
        label: { en: 'Hair', ja: '髪' },
        items: [
          { id: 'bun', label: { en: 'Bun', ja: 'お団子' }, meshes: ['Manuka_hair_bun'] },
          { id: 'twin', label: { en: 'Twin tails', ja: 'ツイン' }, meshes: ['Manuka_hair_twin'] },
        ],
      },
      ears: {
        label: { en: 'Animal ears', ja: '獣耳' },
        items: [
          {
            id: 'kemono',
            label: { en: 'Ears and tail', ja: '耳と尻尾' },
            meshes: ['Manuka_kemono_ear', 'Manuka_kemono_tail'],
          },
        ],
      },
      accessory: {
        label: { en: 'Accessory', ja: '小物' },
        items: [
          {
            id: 'set',
            label: { en: 'Ribbon, hairpin and bracelet', ja: 'リボン・髪飾り・腕輪' },
            meshes: ['Manuka_hair_ribbon', 'Manuka_hairpin', 'Manuka_costume_bracelet'],
          },
        ],
      },
    },
    presets: {
      default: {
        label: { en: 'Standard', ja: '標準' },
        set: {
          top: 'shirt',
          bottom: 'shorts',
          apron: 'apron',
          neck: 'tie',
          legs: 'stocking',
          shoes: 'shoes',
          inner: null,
          hair: 'bun',
          ears: 'kemono',
          accessory: 'set',
        },
      },
      stream: {
        label: { en: 'On stream', ja: '配信用' },
        set: {
          top: 'shirt',
          bottom: 'shorts',
          apron: null,
          neck: 'tie',
          legs: 'stocking',
          shoes: 'shoes',
          inner: null,
          hair: 'twin',
          ears: 'kemono',
          accessory: 'set',
        },
      },
      roomwear: {
        label: { en: 'At home', ja: '部屋着' },
        set: {
          top: 'shirt',
          bottom: 'shorts',
          apron: null,
          neck: null,
          legs: null,
          shoes: null,
          inner: 'underwear',
          hair: 'bun',
          ears: 'kemono',
          accessory: null,
        },
      },
    },
    note: {
      en:
        'Worn a piece at a time. The stockings and the tie also raise the body’s own ' +
        'Shrink shapes so nothing pokes through — this model narrows the body rather ' +
        'than hiding it.',
      ja:
        'パーツ単位で着脱する。ストッキングとタイは素体側の Shrink シェイプを併用して' +
        '貫通を防ぐ（このモデルは Hide ではなく縮小方式）。',
    },
  },

  /**
   * Secondary motion.
   *
   * Every figure below is the one this model's author set. The package ships a
   * VRM alongside the FBX, the VRM carries a `secondaryAnimation` block, and the
   * fifteen groups and twelve collider groups in it are transcribed here as they
   * stand — stiffness, drag, gravity and hit radius unchanged.
   *
   * Two conversions were needed and neither touches the numbers that describe
   * *motion*. The VRM faces the opposite way from the GLB, so collider positions
   * were carried through world space and rebuilt in the GLB's bones. And four
   * of the author's collider anchors are helper bones the GLB export drops —
   * `Chest_C1`, `Chest_C2`, `Tail_C`, `Apron_ribbon_C` — so those colliders are
   * re-anchored to the nearest bone that survived, which moves what they hang
   * off without moving where they sit.
   *
   * One root was lost outright: the author's "hair side" group also drives
   * `Chest_C1`, and with the bone gone there is nothing to drive. It was a
   * helper, so nothing visible is missing.
   */
  sway: {
    /**
     * Collider sets, named after the part of the body they stand for.
     *
     * Positions are in metres along the anchor bone's own axes. The author gave
     * the arms three spheres apiece rather than a capsule, which is what VRM
     * 0.x supports; they are kept as spheres so the shape is the one that was
     * tuned against.
     */
    colliders: {
      head: [
        { bone: 'Head', offset: [0, 0.0561, 0], radius: 0.075 },
        { bone: 'Head', offset: [0, 0.0475, -0.0007], radius: 0.075 },
      ],
      // `Chest_C1` — the bust, which is what the side hair rests against.
      bust: [{ bone: 'Chest', offset: [0, 0.0689, 0.0478], radius: 0.087 }],
      // `Chest_C2` — the ribcage, one size larger and further back.
      chest: [{ bone: 'Chest', offset: [0, 0.0385, 0.0107], radius: 0.1 }],
      hips: [
        { bone: 'Hips', offset: [-0.03, 0, 0.06], radius: 0.1 },
        { bone: 'Hips', offset: [0.03, 0, 0.06], radius: 0.1 },
      ],
      upperArmL: [
        { bone: 'UpperArm_L', offset: [0, 0, 0], radius: 0.047 },
        { bone: 'UpperArm_L', offset: [0.0015, 0.075, 0], radius: 0.047 },
        { bone: 'UpperArm_L', offset: [0.0029, 0.15, 0], radius: 0.047 },
      ],
      upperArmR: [
        { bone: 'UpperArm_R', offset: [0, 0, 0], radius: 0.047 },
        { bone: 'UpperArm_R', offset: [-0.0015, 0.075, 0], radius: 0.047 },
        { bone: 'UpperArm_R', offset: [-0.0029, 0.15, 0], radius: 0.047 },
      ],
      lowerArmL: [
        { bone: 'LowerArm_L', offset: [0, 0, 0], radius: 0.034 },
        { bone: 'LowerArm_L', offset: [-0.0032, 0.0749, 0.0001], radius: 0.034 },
        { bone: 'LowerArm_L', offset: [-0.0064, 0.1499, 0.0001], radius: 0.034 },
      ],
      lowerArmR: [
        { bone: 'LowerArm_R', offset: [0, 0, 0], radius: 0.034 },
        { bone: 'LowerArm_R', offset: [0.0032, 0.0749, 0.0001], radius: 0.034 },
        { bone: 'LowerArm_R', offset: [0.0064, 0.1499, 0.0001], radius: 0.034 },
      ],
      upperLegL: [
        { bone: 'UpperLeg_L', offset: [0, -0.0006, -0.055], radius: 0.1 },
        { bone: 'UpperLeg_L', offset: [0, 0.0897, -0.0309], radius: 0.1 },
      ],
      upperLegR: [
        { bone: 'UpperLeg_R', offset: [0, -0.0006, -0.055], radius: 0.1 },
        { bone: 'UpperLeg_R', offset: [0, 0.0897, -0.0309], radius: 0.1 },
      ],
      // `Tail_C` — one large sphere behind and below the hips, which is what
      // keeps the tail from sweeping through the backside.
      tailBase: [{ bone: 'Hips', offset: [0, -0.1829, -0.1145], radius: 0.204 }],
      // `Apron_ribbon_C` — the small of the back, for the apron's bow strings.
      apronBack: [
        { bone: 'Hips', offset: [0, 0.0242, 0.0346], radius: 0.1 },
        { bone: 'Hips', offset: [0, -0.0606, 0.0249], radius: 0.1 },
      ],
    },

    groups: [
      // --- hair ---------------------------------------------------------
      {
        id: 'hairFront',
        label: { en: 'Fringe', ja: '前髪' },
        stiffness: 2.31,
        drag: 0.945,
        radius: 0.012,
        roots: [
          'Manuka_hair_front_1',
          'Manuka_hair_front_2',
          'Manuka_hair_front_side_L',
          'Manuka_hair_front_side_R',
        ],
        colliders: ['head'],
      },
      {
        id: 'hairAhoge',
        label: { en: 'Cowlick', ja: 'アホ毛' },
        stiffness: 0.67,
        drag: 0.779,
        radius: 0.004,
        roots: ['Manuka_hair_ahoge'],
      },
      {
        id: 'hairSide',
        label: { en: 'Side hair', ja: 'サイドの髪' },
        stiffness: 0.39,
        drag: 0.831,
        radius: 0.019,
        roots: ['Manuka_hair_side_L', 'Manuka_hair_side_R'],
        colliders: ['head', 'bust', 'upperArmL', 'upperArmR'],
      },
      {
        id: 'hairBun',
        label: { en: 'Buns', ja: 'お団子' },
        stiffness: 1.57,
        drag: 0.926,
        radius: 0.037,
        roots: ['Manuka_hair_bun_L', 'Manuka_hair_bun_R'],
      },
      {
        id: 'hairTwin',
        label: { en: 'Twin tails', ja: 'ツインテール' },
        stiffness: 1.56,
        drag: 0.942,
        gravity: 0.1,
        radius: 0.025,
        roots: ['Manuka_hair_twin_L', 'Manuka_hair_twin_R'],
        colliders: ['head', 'chest', 'upperArmL', 'upperArmR', 'lowerArmL', 'lowerArmR'],
      },
      {
        id: 'hairRibbon',
        label: { en: 'Hair ribbons', ja: '髪リボン' },
        stiffness: 0.59,
        drag: 0.853,
        radius: 0.02,
        roots: [
          'Manuka_hair_ribbon_1_L',
          'Manuka_hair_ribbon_2_L',
          'Manuka_hair_ribbon_3_L',
          'Manuka_hair_ribbon_4_L',
          'Manuka_hair_ribbon_1_R',
          'Manuka_hair_ribbon_2_R',
          'Manuka_hair_ribbon_3_R',
          'Manuka_hair_ribbon_4_R',
        ],
      },

      // --- body ---------------------------------------------------------
      {
        id: 'ear',
        label: { en: 'Animal ears', ja: '獣耳' },
        stiffness: 0.08,
        drag: 0.138,
        radius: 0.02,
        roots: ['Manuka_ear_L', 'Manuka_ear_R'],
      },
      {
        id: 'tail',
        label: { en: 'Tail', ja: '尻尾' },
        stiffness: 0.47,
        drag: 0.286,
        radius: 0.091,
        roots: ['Manuka_tail'],
        colliders: ['tailBase'],
      },
      {
        id: 'breast',
        label: { en: 'Chest', ja: '胸' },
        stiffness: 0.68,
        drag: 0.167,
        radius: 0.02,
        roots: ['Breast_L', 'Breast_R'],
      },
      {
        id: 'butt',
        label: { en: 'Hips', ja: '腰まわり' },
        stiffness: 0.41,
        drag: 0.265,
        radius: 0.048,
        roots: ['Butt_L', 'Butt_R'],
      },

      // --- clothing -----------------------------------------------------
      {
        id: 'shirt',
        label: { en: 'Shirt hem', ja: 'シャツの裾' },
        stiffness: 3.46,
        drag: 0.934,
        radius: 0.02,
        roots: [
          'Manuka_shirt_root_1_L',
          'Manuka_shirt_root_2_L',
          'Manuka_shirt_root_3_L',
          'Manuka_shirt_root_4_L',
          'Manuka_shirt_root_1_R',
          'Manuka_shirt_root_2_R',
          'Manuka_shirt_root_3_R',
          'Manuka_shirt_root_4_R',
        ],
      },
      {
        id: 'apron',
        label: { en: 'Apron', ja: 'エプロン' },
        stiffness: 2.1,
        drag: 0.819,
        radius: 0.028,
        roots: ['Manuka_apron_1_L', 'Manuka_apron_1_R', 'Manuka_apron_2_L', 'Manuka_apron_2_R'],
        colliders: ['hips', 'upperLegL', 'upperLegR'],
      },
      {
        id: 'apronRibbon',
        label: { en: 'Apron strings', ja: 'エプロンの紐' },
        stiffness: 0.41,
        drag: 0.432,
        radius: 0.009,
        roots: [
          'Manuka_apron_ribbon_1_L',
          'Manuka_apron_ribbon_1_R',
          'Manuka_apron_ribbon_2_L',
          'Manuka_apron_ribbon_2_R',
        ],
        colliders: ['apronBack'],
      },
      {
        id: 'nameplate',
        label: { en: 'Name plate', ja: 'ネームプレート' },
        stiffness: 0.8,
        drag: 0.34,
        radius: 0.009,
        roots: ['Manuka_apron_nameplate'],
      },
      {
        id: 'smallRibbon',
        label: { en: 'Small ribbons', ja: '小リボン' },
        stiffness: 0.21,
        drag: 0.905,
        radius: 0.009,
        roots: [
          'Manuka_pants_ribbon_L',
          'Manuka_pants_ribbon_R',
          'Manuka_shoes_ribbon_L',
          'Manuka_shoes_ribbon_R',
        ],
      },
    ],
  },

  /**
   * Actively driven appendages. See `engine/secondary/tail.ts` for why a tail
   * cannot be left to the sway layer alone, and `yoka.ts` for the counterpart
   * block.
   *
   * Held tighter than that avatar's, for two reasons that both come off this
   * model. The tail is shorter — eight joints over about half a metre — and it
   * sits against `Tail_C`, the collider the author placed behind the hips.
   * Calibration lets the tail keep the position it was drawn in but not move
   * any further into that sphere, so a wide sweep spends part of its arc being
   * held by the collider rather than by the spring, and the motion flattens on
   * one side. Staying inside the clearance keeps the arc symmetrical.
   */
  drive: {
    tail: { group: 'tail', swing: 0.36, lift: 0.24 },
  },

  script: [
    {
      emotion: { joy: 0.55, relaxed: 0.45 },
      gesture: 'wave',
      text: 'こんばんは、マヌカです。今日はよろしくね。',
    },
    {
      emotion: { relaxed: 0.8 },
      gesture: 'explain',
      text: 'わたしはARKitのブレンドシェイプを持っていません。',
    },
    {
      emotion: { thinking: 0.9 },
      gesture: 'think',
      text: 'だから表情は、目と眉と口を別々に組み合わせて作っています。',
    },
    { emotion: { surprise: 0.85 }, gesture: 'pointUp', text: 'あっ、それでもちゃんと笑えますよ。' },
    { emotion: { joy: 0.9 }, gesture: 'present', text: 'ほら、こんなふうに。' },
    { emotion: { shy: 0.7 }, gesture: 'cover', text: '……あんまり見られると照れます。' },
    {
      emotion: { joy: 0.4, relaxed: 0.6 },
      gesture: 'bow',
      text: 'というわけで、今日はここまで。またね。',
    },
  ],
} satisfies AvatarDescriptor;
