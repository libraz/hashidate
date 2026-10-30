import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FINGER_WIDTH, HAND_CONTACT, JOINTS } from '@/engine/anatomy';
import { ArmAnatomy } from '@/engine/anatomy/arm';
import * as armFrame from '@/engine/anatomy/arm-frame';
import * as strain from '@/engine/anatomy/strain';
import * as volume from '@/engine/anatomy/volume';
import { type BodyClearance, makeBodyVolumeFrame } from '@/engine/anatomy/volumes';
import { Director } from '@/engine/director';
import * as armConfiguration from '@/engine/rig/arm-configuration';
import * as armPath from '@/engine/rig/arm-path';
import * as armQp from '@/engine/rig/arm-qp';
import * as armRoute from '@/engine/rig/arm-route';
import { ElbowSearch } from '@/engine/rig/elbow';
import { type FingerAxes, solveFingerAxes } from '@/engine/rig/finger-axes';
import { FingerClearance, handFrame } from '@/engine/rig/finger-clearance';
import { ShoulderGirdle } from '@/engine/rig/girdle';
import {
  captureHandContactGeometry,
  captureHandGeometry,
  type HandContactCalibration,
  type HandGeometryCalibration,
  type HandGeometrySample,
  makeHandGeometrySample,
  sampleHandContact,
  sampleHandGeometry,
} from '@/engine/rig/hand-geometry';
import { Hands } from '@/engine/rig/hands';
import { GroundedLegs } from '@/engine/rig/legs';
import { type PointRequest, PointSolver } from '@/engine/rig/point';
import {
  type ArmSolution,
  nearReach,
  poleAngle,
  type ReachLinks,
  reachRef,
  solveReach,
  swivelOf,
} from '@/engine/rig/reach';
import { SkeletonRefresh } from '@/engine/rig/skeleton';
import { type OffsetSlot, SpineOffsets } from '@/engine/rig/spine';
import {
  type BoneSlot,
  FINGER_NAMES,
  type FingerSpec,
  type HandContact,
  type JointTable,
  type Side,
  type Vec3Tuple,
} from '@/engine/types';
import { makeFnv64 } from '../../tools/parity/hash';
import { withCoreMath } from '../helpers/core-math';
import {
  BASE_VARIANT,
  DIRECTOR_FIXTURES,
  prepareFixture,
  runDirectorFixture,
  splitmix64,
} from '../helpers/director-fixtures';
import { must } from '../helpers/must';

/**
 * The function corpora and the base avatar the Rust ports replay, recorded from the TS engine.
 *
 * Each corpus is one function's calls during the director fixtures, at most 500 spread evenly
 * across them (fewer where 500 would not fit the 200 KiB a corpus may take), captured by
 * replacing the export on its module namespace. That sees calls from other modules only, so only
 * functions every caller of which is in another module are recorded.
 *
 * `<fn>.bin` is little-endian f64, one case after another: the inputs, then the outputs (the
 * result, then each argument the function writes, as it stands after the call). `<fn>.json`
 * names the fields. A field is flattened as: a number or a boolean (0/1) 1; a Vector3 or a
 * tuple 3; a Quaternion 4; a Matrix3 9; a typed array its length; a string of a closed set its
 * index in declaration order; a value that may be absent a `<name>.present` 0/1 and, when
 * present, its fields; an array a `<name>.len` and its items; an object its fields in interface
 * order. A field one case lacks reads 0 in that case. Free-text names (labels, point ids,
 * clearance keys) are not numbers and are left out.
 *
 * `avatar-base.bin` holds the base variant as the rig is built on it: the node table, the
 * profile's numbers and what construction measures off the mesh; `avatar-base.json` indexes it
 * by name. An array the profile does not have (a null face, an absent override) is not listed.
 *
 * `arm-battery` is not a function's calls but a fixed sequence of them on the base avatar's
 * `ArmAnatomy`, in the corpus format: one case per step, `kind` saying which. `frame` is the
 * anatomy's frame after `update`; `pose` places one arm, then measures, costs and clamps a pose
 * and clears a second one's hand; `volume` samples both clearances at a point and pushes it to
 * the surface; `face` samples the head's skin.
 *
 * `rig-a-battery` is the same kind of run over the rig's leaf modules on the base avatar:
 * `SkeletonRefresh`, `GroundedLegs`, `SpineOffsets`, `ShoulderGirdle`, the reach functions,
 * `ElbowSearch` and `PointSolver`, wired as `Rig` wires them. A step may first write one node's
 * position and quaternion (`set`) and run the root's full pass (`update`); every step ends with
 * `hash`, a 64-bit FNV-1a over every node's position, quaternion, scale, matrix, matrixWorld and
 * matrixWorldNeedsUpdate (high and low 32 bits), and a step that writes bones lists their state
 * as `touched`. `slot` names one of four `ArmSolution`s the elbow and point steps carry.
 *
 * `rig-b-battery` runs the finger axes, `Hands`, the hand geometry and contact landmarks,
 * `FingerClearance` and the arm-configuration functions the same way, with the same `set`,
 * `update` and `hash`. Its inputs are worked out on a second copy of the avatar, so the recorded
 * tree sees only the steps. A structure too large to list (the axes, a captured calibration) is
 * a `digest`, FNV-1a over its numbers in a fixed order; lists of points, rotations and numbers
 * share `vecs`, `quats` and `nums`, and `touched` gives only quaternions, which keeps the stride
 * inside the size limit. A clearance step places a hand at the mouth with its fingers aimed in,
 * and the recording checks that one turned the hand and one curled a finger.
 *
 * `arm-path-plan-battery` calls `configurationFromQ` (`fromQ`) and `copyForward` (`copyForward`)
 * directly, as every caller of theirs outside the tests is in their own module. The values are
 * splitmix64 draws over several magnitudes, mixed with signed zeros, infinities, NaN and the
 * smallest subnormal; `same` says `configurationFromQ` returned its `out`.
 *
 * Without `HASHIDATE_RECORD_CORPORA=1` this checks the files against a fresh recording;
 * with it, it writes them.
 */

const DIR = new URL('../../crates/hashidate-core/tests/corpora/', import.meta.url);
const WRITE = process.env.HASHIDATE_RECORD_CORPORA === '1';
const MAX_CASES = 500;
/** What a corpus `.bin` may take, a little under the 200 KiB limit. */
const MAX_BYTES = 200 * 1024 - 1024;
const NO_NODE = 0xffff_ffff;

// --- flattening ---------------------------------------------------------------------------

interface Field {
  name: string;
  values: number[];
}

type Flat = (value: unknown, name: string, out: Field[]) => void;

function fail(at: string, expected: string, value: unknown): never {
  const got =
    value === null ? 'null' : typeof value === 'object' ? value.constructor?.name : typeof value;
  throw new Error(`${at}: expected ${expected}, got ${got}`);
}

const num: Flat = (v, name, out) => {
  if (typeof v !== 'number') fail(name, 'number', v);
  out.push({ name, values: [v] });
};
const bool: Flat = (v, name, out) => {
  if (typeof v !== 'boolean') fail(name, 'boolean', v);
  out.push({ name, values: [v ? 1 : 0] });
};
const oneOf =
  (values: readonly string[]): Flat =>
  (v, name, out) => {
    const i = typeof v === 'string' ? values.indexOf(v) : -1;
    if (i < 0) fail(name, values.join('|'), v);
    out.push({ name, values: [i] });
  };
const vec3: Flat = (v, name, out) => {
  const o = v as THREE.Vector3 | null;
  if (!o?.isVector3) fail(name, 'Vector3', v);
  out.push({ name, values: [o.x, o.y, o.z] });
};
const quat: Flat = (v, name, out) => {
  const o = v as THREE.Quaternion | null;
  if (!o?.isQuaternion) fail(name, 'Quaternion', v);
  out.push({ name, values: [o.x, o.y, o.z, o.w] });
};
const tuple =
  (n: number): Flat =>
  (v, name, out) => {
    if (!(Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number'))) {
      fail(name, `${n} numbers`, v);
    }
    out.push({ name, values: [...v] });
  };
const tuple2 = tuple(2);
const tuple3 = tuple(3);
/** A typed array, at its own length. */
const typed: Flat = (v, name, out) => {
  if (!(v instanceof Float64Array || v instanceof Float32Array || v instanceof Int32Array)) {
    fail(name, 'a typed array', v);
  }
  out.push({ name, values: Array.from(v) });
};
const opt =
  (flat: Flat): Flat =>
  (v, name, out) => {
    const present = v !== null && v !== undefined;
    out.push({ name: `${name}.present`, values: [present ? 1 : 0] });
    if (present) flat(v, name, out);
  };
const arr =
  (flat: Flat): Flat =>
  (v, name, out) => {
    if (!Array.isArray(v)) fail(name, 'array', v);
    out.push({ name: `${name}.len`, values: [v.length] });
    v.forEach((x, i) => {
      flat(x, `${name}[${i}]`, out);
    });
  };
const obj =
  (fields: ReadonlyArray<readonly [string, Flat]>): Flat =>
  (v, name, out) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(name, 'an object', v);
    for (const [key, flat] of fields)
      flat((v as Record<string, unknown>)[key], `${name}.${key}`, out);
  };
/** A record whose keys are data rather than declared, in its own key order. */
const record =
  (flat: Flat): Flat =>
  (v, name, out) => {
    if (v === null || typeof v !== 'object') fail(name, 'a record', v);
    for (const [key, x] of Object.entries(v)) flat(x, `${name}.${key}`, out);
  };
const nums = (keys: readonly string[]): Flat => obj(keys.map((k) => [k, num] as const));

