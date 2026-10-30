import * as THREE from 'three';
import { core } from '@/core';
import { ArmAnatomy } from '@/engine/anatomy';
import { FaceSurface } from '@/engine/anatomy/face';
import { Autopilot } from '@/engine/autopilot';
import { Director } from '@/engine/director';
import type { PointCommand } from '@/engine/motion';
import { ArmTransaction } from '@/engine/motion/arm-transaction';
import { CharacterFrame } from '@/engine/motion/frame';
import { PERFORMANCE_IDS } from '@/engine/performance';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { AvatarDescriptor, FingerName, FingerSpec, Profile, Side } from '@/engine/types';
import { FINGER_NAMES } from '@/engine/types';
import { withSide } from '@/server/side';
import { type HashSink, makeFnv64, writeDirectorFrame } from '../../tools/parity/hash';
import { coreMathCalls, withCoreMath } from './core-math';
import { must } from './must';
import { addBoneChain, buildRig, interposeBone, type SyntheticRig } from './scene';

/**
 * Deterministic avatars and scripts for the director's golden, and the run that hashes them.
 *
 * The avatar varies along six independent parameters. Their pairs were covered with coverwise's
 * `pairwise_generate` (seed 7, strength 2): the model below has 70 value pairs, all covered by
 * the ten rows V1–V10, used as generated. V0 is the base variant the single-avatar scripts use.
 *
 *     legs: true false | twists: true false | naming: vrchat unity vrm
 *     scale: 1 0.01 | fingerHelpers: true false | ancestor: none wrapper
 *
 * Scripts (a)–(d) are the design's; (e) adds the limiter switched off and (f) the paths the
 * others leave unrun. Every number a step applies is computed at module load with the host's `Math`.
 * The run puts construction, `update`, the full world update and `Skeleton.update` under
 * `withCoreMath`, so only the engine sees the fixed transcendentals. No step changes the
 * hierarchy.
 *
 * The `calls` hash folds every boundary call (see `BOUNDARY`) into one FNV-1a 64 per fixture:
 * the method, its arguments and result after the call, then every node's position, quaternion,
 * scale, matrixWorld and matrixWorldNeedsUpdate as they stand, with no update.
 */

export interface Variant {
  id: string;
  legs: boolean;
  twists: boolean;
  naming: 'vrchat' | 'unity' | 'vrm';
  scale: number;
  fingerHelpers: boolean;
  ancestor: 'none' | 'wrapper';
  /**
   * Build-time shapes outside the pairwise model, for group (f): no finger chains (so neither
   * arm builds a constrained driver), straight rest legs (no authored knee bend), and carriers
   * (a plain group above the hips and bones interposed above the right forearm and hand).
   */
  extra?: 'noFingers' | 'straightLegs' | 'carriers';
}

const row = (
  id: string,
  legs: boolean,
  twists: boolean,
  naming: Variant['naming'],
  scale: number,
  fingerHelpers: boolean,
  ancestor: Variant['ancestor'],
): Variant => ({ id, legs, twists, naming, scale, fingerHelpers, ancestor });

export const BASE_VARIANT = row('V0', true, true, 'vrchat', 1, true, 'none');

// biome-ignore format: one generated row per line
export const VARIANTS: readonly Variant[] = [
  BASE_VARIANT,
  row('V1', true, true, 'vrm', 0.01, true, 'wrapper'),
  row('V2', false, true, 'vrchat', 1, false, 'none'),
  row('V3', true, false, 'unity', 0.01, false, 'none'),
  row('V4', false, true, 'unity', 0.01, true, 'none'),
  row('V5', true, false, 'vrchat', 0.01, false, 'wrapper'),
  row('V6', false, false, 'vrm', 1, true, 'wrapper'),
  row('V7', true, true, 'unity', 1, false, 'wrapper'),
  row('V8', false, true, 'vrm', 1, true, 'none'),
  row('V9', true, false, 'vrm', 0.01, false, 'wrapper'),
  row('V10', false, false, 'vrchat', 1, true, 'none'),
];

/** Shared with stage 1's corpora and the spring fixtures. */
const SEED = 0x6861_7368_6964_6174n;
const MASK = (1n << 64n) - 1n;

/** Draws in [0, 1) from splitmix64. */
export function splitmix64(seed: bigint = SEED): () => number {
  let state = seed;
  return () => {
    state = (state + 0x9e37_79b9_7f4a_7c15n) & MASK;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK;
    z ^= z >> 31n;
    return Number(z >> 11n) / 2 ** 53;
  };
}

/** A transform for the ancestor wrapper, as components. */
interface WrapperPose {
  position: readonly [number, number, number];
  quaternion: readonly [number, number, number, number];
  scale: number;
}

function wrapperPose(
  position: [number, number, number],
  axis: [number, number, number],
  angle: number,
  scale: number,
): WrapperPose {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), angle);
  return { position, quaternion: [q.x, q.y, q.z, q.w], scale };
}

/** Where the wrapper starts, and where script (d) moves it without an update. */
const WRAPPER_REST = wrapperPose([0.35, -0.12, 0.4], [0.2, 1, 0.1], 0.6, 1.2);
const WRAPPER_MOVES: Record<number, WrapperPose> = {
  200: wrapperPose([-0.2, 0.05, 0.1], [0.1, 1, -0.3], -0.45, 0.9),
  400: wrapperPose([0.1, 0.2, -0.3], [-0.4, 1, 0.2], 1.1, 1.35),
};

