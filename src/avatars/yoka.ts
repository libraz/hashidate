/**
 * Avatar data — 旅枕ヨカ.
 *
 * Everything in this file is a property of this particular model: what its
 * author called things, how its garments are built, how far its eyes can turn.
 * The engine reads it through the profile and never names any of it directly.
 *
 * See `engine/types.ts` for the shape of a descriptor and what each field means.
 */

import type { AvatarDescriptor } from '../engine/types';

export default {
  id: 'yoka',
  label: '旅枕ヨカ',
  author: 'コトブキヤ',
  url: '/models/yoka.glb',

  // Shape groups are delimited by dummy shapes named ___GROUP___.
  separator: /^_{2,}(.+?)_{2,}$/,

  /**
   * How far the gaze chain may turn, in radians.
   *
   * The eye figures are the ones that matter, and they are far tighter than an
   * anatomical range. A toon eye is a painted plane behind an opening cut in
   * the face, and on a design where the iris nearly fills that opening there is
   * almost no travel before sclera appears on one side. Measured by sweeping
   * the eye bone against a front-on shot: yaw stays clean to about 0.07 rad and
   * shows a white crescent by 0.09; pitch is tighter still, clean to about 0.05
   * and visibly broken by 0.06 — the opening is shorter vertically than it is
   * wide.
   *
   * Head and neck limits keep camera tracking from wringing the neck when the
   * shot is off-axis; the body simply stops following past them.
   */
  gaze: {
    eyeYaw: 0.07,
    eyePitch: 0.05,
    headYaw: 0.5,
    headPitch: 0.32,
    neckYaw: 0.3,
    neckPitch: 0.22,
  },

  // ARKit 51/52, named exactly as the standard has them, so the engine's own
  // candidate lists resolve everything and nothing has to be stated here.
  shapes: {},

  /**
   * The finished faces the author drew and ships with the model, the ones
   * printed on the product page.
   *
   * They are not redundant with the ARKit composition. An authored face swaps
   * the iris for a spiral, replaces the pupil with a dot, puts the mouth in a
   * shape no combination of muscle-level weights reaches. None of that can be
   * synthesised, so the engine has to be able to fire the authored shape
   * directly.
   *
   * `emotion` is what lets the semantic API benefit from them: `setEmotion({
   * joy: 1 })` resolves to a drawn face on an avatar that has one and falls
   * back to the composition on one that does not. Which drawing suits which
   * emotion is a judgement about these particular drawings, so it lives here.
   */
  presets: {
    group: 'YOKA',
    label: (id: string) => id.replace(/^F_/, '').replace(/_/g, ' '),
    emotion: {
      joy: 'F_NIKONIKO',
      anger: 'F_PUNPUN',
      sadness: 'F_IYAIYA',
      surprise: 'F_PAH',
      relaxed: 'F_HOWAWA',
      thinking: 'F_FUMUFUMU',
      shy: 'F_TERETERE',
    },
  },

  // ARKit is supported, so no composition in the avatar's own vocabulary is
  // needed. See `manuka.ts` for the other case.
  emotionShapes: null,

  // Additive drawn effects layered over whatever face is showing. This avatar
  // ships its equivalents inside the finished faces above, so there is no
  // separate overlay group.
  overlays: null,

  /**
   * Material fixups, matched by name.
   *
   * `doubleSided` — lilToon materials declare their own culling, none of which
   * survives FBX, so the exporter marks everything double-sided. A closed
   * avatar wants FrontSide everywhere except genuinely flat pieces.
   *
   * `faceDecal` — coplanar overlays on the face: lashes, brows, highlights.
   * They genuinely need blending and have to draw after the head.
   */
  materials: {
    doubleSided: /doubleS|Wig_alpha|lantern|Ribbon|Skirt/i,
    faceDecal: /Face_alpha|_eyeline|_eyelash|highlight/i,
  },

  /**
   * Wardrobe.
   *
   * Which meshes make up a garment, and which body parts have to be hidden so
   * they do not poke through it. The hide mechanism is the VRChat convention:
   * the body carries a `*Hide` blendshape per region (neck, bust, thigh, shin,
   * …) that collapses those vertices, and each outfit declares the set it
   * needs.
   */
  wardrobe: {
    slots: {
      outer: {
        label: 'アウター',
        items: [{ id: 'cardigan', label: 'カーディガン', meshes: ['Outer'] }],
      },
      top: {
        label: 'トップス',
        items: [{ id: 'camisole', label: 'キャミソール', meshes: ['Tops'] }],
      },
      bottom: {
        label: 'ボトムス',
        items: [
          { id: 'short', label: 'ショートパンツ', meshes: ['Bottoms'] },
          {
            id: 'long',
            label: 'ロングパンツ',
            meshes: ['Bottoms_Long'],
            // Covers the legs entirely, so the leg mesh underneath is collapsed.
            hide: [
              'upperthighHide_LT',
              'upperthighHide_RT',
              'lowerthighHide_LT',
              'lowerthighHide_RT',
              'kneeHide_LT',
              'kneeHide_RT',
              'shinHide_LT',
              'shinHide_RT',
            ],
          },
        ],
      },
      inner: {
        label: 'インナー',
        items: [{ id: 'lingerie', label: '下着', meshes: ['Lingerie'] }],
      },
      shoes: {
        label: '靴',
        items: [{ id: 'slippers', label: 'スリッパ', meshes: ['Slippers'] }],
      },
      head: {
        label: '頭',
        items: [{ id: 'eyemask', label: 'アイマスク', meshes: ['Eyemask'] }],
      },
      neck: {
        label: '首',
        items: [{ id: 'choker', label: 'チョーカー', meshes: ['Choker'] }],
      },
      prop: {
        label: '小物',
        items: [{ id: 'pillow', label: '枕', meshes: ['Pillow'] }],
      },
    },
    presets: {
      default: {
        label: '標準',
        set: {
          outer: 'cardigan',
          top: 'camisole',
          bottom: 'short',
          inner: 'lingerie',
          shoes: 'slippers',
          head: 'eyemask',
          neck: 'choker',
          prop: null,
        },
      },
      stream: {
        label: '配信用',
        set: {
          outer: 'cardigan',
          top: 'camisole',
          bottom: 'long',
          inner: 'lingerie',
          shoes: 'slippers',
          head: null,
          neck: 'choker',
          prop: null,
        },
      },
      roomwear: {
        label: '部屋着',
        set: {
          outer: null,
          top: 'camisole',
          bottom: 'short',
          inner: 'lingerie',
          shoes: null,
          head: 'eyemask',
          neck: 'choker',
          prop: 'pillow',
        },
      },
    },
    note: 'パーツ単位で着脱する。ロングパンツは脚のHideシェイプを併用して素体の貫通を防ぐ。',
  },

  /**
   * Secondary motion.
   *
   * The counterpart to マヌカ's block, and the reason it is worth comparing the
   * two. That avatar ships a VRM, the VRM carries the author's spring settings,
   * and every figure there is transcribed. This one ships no VRM. Its sway is
   * authored as VRChat `PhysBone` and Unity `DynamicBone` components, both of
   * which live on prefabs rather than on the mesh, and neither of which survives
   * an FBX — the bones arrive, the numbers do not.
   *
   * So the chains below are read off the rig and are exact; the numbers are
   * chosen by eye against how each part hangs, and are the one thing here that
   * is a judgement rather than a measurement. They are written in the same terms
   * as the other avatar's so the two can be compared directly: a long back
   * strand is heavier and slower than a fringe, a hem is stiff and barely moves,
   * a ribbon is light and keeps swinging after the body has stopped.
   *
   * Collider positions are measured off this model's own bones — head radius
   * from where the side hair is rooted, trunk half-width from the shoulder,
   * limb lengths from the joints — and are given in metres along each anchor
   * bone's axes.
   */
  sway: {
    colliders: {
      head: [{ bone: 'Head', offset: [0, 0.075, 0.005], radius: 0.078 }],
      // Capsules along each bone. `Y` is the direction the bone runs in on this
      // rig, which is why an arm capsule and a leg capsule are written the same
      // way despite pointing opposite ways in the world.
      chest: [{ bone: 'Chest', offset: [0, 0.02, 0], tail: [0, -0.12, 0], radius: 0.068 }],
      hips: [{ bone: 'Hips', offset: [0, 0.02, 0], tail: [0, -0.09, 0], radius: 0.085 }],
      upperArmL: [{ bone: 'UpperArm_L', offset: [0, 0.02, 0], tail: [0, 0.16, 0], radius: 0.042 }],
      upperArmR: [{ bone: 'UpperArm_R', offset: [0, 0.02, 0], tail: [0, 0.16, 0], radius: 0.042 }],
      lowerArmL: [{ bone: 'LowerArm_L', offset: [0, 0, 0], tail: [0, 0.15, 0], radius: 0.033 }],
      lowerArmR: [{ bone: 'LowerArm_R', offset: [0, 0, 0], tail: [0, 0.15, 0], radius: 0.033 }],
      upperLegL: [{ bone: 'UpperLeg_L', offset: [0, 0, 0], tail: [0, 0.26, 0], radius: 0.055 }],
      upperLegR: [{ bone: 'UpperLeg_R', offset: [0, 0, 0], tail: [0, 0.26, 0], radius: 0.055 }],
      lowerLegL: [{ bone: 'LowerLeg_L', offset: [0, 0, 0], tail: [0, 0.25, 0], radius: 0.04 }],
      lowerLegR: [{ bone: 'LowerLeg_R', offset: [0, 0, 0], tail: [0, 0.25, 0], radius: 0.04 }],
    },

    groups: [
      // --- hair ---------------------------------------------------------
      //
      // All of it hangs off `Hair_root` under the head, in seventeen separate
      // strands. Grouped by family rather than driven as one, because a fringe
      // and a waist-length back strand behave nothing alike and the difference
      // is most of what makes hair read as hair.
      {
        id: 'hairFront',
        label: '前髪',
        stiffness: 2.2,
        drag: 0.94,
        radius: 0.012,
        roots: ['Hair_front_C_001', 'Hair_front_L_001', 'Hair_front_R_001'],
        colliders: ['head'],
      },
      {
        id: 'hairAhoge',
        label: 'アホ毛',
        stiffness: 0.7,
        drag: 0.8,
        radius: 0.006,
        roots: ['Hair_front_ahoge_001'],
      },
      {
        id: 'hairSide',
        label: 'サイドの髪',
        stiffness: 0.95,
        drag: 0.9,
        gravity: 0.05,
        radius: 0.018,
        roots: ['Hair_side_A_L_001', 'Hair_side_B_L_001', 'Hair_side_A_R_001', 'Hair_side_B_R_001'],
        colliders: ['head'],
      },
      {
        id: 'hairSideUp',
        label: 'サイドの結び',
        stiffness: 1.4,
        drag: 0.92,
        radius: 0.015,
        roots: ['Hair_sideup_L_001', 'Hair_sideup_R_001'],
        colliders: ['head'],
      },
      // Nine joints each and the longest strands on the model, so they carry
      // the most inertia and the only meaningful gravity in the hair.
      {
        id: 'hairBack',
        label: '後ろ髪',
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
        colliders: ['head', 'chest', 'upperArmL', 'upperArmR'],
      },

      // --- body ---------------------------------------------------------
      {
        id: 'ear',
        label: '耳',
        stiffness: 0.45,
        drag: 0.45,
        radius: 0.014,
        roots: ['Ear_L_001', 'Ear_R_001'],
      },
      {
        id: 'tail',
        label: '尻尾',
        stiffness: 0.6,
        drag: 0.35,
        radius: 0.035,
        roots: ['Tail_001'],
      },
      {
        id: 'breast',
        label: '胸',
        stiffness: 0.7,
        drag: 0.18,
        radius: 0.02,
        roots: ['Breast_L', 'Breast_R'],
      },

      // --- clothing -----------------------------------------------------
      //
      // Each of these is a hub bone carrying sixteen or twenty short strands,
      // so the descriptor names the hub and the strands come off the rig.
      {
        id: 'topsFrill',
        label: 'トップスのフリル',
        stiffness: 3.0,
        drag: 0.93,
        gravity: 0.1,
        radius: 0.012,
        childrenOf: ['Tops_frill'],
        colliders: ['chest', 'hips'],
      },
      {
        id: 'outerHem',
        label: 'アウターの裾',
        stiffness: 2.6,
        drag: 0.92,
        gravity: 0.15,
        radius: 0.015,
        childrenOf: ['Outer_hem'],
        colliders: ['hips', 'upperLegL', 'upperLegR'],
      },
      {
        id: 'bottomsHem',
        label: 'ロングパンツの裾',
        stiffness: 2.4,
        drag: 0.92,
        gravity: 0.1,
        radius: 0.012,
        childrenOf: ['Bottoms_Long_hem_L', 'Bottoms_Long_hem_R'],
        colliders: ['lowerLegL', 'lowerLegR'],
      },

      // --- ribbons ------------------------------------------------------
      //
      // Light and floppy, and the part most visible in a bust framing: they are
      // still moving a second after the body has settled, which is the cue that
      // sells a shot as live rather than as a still.
      {
        id: 'ribbonChest',
        label: '胸元のリボン',
        stiffness: 0.55,
        drag: 0.86,
        gravity: 0.05,
        radius: 0.008,
        childrenOf: ['Ribbon_chest'],
        colliders: ['chest'],
      },
      {
        id: 'ribbonBreast',
        label: '肩のリボン',
        stiffness: 0.55,
        drag: 0.86,
        gravity: 0.05,
        radius: 0.008,
        childrenOf: ['Ribbon_Breast'],
        colliders: ['chest'],
      },
      {
        id: 'ribbonHips',
        label: '腰のリボン',
        stiffness: 0.5,
        drag: 0.87,
        gravity: 0.08,
        radius: 0.008,
        childrenOf: ['Ribbon_Hips'],
        colliders: ['hips', 'upperLegL', 'upperLegR'],
      },
      {
        id: 'ribbonSide',
        label: '腿のリボン',
        stiffness: 0.5,
        drag: 0.87,
        gravity: 0.08,
        radius: 0.008,
        childrenOf: ['Ribbon_side_L', 'Ribbon_side_R'],
        colliders: ['upperLegL', 'upperLegR'],
      },
      {
        id: 'ribbonShin',
        label: '脚のリボン',
        stiffness: 0.5,
        drag: 0.87,
        gravity: 0.08,
        radius: 0.008,
        childrenOf: ['Ribbon_shin_L', 'Ribbon_shin2_L', 'Ribbon_shin_R'],
        colliders: ['lowerLegL', 'lowerLegR'],
      },
      {
        id: 'ribbonWrist',
        label: '手首のリボン',
        stiffness: 0.45,
        drag: 0.86,
        gravity: 0.06,
        radius: 0.008,
        childrenOf: ['Ribbon_wrist'],
      },

      // --- props --------------------------------------------------------
      // The bonus pillow, which arrives as its own FBX with its own bones and is
      // grafted onto the skeleton at build time. Heavy and slow, and it carries
      // its own ribbon.
      {
        id: 'pillow',
        label: '枕',
        stiffness: 0.9,
        drag: 0.45,
        gravity: 0.1,
        radius: 0.045,
        childrenOf: ['Pillow'],
      },
    ],
  },

  /**
   * Actively driven appendages.
   *
   * The tail is in the sway block above and is simulated correctly there, and
   * that is not enough — see the note at the top of `engine/secondary/tail.ts`
   * for why a chain hanging off the hips gets no input worth the name. This
   * states how far it may be posed; the axes are measured off the rig.
   *
   * `Tail_001` to `Tail_010` runs 0.69 m, which is long enough to reach the
   * back of the knee, so the angles at the base are deliberately smaller than
   * they would be for a short tail: 0.45 rad here already sweeps the tip
   * through most of the character's width, and anything wider reads as the tail
   * being thrown rather than wagged.
   */
  drive: {
    tail: { group: 'tail', swing: 0.45, lift: 0.3 },
  },

  /**
   * Demo script — one entry per turn, in order.
   *
   * There are no timestamps. There used to be, and they were a hand-maintained
   * copy of how long each line takes to say: edit a line and every cue after it
   * drifts. The session queues turns and starts each one when the previous
   * mouth finishes, which is the same thing an orchestrator needs.
   */
  script: [
    {
      emotion: { joy: 0.55, relaxed: 0.45 },
      gesture: 'wave',
      text: 'こんばんは、ヨカです。今日も来てくれてありがとう。',
    },
    {
      emotion: { relaxed: 0.8 },
      gesture: 'explain',
      text: '今日はアバターを動かす仕組みの話をしようと思います。',
    },
    { emotion: { thinking: 0.9 }, gesture: 'think', text: 'えーっと、どこから話そうかな。' },
    {
      emotion: { surprise: 0.85 },
      gesture: 'pointUp',
      text: 'あっ、そうだ。表情のつくりかたから！',
    },
    {
      emotion: { joy: 0.9 },
      gesture: 'present',
      expression: 'F_NIKONIKO',
      text: 'こんなふうに、いろんな表情が出せるんです。',
    },
    {
      emotion: { shy: 0.7 },
      gesture: 'cover',
      expression: 'F_TERETERE',
      text: '……ちょっと恥ずかしいですけどね。',
    },
    {
      emotion: { joy: 0.4, relaxed: 0.6 },
      gesture: 'bow',
      text: 'というわけで、今日はここまで。またね。',
    },
  ],
} satisfies AvatarDescriptor;