const side = oneOf(['L', 'R']);
const finger = oneOf(FINGER_NAMES);
const armConfigurationFlat = nums([
  'shoulderPlane',
  'shoulderLift',
  'humeralRotation',
  'elbowFlex',
  'forearmRoll',
  'wristFlex',
  'wristDev',
]);
const jointDof = obj([
  ['free', tuple2],
  ['max', tuple2],
]);
const jointSpec = obj([
  ['dofs', record(jointDof)],
  ['elevation', opt(arr(tuple3))],
]);
const jointTable = obj(
  ['shoulder', 'elbow', 'wrist', 'finger', 'thumb', 'neck', 'spine'].map(
    (k) => [k, jointSpec] as const,
  ),
);
const calibration = obj([
  [
    'upper',
    obj([
      ['axis', vec3],
      ['rest', quat],
      ['front', vec3],
    ]),
  ],
  [
    'lower',
    obj([
      ['axis', vec3],
      ['rest', quat],
    ]),
  ],
  [
    'hand',
    obj([
      ['axis', vec3],
      ['rest', quat],
      ['palm', vec3],
    ]),
  ],
  ['radialSign', num],
  ['joints', jointTable],
]);
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
const armDirections = obj(
  (['upperArm', 'lowerArm', 'hand'] as const).map((k) => [k, vec3] as const),
);
const fingerJointPath = obj([
  ['position', vec3],
  ['rest', quat],
  ['scale', vec3],
  ['curlAxis', opt(vec3)],
  ['splayAxis', opt(vec3)],
  ['jointIndex', opt(num)],
]);
const fingerPointPath = obj([
  ['finger', finger],
  ['jointIndex', num],
  ['tip', bool],
  ['nodes', opt(arr(fingerJointPath))],
  ['previousPoint', opt(num)],
  ['lastPoint', opt(num)],
]);
const handGeometry = obj([
  ['handPresent', opt(bool)],
  ['metricScale', num],
  ['joints', jointTable],
  ['points', arr(fingerPointPath)],
]);
const planOutput = obj([
  ['q', typed],
  ['configuration', armConfigurationFlat],
  ['forward', forwardResult],
  [
    'points',
    arr(
      obj([
        ['kind', oneOf(['upper', 'forearm', 'hand', 'finger'])],
        ['index', num],
        ['finger', opt(finger)],
        ['jointIndex', opt(num)],
        ['tip', opt(bool)],
        ['position', vec3],
      ]),
    ),
  ],
  [
    'clearances',
    arr(
      obj([
        ['pointIndex', num],
        ['valid', bool],
        ['distance', num],
        ['normal', vec3],
      ]),
    ),
  ],
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
const qpScratch = obj(
  (['working', 'gram', 'gramFactor', 'r', 'd'] as const).map((k) => [k, typed] as const),
);
const measuredVolume = obj([
  ['r', opt(typed)],
  ['bands', num],
  ['sectors', num],
  ['top', num],
  ['bottom', num],
  ['radius', num],
]);
const surfaceGradient = obj([
  ['height', num],
  ['bearing', num],
]);

/** One recorded function: its module, its arguments, which of them it writes, and its result. */
interface CorpusSpec {
  fn: string;
  module: Record<string, unknown>;
  args: ReadonlyArray<readonly [string, Flat]>;
  /** Names of the arguments the function writes; every other object argument must come back unchanged. */
  writes: readonly string[];
  result: Flat | null;
}

const spec = (
  fn: string,
  module: object,
  args: ReadonlyArray<readonly [string, Flat]>,
  writes: readonly string[],
  result: Flat | null,
): CorpusSpec => ({ fn, module: module as Record<string, unknown>, args, writes, result });

const CORPORA: readonly CorpusSpec[] = [
  spec(
    'forwardArm',
    armConfiguration,
    [
      ['configuration', armConfigurationFlat],
      ['calibration', calibration],
      ['context', forwardContext],
      ['out', forwardResult],
    ],
    ['out'],
    forwardResult,
  ),
  spec(
    'configurationOfDirections',
    armConfiguration,
    [
      ['directions', armDirections],
      ['palm', opt(vec3)],
      ['calibration', calibration],
      ['context', forwardContext],
      ['previous', opt(armConfigurationFlat)],
      ['out', armConfigurationFlat],
    ],
    ['out'],
    bool,
  ),
  spec(
    'configurationToQ',
    armPath,
    [
      ['configuration', armConfigurationFlat],
      ['out', typed],
    ],
    ['out'],
    null,
  ),
  spec(
    'makeArmPathPlanOutput',
    armPath,
    [
      ['calibration', calibration],
      ['handGeometry', handGeometry],
      ['rowCount', num],
    ],
    [],
    planOutput,
  ),
  spec(
    'solveDualActiveSet',
    armQp,
    [
      ['A', typed],
      ['b', typed],
      ['Z', typed],
      ['count', num],
      ['u', typed],
      ['delta', typed],
      ['lambda', typed],
      ['scratch', qpScratch],
    ],
    ['u', 'delta', 'lambda', 'scratch'],
    oneOf(['optimal', 'infeasible', 'failed']),
  ),
  spec('validationSamples', armRoute, [['dt', num]], [], num),
  spec(
    'rollRoom',
    strain,
    [
      ['used', num],
      ['d', jointDof],
    ],
    [],
    tuple2,
  ),
  spec(
    'humeralReference',
    armFrame,
    [
      ['u', vec3],
      ['up', vec3],
      ['forward', vec3],
      ['out', vec3],
    ],
    ['out'],
    vec3,
  ),
  spec(
    'lateralReference',
    armFrame,
    [
      ['u', vec3],
      ['ref', vec3],
      ['up', vec3],
      ['forward', vec3],
      ['lateral', vec3],
      ['out', vec3],
    ],
    ['out'],
    vec3,
  ),
  spec(
    'fingerCurl',
    strain,
    [
      ['joints', jointSpec],
      ['index', num],
      ['amount', num],
    ],
    [],
    num,
  ),
  spec('thumbOpposition', strain, [['amount', num]], [], num),
  spec(
    'surfaceOf',
    volume,
    [
      ['t', measuredVolume],
      ['h', num],
      ['theta', num],
      ['gradient', opt(surfaceGradient)],
    ],
    ['gradient'],
    num,
  ),
];

/** One sampled call, flattened. */
interface Case {
  input: Field[];
  output: Field[];
}

function flattenArgs(
  s: CorpusSpec,
  args: readonly unknown[],
  names: readonly string[] | null,
): Field[] {
  const out: Field[] = [];
  s.args.forEach(([name, flat], i) => {
    if (names === null || names.includes(name)) flat(args[i], name, out);
  });
  return out;
}

function sameFields(a: Field[], b: Field[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (f, i) =>
        f.name === b[i].name &&
        f.values.length === b[i].values.length &&
        f.values.every((x, k) => Object.is(x, b[i].values[k])),
    )
  );
}

/**
 * Point a module namespace's export at `replacement`, as `vi.spyOn` does, without the spy's
 * record of every call, which a run of the fixtures grows past the heap. Returns the undo.
 */
function replaceExport(
  module: Record<string, unknown>,
  name: string,
  replacement: unknown,
): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(module, name);
  if (!descriptor?.configurable) throw new Error(`${name} cannot be replaced on its module`);
  Object.defineProperty(module, name, {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: () => replacement,
  });
  return () => Object.defineProperty(module, name, descriptor);
}

/**
 * Wrap every corpus function for the duration of `run`. A call is captured when `take` says
 * so for its index; every call is counted.
 */
function observe(
  take: (fn: string, index: number) => boolean,
  run: () => void,
): { counts: Map<string, number>; cases: Map<string, Case[]> } {
  const counts = new Map<string, number>();
  const cases = new Map<string, Case[]>();
  const restore: Array<() => void> = [];
  for (const s of CORPORA) {
    const original = s.module[s.fn] as (...args: unknown[]) => unknown;
    if (typeof original !== 'function') throw new Error(`${s.fn} is not exported`);
    cases.set(s.fn, []);
    const readOnly = s.args.map(([name]) => name).filter((name) => !s.writes.includes(name));
    restore.push(
      replaceExport(s.module, s.fn, function (this: unknown, ...args: unknown[]) {
        const index = counts.get(s.fn) ?? 0;
        counts.set(s.fn, index + 1);
        if (!take(s.fn, index)) return original.apply(this, args);
        const input = flattenArgs(s, args, null);
        const untouched = flattenArgs(s, args, readOnly);
        const result = original.apply(this, args);
        if (!sameFields(untouched, flattenArgs(s, args, readOnly))) {
          throw new Error(`${s.fn} wrote an argument it is not recorded as writing`);
        }
        const output: Field[] = [];
        s.result?.(result, 'return', output);
        output.push(...flattenArgs(s, args, s.writes));
        must(cases.get(s.fn), s.fn).push({ input, output });
        return result;
      }),
    );
  }
  try {
    run();
  } finally {
    for (const undo of restore) undo();
  }
  return { counts, cases };
}

/** The union of the cases' fields, each in the place its own case gave it. */
function layout(lists: Field[][]): Array<{ name: string; len: number }> {
  const merged: Array<{ name: string; len: number }> = [];
  const at = new Map<string, number>();
  for (const fields of lists) {
    let position = 0;
    for (const f of fields) {
      const known = at.get(f.name);
      if (known !== undefined) {
        if (merged[known].len !== f.values.length) {
          throw new Error(
            `${f.name} is ${merged[known].len} long in one case and ${f.values.length} in another`,
          );
        }
        position = known + 1;
        continue;
      }
      merged.splice(position, 0, { name: f.name, len: f.values.length });
      for (const [name, i] of at) if (i >= position) at.set(name, i + 1);
      at.set(f.name, position);
      position++;
    }
  }
  return merged;
}

function fill(into: number[], fields: Field[], order: Array<{ name: string; len: number }>): void {
  const byName = new Map(fields.map((f) => [f.name, f.values]));
  for (const { name, len } of order) {
    const values = byName.get(name);
    for (let k = 0; k < len; k++) into.push(values ? values[k] : 0);
  }
}

function f64Bytes(values: readonly number[]): Uint8Array {
  return new Uint8Array(new Float64Array(values).buffer);
}

interface Recorded {
  json: string;
  bin: Uint8Array;
}

/** Every corpus, from two runs of the fixtures: one to count the calls, one to take them. */
function recordCorpora(): Map<string, Recorded> {
  const runAll = () => {
    for (const f of DIRECTOR_FIXTURES) runDirectorFixture(f);
  };
  const { counts } = observe(() => false, runAll);
  const picks = new Map<string, Set<number>>();
  for (const s of CORPORA) {
    const total = counts.get(s.fn) ?? 0;
    if (total === 0) throw new Error(`no fixture calls ${s.fn} from outside its module`);
    const n = Math.min(MAX_CASES, total);
    picks.set(s.fn, new Set(Array.from({ length: n }, (_, k) => Math.floor((k * total) / n))));
  }
  const second = observe((fn, i) => must(picks.get(fn), fn).has(i), runAll);
  const out = new Map<string, Recorded>();
  for (const s of CORPORA) {
    expect(second.counts.get(s.fn), `${s.fn} call count across runs`).toBe(counts.get(s.fn));
    let taken = must(second.cases.get(s.fn), s.fn);
    let input = layout(taken.map((c) => c.input));
    let output = layout(taken.map((c) => c.output));
    const stride = [...input, ...output].reduce((sum, f) => sum + f.len, 0);
    const fit = Math.floor(MAX_BYTES / (stride * 8));
    if (taken.length > fit) {
      const all = taken;
      taken = Array.from({ length: fit }, (_, k) => all[Math.floor((k * all.length) / fit)]);
      input = layout(taken.map((c) => c.input));
      output = layout(taken.map((c) => c.output));
    }
    const values: number[] = [];
    for (const c of taken) {
      fill(values, c.input, input);
      fill(values, c.output, output);
    }
    const index = { fn: s.fn, cases: taken.length, in: input, out: output };
    out.set(s.fn, { json: `${JSON.stringify(index, null, 1)}\n`, bin: f64Bytes(values) });
  }
  return out;
}

// --- the base avatar ----------------------------------------------------------------------

type Kind = 'u32' | 'f64' | 'f32';

/** Named arrays packed into one buffer, each at an 8-byte aligned offset. */
class Arrays {
  readonly index: Array<{ name: string; kind: Kind; offset: number; len: number }> = [];
  #parts: Uint8Array[] = [];
  #length = 0;