const HEAD: Record<Variant['naming'], string> = {
  vrchat: 'Head',
  unity: 'Head',
  vrm: 'J_Bip_C_Head',
};

/** A built variant: the synthetic rig, its optional wrapper, and the descriptor with its sway. */
export interface DirectorAvatar {
  rig: SyntheticRig;
  root: THREE.Object3D;
  wrapper: THREE.Group | null;
  descriptor: AvatarDescriptor;
}

/**
 * Build a variant. Every variant carries one hair chain under the head with a sway group, so
 * the sway solver's state in each frame is a real one.
 */
export function buildDirectorAvatar(variant: Variant): DirectorAvatar {
  const rig = buildRig({
    legs: variant.legs,
    naming: variant.naming,
    armatureScale: variant.scale,
    ...(variant.twists ? { armTwistHelpers: 'twist' as const } : {}),
    ...(variant.fingerHelpers ? { fingerHelpers: 'after' as const } : {}),
    ...(variant.extra === 'noFingers' ? { fingers: false } : {}),
  });
  const bone = (name: string) => must(rig.bones.get(name), name);
  if (variant.extra && variant.naming !== 'vrchat') throw new Error('extras name vrchat bones');
  if (variant.extra === 'straightLegs') {
    // As `tests/rig/legs-soft.test.ts` straightens them: knee and ankle on the hip's line.
    for (const side of ['L', 'R']) {
      bone(`LowerLeg_${side}`).position.z = 0;
      bone(`Foot_${side}`).position.z = 0;
    }
    rig.root.updateMatrixWorld(true);
  }
  if (variant.extra === 'carriers') {
    const carrier = new THREE.Group();
    carrier.name = 'HipsCarrier';
    rig.root.add(carrier);
    carrier.attach(bone('Hips'));
    // As `tests/rig/arm-legacy-chain.test.ts` interposes them.
    interposeBone(rig, 'LowerArm_R', 'ElbowCarrier_R', [0.31, -0.42, 0.57]);
    interposeBone(rig, 'Hand_R', 'WristCarrier_R', [-0.27, 0.36, 0.19], 0.4);
  }
  addBoneChain(rig, {
    parent: HEAD[variant.naming],
    root: 'Hair',
    joints: 3,
    rootOffset: [0.02, 0.05, -0.06],
    segmentOffset: [0, -0.07, -0.03],
  });
  const descriptor: AvatarDescriptor = {
    ...rig.descriptor,
    sway: {
      groups: [{ id: 'hair', roots: ['Hair'], stiffness: 1.2, drag: 0.5, gravity: 0.1 }],
      colliders: {},
    },
  };
  let wrapper: THREE.Group | null = null;
  if (variant.ancestor === 'wrapper') {
    wrapper = new THREE.Group();
    wrapper.name = 'Wrapper';
    placeWrapper(wrapper, WRAPPER_REST);
    wrapper.add(rig.root);
    wrapper.updateMatrixWorld(true);
  }
  return { rig, root: rig.root, wrapper, descriptor };
}

function placeWrapper(wrapper: THREE.Object3D, pose: WrapperPose): void {
  wrapper.position.set(...pose.position);
  wrapper.quaternion.set(...pose.quaternion);
  wrapper.scale.setScalar(pose.scale);
}

/** One command a step gives the director before its update. */
export type Action =
  | { perform: string }
  | { gesture: string; side?: Side }
  | { point: Side; spec: PointCommand }
  | { hop: string }
  | { limits: boolean }
  /** `rig.aimArm` with `ARM_EDIT`'s other links, as an outside caller edits an arm. */
  | { aim: Side; upperArm: readonly [number, number, number] }
  | { curl: FingerName; side: Side; amount: number }
  | { hand: Side; curls: FingerSpec }
  /** `rig.measure`, the joint readout the panel shows. */
  | { measure: Side };

export interface Step {
  dt: number;
  actions?: readonly Action[];
  /** Where the gaze is aimed from this step on, as the viewer's camera moves; defaults to `CAMERA`. */
  camera?: readonly [number, number, number];
  /** Moves the ancestor wrapper, with no world update. */
  wrapper?: WrapperPose;
}

export interface DirectorFixture {
  id: string;
  variant: Variant;
  /** Engage the autopilot and play its choices, drawn from their own splitmix64 stream. */
  idle: boolean;
  steps: readonly Step[];
}

const STEP = 1 / 60;
/** The step the viewer caps a slow frame at. */
const CAPPED = 0.05;

type DtSeries = 'steady' | 'capped';

function dtAt(series: DtSeries, frame: number): number {
  return series === 'capped' && frame % 10 === 9 ? CAPPED : STEP;
}

function steps(
  frames: number,
  series: DtSeries,
  at: (frame: number) => Omit<Step, 'dt'> = () => ({}),
): Step[] {
  return Array.from({ length: frames }, (_, frame) => ({ dt: dtAt(series, frame), ...at(frame) }));
}

/** (a) Each performance on its own, from a fresh base avatar. */
const PERFORMANCE_FIXTURES: DirectorFixture[] = PERFORMANCE_IDS.map((id) => ({
  id: `a ${id}`,
  variant: BASE_VARIANT,
  idle: false,
  steps: steps(120, 'steady', (frame) => (frame === 0 ? { actions: [{ perform: id }] } : {})),
}));