  add(name: string, kind: Kind, values: ArrayLike<number>): void {
    if (this.index.some((a) => a.name === name)) throw new Error(`${name} written twice`);
    const bytes =
      kind === 'u32'
        ? new Uint8Array(
            Uint32Array.from(values, (v) => {
              if (!Number.isInteger(v) || v < 0 || v > NO_NODE)
                throw new Error(`${name}: ${v} is not a u32`);
              return v;
            }).buffer,
          )
        : kind === 'f32'
          ? new Uint8Array(Float32Array.from(values).buffer)
          : new Uint8Array(Float64Array.from(values).buffer);
    this.index.push({ name, kind, offset: this.#length, len: values.length });
    this.#parts.push(bytes);
    this.#length += bytes.length;
    const pad = (8 - (this.#length % 8)) % 8;
    if (pad) {
      this.#parts.push(new Uint8Array(pad));
      this.#length += pad;
    }
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let at = 0;
    for (const p of this.#parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/** Every slot the profile resolves, in `BoneSlot`'s declaration order. */
const BONE_SLOTS = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'eye.L',
  'eye.R',
  ...(
    ['shoulder', 'upperArm', 'lowerArm', 'hand', 'upperLeg', 'lowerLeg', 'foot', 'toe'] as const
  ).flatMap((slot) => [`${slot}.L`, `${slot}.R`] as const),
] satisfies readonly BoneSlot[];

/** The base variant as the rig is built on it, and what its construction measures. */
function recordAvatarBase(): Recorded {
  const fixture = must(
    DIRECTOR_FIXTURES.find((f) => f.variant === BASE_VARIANT),
    'a base-variant fixture',
  );
  const { root, profile } = prepareFixture(fixture);
  const a = new Arrays();

  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => {
    nodes.push(o);
  });
  const index = new Map(nodes.map((o, i) => [o, i]));
  const at = (o: THREE.Object3D | null | undefined) => (o ? (index.get(o) ?? NO_NODE) : NO_NODE);
  const kind = (o: THREE.Object3D) =>
    (o as THREE.SkinnedMesh).isSkinnedMesh
      ? 3
      : (o as THREE.Mesh).isMesh
        ? 2
        : (o as THREE.Bone).isBone
          ? 1
          : 0;
  a.add('node.kind', 'u32', nodes.map(kind));
  a.add(
    'node.parent',
    'u32',
    nodes.map((o) => at(o.parent)),
  );
  a.add(
    'node.flags',
    'u32',
    nodes.map(
      (o) =>
        (o.matrixAutoUpdate ? 1 : 0) |
        (o.matrixWorldAutoUpdate ? 2 : 0) |
        (o.matrixWorldNeedsUpdate ? 4 : 0) |
        (o.pivot ? 8 : 0),
    ),
  );
  a.add(
    'node.position',
    'f64',
    nodes.flatMap((o) => o.position.toArray()),
  );
  a.add(
    'node.quaternion',
    'f64',
    nodes.flatMap((o) => o.quaternion.toArray()),
  );
  a.add(
    'node.scale',
    'f64',
    nodes.flatMap((o) => o.scale.toArray()),
  );
  a.add(
    'node.pivot',
    'f64',
    nodes.flatMap((o) => (o.pivot ? o.pivot.toArray() : [0, 0, 0])),
  );
  a.add(
    'node.matrix',
    'f64',
    nodes.flatMap((o) => o.matrix.elements),
  );
  a.add(
    'node.matrixWorld',
    'f64',
    nodes.flatMap((o) => o.matrixWorld.elements),
  );

  const skinned = nodes.filter(
    (o): o is THREE.SkinnedMesh => (o as THREE.SkinnedMesh).isSkinnedMesh,
  );
  const skeletons = [...new Set(skinned.map((m) => m.skeleton))];
  a.add('skinned.node', 'u32', skinned.map(at));
  a.add(
    'skinned.bindMode',
    'u32',
    skinned.map((m) => (m.bindMode === THREE.AttachedBindMode ? 0 : 1)),
  );
  a.add(
    'skinned.skeleton',
    'u32',
    skinned.map((m) => skeletons.indexOf(m.skeleton)),
  );
  a.add(
    'skinned.bindMatrix',
    'f64',
    skinned.flatMap((m) => m.bindMatrix.elements),
  );
  a.add(
    'skinned.bindMatrixInverse',
    'f64',
    skinned.flatMap((m) => m.bindMatrixInverse.elements),
  );
  a.add(
    'skeleton.boneCount',
    'u32',
    skeletons.map((s) => s.bones.length),
  );
  a.add(
    'skeleton.bones',
    'u32',
    skeletons.flatMap((s) => s.bones.map(at)),
  );
  a.add(
    'skeleton.boneInverses',
    'f64',
    skeletons.flatMap((s) => s.boneInverses.flatMap((m) => m.elements)),
  );

  for (const slot of BONE_SLOTS) a.add(`profile.bones.${slot}`, 'u32', [at(profile.bones[slot])]);
  for (const s of ['L', 'R'] as const) {
    for (const f of FINGER_NAMES) {
      const chain = profile.fingerBones[`${f}.${s}`];
      if (chain) a.add(`profile.fingerBones.${f}.${s}`, 'u32', chain.map(at));
    }
  }
  for (const [key, dir] of Object.entries(profile.restDir)) {
    a.add(`profile.restDir.${key}`, 'f64', dir.toArray());
  }
  a.add('profile.sideSign', 'f64', [profile.sideSign]);
  for (const [key, length] of Object.entries(profile.limb))
    a.add(`profile.limb.${key}`, 'f64', [length]);
  if (profile.face) {
    for (const k of ['origin', 'right', 'up', 'forward'] as const) {
      a.add(`profile.face.${k}`, 'f64', profile.face[k].toArray());
    }
    a.add('profile.face.ipd', 'f64', [profile.face.ipd]);
    if (profile.face.mouth) a.add('profile.face.mouth', 'f64', profile.face.mouth.toArray());
  }
  if (profile.body) {
    for (const k of ['right', 'up', 'forward'] as const) {
      a.add(`profile.body.${k}`, 'f64', profile.body[k].toArray());
    }
    if (typeof profile.body.span === 'number')
      a.add('profile.body.span', 'f64', [profile.body.span]);
  }
  if (profile.anatomy) throw new Error('the base variant has no joint-table override to record');
  for (const [slot, binding] of Object.entries(profile.armTwists ?? {})) {
    if (!binding) continue;
    a.add(`profile.armTwists.${slot}.primary`, 'u32', [at(binding.primary)]);
    a.add(`profile.armTwists.${slot}.next`, 'u32', [at(binding.next)]);
    a.add(`profile.armTwists.${slot}.helper`, 'u32', [at(binding.helper)]);
  }
  for (const [slot, dir] of Object.entries(profile.avatar.armRest ?? {})) {
    if (dir) a.add(`avatar.armRest.${slot}`, 'f64', dir);
  }

  // What construction measures off the mesh; the vertex walk feeds these two and nothing else.
  const measured: Array<{ fixed: boolean; frame: number[]; result: volume.MeasuredVolume | null }> =
    [];
  const measure = volume.measureVolume;
  vi.spyOn(volume, 'measureVolume').mockImplementation((...args) => {
    const result = measure(...args);
    const [, , O, up, right, fwd, fixed] = args;
    measured.push({
      fixed: fixed !== undefined && fixed !== null,
      frame: [...O.toArray(), ...up.toArray(), ...right.toArray(), ...fwd.toArray()],
      result,
    });
    return result;
  });
  let director: Director;
  try {
    director = withCoreMath(() => new Director(profile, undefined, { random: splitmix64() }));
  } finally {
    vi.restoreAllMocks();
  }
  try {
    expect(measured.map((m) => m.fixed)).toEqual([true, false]);
    for (const [name, m] of [
      ['torso', measured[0]],
      ['head', measured[1]],
    ] as const) {
      const v = must(m.result, `${name} volume`);
      a.add(`measure.${name}.frame`, 'f64', m.frame);
      if (v.r) a.add(`measure.${name}.r`, 'f32', v.r);
      a.add(`measure.${name}.bands`, 'f64', [v.bands]);
      a.add(`measure.${name}.sectors`, 'f64', [v.sectors]);
      a.add(`measure.${name}.top`, 'f64', [v.top]);
      a.add(`measure.${name}.bottom`, 'f64', [v.bottom]);
      a.add(`measure.${name}.radius`, 'f64', [v.radius]);
    }
    const face = director.rig.anat.face as unknown as {
      pos: Float32Array;
      nrm: Float32Array;
    } | null;
    if (face) {
      a.add('measure.face.pos', 'f32', face.pos);
      a.add('measure.face.nrm', 'f32', face.nrm);
    }
  } finally {
    director.spring.dispose();
  }
  return { json: `${JSON.stringify({ arrays: a.index }, null, 1)}\n`, bin: a.bytes() };
}

// --- the anatomy battery ------------------------------------------------------------------

const BATTERY_KIND = oneOf(['frame', 'pose', 'volume', 'face']);
const clearanceRow = obj([
  ['valid', bool],
  ['distance', num],
  ['normal', vec3],
]);

/** The base avatar's `ArmAnatomy` through a fixed run of its queries; see the file comment. */
function recordArmBattery(): Recorded {
  const fixture = must(
    DIRECTOR_FIXTURES.find((f) => f.variant === BASE_VARIANT),
    'a base-variant fixture',
  );
  const { root, profile } = prepareFixture(fixture);
  root.updateMatrixWorld(true);
  const cases: Array<{ input: Field[]; output: Field[] }> = [];
  withCoreMath(() => {
    const anat = new ArmAnatomy(profile);
    anat.update();
    const dir = (k: number) =>
      new THREE.Vector3(
        Math.sin(k * 1.7 + 0.3),
        Math.cos(k * 2.3),
        Math.sin(k * 0.9 - 1.1),
      ).normalize();
    const step = (kind: string, input: Field[], output: Field[]) => {
      const head: Field[] = [];
      BATTERY_KIND(kind, 'kind', head);
      cases.push({ input: [...head, ...input], output });
    };

    const frame: Field[] = [];
    tuple2([anat.radialSign.L, anat.radialSign.R], 'radialSign', frame);
    for (const [name, v] of [
      ['up', anat.up],
      ['fwd', anat.fwd],
      ['right', anat.right],
      ['axisO', anat.axisO],
    ] as const) {
      vec3(v, name, frame);
    }
    step('frame', [], frame);

    for (const s of ['L', 'R'] as const) {
      for (let k = 0; k < 12; k++) {
        const [u, l, h] = [dir(k), dir(k + 0.4), dir(k + 0.7)];
        const palm = k % 2 ? dir(k + 3.1) : null;
        const forearmRoll = 0.1 * k - 0.5;
        const humeralRoll = k % 3 ? 0 : 0.3;
        const [cu, cl, ch] = [dir(k + 5), dir(k + 5.2), dir(k + 5.5)];
        const input: Field[] = [];
        side(s, 'side', input);
        for (const [name, v] of [
          ['u', u],
          ['l', l],
          ['h', h],
        ] as const) {
          vec3(v, name, input);
        }
        opt(vec3)(palm, 'palm', input);
        num(forearmRoll, 'forearmRoll', input);
        num(humeralRoll, 'humeralRoll', input);
        for (const [name, v] of [
          ['clear.u', cu],
          ['clear.l', cl],
          ['clear.h', ch],
        ] as const) {
          vec3(v, name, input);
        }

        const bone = must(profile.bones[`upperArm.${s}`], `upperArm.${s}`);
        anat.setArm(
          bone.getWorldPosition(new THREE.Vector3()),
          profile.limb[`upper.${s}`],
          profile.limb[`lower.${s}`],
          profile.limb[`tip.${s}.middle`] * 0.35,
        );
        const output: Field[] = [];
        const m = anat.measure(s, u, l, h, palm, forearmRoll, humeralRoll);
        nums([
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
        ])(m, 'measure', output);
        num(anat.cost(), 'cost', output);
        anat.clamp(s, u, l, h, palm);
        for (const [name, v] of [
          ['clamp.u', u],
          ['clamp.l', l],
          ['clamp.h', h],
        ] as const) {
          vec3(v, name, output);
        }
        bool(anat.clearHand(s, cu, cl, ch), 'clearHand', output);
        for (const [name, v] of [
          ['clearHand.u', cu],
          ['clearHand.l', cl],
          ['clearHand.h', ch],
        ] as const) {
          vec3(v, name, output);
        }
        step('pose', input, output);
      }
    }

    const volumes = makeBodyVolumeFrame();
    anat.captureVolumeFrame(volumes);
    const rows: BodyClearance[] = (['torso', 'head'] as const).map((surface) => ({
      surface,
      valid: false,
      distance: Number.POSITIVE_INFINITY,
      normal: new THREE.Vector3(),
    }));
    for (let k = 0; k < 16; k++) {
      const P = anat.axisO
        .clone()
        .addScaledVector(dir(k), 0.03 + 0.012 * k)
        .addScaledVector(anat.up, -0.15 + 0.03 * k);
      const input: Field[] = [];
      vec3(P, 'point', input);
      anat.sampleVolumeClearances(volumes, P, rows);
      const output: Field[] = [];
      clearanceRow(rows[0], 'torso', output);
      clearanceRow(rows[1], 'head', output);
      num(anat.surface(P), 'surface.depth', output);
      vec3(P, 'surface.point', output);
      step('volume', input, output);
    }

    const face = must(anat.face, 'a face surface');
    const head = must(profile.bones.head, 'head').getWorldPosition(new THREE.Vector3());
    const sample = { distance: 0, normal: new THREE.Vector3(), valid: false };
    for (let k = 0; k < 16; k++) {
      const P = head.clone().addScaledVector(dir(k + 9), 0.02 + 0.006 * k);
      const input: Field[] = [];
      vec3(P, 'point', input);
      face.refresh();
      face.sample(P, sample);
      const output: Field[] = [];
      clearanceRow(sample, 'face', output);
      step('face', input, output);
    }
  });
  const input = layout(cases.map((c) => c.input));
  const output = layout(cases.map((c) => c.output));
  const values: number[] = [];
  for (const c of cases) {
    fill(values, c.input, input);
    fill(values, c.output, output);
  }
  const index = { fn: 'arm-battery', cases: cases.length, in: input, out: output };
  return { json: `${JSON.stringify(index, null, 1)}\n`, bin: f64Bytes(values) };
}

// --- the rig battery ------------------------------------------------------------------------

const RIG_KINDS = [
  'skeleton.build',
  'legs.create',
  'spine.build',
  'anat.build',
  'update',
  'skeleton.run',
  'legs.apply',
  'legs.pivot',
  'spine.commit',
  'spine.eyes',
  'spine.head',
  'girdle.room',
  'girdle.turn',
  'reach.near',
  'reach.ref',
  'reach.solve',
  'reach.pole',
  'reach.swivel',
  'elbow.search',
  'point.solve',
] as const;
type RigKind = (typeof RIG_KINDS)[number];
const RIG_KIND = oneOf(RIG_KINDS);
const OFFSET_SLOTS: readonly OffsetSlot[] = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'eye.L',
  'eye.R',
];
const offsetSlot = oneOf(OFFSET_SLOTS);
const nodeState = obj([
  ['node', num],
  ['position', vec3],
  ['quaternion', quat],
  ['matrixWorld', tuple(16)],
  ['matrixWorldNeedsUpdate', bool],
]);
const nodeWrite = obj([
  ['node', num],
  ['position', vec3],
  ['quaternion', quat],
]);
const spineAdd = obj([
  ['slot', offsetSlot],
  ['offset', tuple3],
]);

/** The base avatar's rig leaf modules through a fixed run of their calls; see the file comment. */
function recordRigBattery(): Recorded {
  const fixture = must(
    DIRECTOR_FIXTURES.find((f) => f.variant === BASE_VARIANT),
    'a base-variant fixture',
  );
  const { root, profile } = prepareFixture(fixture);
  root.updateMatrixWorld(true);
  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => {
    nodes.push(o);
  });
  const at = (o: THREE.Object3D) => {
    const i = nodes.indexOf(o);
    if (i < 0) throw new Error(`${o.name} is not under the root`);
    return i;
  };
  const bone = (slot: BoneSlot) => must(profile.bones[slot], slot);
  const cases: Array<{ input: Field[]; output: Field[] }> = [];

  const hash = (out: Field[]) => {
    const h = makeFnv64();
    for (const o of nodes) {
      h.f64s(o.position.toArray());
      h.f64s(o.quaternion.toArray());
      h.f64s(o.scale.toArray());
      h.f64s(o.matrix.elements);
      h.f64s(o.matrixWorld.elements);
      h.bool(o.matrixWorldNeedsUpdate);
    }
    const d = h.digest();
    tuple2([Number.parseInt(d.slice(0, 8), 16), Number.parseInt(d.slice(8), 16)], 'hash', out);
  };
  const touched = (bones: THREE.Object3D[], out: Field[]) =>
    arr(nodeState)(
      bones.map((b) => ({
        node: at(b),
        position: b.position,
        quaternion: b.quaternion,
        matrixWorld: [...b.matrixWorld.elements],
        matrixWorldNeedsUpdate: b.matrixWorldNeedsUpdate,
      })),
      'touched',
      out,
    );
  /** Write `set` and run the full pass when asked, then the call, then the hash. */
  const step = (
    kind: RigKind,
    setup: { set?: [THREE.Object3D, THREE.Vector3, THREE.Quaternion]; update?: boolean },
    input: Field[],
    call: (output: Field[]) => void,
  ) => {
    const head: Field[] = [];
    RIG_KIND(kind, 'kind', head);
    const set = setup.set;
    opt(nodeWrite)(
      set ? { node: at(set[0]), position: set[1], quaternion: set[2] } : null,
      'set',
      head,
    );
    bool(setup.update ?? false, 'update', head);
    if (set) {
      set[0].position.copy(set[1]);
      set[0].quaternion.copy(set[2]);
    }
    if (setup.update) root.updateMatrixWorld(true);
    const output: Field[] = [];
    call(output);
    hash(output);
    cases.push({ input: [...head, ...input], output });
  };

  withCoreMath(() => {
    const rest = new Map<THREE.Object3D, THREE.Quaternion>();
    for (const o of nodes) rest.set(o, o.quaternion.clone());
    const restOf = (b: THREE.Bone) => must(rest.get(b), b.name);
    const joints = profile.anatomy ?? JOINTS;

    const skeleton = new SkeletonRefresh(root);
    step('skeleton.build', {}, [], (out) => {
      const s = skeleton as unknown as { path: THREE.Object3D[]; subtrees: THREE.Object3D[] };
      arr(num)(s.path.map(at), 'path', out);
      arr(num)(s.subtrees.map(at), 'subtrees', out);
    });

    let legs: GroundedLegs | null = null;
    step('legs.create', {}, [], (out) => {
      legs = must(GroundedLegs.create(profile, restOf), 'grounded legs');
      const state = (legs as unknown as { legs: Record<Side, Record<string, unknown>> }).legs;
      for (const s of ['L', 'R'] as const) {
        vec3(state[s].kneePole, `legs.${s}.kneePole`, out);
        vec3(state[s].anchorRoot, `legs.${s}.anchorRoot`, out);
        num(state[s].softZone, `legs.${s}.softZone`, out);
        num(state[s].upperLength, `legs.${s}.upperLength`, out);
        num(state[s].lowerLength, `legs.${s}.lowerLength`, out);
      }
    });
    const grounded = must<GroundedLegs>(legs, 'grounded legs');

    const spine = new SpineOffsets(profile);
    step('spine.build', {}, [], (out) => {
      const basis = (spine as unknown as { basis: Map<OffsetSlot, { q: THREE.Quaternion }> }).basis;
      for (const slot of OFFSET_SLOTS) opt(quat)(basis.get(slot)?.q, `basis.${slot}`, out);
    });

    const anat = new ArmAnatomy(profile);
    step('anat.build', {}, [], (out) => {
      bool(anat.update(), 'ok', out);
    });

    // --- legs ---
    const hips = bone('hips');
    const legBones = [
      hips,
      ...(['L', 'R'] as const).flatMap((s) =>
        (['upperLeg', 'lowerLeg', 'foot'] as const).map((k) => bone(`${k}.${s}`)),
      ),
    ];
    const hipsRest = hips.position.clone();
    const hipsRestQ = hips.quaternion.clone();
    const span = bone('upperLeg.L')
      .getWorldPosition(new THREE.Vector3())
      .distanceTo(bone('foot.L').getWorldPosition(new THREE.Vector3()));
    const state = (grounded as unknown as { legs: Record<Side, Record<string, number>> }).legs;
    const gap = state.L.upperLength + state.L.lowerLength - span;
    const hipsAt = (x: number, y: number, z: number, q = hipsRestQ) =>
      [hips, hipsRest.clone().add(new THREE.Vector3(x, y, z)), q.clone()] as [
        THREE.Object3D,
        THREE.Vector3,
        THREE.Quaternion,
      ];
    const apply = (
      rise: number,
      turn: number,
      refresh: boolean,
      setup: Parameters<typeof step>[1] = {},
    ) => {
      const input: Field[] = [];
      num(rise, 'rise', input);
      num(turn, 'yaw', input);
      bool(refresh, 'refresh', input);
      step('legs.apply', setup, input, (out) => {
        bool(grounded.apply(rise, turn, refresh ? skeleton : null), 'ok', out);
        touched(legBones, out);
      });
    };
    apply(0, 0, false);
    apply(0, 0, false, { set: hipsAt(0.012, -0.035, 0.006) });
    // Near full extension, so the soft reach settles the pelvis.
    apply(0, 0, false, { set: hipsAt(0, gap * 0.5, 0) });
    apply(0.03, 0, false, { set: hipsAt(0.01, -0.01, 0) });
    apply(0, Math.PI / 2, false, { set: hipsAt(0, -0.02, 0.01), update: true });
    apply(0.02, -0.7, true, {
      set: hipsAt(
        -0.01,
        -0.015,
        0,
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.08)),
      ),
      update: true,
    });
    step('legs.pivot', {}, [], (out) => {
      vec3(grounded.stancePivot(new THREE.Vector3()), 'value3', out);
    });
    // No common reach: the pose is left as it was.
    apply(0, 0, false, { set: hipsAt(0.5, 0, 0) });

    // --- skeleton ---
    step(
      'skeleton.run',
      {
        set: [
          bone('spine'),
          bone('spine').position.clone(),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, -0.2, 0.05)),
        ],
      },
      [],
      () => {
        skeleton.run();
      },
    );
    step('update', { set: hipsAt(0, 0, 0) }, [], () => {
      root.updateMatrixWorld(true);
    });

    // --- spine ---
    const spineBones = OFFSET_SLOTS.slice(0, 5).map((slot) => bone(slot));
    const eyeBones = [bone('eye.L'), bone('eye.R')];
    const commit = (adds: Array<[OffsetSlot, Vec3Tuple]>) => {
      const input: Field[] = [];
      arr(spineAdd)(
        adds.map(([slot, offset]) => ({ slot, offset })),
        'adds',
        input,
      );
      step('spine.commit', {}, input, (out) => {
        spine.clear();
        for (const [slot, [x, y, z]] of adds) spine.add(slot, x, y, z);
        spine.commit(profile, restOf);
        touched(spineBones, out);
      });
    };
    // Past every knee but the neck's, so the bound's tanh runs; the eyes ride along unbounded.
    commit([
      ['head', [1.5, 0.32, 0]],
      ['head', [0.1, -0.2, 0.05]],
      ['chest', [0.08, -0.4, 0.05]],
      ['neck', [-0.11, 0.06, 0.13]],
      ['hips', [0.3, 0, -0.5]],
      ['spine', [0.02, 0.01, 0]],
      ['eye.L', [-0.08, 0.1, 0.06]],
      ['eye.R', [0.05, 0, 0]],
    ]);
    step('spine.head', {}, [], (out) => {
      const q = new THREE.Quaternion();
      bool(spine.readHeadOffset(profile, q), 'ok', out);
      quat(q, 'q', out);
    });
    step('spine.eyes', {}, [], (out) => {
      spine.commitEyes(profile, restOf);
      touched(eyeBones, out);
    });
    commit([
      ['hips', [0.01, 0.02, -0.03]],
      ['head', [-0.2, 0.1, 0]],
    ]);
    step('update', {}, [], () => {
      root.updateMatrixWorld(true);
    });
    step('anat.build', {}, [], (out) => {
      bool(anat.update(), 'ok', out);
    });

    // --- girdle ---
    const girdle = new ShoulderGirdle(profile, joints);
    const shoulder = (s: Side) => bone(`upperArm.${s}`).getWorldPosition(new THREE.Vector3());
    const clavicle = (s: Side) => bone(`shoulder.${s}`).getWorldPosition(new THREE.Vector3());
    for (const [s, ahead, weight] of [
      ['R', 0.04, 1],
      ['R', 0.04, 0.6],
      ['L', 0.07, 1],
    ] as const) {
      const aim = shoulder(s).sub(clavicle(s)).normalize();
      const dir: Vec3Tuple = [aim.x, aim.y, aim.z];
      const target = shoulder(s).addScaledVector(anat.fwd, ahead);
      const turn = new THREE.Vector3(0.01, 0, 0);
      const input: Field[] = [];
      side(s, 'side', input);
      vec3(target, 'target', input);
      tuple3(dir, 'dir', input);
      num(weight, 'weight', input);
      vec3(turn, 'turn', input);
      step('girdle.room', {}, input, (out) => {
        girdle.girdleRoom(s, target, dir, weight, turn);
        vec3(turn, 'value3', out);
      });
      const turnInput: Field[] = [];
      tuple3(dir, 'dir', turnInput);
      vec3(turn, 'turn', turnInput);
      step('girdle.turn', {}, turnInput, (out) => {
        girdle.turnGirdle(dir, turn);
        tuple3(dir, 'value3', out);
      });
    }

    // --- reach ---
    const sR = shoulder('R');
    const sL = shoulder('L');
    const off = (s: THREE.Vector3, x: number, y: number, z: number) =>
      s.clone().add(new THREE.Vector3(x, y, z));
    const nearInput: Field[] = [];
    num(profile.limb['upper.R'], 'la', nearInput);
    num(profile.limb['lower.R'], 'lf', nearInput);
    step('reach.near', {}, nearInput, (out) => {
      num(nearReach(profile.limb['upper.R'], profile.limb['lower.R'], joints), 'value', out);
    });
    for (const [n, framed] of [
      [new THREE.Vector3(0, -1, 0), null],
      [new THREE.Vector3(-0.4, -0.6, -0.7).normalize(), true],
      [anat.fwd.clone(), null],
      [new THREE.Vector3(0, 0, 1), false],
    ] as const) {
      const input: Field[] = [];
      vec3(n, 'n', input);
      opt(bool)(framed, 'framed', input);
      step('reach.ref', {}, input, (out) => {
        vec3(reachRef(anat, n, new THREE.Vector3(), framed ?? undefined), 'value3', out);
      });
    }
    for (const [s, target, angle, framed] of [
      ['R', off(sR, -0.05, -0.05, -0.2), 0, null],
      ['R', off(sR, 0, -0.2, -1), 0.4, null],
      ['R', off(sR, 0, 0, -0.03), -0.7, true],
      ['L', off(sL, 0.06, -0.08, -0.19), 1.2, false],
      ['R', sR.clone(), 0, null],
    ] as const) {
      const input: Field[] = [];
      side(s, 'side', input);
      vec3(target, 'target', input);
      num(angle, 'angle', input);
      opt(bool)(framed, 'framed', input);
      step('reach.solve', {}, input, (out) => {
        const links: ReachLinks = { upperArm: new THREE.Vector3(), lowerArm: new THREE.Vector3() };
        const solved = solveReach(
          profile,
          joints,
          anat,
          s,
          target,
          angle,
          links,
          framed ?? undefined,
        );
        bool(solved !== null, 'ok', out);
        vec3(links.upperArm, 'upperArm', out);
        vec3(links.lowerArm, 'lowerArm', out);
      });
    }
    const reachTarget = off(sR, -0.05, -0.05, -0.2);
    const reachLine = reachTarget.clone().sub(sR).normalize();
    for (const pole of [
      off(sR, 0.3, -0.3, 0),
      off(sR, -0.25, -0.2, 0.1),
      sR.clone().addScaledVector(reachLine, 0.2),
      sR.clone(),
    ]) {
      const input: Field[] = [];
      vec3(reachTarget, 'target', input);
      vec3(pole, 'pole', input);
      step('reach.pole', {}, input, (out) => {
        const a = poleAngle(profile, anat, 'R', reachTarget, pole);
        bool(a !== null, 'ok', out);
        num(a ?? 0, 'value', out);
      });
    }
    for (const [w, framed] of [
      [new THREE.Vector3(0.2, -0.1, 0.05), true],
      [
        reachLine
          .clone()
          .multiplyScalar(0.3)
          .add(new THREE.Vector3(0, 0.01, 0)),
        null,
      ],
    ] as const) {
      const input: Field[] = [];
      vec3(reachLine, 'n', input);
      vec3(w, 'w', input);
      opt(bool)(framed, 'framed', input);
      step('reach.swivel', {}, input, (out) => {
        const a = swivelOf(anat, reachLine, w, framed ?? undefined);
        bool(a !== null, 'ok', out);
        num(a ?? 0, 'value', out);
      });
    }

    // --- elbow and point, wired as `Rig` wires them ---
    let dt = 1 / 60;
    const armContext = (s: Side): boolean => {
      const upper = profile.bones[`upperArm.${s}`];
      const La = profile.limb?.[`upper.${s}`];
      if (!(upper && La)) {
        anat.clearArm();
        return false;
      }
      upper.updateWorldMatrix(true, false);
      anat.setArm(
        upper.getWorldPosition(new THREE.Vector3()),
        La,
        profile.limb?.[`lower.${s}`] ?? 0,
        (profile.limb?.[`tip.${s}.middle`] ?? 0) * HAND_CONTACT,
      );
      return true;
    };
    const elbow = new ElbowSearch(profile, anat, {
      solveReach: (s, target, angle, out, framed) =>
        solveReach(profile, joints, anat, s, target, angle, out, framed),
      armContext,
      dt: () => dt,
    });
    const point = new PointSolver(profile, joints, anat, (s, wrist, handDir, palmN, out) =>
      elbow.search(s, wrist, handDir, palmN, out),
    );
    const slots: ArmSolution[] = Array.from({ length: 4 }, () => ({
      upperArm: new THREE.Vector3(),
      lowerArm: new THREE.Vector3(),
      hand: new THREE.Vector3(),
      palm: new THREE.Vector3(),
      tip: new THREE.Vector3(),
      twist: 0,
      swivelDir: new THREE.Vector3(),
    }));
    const solution = (slot: number, out: Field[]) => {
      const o = slots[slot];
      vec3(o.upperArm, 'upperArm', out);
      vec3(o.lowerArm, 'lowerArm', out);
      vec3(o.swivelDir, 'swivelDir', out);
    };
    const limbSpan = profile.limb['upper.R'] + profile.limb['lower.R'];
    const ahead = sR.clone().add(new THREE.Vector3(-0.2, 0.25, 0.6).multiplyScalar(limbSpan));
    const across = sR.clone().add(new THREE.Vector3(-0.6, -0.1, 0.4).multiplyScalar(limbSpan));
    const near = off(sR, -0.05, 0.02, -0.12);
    const down = new THREE.Vector3(0, -1, 0);
    for (const [s, slot, wrist, handDir, palmN, pole, stepDt] of [
      ['R', 0, ahead, null, null, null, 1 / 60],
      ['R', 0, across, null, null, null, 1 / 60],
      ['R', 0, across, null, null, null, 1 / 144],
      ['R', 0, ahead, null, null, null, 0.05],
      ['R', 1, near, new THREE.Vector3(0, 0.3, -1).normalize(), down, null, 1 / 60],
      ['R', 1, near, null, null, off(sR, 0.15, -0.2, 0.05), 1 / 60],
      ['R', 1, near, null, null, off(sR, 0.15, -0.2, 0.05), 1 / 60],
      ['L', 2, off(sL, 0.1, -0.1, -0.2), null, null, null, 1 / 30],
    ] as const) {
      const input: Field[] = [];
      side(s, 'side', input);
      num(slot, 'slot', input);
      vec3(wrist, 'target', input);
      opt(vec3)(handDir, 'handDir', input);
      opt(vec3)(palmN, 'palmN', input);
      opt(vec3)(pole, 'pole', input);
      num(stepDt, 'dt', input);
      step('elbow.search', {}, input, (out) => {
        dt = stepDt;
        const strain = elbow.search(s, wrist, handDir, palmN, slots[slot], pole);
        bool(strain !== null, 'ok', out);
        num(strain ?? 0, 'value', out);
        solution(slot, out);
      });
    }
    const spec = (azimuth: number, elevation: number, extent?: number): PointRequest => ({
      azimuth,
      elevation,
      ...(extent === undefined ? {} : { extent }),
    });
    for (const [s, slot, request, stepDt] of [
      ['R', 3, spec(0.2, 0.35, 0.75), 1 / 60],
      ['R', 3, spec(0.2, 0.35, 0.75), 1 / 60],
      ['R', 3, spec(0.2, 0.35, 0.75), 1 / 60],
      ['R', 3, { ...spec(0.3, 0.2), finger: 'thumb' }, 1 / 144],
      ['R', 3, { ...spec(0.3, 0.2, 0.5), point: new THREE.Vector3(0, -1, 0) }, 1 / 60],
      ['R', 3, { ...spec(-0.9, 0.6, 0.7), palm: [0, 0, 1] as Vec3Tuple }, 1 / 60],
      ['R', 0, spec(0, 0, 0.1), 0.05],
      ['L', 2, spec(-0.5, 0.3, 4), 1 / 60],
    ] as const) {
      const r = request as PointRequest;
      const input: Field[] = [];
      side(s, 'side', input);
      num(slot, 'slot', input);
      num(r.azimuth ?? 0, 'azimuth', input);
      num(r.elevation ?? 0, 'elevation', input);
      opt(num)(r.extent, 'extent', input);
      opt(finger)(r.finger, 'finger', input);
      opt(vec3)(r.point ?? null, 'point', input);
      opt(tuple3)(r.palm ?? null, 'palm', input);
      num(stepDt, 'dt', input);
      step('point.solve', {}, input, (out) => {
        dt = stepDt;
        const o = slots[slot];
        bool(point.solve(s, r, o) !== null, 'ok', out);
        solution(slot, out);
        vec3(o.hand, 'hand', out);
        vec3(o.palm, 'palm', out);
        vec3(o.tip, 'tip', out);
        num(o.twist, 'twist', out);
        num(o.strain ?? 0, 'value', out);
      });
    }
  });
  const input = layout(cases.map((c) => c.input));
  const output = layout(cases.map((c) => c.output));
  const values: number[] = [];
  for (const c of cases) {
    fill(values, c.input, input);
    fill(values, c.output, output);
  }
  const index = { fn: 'rig-a-battery', cases: cases.length, in: input, out: output };
  return { json: `${JSON.stringify(index, null, 1)}\n`, bin: f64Bytes(values) };
}

// --- the rig-b battery --------------------------------------------------------------------

const RIG_B_KINDS = [
  'axes.solve',
  'hands.build',
  'hands.curlHand',
  'hands.curlFinger',
  'update',
  'geometry.capture',
  'geometry.sample',
  'contact.capture',
  'contact.sample',
  'clearance.build',
  'clearance.note',
  'clearance.curl',
  'arm.calibrate',
  'arm.forward',
  'arm.bound',
  'arm.inverse',
  'hand.frame',
] as const;
type RigBKind = (typeof RIG_B_KINDS)[number];
const RIG_B_KIND = oneOf(RIG_B_KINDS);
const fingerSpec = obj(FINGER_NAMES.map((f) => [f, opt(num)] as const));
const contactSurface = oneOf(['center', 'pad', 'back']);
const calibrationInputFlat = obj([
  [
    'upper',
    obj([
      ['axis', vec3],
      ['rest', quat],
      ['front', vec3],
    ]),
  ],
  [
    'lower',
    obj([
      ['axis', vec3],
      ['rest', quat],
    ]),
  ],
  [
    'hand',
    obj([
      ['axis', vec3],
      ['rest', quat],
      ['palm', vec3],
    ]),
  ],
  ['radialSign', num],
]);
const nodeQuaternion = obj([
  ['node', num],
  ['quaternion', quat],
]);
/** The joint tables `arm.calibrate` captures with, by index. */
const ARM_JOINTS: readonly JointTable[] = [
  JOINTS,
  {
    ...JOINTS,
    wrist: {
      ...JOINTS.wrist,
      dofs: {
        ...JOINTS.wrist.dofs,
        flexion: { ...JOINTS.wrist.dofs.flexion, max: [-Math.PI / 2, Math.PI / 2] },
        deviation: { ...JOINTS.wrist.dofs.deviation, max: [0, 0] },
      },
    },
  },
  {
    ...JOINTS,
    elbow: {
      ...JOINTS.elbow,
      dofs: {
        ...JOINTS.elbow.dofs,
        rotation: { ...JOINTS.elbow.dofs.rotation, max: [-7, 7] },
      },
    },
  },
];
const CALIBRATION_REFUSALS = [
  'arm calibration axis must be nonzero',
  'upper humeral front must not parallel its axis',
  'hand palm normal must not parallel its axis',
  'wrist hard ranges must stay inside a 90 degree combined bend',
] as const;