const SERIES: readonly DtSeries[] = ['steady', 'capped'];

/** (b) The idle autopilot on every variant. */
const IDLE_FIXTURES: DirectorFixture[] = VARIANTS.flatMap((variant) =>
  SERIES.map((series) => ({
    id: `b ${variant.id} ${series}`,
    variant,
    idle: true,
    steps: steps(600, series),
  })),
);

/** (c) Reach, point, clasp, leap and spin in turn, on the base avatar. */
const SWITCHES: Record<number, Action> = {
  0: { gesture: 'chin', side: 'R' },
  120: { point: 'R', spec: { azimuth: 35, elevation: 15, extent: 0.85 } },
  240: { gesture: 'handsClasp', side: 'L' },
  360: { hop: 'leap' },
  480: { hop: 'spin' },
};

const SWITCH_FIXTURES: DirectorFixture[] = SERIES.map((series) => ({
  id: `c switches ${series}`,
  variant: BASE_VARIANT,
  idle: false,
  steps: steps(600, series, (frame) => {
    const action = SWITCHES[frame];
    return action ? { actions: [action] } : {};
  }),
}));

/** (d) The wrapper moved every 200 frames with no update, under the idle, on each variant that has one. */
const ANCESTOR_FIXTURES: DirectorFixture[] = VARIANTS.filter((v) => v.ancestor === 'wrapper').map(
  (variant) => ({
    id: `d ${variant.id} wrapper`,
    variant,
    idle: true,
    steps: steps(600, 'steady', (frame) => {
      const wrapper = WRAPPER_MOVES[frame];
      return wrapper ? { wrapper } : {};
    }),
  }),
);

/** (e)'s commands: the limiter off, performances that spend a roll past the forearm's stop, then on again. */
const UNLIMITED: Record<number, readonly Action[]> = {
  0: [{ limits: false }, { perform: 'explain' }],
  120: [{ perform: 'catPaw' }],
  240: [{ point: 'L', spec: { azimuth: -40, elevation: 25, extent: 0.9 } }],
  360: [{ perform: 'selfHug' }],
  480: [{ limits: true }, { perform: 'bravo' }],
};

/**
 * (e) The anatomical limits off, then back on. The legacy arm chain runs only with the
 * constrained solver off, and no other script turns it off.
 */
const LIMITS_FIXTURE: DirectorFixture = {
  id: 'e limits off',
  variant: BASE_VARIANT,
  idle: false,
  steps: steps(600, 'steady', (frame) => {
    const actions = UNLIMITED[frame];
    return actions ? { actions } : {};
  }),
};

/** A group (f) variant: the base avatar with one build-time extra. */
const extraVariant = (extra: Variant['extra'], overrides: Partial<Variant> = {}): Variant => ({
  ...BASE_VARIANT,
  id: `V0 ${extra}`,
  extra,
  ...overrides,
});

/** 300 steady frames of `at`'s commands, with the joint readout taken every 30 frames. */
function measured(
  at: Record<number, readonly Action[]>,
  dt: (frame: number) => number = () => STEP,
): Step[] {
  return Array.from({ length: 300 }, (_, frame) => {
    const actions = [...(at[frame] ?? [])];
    if (frame % 30 === 15) actions.push({ measure: frame % 60 === 15 ? 'L' : 'R' });
    return { dt: dt(frame), ...(actions.length ? { actions } : {}) };
  });
}

/** The gaze target swinging across and over the face, as a moving camera carries it. */
const swingingCamera = (frame: number): [number, number, number] => [
  Math.sin(frame * 0.35) * 2.5,
  1.35 + Math.cos(frame * 0.21) * 0.8,
  1.2,
];

/** Rapid switches between contact gestures, every 10 frames. */
const CONTACT_SWITCHES = ['cover', 'heartHands', 'faceFrame', 'cheekPoke', 'selfHug', 'listen'];

/**
 * (f) Paths (a)–(e) leave unrun, each driven through the public API on the synthetic avatar:
 * outside edits of an arm (`rig.aimArm`, `curlFinger`, `curlHand`, an invalid aim, edits with
 * the limiter off and its re-enable), the joint readout, the legacy chain with the limits on
 * (no fingers, so no constrained driver), carriers in the chain, straight rest legs, finger
 * clearance on the legacy chain, and arm recovery under fast contact switches and a moving gaze.
 */