/** A value that may be absent, for a digest: 0 alone, or 1 and its components. */
function present(into: number[], v: THREE.Vector3 | number | null | undefined): void {
  if (v === null || v === undefined) into.push(0);
  else if (typeof v === 'number') into.push(1, v);
  else into.push(1, v.x, v.y, v.z);
}

function digest(values: readonly number[], out: Field[]): void {
  const h = makeFnv64();
  h.f64s(values);
  const d = h.digest();
  tuple2([Number.parseInt(d.slice(0, 8), 16), Number.parseInt(d.slice(8), 16)], 'digest', out);
}

/**
 * The base avatar's finger and arm-configuration modules through a fixed run of their calls;
 * see the file comment.
 */
function recordRigBBattery(): Recorded {
  const fixture = must(
    DIRECTOR_FIXTURES.find((f) => f.variant === BASE_VARIANT),
    'a base-variant fixture',
  );
  const { root, profile } = prepareFixture(fixture);
  root.updateMatrixWorld(true);
  // Inputs are worked out on a second copy: a world read updates the matrices on its way, so
  // reading the recorded tree between steps would change what the next step's hash sees.
  const twin = prepareFixture(fixture);
  twin.root.updateMatrixWorld(true);
  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => {
    nodes.push(o);
  });
  const twinNodes: THREE.Object3D[] = [];
  twin.root.traverse((o) => {
    twinNodes.push(o);
  });
  const at = (o: THREE.Object3D) => {
    const i = nodes.indexOf(o);
    if (i < 0) throw new Error(`${o.name} is not under the root`);
    return i;
  };
  const p = twin.profile;
  const twinBone = (slot: BoneSlot) => must(p.bones[slot], slot);
  const cases: Array<{ input: Field[]; output: Field[] }> = [];

  const hash = (out: Field[]) => {
    const h = makeFnv64();
    for (const o of nodes) {
      h.f64s(o.position.toArray());
      h.f64s(o.quaternion.toArray());
      h.f64s(o.scale.toArray());
      h.f64s(o.matrix.elements);
      h.f64s(o.matrixWorld.elements);
      h.bool(o.matrixWorldNeedsUpdate);
    }
    const d = h.digest();
    tuple2([Number.parseInt(d.slice(0, 8), 16), Number.parseInt(d.slice(8), 16)], 'hash', out);
  };
  const handBone = (s: Side) => must(profile.bones[`hand.${s}`], `hand.${s}`);
  const fingerBones = (s: Side) =>
    FINGER_NAMES.flatMap((f) => profile.fingerBones[`${f}.${s}`] ?? []);
  const touched = (bones: THREE.Object3D[], out: Field[]) =>
    arr(nodeQuaternion)(
      bones.map((b) => ({ node: at(b), quaternion: b.quaternion })),
      'touched',
      out,
    );
  /** Write `set` (a node of the twin, by index) and run the full pass when asked, then the call. */
  const step = (
    kind: RigBKind,
    setup: { set?: [number, THREE.Vector3, THREE.Quaternion]; update?: boolean },
    input: Field[],
    call: (output: Field[]) => void,
  ) => {
    const head: Field[] = [];
    RIG_B_KIND(kind, 'kind', head);
    const set = setup.set;
    opt(nodeWrite)(
      set ? { node: set[0], position: set[1], quaternion: set[2] } : null,
      'set',
      head,
    );
    bool(setup.update ?? false, 'update', head);
    if (set) {
      nodes[set[0]].position.copy(set[1]);
      nodes[set[0]].quaternion.copy(set[2]);
    }
    if (setup.update) root.updateMatrixWorld(true);
    const output: Field[] = [];
    call(output);
    hash(output);
    cases.push({ input: [...head, ...input], output });
  };

  // --- inputs, from the twin ---
  const twinAxes = solveFingerAxes(p);
  const twinAnat = new ArmAnatomy(p);
  expect(twinAnat.update()).toBe(true);
  const contextOf = (s: Side): armConfiguration.ArmForwardContext => {
    const upper = twinBone(`upperArm.${s}`);
    upper.updateWorldMatrix(true, false);
    return {
      side: s,
      shoulder: upper.getWorldPosition(new THREE.Vector3()),
      upperLength: p.limb[`upper.${s}`],
      lowerLength: p.limb[`lower.${s}`],
      up: twinAnat.up.clone(),
      right: twinAnat.right.clone(),
      forward: twinAnat.fwd.clone(),
      upperParentWorld: must(upper.parent, 'upper parent').getWorldQuaternion(
        new THREE.Quaternion(),
      ),
    };
  };
  const contexts = { L: contextOf('L'), R: contextOf('R') };
  /** What `ArmDriver.create` hands `captureArmCalibration`, with the front `Rig` derives. */
  const calibrationInputOf = (s: Side) => {
    const upper = twinBone(`upperArm.${s}`);
    const lower = twinBone(`lowerArm.${s}`);
    const hand = twinBone(`hand.${s}`);
    const chest = twinBone('chest');
    const parentWorld = must(upper.parent, 'upper parent').getWorldQuaternion(
      new THREE.Quaternion(),
    );
    const upperWorld = upper.getWorldQuaternion(new THREE.Quaternion());
    const lowerWorld = lower.getWorldQuaternion(new THREE.Quaternion());
    const handWorld = hand.getWorldQuaternion(new THREE.Quaternion());
    const along = p.restDir[`upperArm.${s}`].clone().applyQuaternion(upperWorld);
    const front = must(p.body, 'body frame')
      .forward.clone()
      .applyQuaternion(chest.getWorldQuaternion(new THREE.Quaternion()));
    front.addScaledVector(along, -front.dot(along));
    front.normalize().applyQuaternion(upperWorld.clone().invert());
    return {
      upper: {
        axis: p.restDir[`upperArm.${s}`].clone(),
        rest: parentWorld.clone().invert().multiply(upperWorld),
        front,
      },
      lower: {
        axis: p.restDir[`lowerArm.${s}`].clone(),
        rest: upperWorld.clone().invert().multiply(lowerWorld),
      },
      hand: {
        axis: p.restDir[`hand.${s}`].clone(),
        rest: lowerWorld.clone().invert().multiply(handWorld),
        palm: must(twinAxes.palmLocal[s], `palm ${s}`).clone(),
      },
      radialSign: twinAnat.radialSign[s],
    };
  };
  /** The hand set `depth` hand lengths in front of the mouth, its fingers aimed into the face. */
  const handAtFace = (
    s: Side,
    depth: number,
    across: number,
  ): [number, THREE.Vector3, THREE.Quaternion] => {
    const head = twinBone('head');
    const lower = twinBone(`lowerArm.${s}`);
    const hand = twinBone(`hand.${s}`);
    const face = must(p.face, 'face frame');
    head.updateWorldMatrix(true, false);
    const mouth = (face.mouth ?? face.origin).clone().applyMatrix4(head.matrixWorld);
    const fwd = face.forward.clone().transformDirection(head.matrixWorld);
    const right = face.right.clone().transformDirection(head.matrixWorld);
    const length = p.limb[`tip.${s}.middle`];
    const target = mouth.addScaledVector(fwd, depth * length).addScaledVector(right, across);
    const aim = fwd
      .clone()
      .negate()
      .addScaledVector(right, -across * 4)
      .normalize();
    const handWorld = hand.getWorldQuaternion(new THREE.Quaternion());
    const axis = p.restDir[`hand.${s}`].clone().applyQuaternion(handWorld).normalize();
    const world = new THREE.Quaternion().setFromUnitVectors(axis, aim).multiply(handWorld);
    lower.updateWorldMatrix(true, false);
    const local = lower.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(world);
    return [twinNodes.indexOf(hand), lower.worldToLocal(target.clone()), local];
  };

  withCoreMath(() => {
    const rest = new Map<THREE.Object3D, THREE.Quaternion>();
    for (const o of nodes) rest.set(o, o.quaternion.clone());
    const restOf = (b: THREE.Bone) => must(rest.get(b), b.name);
    const joints = profile.anatomy ?? JOINTS;
    const clearanceOf = (s: Side) => 0.5 * FINGER_WIDTH * (profile.limb?.[`pitch.${s}`] ?? 0);

    // --- finger axes and curls ---
    let solved: FingerAxes | null = null;
    step('axes.solve', {}, [], (out) => {
      solved = solveFingerAxes(profile);
      const v: number[] = [];
      for (const s of ['L', 'R'] as const) {
        for (const f of FINGER_NAMES) {
          for (const b of profile.fingerBones[`${f}.${s}`] ?? []) {
            present(v, (solved as FingerAxes).axes.get(b));
            present(v, (solved as FingerAxes).splayAxes.get(b));
            present(v, (solved as FingerAxes).oppositionSign.get(b));
          }
        }
      }
      for (const s of ['L', 'R'] as const) present(v, (solved as FingerAxes).palmLocal[s]);
      digest(v, out);
    });
    const axes = must<FingerAxes>(solved, 'finger axes');
    let built: Hands | null = null;
    step('hands.build', {}, [], () => {
      built = new Hands(profile, joints, restOf);
    });
    const hands = must<Hands>(built, 'hands');

    const curlHand = (s: Side, spec: FingerSpec, spread: FingerSpec) => {
      const input: Field[] = [];
      side(s, 'side', input);
      fingerSpec(spec, 'spec', input);
      fingerSpec(spread, 'spread', input);
      step('hands.curlHand', {}, input, (out) => {
        hands.curlHand(s, spec, spread);
        touched(fingerBones(s), out);
      });
    };
    curlHand('R', { index: 0.6, middle: 0.3 }, {});
    // Past the opposition ramp, with every knuckle splayed.
    curlHand(
      'R',
      { thumb: 0.8, index: 1, middle: 1, ring: 1, little: 1 },
      { thumb: 0.2, index: 0.12, middle: -0.08 },
    );
    curlHand('L', { thumb: 1, index: 0.2, ring: 1.4, little: -0.5 }, { thumb: -0.1, little: 0.3 });
    curlHand('L', { thumb: 0.3 }, { index: 0.4, little: 0.4 });
    step('update', {}, [], () => {
      root.updateMatrixWorld(true);
    });
    for (const [f, s, amount, spread] of [
      ['thumb', 'R', 0.5, 0.1],
      ['thumb', 'L', 1, 0],
      ['index', 'L', -5, 0.2],
      ['little', 'R', 5, -0.3],
      ['ring', 'R', 0.4, 0],
    ] as const) {
      const input: Field[] = [];
      finger(f, 'finger', input);
      side(s, 'side', input);
      num(amount, 'amount', input);
      num(spread, 'spreadAmount', input);
      step('hands.curlFinger', {}, input, (out) => {
        hands.curlFinger(f, s, amount, spread);
        touched(fingerBones(s), out);
      });
    }
    step('update', {}, [], () => {
      root.updateMatrixWorld(true);
    });

    // --- hand geometry and contact landmarks ---
    const geometry: Partial<Record<Side, HandGeometryCalibration>> = {};
    const samples: Partial<Record<Side, HandGeometrySample>> = {};
    for (const s of ['L', 'R'] as const) {
      const metricScale = twinBone(`hand.${s}`).getWorldScale(new THREE.Vector3()).x;
      const input: Field[] = [];
      side(s, 'side', input);
      num(metricScale, 'metricScale', input);
      step('geometry.capture', {}, input, (out) => {
        const g = captureHandGeometry(profile, s, rest, axes, joints, metricScale);
        geometry[s] = g;
        samples[s] = makeHandGeometrySample(g);
        const v: number[] = [];
        present(v, g.handPresent === undefined ? null : g.handPresent ? 1 : 0);
        v.push(g.metricScale, g.points.length);
        for (const point of g.points) {
          v.push(FINGER_NAMES.indexOf(point.finger), point.jointIndex, point.tip ? 1 : 0);
          if (point.nodes) {
            v.push(1, point.nodes.length);
            for (const node of point.nodes) {
              v.push(...node.position.toArray(), ...node.rest.toArray(), ...node.scale.toArray());
              present(v, node.curlAxis);
              present(v, node.splayAxis);
              present(v, node.jointIndex);
            }
          } else v.push(0);
          present(v, point.previousPoint);
          present(v, point.lastPoint);
        }
        digest(v, out);
      });
    }
    for (const [s, curls, spread] of [
      ['R', {}, {}],
      ['R', { thumb: 0.8, index: 1, middle: 1, ring: 1, little: 1 }, {}],
      ['L', { thumb: 0.3, index: 0, middle: 0, ring: 0.85, little: 0.85 }, { index: 0.12 }],
      // A closed thumb: the sample leaves its distal turn out, where `Hands` puts it in.
      ['L', { thumb: 1 }, { thumb: 0.2 }],
      ['R', { index: -0.5, middle: 1.3 }, { middle: 0.2, ring: -0.1 }],
    ] as const) {
      const input: Field[] = [];
      side(s, 'side', input);
      fingerSpec(curls, 'spec', input);
      fingerSpec(spread, 'spread', input);
      step('geometry.sample', {}, input, (out) => {
        const sample = sampleHandGeometry(must(geometry[s], s), curls, spread, must(samples[s], s));
        arr(vec3)(
          sample.points.map((point) => point.position),
          'vecs',
          out,
        );
      });
    }
    const contacts: HandContactCalibration[] = [];
    for (const [slot, s, palm] of [
      [0, 'L', must(twinAxes.palmLocal.L, 'palm L')],
      [1, 'R', must(twinAxes.palmLocal.R, 'palm R')],
      [2, 'R', new THREE.Vector3()],
    ] as const) {
      const input: Field[] = [];
      num(slot, 'slot', input);
      side(s, 'side', input);
      opt(vec3)(palm, 'palm', input);
      step('contact.capture', {}, input, (out) => {
        const g = must(geometry[s], s);
        const c = captureHandContactGeometry(g, palm);
        contacts[slot] = c;
        const v: number[] = [];
        present(v, c.palmNormal);
        present(v, c.palmCenter);
        v.push(c.segments.length);
        for (const segment of c.segments) {
          v.push(
            FINGER_NAMES.indexOf(segment.finger),
            segment.segment,
            g.points.indexOf(segment.start),
            g.points.indexOf(segment.end),
          );
          present(v, segment.normal);
        }
        digest(v, out);
      });
    }
    const fist = { thumb: 0.8, index: 1, middle: 1, ring: 1, little: 1 };
    const clear = clearanceOf('R');
    for (const [slot, curls, spread, selector, clearance] of [
      [1, {}, {}, { kind: 'palm', region: 'heel' }, clear],
      [
        1,
        { middle: 0.8 },
        { middle: 0.1 },
        { kind: 'palm', region: 'center', surface: 'pad' },
        clear,
      ],
      [0, {}, {}, { kind: 'palm', region: 'center', surface: 'back' }, clear],
      [
        1,
        { middle: 0.8 },
        {},
        { kind: 'finger', finger: 'middle', segment: 1, fraction: 0.6, surface: 'pad' },
        clear,
      ],
      [
        0,
        fist,
        { index: 0.12 },
        { kind: 'finger', finger: 'index', segment: 0, fraction: 0.37, surface: 'back' },
        clear,
      ],
      [1, { thumb: 0.9 }, {}, { kind: 'finger', finger: 'thumb', segment: 1, fraction: 1 }, 0],
      [1, {}, {}, { kind: 'finger', finger: 'ring', segment: 0, fraction: 1.1 }, 0],
      [1, {}, {}, { kind: 'finger', finger: 'index', segment: 2, fraction: 0.5 }, 0],
      [2, {}, {}, { kind: 'palm', region: 'center', surface: 'pad' }, clear],
      [
        1,
        {},
        {},
        { kind: 'finger', finger: 'little', segment: 0, fraction: 0.5, surface: 'pad' },
        -1,
      ],
      [1, {}, {}, { kind: 'finger', finger: 'middle', segment: 0, fraction: Number.NaN }, 0],
    ] as ReadonlyArray<readonly [number, FingerSpec, FingerSpec, HandContact, number]>) {
      const sentinel = new THREE.Vector3(9, 8, 7);
      const input: Field[] = [];
      num(slot, 'slot', input);
      fingerSpec(curls, 'spec', input);
      fingerSpec(spread, 'spread', input);
      num(selector.kind === 'palm' ? 0 : 1, 'selector.kind', input);
      num(
        selector.kind === 'palm' ? ['heel', 'center'].indexOf(selector.region) : 0,
        'selector.region',
        input,
      );
      num(
        selector.kind === 'finger' ? FINGER_NAMES.indexOf(selector.finger) : 0,
        'selector.finger',
        input,
      );
      num(selector.kind === 'finger' ? selector.segment : 0, 'selector.segment', input);
      num(selector.kind === 'finger' ? selector.fraction : 0, 'selector.fraction', input);
      opt(contactSurface)(selector.surface, 'selector.surface', input);
      num(clearance, 'clearance', input);
      vec3(sentinel, 'outVec', input);
      step('contact.sample', {}, input, (out) => {
        const o = sentinel.clone();
        bool(sampleHandContact(contacts[slot], curls, spread, selector, clearance, o), 'ok', out);
        vec3(o, 'outVec', out);
      });
    }

    // --- finger clearance ---
    let built2: FingerClearance | null = null;
    let anat: ArmAnatomy | null = null;
    step('clearance.build', {}, [], (out) => {
      anat = new ArmAnatomy(profile);
      bool(anat.update(), 'ok', out);
      built2 = new FingerClearance(profile, hands, anat, clearanceOf);
      num((built2 as FingerClearance).turnMax, 'value', out);
    });
    const fingers = must<FingerClearance>(built2, 'finger clearance');
    const note = (s: Side) => {
      const input: Field[] = [];
      side(s, 'side', input);
      step('clearance.note', {}, input, (out) => {
        fingers.noteFingers(s);
        arr(vec3)([...fingers.fingerShape(s)], 'vecs', out);
        arr(num)([...fingers.fingerFrame(s).elements], 'nums', out);
      });
    };
    note('R');
    note('L');
    let turnedOnce = false;
    let curledOnce = false;
    for (const [s, depth, across, spec, spread, update] of [
      ['R', 0.35, 0, {}, {}, false],
      ['R', 0.6, 0.01, { index: 0.2, middle: 0.4 }, { index: 0.1 }, true],
      ['L', 0.3, -0.015, fist, {}, false],
      ['R', 3, 0, {}, {}, false],
    ] as const) {
      const set = handAtFace(s, depth, across);
      const input: Field[] = [];
      side(s, 'side', input);
      fingerSpec(spec, 'spec', input);
      fingerSpec(spread, 'spread', input);
      step('clearance.curl', { set, update }, input, (out) => {
        const posed = fingers.curlClearOfFace(s, spec, spread);
        if (!handBone(s).quaternion.equals(set[2])) turnedOnce = true;
        if (FINGER_NAMES.some((f) => posed[f] !== ((spec as FingerSpec)[f] ?? 0)))
          curledOnce = true;
        arr(num)(
          FINGER_NAMES.map((f) => must(posed[f], f)),
          'nums',
          out,
        );
        touched([handBone(s), ...fingerBones(s)], out);
      });
      note(s);
    }
    // The battery is only worth its bytes if the clearance turned a hand and curled a finger.
    expect(turnedOnce, 'a clearance turn').toBe(true);
    expect(curledOnce, 'a clearance curl').toBe(true);

    // --- arm configuration ---
    const calibrations: armConfiguration.ArmCalibration[] = [];
    const calibrate = (
      slot: number,
      jointsIndex: number,
      input: ReturnType<typeof calibrationInputOf>,
    ) => {
      const fields: Field[] = [];
      num(slot, 'slot', fields);
      num(jointsIndex, 'joints', fields);
      calibrationInputFlat(input, 'calibration', fields);
      step('arm.calibrate', {}, fields, (out) => {
        let refusal = -1;
        try {
          const c = armConfiguration.captureArmCalibration({
            ...input,
            joints: ARM_JOINTS[jointsIndex],
          });
          calibrations[slot] = c;
          const v = [
            ...c.upper.axis.toArray(),
            ...c.upper.rest.toArray(),
            ...c.upper.front.toArray(),
            ...c.lower.axis.toArray(),
            ...c.lower.rest.toArray(),
            ...c.hand.axis.toArray(),
            ...c.hand.rest.toArray(),
            ...c.hand.palm.toArray(),
            c.radialSign,
          ];
          digest(v, out);
        } catch (error) {
          refusal = CALIBRATION_REFUSALS.indexOf(
            (error as Error).message as (typeof CALIBRATION_REFUSALS)[number],
          );
          expect(refusal, (error as Error).message).toBeGreaterThanOrEqual(0);
        }
        bool(refusal < 0, 'ok', out);
        num(refusal, 'refusal', out);
      });
    };
    calibrate(0, 0, calibrationInputOf('L'));
    calibrate(1, 0, calibrationInputOf('R'));
    calibrate(2, 2, calibrationInputOf('R'));
    calibrate(3, 1, calibrationInputOf('R'));
    const zeroAxis = calibrationInputOf('R');
    zeroAxis.upper.axis.set(0, 0, 0);
    calibrate(3, 0, zeroAxis);
    const frontAlong = calibrationInputOf('R');
    frontAlong.upper.front.copy(frontAlong.upper.axis).multiplyScalar(2);
    calibrate(3, 0, frontAlong);
    const palmAlong = calibrationInputOf('L');
    palmAlong.hand.palm.copy(palmAlong.hand.axis);
    calibrate(3, 0, palmAlong);

    const pose: armConfiguration.ArmConfiguration = {
      shoulderPlane: 0.41,
      shoulderLift: 0.72,
      humeralRotation: 0.38,
      elbowFlex: 1.1,
      forearmRoll: 0.52,
      wristFlex: 0.31,
      wristDev: -0.19,
    };
    const sideOfSlot = (slot: number): Side => (slot === 0 ? 'L' : 'R');
    const forwardOf = (slot: number, c: armConfiguration.ArmConfiguration) =>
      armConfiguration.forwardArm(
        c,
        calibrations[slot],
        contexts[sideOfSlot(slot)],
        armConfiguration.makeArmForwardResult(),
      );
    for (const [slot, c] of [
      [0, pose],
      [1, pose],
      [1, { ...pose, wristFlex: 0, wristDev: 0 }],
      [0, { ...pose, shoulderPlane: Math.PI + 0.01, humeralRotation: 0.35 }],
      [1, { ...pose, shoulderLift: 1.1, humeralRotation: 2, elbowFlex: 2.8, forearmRoll: 0 }],
      [2, { ...pose, forearmRoll: 0.3 }],
      [1, { ...pose, wristFlex: 1.7, wristDev: 0.5 }],
    ] as const) {
      const input: Field[] = [];
      num(slot, 'slot', input);
      armConfigurationFlat(c, 'configuration', input);
      forwardContext(contexts[sideOfSlot(slot)], 'context', input);
      step('arm.forward', {}, input, (out) => {
        const r = forwardOf(slot, c);
        arr(vec3)([r.u, r.l, r.h, r.palm, r.elbow, r.wrist], 'vecs', out);
        arr(quat)(
          [r.upperWorld, r.lowerWorld, r.handWorld, r.upperLocal, r.lowerLocal, r.handLocal],
          'quats',
          out,
        );
      });
    }
    for (const [slot, c] of [
      [
        1,
        {
          shoulderPlane: 0,
          shoulderLift: 1,
          humeralRotation: Math.PI,
          elbowFlex: Math.PI,
          forearmRoll: -Math.PI,
          wristFlex: Math.PI,
          wristDev: -Math.PI,
        },
      ],
      [0, { ...pose, shoulderLift: -0.2, humeralRotation: 2, elbowFlex: 2.8 }],
    ] as const) {
      const input: Field[] = [];
      num(slot, 'slot', input);
      armConfigurationFlat(c, 'configuration', input);
      step('arm.bound', {}, input, (out) => {
        const o = { ...pose };
        armConfiguration.boundArmConfiguration(c, calibrations[slot], o);
        arr(num)(
          [
            o.shoulderPlane,
            o.shoulderLift,
            o.humeralRotation,
            o.elbowFlex,
            o.forearmRoll,
            o.wristFlex,
            o.wristDev,
          ],
          'nums',
          out,
        );
      });
    }
    const inverse = (
      slot: number,
      directions: armConfiguration.ArmDirections,
      palm: THREE.Vector3 | null,
      previous: armConfiguration.ArmConfiguration | null,
      context = contexts[sideOfSlot(slot)],
    ) => {
      const start = { ...pose, shoulderPlane: -1 };
      const input: Field[] = [];
      num(slot, 'slot', input);
      armDirections(directions, 'directions', input);
      opt(vec3)(palm, 'palm', input);
      forwardContext(context, 'context', input);
      opt(armConfigurationFlat)(previous, 'previous', input);
      armConfigurationFlat(start, 'outConf', input);
      step('arm.inverse', {}, input, (out) => {
        const o = { ...start };
        bool(
          armConfiguration.configurationOfDirections(
            directions,
            palm,
            calibrations[slot],
            context,
            previous,
            o,
          ),
          'ok',
          out,
        );
        arr(num)(
          [
            o.shoulderPlane,
            o.shoulderLift,
            o.humeralRotation,
            o.elbowFlex,
            o.forearmRoll,
            o.wristFlex,
            o.wristDev,
          ],
          'nums',
          out,
        );
      });
    };
    const dirs = (r: armConfiguration.ArmForwardResult) => ({
      upperArm: r.u.clone(),
      lowerArm: r.l.clone(),
      hand: r.h.clone(),
    });
    const fR = forwardOf(1, pose);
    inverse(1, dirs(fR), fR.palm.clone(), null);
    const seam = forwardOf(0, { ...pose, shoulderPlane: -Math.PI + 0.01 });
    inverse(0, dirs(seam), seam.palm.clone(), { ...pose, shoulderPlane: Math.PI - 0.01 });
    inverse(1, dirs(fR), null, { ...pose, forearmRoll: 0.73 });
    const roll = forwardOf(2, { ...pose, forearmRoll: 0.3 });
    inverse(2, dirs(roll), roll.palm.clone(), { ...pose, forearmRoll: Math.PI * 2 + 0.3 });
    inverse(1, dirs(roll), roll.palm.clone(), { ...pose, forearmRoll: Math.PI * 2 + 0.3 });
    const fL = forwardOf(0, pose);
    inverse(0, { ...dirs(fL), upperArm: new THREE.Vector3() }, fL.palm.clone(), null);
    inverse(0, dirs(fL), fL.l.clone(), null);
    inverse(0, { ...dirs(fL), hand: fL.l.clone().negate() }, fL.palm.clone(), null);
    inverse(0, dirs(fL), fL.palm.clone(), null, { ...contexts.L, up: new THREE.Vector3() });
    // Past the elevation ceiling and the humeral stop, as an unbounded request may be.
    {
      const ctx = contexts.R;
      const plane = Math.PI / 2;
      const elevation = 3.1;
      const upperArm = ctx.up
        .clone()
        .multiplyScalar(-Math.cos(elevation))
        .addScaledVector(ctx.right, Math.sin(elevation) * Math.cos(plane))
        .addScaledVector(ctx.forward, Math.sin(elevation) * Math.sin(plane))
        .normalize();
      const ref = new THREE.Vector3();
      const perp = new THREE.Vector3();
      armFrame.humeralReference(upperArm, ctx.up, ctx.forward, ref);
      armFrame.lateralReference(upperArm, ref, ctx.up, ctx.forward, ctx.right, perp);
      const bend = ref.clone().multiplyScalar(Math.cos(2)).addScaledVector(perp, Math.sin(2));
      const lowerArm = upperArm
        .clone()
        .multiplyScalar(Math.cos(2.8))
        .addScaledVector(bend.normalize(), Math.sin(2.8))
        .normalize();
      const palm = ctx.forward.clone().addScaledVector(lowerArm, -ctx.forward.dot(lowerArm));
      inverse(1, { upperArm, lowerArm, hand: lowerArm.clone() }, palm.normalize(), null);
    }
    // A wrist bent past both hard stops.
    {
      const base = forwardOf(1, { ...pose, wristFlex: 0, wristDev: 0 });
      const flex = 1.7;
      const deviation = 0.5;
      const angle = Math.hypot(flex, deviation);
      const radial = new THREE.Vector3()
        .crossVectors(base.palm, base.l)
        .multiplyScalar(calibrations[1].radialSign)
        .normalize();
      const swing = base.palm
        .clone()
        .multiplyScalar(flex / angle)
        .addScaledVector(radial, deviation / angle);
      const hand = base.l
        .clone()
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(swing, Math.sin(angle))
        .normalize();
      const palm = base.palm
        .clone()
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(base.l, (-Math.sin(angle) * flex) / angle)
        .normalize();
      inverse(1, { upperArm: base.u.clone(), lowerArm: base.l.clone(), hand }, palm, pose);
    }

    // --- hand frames ---
    for (const [point, palm] of [
      [new THREE.Vector3(0.3, -2, 0.1), new THREE.Vector3(0, 0.2, 1)],
      [new THREE.Vector3(1e-7, 0, 0), new THREE.Vector3(0, 0, 1)],
      [new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, -1, 1e-5)],
    ] as const) {
      const input: Field[] = [];
      vec3(point, 'point', input);
      opt(vec3)(palm, 'palm', input);
      step('hand.frame', {}, input, (out) => {
        const x = point.clone();
        const m = new THREE.Matrix3();
        bool(handFrame(x, palm, m) !== null, 'ok', out);
        arr(vec3)([x], 'vecs', out);
        arr(num)([...m.elements], 'nums', out);
      });
    }
  });
  const input = layout(cases.map((c) => c.input));
  const output = layout(cases.map((c) => c.output));
  const values: number[] = [];
  for (const c of cases) {
    fill(values, c.input, input);
    fill(values, c.output, output);
  }
  const index = { fn: 'rig-b-battery', cases: cases.length, in: input, out: output };
  return { json: `${JSON.stringify(index, null, 1)}\n`, bin: f64Bytes(values) };
}

// --- the arm-path plan battery ------------------------------------------------------------

const ARM_PATH_PLAN_KIND = oneOf(['fromQ', 'copyForward']);
const SPECIAL_VALUES = [
  0,
  -0,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  5e-324,
  -Math.PI,
  1e308,
];

/** `configurationFromQ` and `copyForward` on drawn values; see the file comment. */
function recordArmPathPlanBattery(): Recorded {
  const random = splitmix64(0x2a2a_0001n);
  const draw = () => {
    const r = random();
    if (r < 0.2) return SPECIAL_VALUES[Math.floor(random() * SPECIAL_VALUES.length)];
    const scale = [1e-9, 1, Math.PI, 1e6][Math.floor(random() * 4)];
    return (random() * 2 - 1) * scale;
  };
  const vector = () => new THREE.Vector3(draw(), draw(), draw());
  const quaternion = () => new THREE.Quaternion(draw(), draw(), draw(), draw());
  const forward = (): armConfiguration.ArmForwardResult => {
    const r = armConfiguration.makeArmForwardResult();
    for (const k of ['u', 'l', 'h', 'palm', 'elbow', 'wrist'] as const) r[k].copy(vector());
    for (const k of [
      'upperWorld',
      'lowerWorld',
      'handWorld',
      'upperLocal',
      'lowerLocal',
      'handLocal',
    ] as const) {
      r[k].copy(quaternion());
    }
    return r;
  };
  const configuration = (): armConfiguration.ArmConfiguration => ({
    shoulderPlane: draw(),
    shoulderLift: draw(),
    humeralRotation: draw(),
    elbowFlex: draw(),
    forearmRoll: draw(),
    wristFlex: draw(),
    wristDev: draw(),
  });
  const cases: Array<{ input: Field[]; output: Field[] }> = [];
  for (let i = 0; i < 48; i++) {
    const q = Float64Array.from({ length: 7 }, draw);
    const o = configuration();
    const input: Field[] = [];
    ARM_PATH_PLAN_KIND('fromQ', 'kind', input);
    typed(q, 'q', input);
    armConfigurationFlat(o, 'outConf', input);
    const output: Field[] = [];
    bool(armPath.configurationFromQ(q, o) === o, 'same', output);
    armConfigurationFlat(o, 'outConf', output);
    cases.push({ input, output });
  }
  for (let i = 0; i < 16; i++) {
    const source = forward();
    const target = forward();
    const input: Field[] = [];
    ARM_PATH_PLAN_KIND('copyForward', 'kind', input);
    forwardResult(source, 'source', input);
    forwardResult(target, 'target', input);
    const output: Field[] = [];
    armPath.copyForward(source, target);
    forwardResult(target, 'target', output);
    cases.push({ input, output });
  }
  const input = layout(cases.map((c) => c.input));
  const output = layout(cases.map((c) => c.output));
  const values: number[] = [];
  for (const c of cases) {
    fill(values, c.input, input);
    fill(values, c.output, output);
  }
  const index = { fn: 'arm-path-plan-battery', cases: cases.length, in: input, out: output };
  return { json: `${JSON.stringify(index, null, 1)}\n`, bin: f64Bytes(values) };
}