const PATH_FIXTURES: DirectorFixture[] = [
  {
    id: 'f outside edits',
    variant: BASE_VARIANT,
    idle: false,
    steps: measured({
      10: [{ aim: 'R', upperArm: [Number.NaN, 0.2, 0.9] }],
      20: [{ aim: 'R', upperArm: [0.38, -0.79, 0.48] }],
      30: [{ curl: 'index', side: 'R', amount: 0.7 }],
      40: [{ hand: 'L', curls: { thumb: 0.3, index: 0.8 } }],
      100: [{ limits: false }],
      110: [
        { aim: 'L', upperArm: [-0.42, -0.79, 0.44] },
        { curl: 'middle', side: 'L', amount: 0.5 },
        { hand: 'R', curls: { ring: 0.9 } },
      ],
      150: [{ gesture: 'blowKiss', side: 'R' }],
      200: [{ limits: true }],
      210: [{ aim: 'L', upperArm: [-0.4, -0.7, 0.5] }],
      // Pointing along stated directions rather than a bearing, with and without a palm.
      240: [{ point: 'R', spec: { point: [0.3, 0.1, 0.95], palm: [0, -1, 0.2], extent: 0.8 } }],
      270: [{ point: 'L', spec: { point: [-0.2, 0.2, 0.9], extent: 0.85 } }],
    }),
  },
  {
    id: 'f no fingers',
    variant: extraVariant('noFingers', { fingerHelpers: false }),
    idle: false,
    steps: measured({
      0: [{ gesture: 'chin', side: 'R' }],
      100: [{ perform: 'selfHug' }],
      160: [{ point: 'L', spec: { azimuth: -40, elevation: 25, extent: 0.9 } }],
      220: [{ perform: 'explain' }],
    }),
  },
  {
    id: 'f carriers',
    variant: extraVariant('carriers'),
    idle: false,
    steps: measured({
      0: [{ gesture: 'chin', side: 'R' }],
      100: [{ perform: 'bravo' }],
      200: [{ hop: 'leap' }],
    }),
  },
  {
    id: 'f straight legs',
    variant: extraVariant('straightLegs'),
    idle: false,
    steps: measured({ 0: [{ hop: 'leap' }], 100: [{ hop: 'spin' }], 200: [{ perform: 'twirl' }] }),
  },
  {
    id: 'f legacy face contact',
    variant: BASE_VARIANT,
    idle: false,
    steps: measured({
      0: [{ limits: false }, { gesture: 'blowKiss', side: 'R' }],
      100: [
        { gesture: 'cheekPoke', side: 'L' },
        { curl: 'index', side: 'L', amount: 0.4 },
      ],
      200: [{ gesture: 'cover', side: 'R' }],
    }),
  },
  {
    id: 'f contact switches capped',
    variant: BASE_VARIANT,
    idle: false,
    steps: measured(
      Object.fromEntries(
        Array.from({ length: 30 }, (_, k): [number, Action[]] => [
          k * 10,
          [{ gesture: CONTACT_SWITCHES[k % CONTACT_SWITCHES.length], side: k % 2 ? 'L' : 'R' }],
        ]),
      ),
      () => CAPPED,
    ),
  },
  {
    id: 'f moving gaze',
    variant: BASE_VARIANT,
    idle: false,
    steps: measured({
      0: [{ gesture: 'chin', side: 'R' }],
      100: [{ hop: 'spin' }],
      200: [{ gesture: 'cheekPeace', side: 'L' }],
    }).map((step, frame) => ({ ...step, camera: swingingCamera(frame) })),
  },
];

export const DIRECTOR_FIXTURES: readonly DirectorFixture[] = [
  ...PERFORMANCE_FIXTURES,
  ...IDLE_FIXTURES,
  ...SWITCH_FIXTURES,
  ...ANCESTOR_FIXTURES,
  LIMITS_FIXTURE,
  ...PATH_FIXTURES,
];

// --- the boundary's field table ----------------------------------------------

/** Writes one value; throws on a value the table does not describe. */
type Schema = (out: HashSink, value: unknown, at: string) => void;

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  return (value as object).constructor?.name ?? 'object';
}

function fail(at: string, expected: string, value: unknown): never {
  throw new Error(`${at}: expected ${expected}, got ${describe(value)}`);
}

type Fields = Record<string, unknown>;

const num: Schema = (out, v, at) => {
  if (typeof v !== 'number') fail(at, 'number', v);
  out.f64(v);
};
const bool: Schema = (out, v, at) => {
  if (typeof v !== 'boolean') fail(at, 'boolean', v);
  out.bool(v);
};
const str: Schema = (out, v, at) => {
  if (typeof v !== 'string') fail(at, 'string', v);
  out.string(v);
};
const none: Schema = (_out, v, at) => {
  if (v !== undefined) fail(at, 'nothing', v);
};
/** A string from a closed set, as its index in declaration order. */
const oneOf =
  (values: readonly string[]): Schema =>
  (out, v, at) => {
    const i = typeof v === 'string' ? values.indexOf(v) : -1;
    if (i < 0) fail(at, values.join('|'), v);
    out.u32(i);
  };