// --- the files ----------------------------------------------------------------------------

function settle(name: string, recorded: Recorded): void {
  const json = new URL(`${name}.json`, DIR);
  const bin = new URL(`${name}.bin`, DIR);
  expect(recorded.bin.length, `${name}.bin size`).toBeLessThan(204_800);
  if (WRITE) {
    writeFileSync(json, recorded.json);
    writeFileSync(bin, recorded.bin);
    return;
  }
  expect(readFileSync(json, 'utf8'), `${name}.json`).toBe(recorded.json);
  expect(Buffer.compare(readFileSync(bin), Buffer.from(recorded.bin)), `${name}.bin`).toBe(0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the recorded corpora', () => {
  it('match a fresh recording of every function', () => {
    const corpora = recordCorpora();
    expect([...corpora.keys()]).toEqual(CORPORA.map((s) => s.fn));
    for (const [fn, recorded] of corpora) settle(fn, recorded);
  });

  it('match a fresh recording of the base avatar', () => {
    settle('avatar-base', recordAvatarBase());
  });

  it('match a fresh recording of the anatomy battery', () => {
    settle('arm-battery', recordArmBattery());
  });

  it('match a fresh recording of the rig battery', () => {
    settle('rig-a-battery', recordRigBattery());
  });

  it('match a fresh recording of the finger and arm-configuration battery', () => {
    settle('rig-b-battery', recordRigBBattery());
  });

  it('match a fresh recording of the arm-path plan battery', () => {
    settle('arm-path-plan-battery', recordArmPathPlanBattery());
  });
});