const vec3: Schema = (out, v, at) => {
  const o = v as THREE.Vector3 | null;
  if (!o?.isVector3) fail(at, 'Vector3', v);
  out.f64(o.x);
  out.f64(o.y);
  out.f64(o.z);
};
const quat: Schema = (out, v, at) => {
  const o = v as THREE.Quaternion | null;
  if (!o?.isQuaternion) fail(at, 'Quaternion', v);
  out.f64(o.x);
  out.f64(o.y);
  out.f64(o.z);
  out.f64(o.w);
};
const mat3: Schema = (out, v, at) => {
  const o = v as THREE.Matrix3 | null;
  if (!o?.isMatrix3) fail(at, 'Matrix3', v);
  out.f64s(o.elements);
};
const tuple =
  (n: number): Schema =>
  (out, v, at) => {
    if (!(Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number'))) {
      fail(at, `${n} numbers`, v);
    }
    out.f64s(v);
  };
const tuple2 = tuple(2);
const tuple3 = tuple(3);
const f64a: Schema = (out, v, at) => {
  if (!(v instanceof Float64Array)) fail(at, 'Float64Array', v);
  out.u32(v.length);
  out.f64s(v);
};
/** A tuple or a vector, tagged 0 or 1. */
const vecLike: Schema = (out, v, at) => {
  if (Array.isArray(v)) {
    out.u32(0);
    tuple3(out, v, at);
  } else {
    out.u32(1);
    vec3(out, v, at);
  }
};
/** Null or absent as a 0 byte; otherwise 1 and the value. */
const opt =
  (schema: Schema): Schema =>
  (out, v, at) => {
    const present = v !== null && v !== undefined;
    out.bool(present);
    if (present) schema(out, v, at);
  };
const optNum = opt(num);
const optBool = opt(bool);
const arr =
  (schema: Schema): Schema =>
  (out, v, at) => {
    if (!Array.isArray(v)) fail(at, 'array', v);
    out.u32(v.length);
    v.forEach((x, i) => {
      schema(out, x, `${at}[${i}]`);
    });
  };
/** An object's listed fields, in the interface's declaration order. */
const obj =
  (fields: ReadonlyArray<readonly [string, Schema]>): Schema =>
  (out, v, at) => {
    const o = v as Record<string, unknown> | null;
    if (
      o === null ||
      typeof o !== 'object' ||
      Array.isArray(o) ||
      ArrayBuffer.isView(o) ||
      o.isVector3 ||
      o.isQuaternion ||
      o.isMatrix3 ||
      o.isMatrix4 ||
      o.isObject3D
    ) {
      fail(at, 'a plain object', v);
    }
    for (const [key, schema] of fields) schema(out, (o as Fields)[key], `${at}.${key}`);
  };
const rec = (keys: readonly string[], schema: Schema): Schema =>
  obj(keys.map((k) => [k, schema] as const));
/** A tagged union: the tag's index among `cases`, then that case's fields. */
const tagged =
  (key: string, cases: Record<string, Schema>): Schema =>
  (out, v, at) => {
    const tag = (v as Fields | null)?.[key];
    const names = Object.keys(cases);
    const i = typeof tag === 'string' ? names.indexOf(tag) : -1;
    if (i < 0) fail(`${at}.${key}`, names.join('|'), tag);
    out.u32(i);
    cases[tag as string](out, v, at);
  };

const SIDES = ['L', 'R'] as const;
const side = oneOf(SIDES);
const finger = oneOf(FINGER_NAMES);
const ARM_SLOTS = ['shoulder', 'upperArm', 'lowerArm', 'hand'] as const;
const OFFSET_SLOTS = ['hips', 'spine', 'chest', 'neck', 'head', 'eye.L', 'eye.R'] as const;
const CONTACT_SURFACES = ['center', 'pad', 'back'] as const;

const fingerSpec = rec(FINGER_NAMES, optNum);
const fingerRecord = rec(FINGER_NAMES, num);
const armConfiguration = rec(
  [
    'shoulderPlane',
    'shoulderLift',
    'humeralRotation',
    'elbowFlex',
    'forearmRoll',
    'wristFlex',
    'wristDev',
  ],
  num,
);
const forwardContext = obj([
  ['side', side],
  ['shoulder', vec3],
  ['upperLength', num],
  ['lowerLength', num],
  ['up', vec3],
  ['right', vec3],
  ['forward', vec3],
  ['upperParentWorld', quat],
]);
/** `ArmForwardResult` without its internal scratch. */
const forwardResult = obj([
  ...(['u', 'l', 'h', 'palm', 'elbow', 'wrist'] as const).map((k) => [k, vec3] as const),
  ...(
    ['upperWorld', 'lowerWorld', 'handWorld', 'upperLocal', 'lowerLocal', 'handLocal'] as const
  ).map((k) => [k, quat] as const),
]);
const pathPoint = obj([
  ['id', str],
  ['kind', oneOf(['upper', 'forearm', 'hand', 'finger'])],
  ['index', num],
  ['finger', opt(finger)],
  ['jointIndex', optNum],
  ['tip', optBool],
  ['position', vec3],
]);
const pathClearance = obj([
  ['key', str],
  ['pointIndex', num],
  ['valid', bool],
  ['distance', num],
  ['normal', vec3],
]);
const planOutput = obj([
  ['q', f64a],
  ['configuration', armConfiguration],
  ['forward', forwardResult],
  ['points', arr(pathPoint)],
  ['clearances', arr(pathClearance)],
  ['status', oneOf(['progress', 'settled', 'stationary', 'blocked'])],
  ...(
    [
      'positionError',
      'orientationError',
      'secondaryError',
      'maxViolation',
      'iterations',
      'environmentBatches',
    ] as const
  ).map((k) => [k, num] as const),
]);
const sideCommit = obj([
  ['output', planOutput],
  ['context', forwardContext],
  ['curls', fingerSpec],
  ['spread', fingerSpec],
]);
const standingPose = obj([
  ...(['shoulder', 'upperArm', 'lowerArm', 'hand', 'palm'] as const).map((k) => [k, vec3] as const),
  ['curls', fingerSpec],
  ['spread', fingerSpec],
]);
const acceptedArmState = obj([
  ['directions', rec(ARM_SLOTS, tuple3)],
  ['palm', tuple3],
  ['curls', fingerRecord],
  ['spread', fingerRecord],
  ['forearmRoll', num],
]);
const handContact = tagged('kind', {
  palm: obj([
    ['region', oneOf(['heel', 'center'])],
    ['surface', opt(oneOf(CONTACT_SURFACES))],
  ]),
  finger: obj([
    ['finger', finger],
    ['segment', num],
    ['fraction', num],
    ['surface', opt(oneOf(CONTACT_SURFACES))],
  ]),
});
const contactPrediction = obj([
  ['contact', vec3],
  ['shape', arr(vec3)],
  ['bindFrame', mat3],
]);
/** What the motion layer reads off a driver. */
const armDriver = obj([['acceptedQ', f64a]]);
const handSensePose = obj([
  ['knuckle', vec3],
  ['palm', vec3],
  ['forearm', vec3],
  ['index', opt(vec3)],
  ['little', opt(vec3)],
]);
/** A readout row without its display text (`label`, `unit`), which the TS side keeps. */
const jointReading = obj([
  ['id', str],
  ['deg', num],
  ['strain', num],
  ['zone', oneOf(['natural', 'strained', 'limit'])],
  ['range', tuple2],
  ['measured', bool],
]);
const reachLinks = obj([
  ['upperArm', vec3],
  ['lowerArm', vec3],
]);
const armSolution = obj([
  ['upperArm', vec3],
  ['lowerArm', vec3],
  ['hand', vec3],
  ['palm', vec3],
  ['tip', vec3],
  ['twist', num],
  ['strain', optNum],
  ['swivelDir', vec3],
  ['clasp', optBool],
]);
const pointRequest = obj([
  ['azimuth', optNum],
  ['elevation', optNum],
  ['extent', optNum],
  ['finger', opt(finger)],
  ['mirror', optBool],
  ['point', opt(vecLike)],
  ['palm', opt(vecLike)],
  ['twist', optNum],
]);
const armMeasurement = rec(
  [
    'elevation',
    'plane',
    'rotation',
    'elbow',
    'forearm',
    'wristFlex',
    'wristDev',
    'torso',
    'inboard',
    'rotationRead',
  ],
  num,
);
const armStrain = rec(
  ['elevation', 'rotation', 'elbow', 'forearm', 'wristFlex', 'wristDev', 'torso'],
  num,
);
const volumeFrame = rec(['O', 'up', 'right', 'fwd'], vec3);
const bodyVolumeFrame = obj([
  ['torso', opt(volumeFrame)],
  ['head', opt(volumeFrame)],
]);
const bodyClearance = obj([
  ['surface', oneOf(['torso', 'head'])],
  ['valid', bool],
  ['distance', num],
  ['normal', vec3],
]);
const faceSample = obj([
  ['distance', num],
  ['normal', vec3],
  ['valid', bool],
]);

/** A method's arguments, positionally, and its result. */
interface MethodShape {
  args: readonly Schema[];
  ret: Schema;
}

const m = (ret: Schema, ...args: Schema[]): MethodShape => ({ args, ret });

/**
 * The facade boundary: the public methods of `Rig`, `rig.anat`, `rig.anat.face`,
 * `CharacterFrame` and `ArmTransaction`, with the shape of each argument and result as the TS
 * declarations give it. Accessors are not methods and are not listed.
 */
export const BOUNDARY = {
  Rig: {
    acceptedArmState: m(acceptedArmState, side),
    bootstrapStandingPose: m(bool, rec(SIDES, standingPose)),
    armStateForBodyInitialization: m(acceptedArmState, side),
    armDriver: m(opt(armDriver), side),
    predictHandContact: m(opt(contactPrediction), side, handContact, fingerSpec, fingerSpec),
    beginBodyArmFrame: m(bool),
    finishLegacyBodyFrame: m(none, num, optNum),
    armForwardContext: m(opt(forwardContext), side),
    armForwardContextFromUpdatedBody: m(opt(forwardContext), side),
    captureProposedBodyContext: m(none, num, optNum),
    applyBodyContext: m(num, num, optNum, optBool),
    stageArmForward: m(bool, side, forwardResult, fingerSpec, fingerSpec),
    commitArmFrame: m(bool, rec(SIDES, sideCommit), num, optNum, optBool),
    commitArmTransport: m(bool, num, optNum, optBool),
    lastAcceptedHandPose: m(opt(handSensePose), side),
    reset: m(none),
    addOffset: m(none, oneOf(OFFSET_SLOTS), num, num, num),
    commitSpine: m(none),
    readHeadOffset: m(bool, quat),
    commitEyes: m(none),
    plantLegs: m(none, num, optNum, optBool),
    girdleRoom: m(none, side, vec3, tuple3, num, vec3),
    turnGirdle: m(none, tuple3, vec3),
    aimShoulder: m(none, side, opt(vecLike)),
    aimArm: m(bool, side, rec(ARM_SLOTS, tuple3), optNum, opt(tuple3), optNum),
    aimArmLegacy: m(none, side, rec(ARM_SLOTS, tuple3), optNum, opt(tuple3), optNum),
    measure: m(opt(arr(jointReading)), side),
    solveReachNatural: m(opt(armSolution), side, vec3, opt(vec3), armSolution, opt(vec3)),
    solvePoint: m(opt(armSolution), side, pointRequest, armSolution),
    solveReach: m(opt(reachLinks), side, vec3, num, reachLinks, optBool),
    curlFinger: m(bool, finger, side, num),
    curlHand: m(bool, side, fingerSpec, opt(fingerSpec)),
    curlFingerLegacy: m(none, finger, side, num),
    curlHandLegacy: m(none, side, fingerSpec, opt(fingerSpec)),
    fingerClearance: m(num, side),
    fingerShape: m(arr(vec3), side),
    fingerFrame: m(mat3, side),
  },
  ArmAnatomy: {
    update: m(bool),
    setArm: m(none, vec3, num, optNum, optNum),
    clearArm: m(none),
    measure: m(armMeasurement, side, vec3, vec3, vec3, opt(vec3), optNum, optNum),
    score: m(armStrain),
    cost: m(num),
    report: m(arr(jointReading)),
    clamp: m(none, side, vec3, vec3, vec3, opt(vec3)),
    surface: m(num, vec3),
    captureVolumeFrame: m(bodyVolumeFrame, bodyVolumeFrame),
    sampleVolumeClearances: m(arr(bodyClearance), bodyVolumeFrame, vec3, arr(bodyClearance)),
    clearHand: m(bool, side, vec3, opt(vec3), opt(vec3)),
    clampWrist: m(none, side, vec3, vec3, opt(vec3)),
  },
  FaceSurface: {
    refresh: m(none),
    shortfall: m(num, vec3, num, vec3),
    sample: m(none, vec3, faceSample),
  },
  CharacterFrame: {
    ready: m(bool),
    legacyMirror: m(num, side),
    axialMirror: m(num, side, optBool),
    toWorld: m(vec3, vec3, vecLike, side, optNum, optBool),
    tupleToWorld: m(tuple3, tuple3, vecLike, side, optNum, optBool),
    toCharacter: m(vec3, vec3, vec3, side, optBool),
  },
  ArmTransaction: {
    beginFrame: m(none),
    stageClaspLeader: m(none, side, num, bool),
    retime: m(none, num),
    resetRoute: m(none, side, f64a),
    commit: m(none, num, num, optNum),
  },
} satisfies Record<string, Record<string, MethodShape>>;

const PROTOTYPES: Record<keyof typeof BOUNDARY, Record<string, unknown>> = {
  Rig: Rig.prototype as unknown as Record<string, unknown>,
  ArmAnatomy: ArmAnatomy.prototype as unknown as Record<string, unknown>,
  FaceSurface: FaceSurface.prototype as unknown as Record<string, unknown>,
  CharacterFrame: CharacterFrame.prototype as unknown as Record<string, unknown>,
  ArmTransaction: ArmTransaction.prototype as unknown as Record<string, unknown>,
};

/** Writes the state of every node of the avatar, as the calls hash reads it. */
function writeNodes(out: HashSink, nodes: readonly THREE.Object3D[]): void {
  for (const o of nodes) {
    const { position: p, quaternion: q, scale: s } = o;
    out.f64(p.x);
    out.f64(p.y);
    out.f64(p.z);
    out.f64(q.x);
    out.f64(q.y);
    out.f64(q.z);
    out.f64(q.w);
    out.f64(s.x);
    out.f64(s.y);
    out.f64(s.z);
    out.f64s(o.matrixWorld.elements);
    out.bool(o.matrixWorldNeedsUpdate);
  }
}

/** A live wrapping of the boundary's prototypes. */
export interface BoundaryWatch {
  /** Boundary calls seen so far, by `Class.method`. */
  readonly counts: Map<string, number>;
  uninstall(): void;
}

/**
 * Wrap every method in `BOUNDARY` so that each call from outside the boundary (one not made
 * from inside another listed method) is written to `out` when it returns.
 *
 * No argument or result is an `Object3D`; nodes appear only in the dump after each call, in
 * `nodes` order, which is the avatar's `traverse` order and so the scene graph's index order.
 * An `Object3D` arriving where the table expects a plain object fails the hash.
 */
export function watchBoundary(out: HashSink, nodes: readonly THREE.Object3D[]): BoundaryWatch {
  const counts = new Map<string, number>();
  const restore: Array<() => void> = [];
  let depth = 0;
  for (const [cls, methods] of Object.entries(BOUNDARY) as [
    keyof typeof BOUNDARY,
    Record<string, MethodShape>,
  ][]) {
    const proto = PROTOTYPES[cls];
    for (const [name, shape] of Object.entries(methods)) {
      const original = proto[name];
      if (typeof original !== 'function') throw new Error(`${cls}.${name} is not a method`);
      const id = `${cls}.${name}`;
      proto[name] = function (this: unknown, ...args: unknown[]) {
        depth++;
        let result: unknown;
        try {
          result = original.apply(this, args);
        } finally {
          depth--;
        }
        if (depth === 0) {
          if (args.length > shape.args.length) {
            throw new Error(`${id} called with ${args.length} arguments`);
          }
          counts.set(id, (counts.get(id) ?? 0) + 1);
          out.string(id);
          shape.args.forEach((schema, i) => {
            schema(out, args[i], `${id} argument ${i}`);
          });
          shape.ret(out, result, `${id} result`);
          writeNodes(out, nodes);
        }
        return result;
      };
      restore.push(() => {
        proto[name] = original;
      });
    }
  }
  return {
    counts,
    uninstall() {
      for (const undo of restore) undo();
    },
  };
}

// --- the run -------------------------------------------------------------------

/** Where the gaze is aimed, standing in for the viewer's camera. */
const CAMERA = new THREE.Vector3(0, 1.35, 1.8);

export interface DirectorRun {
  /** One FNV-1a 64 per frame. */
  frames: string[];
  /** The fold of every boundary call, or null when the calls were not watched. */
  calls: string | null;
  /** Calls into a replaced transcendental during the run. */
  coreCalls: number;
  /** Frames after which the core's memory was a different buffer than before. */
  bufferSwaps: number;
  /** Boundary calls by method, when watched. */
  counts: Map<string, number>;
}

export interface RunOptions {
  /** Watch the boundary and fold its calls. Off for a run that only wants the frames. */
  calls?: boolean;
  /** Called after each frame's update and before its hash. */
  tamper?: (director: Director, frame: number) => void;
}

/** Build the avatar and the profile for a fixture, outside the replaced transcendentals. */
export function prepareFixture(fixture: DirectorFixture): DirectorAvatar & { profile: Profile } {
  const avatar = buildDirectorAvatar(fixture.variant);
  return { ...avatar, profile: buildProfile(avatar.root, avatar.descriptor) };
}

/** The links an `aim` action leaves fixed, as `tests/rig/arm-static.test.ts` gives them. */
const ARM_EDIT: Record<'shoulder' | 'upperArm' | 'lowerArm' | 'hand', [number, number, number]> = {
  shoulder: [0.34, -0.83, 0.44],
  upperArm: [0.38, -0.79, 0.48],
  lowerArm: [0.08, -0.36, 0.93],
  hand: [0.1, -0.2, 0.97],
};

function apply(director: Director, action: Action): void {
  if ('perform' in action) director.perform(action.perform);
  else if ('gesture' in action) director.gesture(action.gesture, action.side);
  else if ('point' in action) director.point(action.point, action.spec);
  else if ('hop' in action) director.hop(action.hop);
  else if ('limits' in action) director.rig.limitsEnabled = action.limits;
  else if ('aim' in action) {
    director.rig.aimArm(action.aim, { ...ARM_EDIT, upperArm: [...action.upperArm] });
  } else if ('curl' in action) director.rig.curlFinger(action.curl, action.side, action.amount);
  else if ('hand' in action) director.rig.curlHand(action.hand, action.curls);
  else director.rig.measure(action.measure);
}

/** Run one fixture and hash every frame, and the boundary calls when asked. */
export function runDirectorFixture(
  fixture: DirectorFixture,
  options: RunOptions = {},
): DirectorRun {
  const { root, wrapper, profile } = prepareFixture(fixture);
  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => {
    nodes.push(o);
  });
  const skeletons: THREE.Skeleton[] = [];
  for (const o of nodes) {
    const s = (o as THREE.SkinnedMesh).isSkinnedMesh ? (o as THREE.SkinnedMesh).skeleton : null;
    if (s && !skeletons.includes(s)) skeletons.push(s);
  }
  const callSink = options.calls ? makeFnv64() : null;
  const watch = callSink ? watchBoundary(callSink, nodes) : null;
  const frameSink = makeFnv64();
  const frames: string[] = [];
  const before = coreMathCalls();
  let bufferSwaps = 0;
  let director: Director | null = null;
  try {
    const random = splitmix64();
    const built = withCoreMath(() => new Director(profile, undefined, { random }));
    director = built;
    const autopilot = fixture.idle ? new Autopilot(splitmix64()) : null;
    const sideRandom = splitmix64(SEED ^ 1n);
    if (autopilot) built.auto = true;
    const gaze = CAMERA.clone();
    for (const [frame, step] of fixture.steps.entries()) {
      if (step.wrapper && wrapper) placeWrapper(wrapper, step.wrapper);
      const buffer = core().memory.buffer;
      withCoreMath(() => {
        for (const action of step.actions ?? []) apply(built, action);
        for (const choice of autopilot?.advance(step.dt, true) ?? []) {
          if ('act' in choice) {
            // The side the server would draw for this act, as it sends one to every renderer.
            const sided = withSide({ cmd: 'idleAct', act: choice.act }, sideRandom) as {
              act: string;
              side?: Side;
            };
            built.idleAct(sided.act, sided.side);
          } else built.idleFace(choice.face);
        }
        if (step.camera) gaze.set(...step.camera);
        built.update(step.dt, { headWorldTarget: gaze });
        root.updateMatrixWorld(true);
        for (const s of skeletons) s.update();
      });
      if (core().memory.buffer !== buffer) bufferSwaps++;
      options.tamper?.(built, frame);
      writeDirectorFrame(frameSink.reset(), {
        root,
        profile,
        spring: built.spring,
        armSolverOff: built.rig.armSolverOff,
      });
      frames.push(frameSink.digest());
    }
  } finally {
    watch?.uninstall();
    director?.spring.dispose();
  }
  return {
    frames,
    calls: callSink?.digest() ?? null,
    coreCalls: coreMathCalls() - before,
    bufferSwaps,
    counts: watch?.counts ?? new Map(),
  };
}
