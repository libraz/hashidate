import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FINGER_WIDTH, HAND_CONTACT, JOINTS } from '@/engine/anatomy';
import { ArmAnatomy } from '@/engine/anatomy/arm';
import * as armFrame from '@/engine/anatomy/arm-frame';
import { TORSO_SAMPLES } from '@/engine/anatomy/joints';
import * as strain from '@/engine/anatomy/strain';
import * as volume from '@/engine/anatomy/volume';
import { type BodyClearance, makeBodyVolumeFrame } from '@/engine/anatomy/volumes';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import * as armConfiguration from '@/engine/rig/arm-configuration';
import { ArmDriver } from '@/engine/rig/arm-driver';
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
import { buildRig } from '../helpers/scene';
import { DT, harness } from '../motion/body/harness';

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
 * `arm-path-solver-battery-{a..e}` are `ArmStepSolver` calls, each file one case: its input the
 * number of `records`, its output one `stream` of f64 holding them one after another, a tag first. `0` defines a solver: its id, hand
 * length, sweep resolution, calibration (axes, rests, front, palm, radial sign) and hand geometry
 * (both on the human joint table). `1` is a `plan` and `2` a `restoreEndpoint` on a defined
 * solver: the request, start, context, bounds, the environment's and the output's row counts,
 * then every `sample` the solver made, then the output. A sample is the FNV-1a of its points'
 * positions (high and low 32 bits) and the rows that differ from an empty row on their slot's
 * key and point: `slot, valid, distance, normal`, or `-(slot + 1), key, point, ...` where the
 * slot's key or point changed. A key is its first-seen index in the file, `-1` for none. The
 * output is the result, q, configuration, forward result, status, errors and counts, and the
 * FNV-1a of its points and of its rows. Absent values are a `0`, present ones a `1` and the value.
 * `-a` and `-b` repeat the scenarios of `tests/rig/arm-path.test.ts`; `-c` puts the base
 * avatar's arm-driver requests to solvers of their own with no environment and one plane; `-d`
 * and `-e` are the drivers' own calls, chosen to reach every step the fixtures take.
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
    const boneRest = new Map<THREE.Bone, THREE.Quaternion>();
    for (const [o, q] of rest) if (o instanceof THREE.Bone) boneRest.set(o, q);
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
        const g = captureHandGeometry(profile, s, boneRest, axes, joints, metricScale);
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

// --- the arm-path solver battery ----------------------------------------------------------

const SOLVER_STATUSES = ['progress', 'settled', 'stationary', 'blocked'] as const;
const PLAN = armPath.ArmStepSolver.prototype.plan;
const RESTORE = armPath.ArmStepSolver.prototype.restoreEndpoint;
type SolverMethod = 'plan' | 'restore';
type SolverArgs = [
  armPath.ArmPathRequest,
  Float64Array,
  armConfiguration.ArmForwardContext,
  armPath.ArmPathBounds,
  armPath.ArmPathEnvironment,
  armPath.ArmPathPlanOutput,
];
/** What the solver keeps from its constructor arguments, read off the instance. */
interface SolverInternals {
  calibration: armConfiguration.ArmCalibration;
  handGeometry: HandGeometryCalibration;
  handLength: number;
  resolution: number;
}

function hashHalves(values: readonly number[]): [number, number] {
  const h = makeFnv64();
  h.f64s(values);
  const d = h.digest();
  return [Number.parseInt(d.slice(0, 8), 16), Number.parseInt(d.slice(8), 16)];
}

function presentNumber(into: number[], v: number | undefined): void {
  if (v === undefined) into.push(0);
  else into.push(1, v);
}

function presentVector(into: number[], v: THREE.Vector3 | null | undefined): void {
  if (v === null || v === undefined) into.push(0);
  else into.push(1, v.x, v.y, v.z);
}

/**
 * One battery file's stream of solver definitions and calls; see the file comment. A solver
 * is defined by what it was built from, so solvers built alike share one definition.
 */
class SolverStream {
  readonly values: number[] = [];
  readonly statuses = new Map<string, number>();
  samples = 0;
  readonly #defs = new Map<string, number>();
  readonly #keys = new Map<string, number>();
  readonly #layouts = new Map<number, Array<{ key: number; point: number }>>();
  #records = 0;

  plan(solver: armPath.ArmStepSolver, ...args: SolverArgs): armPath.ArmPathPlanOutput {
    return this.call(solver, 'plan', args) as armPath.ArmPathPlanOutput;
  }

  restore(solver: armPath.ArmStepSolver, ...args: SolverArgs): boolean {
    return this.call(solver, 'restore', args) as boolean;
  }

  call(solver: armPath.ArmStepSolver, method: SolverMethod, args: SolverArgs): unknown {
    const [request, start, context, bounds, environment, out] = args;
    const def = this.#define(solver);
    const head: number[] = [method === 'plan' ? 1 : 2, def];
    head.push(...request.wrist.toArray(), ...request.hand.toArray());
    presentVector(head, request.palm);
    for (const f of FINGER_NAMES) presentNumber(head, request.curls[f]);
    for (const f of FINGER_NAMES) presentNumber(head, request.spread[f]);
    presentVector(head, request.elbow);
    head.push(...start);
    head.push(context.side === 'L' ? 0 : 1, ...context.shoulder.toArray());
    head.push(context.upperLength, context.lowerLength);
    head.push(...context.up.toArray(), ...context.right.toArray(), ...context.forward.toArray());
    head.push(...context.upperParentWorld.toArray());
    head.push(...bounds.lower, ...bounds.upper, environment.rowCount, out.clearances.length);
    const samples: number[] = [];
    let count = 0;
    const recorded: armPath.ArmPathEnvironment = {
      rowCount: environment.rowCount,
      sample: (points, rows) => {
        environment.sample(points, rows);
        count++;
        this.#sample(def, points, rows, samples);
      },
    };
    const result =
      method === 'plan'
        ? PLAN.call(solver, request, start, context, bounds, recorded, out)
        : RESTORE.call(solver, request, start, context, bounds, recorded, out);
    const tail: number[] = [method === 'plan' || result ? 1 : 0, ...out.q];
    tail.push(
      ...(
        [
          'shoulderPlane',
          'shoulderLift',
          'humeralRotation',
          'elbowFlex',
          'forearmRoll',
          'wristFlex',
          'wristDev',
        ] as const
      ).map((k) => out.configuration[k]),
    );
    for (const k of ['u', 'l', 'h', 'palm', 'elbow', 'wrist'] as const)
      tail.push(...out.forward[k].toArray());
    for (const k of [
      'upperWorld',
      'lowerWorld',
      'handWorld',
      'upperLocal',
      'lowerLocal',
      'handLocal',
    ] as const) {
      tail.push(...out.forward[k].toArray());
    }
    tail.push(SOLVER_STATUSES.indexOf(out.status), out.positionError, out.orientationError);
    tail.push(out.secondaryError, out.maxViolation, out.iterations, out.environmentBatches);
    tail.push(...hashHalves(out.points.flatMap((p) => p.position.toArray())));
    tail.push(
      ...hashHalves(
        out.clearances.flatMap((r) => [
          this.#key(r.key),
          r.pointIndex,
          r.valid ? 1 : 0,
          r.distance,
          ...r.normal.toArray(),
        ]),
      ),
    );
    this.values.push(...head, count, ...samples, ...tail);
    this.#records++;
    this.samples += count;
    const status = method === 'plan' ? out.status : result ? 'restored' : 'refused';
    this.statuses.set(status, (this.statuses.get(status) ?? 0) + 1);
    return result;
  }

  #key(key: string): number {
    if (key === '') return -1;
    let id = this.#keys.get(key);
    if (id === undefined) {
      id = this.#keys.size;
      this.#keys.set(key, id);
    }
    return id;
  }

  #define(solver: armPath.ArmStepSolver): number {
    const {
      calibration: c,
      handGeometry: g,
      handLength,
      resolution,
    } = solver as unknown as SolverInternals;
    expect(c.joints, 'a solver calibrated on the human joint table').toEqual(JOINTS);
    expect(g.joints, 'a hand calibrated on the human joint table').toEqual(JOINTS);
    const v: number[] = [handLength, resolution];
    for (const x of [
      c.upper.axis,
      c.upper.rest,
      c.upper.front,
      c.lower.axis,
      c.lower.rest,
      c.hand.axis,
      c.hand.rest,
      c.hand.palm,
    ]) {
      v.push(...x.toArray());
    }
    v.push(c.radialSign);
    presentNumber(v, g.handPresent === undefined ? undefined : g.handPresent ? 1 : 0);
    v.push(g.metricScale, g.points.length);
    for (const point of g.points) {
      v.push(FINGER_NAMES.indexOf(point.finger), point.jointIndex, point.tip ? 1 : 0);
      if (point.nodes) {
        v.push(1, point.nodes.length);
        for (const node of point.nodes) {
          v.push(...node.position.toArray(), ...node.rest.toArray(), ...node.scale.toArray());
          presentVector(v, node.curlAxis);
          presentVector(v, node.splayAxis);
          presentNumber(v, node.jointIndex);
        }
      } else v.push(0);
      presentNumber(v, point.previousPoint);
      presentNumber(v, point.lastPoint);
    }
    const content = JSON.stringify(v);
    let id = this.#defs.get(content);
    if (id === undefined) {
      id = this.#defs.size;
      this.#defs.set(content, id);
      this.values.push(0, id, ...v);
      this.#records++;
    }
    return id;
  }

  /** The points' hash, then each row that differs from its slot's layout and an empty row. */
  #sample(
    def: number,
    points: readonly armPath.ArmPathPoint[],
    rows: armPath.ArmPathClearance[],
    into: number[],
  ): void {
    into.push(...hashHalves(points.flatMap((p) => p.position.toArray())));
    let layout = this.#layouts.get(def);
    if (!layout || layout.length !== rows.length) {
      layout = rows.map(() => ({ key: -1, point: -1 }));
      this.#layouts.set(def, layout);
    }
    const entries: number[] = [];
    let changed = 0;
    rows.forEach((row, slot) => {
      const key = this.#key(row.key);
      const values = [row.valid ? 1 : 0, row.distance, ...row.normal.toArray()];
      const slotLayout = must(layout?.[slot], 'a row layout');
      if (key !== slotLayout.key || row.pointIndex !== slotLayout.point) {
        entries.push(-(slot + 1), key, row.pointIndex, ...values);
        slotLayout.key = key;
        slotLayout.point = row.pointIndex;
        changed++;
      } else if (!values.every((x, i) => Object.is(x, [0, Number.POSITIVE_INFINITY, 0, 0, 0][i]))) {
        entries.push(slot, ...values);
        changed++;
      }
    });
    into.push(changed, ...entries);
  }

  recorded(name: string): Recorded {
    const index = {
      fn: name,
      cases: 1,
      in: [{ name: 'records', len: 1 }],
      out: [{ name: 'stream', len: this.values.length }],
    };
    return {
      json: `${JSON.stringify(index, null, 1)}\n`,
      bin: f64Bytes([this.#records, ...this.values]),
    };
  }
}

// The synthetic arms of `tests/rig/arm-path.test.ts`, which the scenarios below repeat.

const PATH_UP = new THREE.Vector3(0, 1, 0);
const PATH_RIGHT = new THREE.Vector3(1, 0, 0);
const PATH_FORWARD = new THREE.Vector3(0, 0, 1);

interface PathFixture {
  calibration: armConfiguration.ArmCalibration;
  context: armConfiguration.ArmForwardContext;
  handGeometry: HandGeometryCalibration;
  handLength: number;
  solver: armPath.ArmStepSolver;
  output: armPath.ArmPathPlanOutput;
}

function pathFixture(side: Side = 'R', yaw = 0, scale = 1): PathFixture {
  const identity = new THREE.Quaternion();
  const calibration = armConfiguration.captureArmCalibration({
    upper: { axis: PATH_UP, front: PATH_FORWARD, rest: identity },
    lower: { axis: PATH_UP, rest: identity },
    hand: { axis: PATH_UP, palm: PATH_FORWARD, rest: identity },
    radialSign: side === 'L' ? -1 : 1,
    joints: JOINTS,
  });
  const rotation = new THREE.Quaternion().setFromAxisAngle(PATH_UP, yaw);
  const context: armConfiguration.ArmForwardContext = {
    side,
    shoulder: new THREE.Vector3(0, 0, 0).applyQuaternion(rotation),
    upperLength: 0.31 * scale,
    lowerLength: 0.27 * scale,
    up: PATH_UP.clone().applyQuaternion(rotation),
    right: PATH_RIGHT.clone().applyQuaternion(rotation),
    forward: PATH_FORWARD.clone().applyQuaternion(rotation),
    upperParentWorld: rotation,
  };
  const handGeometry: HandGeometryCalibration = { metricScale: scale, joints: JOINTS, points: [] };
  const handLength = 0.1 * scale;
  const solver = new armPath.ArmStepSolver(calibration, handGeometry, handLength, 0.006 * scale);
  const output = armPath.makeArmPathPlanOutput(calibration, handGeometry, 0);
  return { calibration, context, handGeometry, handLength, solver, output };
}

let pathFingerGeometryCache: HandGeometryCalibration | null = null;

/** The synthetic avatar's right hand, built outside `withCoreMath` as its meshes need `Math.pow`. */
function pathFingerGeometry(): HandGeometryCalibration {
  pathFingerGeometryCache ??= capturePathFingerGeometry();
  return pathFingerGeometryCache;
}

function capturePathFingerGeometry(): HandGeometryCalibration {
  const built = buildRig({ armatureScale: 1 });
  built.root.updateMatrixWorld(true);
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  const hand = must(profile.bones['hand.R'], 'the synthetic right hand');
  return captureHandGeometry(
    profile,
    'R',
    rig.rest,
    solveFingerAxes(profile),
    rig.joints,
    hand.getWorldScale(new THREE.Vector3()).x,
  );
}

function pathFingerFixture(): PathFixture {
  const h = pathFixture();
  const handGeometry = pathFingerGeometry();
  return {
    ...h,
    handGeometry,
    solver: new armPath.ArmStepSolver(h.calibration, handGeometry, h.handLength, 0.006),
    output: armPath.makeArmPathPlanOutput(h.calibration, handGeometry, 0),
  };
}

function pathNeutralFixture() {
  const calibration: armConfiguration.ArmCalibration = {
    upper: {
      axis: new THREE.Vector3(1, 0, 0),
      front: new THREE.Vector3(0, 0, -1),
      rest: new THREE.Quaternion(0, 0, 0, 1),
    },
    lower: { axis: new THREE.Vector3(1, 0, 0), rest: new THREE.Quaternion(0, 0, 0, 1) },
    hand: {
      axis: new THREE.Vector3(1, 0, 0),
      palm: new THREE.Vector3(0, -1, 0),
      rest: new THREE.Quaternion(0, 0, 0, 1),
    },
    radialSign: -1,
    joints: JOINTS,
  };
  const context: armConfiguration.ArmForwardContext = {
    side: 'R',
    shoulder: new THREE.Vector3(0.155901888668811, 1.1405163252064308, -0.006688540336977538),
    upperLength: 0.17,
    lowerLength: 0.14999999999999997,
    up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(1, 0, 0),
    forward: new THREE.Vector3(0, 0, -1),
    upperParentWorld: new THREE.Quaternion(
      4.377774469290759e-19,
      0.03068963967145867,
      -0.1329884385763209,
      0.9906423275945099,
    ),
  };
  const handGeometry = pathFingerGeometry();
  const handLength = 0.1187500000000001;
  const solver = new armPath.ArmStepSolver(
    calibration,
    handGeometry,
    handLength,
    0.0011250000000000001,
  );
  const request: armPath.ArmPathRequest = {
    wrist: new THREE.Vector3(0.23258893762054733, 0.8375989149964106, -0.06958939001876399),
    hand: new THREE.Vector3(0.1302542439055869, -0.9618774934566418, -0.24046937336416044),
    palm: new THREE.Vector3(-0.8799221644217047, -0.22391718724853235, 0.419044243265706),
    curls: {
      thumb: 0.24745597271258368,
      index: 0.31225594371769966,
      middle: 0.3759045026355887,
      ring: 0.43840089115382835,
      little: 0.49974139671977874,
    },
    spread: {
      thumb: 0,
      index: -6.759174985994615e-10,
      middle: -3.1398130906790893e-10,
      ring: 8.305082845022316e-12,
      little: 3.189180344303935e-10,
    },
    elbow: new THREE.Vector3(0.2070761780500716, 0.9801702184784808, -0.03056987538156583),
  };
  const bound: armPath.ArmPathBounds = {
    lower: new Float64Array([
      -0.23333333333333334, 1.3823428885128457, -0.23333333333333334, 0, -0.23333333333333334,
      -0.23333333333333334, -0.23333333333333334,
    ]),
    upper: new Float64Array([
      0.23333333333333334, 1.8490095551795125, 0.23333333333333334, 0.23333333333333334,
      0.23333333333333334, 0.23333333333333334, 0.23333333333333334,
    ]),
  };
  const start = new Float64Array([0, 1.615676221846179, 0, 0, 0, 0, 0]);
  return { calibration, context, handGeometry, handLength, solver, request, bound, start };
}

function pathConfiguration(q: Float64Array): armConfiguration.ArmConfiguration {
  return armPath.configurationFromQ(q, {
    shoulderPlane: 0,
    shoulderLift: 0,
    humeralRotation: 0,
    elbowFlex: 0,
    forearmRoll: 0,
    wristFlex: 0,
    wristDev: 0,
  });
}

function pathForward(h: PathFixture, q: Float64Array): armConfiguration.ArmForwardResult {
  return armConfiguration.forwardArm(
    pathConfiguration(q),
    h.calibration,
    h.context,
    armConfiguration.makeArmForwardResult(),
  );
}

function pathRequestAt(h: PathFixture, q: Float64Array): armPath.ArmPathRequest {
  const fk = pathForward(h, q);
  return {
    wrist: fk.wrist.clone(),
    hand: fk.h.clone(),
    palm: fk.palm.clone(),
    curls: {},
    spread: {},
  };
}

function pathBounds(): armPath.ArmPathBounds {
  const j = JOINTS.shoulder.dofs.rotation.max;
  return {
    lower: new Float64Array([
      -Math.PI,
      0,
      j[0],
      JOINTS.elbow.dofs.flexion.max[0],
      JOINTS.elbow.dofs.rotation.max[0],
      JOINTS.wrist.dofs.flexion.max[0],
      JOINTS.wrist.dofs.deviation.max[0],
    ]),
    upper: new Float64Array([
      Math.PI,
      Math.PI,
      j[1],
      JOINTS.elbow.dofs.flexion.max[1],
      JOINTS.elbow.dofs.rotation.max[1],
      JOINTS.wrist.dofs.flexion.max[1],
      JOINTS.wrist.dofs.deviation.max[1],
    ]),
  };
}

function pathBoundedAround(q: Float64Array, halfWidth: number): armPath.ArmPathBounds {
  const full = pathBounds();
  return {
    lower: Float64Array.from(q, (v, i) => Math.max(full.lower[i], v - halfWidth)),
    upper: Float64Array.from(q, (v, i) => Math.min(full.upper[i], v + halfWidth)),
  };
}

function pathPoleQ(plane = -1.0605277708708791): Float64Array {
  return new Float64Array([
    plane,
    0,
    0.8775014769549042,
    0.6286143089887103,
    -1.3097985816478976,
    0.29435979269206314,
    0.004239725810632073,
  ]);
}

function pathPoleBounds(q: Float64Array, halfWidth = 14 / 60): armPath.ArmPathBounds {
  const result = pathBoundedAround(q, halfWidth);
  result.lower[0] = q[0] - halfWidth;
  result.upper[0] = q[0] + halfWidth;
  return result;
}

const PATH_FREE: armPath.ArmPathEnvironment = { rowCount: 0, sample: () => {} };

/** One row on `pointIndex` from `fill`, which may leave fields at the solver's reset. */
function pathRow(
  key: string,
  pointIndex: number,
  fill: (position: THREE.Vector3, row: armPath.ArmPathClearance) => void,
): armPath.ArmPathEnvironment {
  return {
    rowCount: 1,
    sample: (points, rows) => {
      rows[0].key = key;
      rows[0].pointIndex = pointIndex;
      rows[0].valid = true;
      fill(must(points[pointIndex], 'a proxy point').position, rows[0]);
    },
  };
}

/** A plane with `axis` its inward normal, whose row is negative past `offset`. */
function pathPlane(pointIndex: number, axis: THREE.Vector3, offset: number) {
  return pathRow('plane', pointIndex, (p, row) => {
    row.distance = offset - p.dot(axis);
    row.normal.copy(axis).negate();
  });
}

function pathSphere(key: string, pointIndex: number, center: THREE.Vector3, radius: number) {
  return pathRow(key, pointIndex, (p, row) => {
    row.normal.copy(p).sub(center);
    row.distance = row.normal.length() - radius;
    if (row.normal.lengthSq() < 1e-12) row.normal.set(0, 1, 0);
    else row.normal.normalize();
  });
}

function pathEnteringPlane(
  pointIndex: number,
  axis: THREE.Vector3,
  activation: number,
  offset: number,
): armPath.ArmPathEnvironment {
  return pathRow('entering-plane', pointIndex, (p, row) => {
    const coordinate = p.dot(axis);
    row.valid = coordinate >= activation;
    if (row.valid) {
      row.distance = offset - coordinate;
      row.normal.copy(axis).negate();
    }
  });
}

function pathHandProxy(h: PathFixture, q: Float64Array): THREE.Vector3 {
  const r = pathForward(h, q);
  return r.wrist.clone().addScaledVector(r.h, (h.handLength * HAND_CONTACT) / TORSO_SAMPLES);
}

const HAND_PROXY = TORSO_SAMPLES * 2 + 1;

/** The scenarios of `tests/rig/arm-path.test.ts`, as public calls on their solvers. */
function recordSyntheticSolverCalls(s: SolverStream, part: 0 | 1): void {
  const out = (h: PathFixture, rows: number) =>
    armPath.makeArmPathPlanOutput(h.calibration, h.handGeometry, rows);
  if (part === 0) {
    // Bounded progress, the neutral 60 Hz target, and the zero-lift pole.
    let h = pathFixture();
    const goal = new Float64Array([0.42, 0.64, 0.35, 0.82, 0.28, 0.22, -0.13]);
    s.plan(
      h.solver,
      pathRequestAt(h, goal),
      new Float64Array([0, 0, 0, 0.2, 0, 0, 0]),
      h.context,
      pathBounds(),
      PATH_FREE,
      h.output,
    );
    const n = pathNeutralFixture();
    const neutral = {
      ...n,
      output: armPath.makeArmPathPlanOutput(n.calibration, n.handGeometry, 1),
    };
    const safe = pathRow('uniform-safe', HAND_PROXY, (p, row) => {
      row.distance = p.y + 100;
      row.normal.set(0, 1, 0);
    });
    s.plan(n.solver, n.request, n.start, n.context, n.bound, safe, neutral.output);
    const pole = pathPoleQ();
    s.plan(n.solver, n.request, pole, n.context, pathPoleBounds(pole), safe, neutral.output);
    for (const [side, plane] of [
      ['R', -1.0605277708708791],
      ['R', -1.0605277708708791 + 2 * Math.PI],
      ['L', -1.0605277708708791],
    ] as const) {
      const context = { ...n.context, side };
      const o = armPath.makeArmPathPlanOutput(n.calibration, n.handGeometry, 0);
      const start = pathPoleQ(plane);
      s.plan(n.solver, n.request, start, context, pathPoleBounds(start), PATH_FREE, o);
      for (let call = 0; call < 3 && !(o.q[1] > 1e-3); call++) {
        const from = Float64Array.from(o.q);
        s.plan(n.solver, n.request, from, context, pathPoleBounds(from), PATH_FREE, o);
      }
    }
    for (const locked of [0, 1]) {
      const limit = pathPoleBounds(pole);
      limit.lower[locked] = pole[locked];
      limit.upper[locked] = pole[locked];
      const o = armPath.makeArmPathPlanOutput(n.calibration, n.handGeometry, 0);
      s.plan(n.solver, n.request, pole, n.context, limit, PATH_FREE, o);
    }
    const lifted = pathPoleQ();
    lifted[1] = 1e-8;
    const narrow = pathPoleBounds(lifted);
    narrow.lower[0] = lifted[0] - 1e-4;
    narrow.upper[0] = lifted[0] + 1e-4;
    const liftedOutput = armPath.makeArmPathPlanOutput(n.calibration, n.handGeometry, 0);
    s.plan(n.solver, n.request, lifted, n.context, narrow, PATH_FREE, liftedOutput);
    {
      const initial = armConfiguration.forwardArm(
        pathConfiguration(pole),
        n.calibration,
        n.context,
        armConfiguration.makeArmForwardResult(),
      );
      const center = initial.wrist
        .clone()
        .addScaledVector(initial.h, (n.handLength * HAND_CONTACT) / TORSO_SAMPLES);
      const boundary = pathRow('pole-lift-boundary', HAND_PROXY, (p, row) => {
        const displacement = p.clone().sub(center);
        row.distance = -displacement.length();
        if (displacement.lengthSq() > 0) row.normal.copy(displacement).normalize().negate();
        else row.normal.set(0, 1, 0);
      });
      s.plan(n.solver, n.request, pole, n.context, pathPoleBounds(pole), boundary, neutral.output);
    }

    // The sweep budget shared across halvings.
    h = pathFixture();
    {
      const solver = new armPath.ArmStepSolver(h.calibration, h.handGeometry, h.handLength, 0.001);
      const start = new Float64Array([0.08, 0.48, -0.04, 0.58, 0.01, 0.02, 0]);
      const far = new Float64Array([0.95, 1.18, -0.4, 1.25, 0.45, 0.23, -0.13]);
      const broad = pathRow('broad-clearance', HAND_PROXY, (p, row) => {
        row.distance = p.y + 10;
        row.normal.set(0, 1, 0);
      });
      s.plan(solver, pathRequestAt(h, far), start, h.context, pathBounds(), broad, out(h, 1));
    }

    // Authored elbow guidance and its fallback.
    for (const scenario of [
      { side: 'R' as const, yaw: 0, scale: 1, palm: true, width: 0.5, flex: 0.2, limit: 0.04 },
      { side: 'L' as const, yaw: -0.5, scale: 1.7, palm: true, width: 0.5, flex: 0.2, limit: 0.04 },
      { side: 'R' as const, yaw: 0.3, scale: 1, palm: false, width: 0.5, flex: 0.2, limit: 0.04 },
      { side: 'R' as const, yaw: 0, scale: 1, palm: true, width: 14 / 60, flex: 0.08, limit: 0.02 },
    ]) {
      const f = pathFixture(scenario.side, scenario.yaw, scenario.scale);
      const start = new Float64Array([0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05]);
      const target = start.slice();
      target[3] += scenario.flex;
      const request = { ...pathRequestAt(f, target), ...(scenario.palm ? {} : { palm: null }) };
      const limit = pathBoundedAround(start, scenario.width);
      limit.upper[3] = start[3] + scenario.limit;
      const reference = s.plan(f.solver, request, start, f.context, limit, PATH_FREE, f.output);
      const nWrist = reference.forward.wrist.clone().sub(f.context.shoulder).normalize();
      const d = reference.forward.wrist.distanceTo(f.context.shoulder);
      const u = f.context.upperLength;
      const l = f.context.lowerLength;
      const center = f.context.shoulder
        .clone()
        .addScaledVector(nWrist, (u * u - l * l + d * d) / (2 * d));
      const radial = reference.forward.elbow.clone().sub(center);
      for (const sign of [-1, 1]) {
        const elbow = radial
          .clone()
          .applyAxisAngle(nWrist, sign * 0.2)
          .add(center);
        const solver = new armPath.ArmStepSolver(
          f.calibration,
          f.handGeometry,
          f.handLength,
          0.006 * scenario.scale,
        );
        const floor = pathRow('floor', TORSO_SAMPLES, (p, row) => {
          row.distance = p.y + scenario.scale;
          row.normal.set(0, 1, 0);
        });
        s.plan(solver, { ...request, elbow }, start, f.context, limit, floor, out(f, 1));
      }
    }
    {
      const f = pathFixture();
      const start = new Float64Array([0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05]);
      const target = start.slice();
      target[3] = 1;
      const request = pathRequestAt(f, target);
      const limit = pathBoundedAround(start, 14 / 60);
      limit.upper[3] = start[3] + 0.04;
      limit.lower[5] = start[5] - 0.02;
      limit.upper[5] = start[5] + 0.02;
      const reference = s.plan(f.solver, request, start, f.context, limit, PATH_FREE, f.output);
      const nWrist = reference.forward.wrist.clone().sub(f.context.shoulder).normalize();
      const center = f.context.shoulder
        .clone()
        .addScaledVector(
          nWrist,
          reference.forward.elbow.clone().sub(f.context.shoulder).dot(nWrist),
        );
      const elbow = reference.forward.elbow
        .clone()
        .sub(center)
        .applyAxisAngle(nWrist, -0.2)
        .add(center);
      const solver = new armPath.ArmStepSolver(f.calibration, f.handGeometry, f.handLength, 0.006);
      s.plan(solver, { ...request, elbow }, start, f.context, limit, PATH_FREE, out(f, 0));
    }
  } else {
    let h = pathFixture();
    for (const kind of ['locked', 'straight', 'pole', 'near-pole'] as const) {
      const start = new Float64Array([0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05]);
      if (kind === 'straight') start[3] = 0;
      if (kind === 'pole') start[1] = 0;
      if (kind === 'near-pole') start[1] = 1e-4;
      const initial = pathForward(h, start);
      const request = {
        ...pathRequestAt(h, start),
        elbow: initial.elbow.clone().add(new THREE.Vector3(0.01, 0.005, 0.01)),
      };
      const limit = pathBoundedAround(start, kind === 'locked' ? 0 : 14 / 60);
      const floor = pathRow('floor', TORSO_SAMPLES, (p, row) => {
        row.distance = p.dot(PATH_UP) + 1;
        row.normal.copy(PATH_UP);
      });
      s.plan(h.solver, request, start, h.context, limit, floor, out(h, 1));
    }
    for (const kind of ['blocking', 'tangent'] as const) {
      const start = new Float64Array([0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05]);
      const initial = pathForward(h, start);
      const nWrist = initial.wrist.clone().sub(h.context.shoulder).normalize();
      const center = h.context.shoulder
        .clone()
        .addScaledVector(nWrist, initial.elbow.clone().sub(h.context.shoulder).dot(nWrist));
      const radial = initial.elbow.clone().sub(center);
      const elbow = radial.clone().applyAxisAngle(nWrist, -0.1).add(center);
      const request = { ...pathRequestAt(h, start), elbow };
      const limit = pathBoundedAround(start, 14 / 60);
      const reference = s.plan(h.solver, request, start, h.context, limit, PATH_FREE, h.output);
      const normal =
        kind === 'blocking'
          ? new THREE.Vector3().crossVectors(nWrist, radial).normalize()
          : nWrist.clone();
      const middle = Float64Array.from(start, (v, dof) => (v + reference.q[dof]) / 2);
      if (kind === 'tangent' && normal.dot(pathForward(h, middle).elbow.sub(initial.elbow)) < 0)
        normal.negate();
      const plane = pathRow('elbow-plane', TORSO_SAMPLES, (p, row) => {
        row.distance = normal.dot(p.clone().sub(initial.elbow));
        row.normal.copy(normal);
      });
      const solver = new armPath.ArmStepSolver(h.calibration, h.handGeometry, h.handLength, 0.006);
      s.plan(solver, request, start, h.context, limit, plane, out(h, 1));
    }

    // Certificates: one reserved final chord, and an uncertified sphere crossing.
    {
      const solver = new armPath.ArmStepSolver(h.calibration, h.handGeometry, h.handLength, 0.003);
      const start = new Float64Array([0.3, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05]);
      const goal = new Float64Array([0.35, 1, 0.15, 0.9, 0.25, 0.1, 0.05]);
      const floor = pathRow('floor', HAND_PROXY, (p, row) => {
        row.distance = p.y + 1;
        row.normal.set(0, 1, 0);
      });
      const request = pathRequestAt(h, goal);
      const limit = pathBoundedAround(start, 14 / 60);
      s.plan(h.solver, request, start, h.context, limit, PATH_FREE, h.output);
      s.plan(solver, request, start, h.context, limit, floor, out(h, 1));
    }
    for (const incompatibleElbow of [false, true]) {
      const solver = new armPath.ArmStepSolver(h.calibration, h.handGeometry, h.handLength, 0.003);
      const start = new Float64Array([0, 0.9, 0.1, 0.8, 0.2, 0.1, 0.05]);
      const goal = start.slice();
      goal[0] = 0.3;
      if (incompatibleElbow) goal[3] += 0.2;
      const middle = start.slice();
      middle[0] = 0.15;
      const center = pathHandProxy(h, middle);
      const limit = { lower: start.slice(), upper: start.slice() };
      limit.upper[0] = goal[0];
      const sphere = pathRow('interior-sphere', HAND_PROXY, (p, row) => {
        row.normal.copy(p).sub(center);
        row.distance = row.normal.length() - 0.008;
        // A local query domain exposes the interior obstacle during the chord replay.
        row.valid = row.distance < 0.012;
        if (row.normal.lengthSq() < 1e-12) row.normal.set(0, 1, 0);
        else row.normal.normalize();
      });
      s.plan(solver, pathRequestAt(h, goal), start, h.context, limit, sphere, out(h, 1));
    }

    // An unreachable request, rendered frames, an empty bound and an invalid frame.
    {
      let next = new Float64Array([0, 0.3, 0, 0.4, 0, 0, 0]);
      const request: armPath.ArmPathRequest = {
        wrist: new THREE.Vector3(8, 4, -7),
        hand: PATH_FORWARD.clone(),
        palm: PATH_UP.clone(),
        curls: {},
        spread: {},
      };
      for (let call = 0; call < 10; call++) {
        const o = s.plan(h.solver, request, next, h.context, pathBounds(), PATH_FREE, h.output);
        if (o.status !== 'progress') break;
        next = new Float64Array(o.q);
      }
    }
    for (const [side, yaw, scale] of [
      ['L', 0, 1],
      ['R', 0.7, 1],
      ['L', 0.7, 0.01],
    ] as const) {
      const f = pathFixture(side, yaw, scale);
      const start = new Float64Array([0, 0.18, 0.1, 0.5, 0.02, 0.04, -0.02]);
      s.plan(
        f.solver,
        pathRequestAt(f, start),
        start,
        f.context,
        pathBounds(),
        PATH_FREE,
        f.output,
      );
    }
    {
      const start = new Float64Array([0, 0.2, 0, 0.3, 0, 0, 0]);
      const strict = pathBounds();
      strict.lower[0] = 0.1;
      strict.upper[0] = 0.05;
      const request = pathRequestAt(h, new Float64Array([0.4, 0.5, 0.3, 0.7, 0, 0, 0]));
      s.plan(h.solver, request, start, h.context, strict, PATH_FREE, h.output);
      // An output sized for another environment is refused before anything is evaluated.
      s.plan(h.solver, request, start, h.context, pathBounds(), PATH_FREE, out(h, 1));
      const f = pathFixture();
      const at = new Float64Array([0.02, 0.28, 0.05, 0.46, 0.02, 0.04, -0.03]);
      const valid = pathRequestAt(f, at);
      f.context.right.copy(f.context.up);
      const never: armPath.ArmPathEnvironment = { rowCount: 1, sample: () => {} };
      s.plan(f.solver, valid, at, f.context, pathBounds(), never, out(f, 1));
      s.restore(f.solver, valid, at, f.context, pathBounds(), PATH_FREE, f.output);
      s.restore(h.solver, valid, at, h.context, pathBounds(), PATH_FREE, h.output);
    }

    // Reused plan and restore calls through obstacles and row-count changes.
    h = pathFixture();
    {
      const start = new Float64Array([0.04, 0.52, 0.06, 0.6, 0.01, 0.03, 0]);
      const goal = new Float64Array([0.66, 0.9, 0.28, 1.0, 0.22, 0.18, -0.07]);
      const request = pathRequestAt(h, goal);
      const from = pathHandProxy(h, start);
      const to = pathHandProxy(h, goal);
      const axis = to.clone().sub(from).normalize();
      const origin = from.dot(axis);
      const travel = to.dot(axis) - origin;
      const entering = pathEnteringPlane(
        HAND_PROXY,
        axis,
        origin + travel * 0.08,
        origin + travel * 0.46,
      );
      s.plan(h.solver, request, start, h.context, pathBounds(), entering, out(h, 1));
      for (const [call, rowCount] of [2, 2, 3, 0, 1, 2].entries()) {
        let samples = 0;
        const environment: armPath.ArmPathEnvironment = {
          rowCount,
          sample: (_points, rows) => {
            samples++;
            for (let slot = 0; slot < rows.length; slot++) {
              const index = (slot + call + samples) % rows.length;
              rows[slot].key = `call:${call}:surface:${index}`;
              rows[slot].pointIndex = index + call;
              rows[slot].valid = index % 2 === 0;
              rows[slot].distance = rows[slot].valid ? 1 : Number.POSITIVE_INFINITY;
              rows[slot].normal.set(0, rows[slot].valid ? 1 : 0, 0);
            }
          },
        };
        if (call % 2 === 0)
          s.plan(h.solver, request, start, h.context, pathBounds(), environment, out(h, rowCount));
        else
          s.restore(
            h.solver,
            request,
            start,
            h.context,
            pathBounds(),
            environment,
            out(h, rowCount),
          );
      }
    }

    // Restoration: a curled fingertip, a start pushed into a face, a locked box.
    for (const surface of ['plane', 'sphere'] as const) {
      const f = pathFingerFixture();
      const start = new Float64Array([0.1, 0.45, 0.1, 0.55, 0, 0, 0]);
      const curls = { index: 0.8 };
      const request = { ...pathRequestAt(f, start), curls };
      s.plan(f.solver, request, start, f.context, pathBounds(), PATH_FREE, f.output);
      const pointIndex = f.output.points.findIndex((p) => p.id === 'finger.index.2.tip');
      const curled = f.output.points[pointIndex].position.clone();
      const qPlus = new Float64Array(start);
      qPlus[0] += 0.25;
      const plusRequest = { ...pathRequestAt(f, qPlus), curls };
      s.plan(f.solver, plusRequest, qPlus, f.context, pathBounds(), PATH_FREE, f.output);
      const outward = f.output.points[pointIndex].position.clone().sub(curled).normalize();
      const boundary = curled.dot(outward) + 0.002;
      const center = curled.clone().addScaledVector(outward, -0.05);
      const environment =
        surface === 'plane'
          ? pathRow('finger-plane', pointIndex, (p, row) => {
              row.distance = p.dot(outward) - boundary;
              row.normal.copy(outward);
            })
          : pathSphere('finger-sphere', pointIndex, center, 0.052);
      const restricted = pathBounds();
      for (let dof = 0; dof < 7; dof++) {
        restricted.lower[dof] = start[dof];
        restricted.upper[dof] = start[dof];
      }
      restricted.upper[0] = start[0] + 0.4;
      const o = out(f, 1);
      s.plan(f.solver, request, start, f.context, restricted, environment, o);
      s.restore(f.solver, request, start, f.context, restricted, environment, o);
      if (surface === 'plane') {
        const locked = pathBounds();
        for (let dof = 0; dof < 7; dof++) {
          locked.lower[dof] = start[dof];
          locked.upper[dof] = start[dof];
        }
        s.restore(f.solver, request, start, f.context, locked, environment, o);
      }
    }
    {
      const start = new Float64Array([0.05, 0.54, 0.08, 0.62, 0.02, 0.04, 0]);
      const goal = new Float64Array([0.52, 0.84, 0.26, 0.94, 0.2, 0.16, -0.06]);
      const from = pathHandProxy(h, start);
      const axis = from.clone().sub(pathHandProxy(h, goal)).normalize();
      const pushed = pathPlane(HAND_PROXY, axis, from.dot(axis) - 1e-3);
      s.plan(h.solver, pathRequestAt(h, goal), start, h.context, pathBounds(), pushed, out(h, 1));
    }

    // Planes, tangents, scaled gradients and spheres the plan must keep clear of.
    {
      const start = new Float64Array([0.05, 0.54, 0.08, 0.62, 0.02, 0.04, 0]);
      const goal = new Float64Array([0.72, 0.92, 0.32, 1.04, 0.24, 0.19, -0.08]);
      const from = pathHandProxy(h, start);
      const to = pathHandProxy(h, goal);
      const axis = to.clone().sub(from).normalize();
      const plane = pathPlane(HAND_PROXY, axis, (from.dot(axis) + to.dot(axis)) / 2);
      s.plan(h.solver, pathRequestAt(h, goal), start, h.context, pathBounds(), plane, out(h, 1));
      const near = new Float64Array([0.52, 0.84, 0.26, 0.94, 0.2, 0.16, -0.06]);
      const tangent = pathHandProxy(h, near).sub(from).cross(PATH_UP).normalize();
      const along = pathPlane(HAND_PROXY, tangent, from.dot(tangent));
      s.plan(h.solver, pathRequestAt(h, near), start, h.context, pathBounds(), along, out(h, 1));
    }
    for (const magnitude of [1, 8]) {
      const start = new Float64Array([0, 0.5, 0, 0.7, 0, 0, 0]);
      const goal = start.slice();
      goal[5] = 0.4;
      const contact = start.slice();
      contact[5] = 0.1;
      const palm = pathForward(h, start).palm.clone();
      const offset = pathHandProxy(h, contact).dot(palm);
      const scaled = pathRow('scaled-plane', HAND_PROXY, (p, row) => {
        row.distance = magnitude * (offset - p.dot(palm));
        row.normal.copy(palm).multiplyScalar(-magnitude);
      });
      const strict = { lower: start.slice(), upper: start.slice() };
      strict.upper[5] = goal[5];
      s.plan(h.solver, pathRequestAt(h, goal), start, h.context, strict, scaled, out(h, 1));
    }
    {
      const f = pathFixture('L', 0.7, 0.01);
      const start = new Float64Array([0.08, 0.48, -0.04, 0.58, 0.01, 0.02, 0]);
      const goal = new Float64Array([0.58, 0.86, -0.28, 0.98, 0.3, 0.18, -0.1]);
      const from = pathHandProxy(f, start);
      const center = from.clone().lerp(pathHandProxy(f, goal), 0.62);
      const radius = from.distanceTo(center) * 0.82;
      let calls = 0;
      const reordered: armPath.ArmPathEnvironment = {
        rowCount: 2,
        sample: (points, rows) => {
          const first = calls++ % 2 === 0 ? 0 : 1;
          const assignments = [
            { key: 'sphere:a', pointIndex: HAND_PROXY, valid: true },
            { key: 'sphere:b', pointIndex: HAND_PROXY + 1, valid: false },
          ];
          for (const [slot, which] of [first, 1 - first].entries()) {
            const a = assignments[which];
            const row = rows[slot];
            row.key = a.key;
            row.pointIndex = a.pointIndex;
            row.valid = a.valid;
            if (a.valid) {
              row.normal.copy(points[a.pointIndex].position).sub(center);
              row.distance = row.normal.length() - radius;
              if (row.normal.lengthSq() < 1e-12) row.normal.set(0, 1, 0);
              else row.normal.normalize();
            }
          }
        },
      };
      s.plan(
        f.solver,
        pathRequestAt(f, goal),
        start,
        f.context,
        pathBounds(),
        reordered,
        out(f, 2),
      );
    }
    {
      const start = new Float64Array([0.08, 0.48, -0.04, 0.58, 0.01, 0.02, 0]);
      const goal = new Float64Array([0.95, 1.18, -0.4, 1.25, 0.45, 0.23, -0.13]);
      const from = pathHandProxy(h, start);
      const center = from
        .clone()
        .lerp(pathHandProxy(h, goal), 0.35)
        .add(new THREE.Vector3(0, 0.03, 0));
      const sphere = pathSphere('sphere:original-chord', HAND_PROXY, center, 0.19814247673641228);
      s.plan(h.solver, pathRequestAt(h, goal), start, h.context, pathBounds(), sphere, out(h, 1));
    }
    {
      let q = new Float64Array([0.02, 0.28, 0.05, 0.46, 0.02, 0.04, -0.03]);
      const goal = new Float64Array([0.58, 0.92, -0.32, 1.05, 0.35, 0.23, -0.15]);
      const request = pathRequestAt(h, goal);
      for (let call = 0; call < 12; call++) {
        const o = s.plan(
          h.solver,
          request,
          q,
          h.context,
          pathBoundedAround(q, 0.18),
          PATH_FREE,
          h.output,
        );
        if (o.status !== 'progress') break;
        q = new Float64Array(o.q);
      }
    }
  }
}

// The base avatar's arm drivers, through the director fixtures that load them hardest.

const SOLVER_FLAGS = [
  'blocked',
  'stationary',
  'refused',
  'pushClear',
  'checkpoint',
  'retraction',
  'halving',
  'temporal',
  'gauge',
  'infeasible',
  'failed',
  'secondary',
  'rows',
  'progress',
  'settled',
  'restored',
] as const;
type SolverFlag = (typeof SOLVER_FLAGS)[number];

interface SolverCallSummary {
  flags: Set<SolverFlag>;
  /** Stream values the call takes, less its solver's definition and row layout. */
  cost: number;
}

type SolverCallHook = (
  index: number,
  solver: armPath.ArmStepSolver,
  method: SolverMethod,
  args: SolverArgs,
) => unknown;

/**
 * Run `run` with every solver call answered by `hook` and summarised: what it exercised, read
 * off the solver's private steps, and what it would cost to record.
 */
function observeSolverCalls(run: () => void, hook: SolverCallHook): SolverCallSummary[] {
  const calls: SolverCallSummary[] = [];
  let current: SolverCallSummary | null = null;
  const note = (flag: SolverFlag) => current?.flags.add(flag);
  const proto = armPath.ArmStepSolver.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  for (const [method, name] of [
    ['plan', 'plan'],
    ['restore', 'restoreEndpoint'],
  ] as const) {
    vi.spyOn(proto, name).mockImplementation(function (this: unknown, ...raw: unknown[]) {
      const args = raw as SolverArgs;
      const summary: SolverCallSummary = { flags: new Set(), cost: 160 };
      const index = calls.length;
      calls.push(summary);
      const environment = args[4];
      const costed: armPath.ArmPathEnvironment = {
        rowCount: environment.rowCount,
        sample: (points, rows) => {
          environment.sample(points, rows);
          const live = rows.filter(
            (r) => r.valid || r.distance !== Number.POSITIVE_INFINITY || r.normal.lengthSq() !== 0,
          );
          summary.cost += 3 + 6 * live.length;
        },
      };
      current = summary;
      try {
        const result = hook(index, this as armPath.ArmStepSolver, method, [
          args[0],
          args[1],
          args[2],
          args[3],
          costed,
          args[5],
        ]);
        if (method === 'plan') note((result as armPath.ArmPathPlanOutput).status);
        else note(result ? 'restored' : 'refused');
        return result;
      } finally {
        current = null;
      }
    });
  }
  type Flagger = (
    result: unknown,
    self: Record<string, unknown>,
    args: unknown[],
    certifiedBefore: unknown,
  ) => SolverFlag | null;
  const watch = (name: string, flag: Flagger) => {
    const original = proto[name];
    vi.spyOn(proto, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
      const self = this as Record<string, unknown>;
      const before = self.currentIsCertified;
      const result = original.apply(this, args);
      const f = flag(result, self, args, before);
      if (f) note(f);
      return result;
    });
  };
  watch('pushClear', () => 'pushClear');
  watch('prepareRows', () => 'rows');
  watch('certifyCurrent', (r, _self, _args, before) =>
    before === false && r === false ? 'checkpoint' : null,
  );
  watch('retractElbow', (r) => (r ? 'retraction' : null));
  watch('evaluatePlanCandidate', (_r, _self, args) => ((args[3] as number) > 0 ? 'halving' : null));
  watch('poleGaugeProposal', (r) => (r === undefined ? null : 'gauge'));
  watch('makeSecondaryStep', (r) => (r ? 'secondary' : null));
  watch('makeConstrainedStep', (r, self) => {
    if (r && self.lastStepTemporal) return 'temporal';
    if (self.lastQpResult === 'infeasible') return 'infeasible';
    if (self.lastQpResult === 'failed') return 'failed';
    return null;
  });
  try {
    run();
  } finally {
    vi.restoreAllMocks();
  }
  return calls;
}

/** Contact gestures, reaches, points and hops, then a hand held against a joint-box corner. */
function runArmDrivers(): void {
  for (const id of ['c switches steady', 'f contact switches capped']) {
    runDirectorFixture(
      must(
        DIRECTOR_FIXTURES.find((f) => f.id === id),
        id,
      ),
    );
  }
  // Built outside `withCoreMath`, which the synthetic avatar's meshes cannot be.
  const body = harness(0, { random: () => 0.5 });
  withCoreMath(() => {
    const driver = must(body.rig.armDriver('R'), 'a right arm driver');
    let start: Float64Array | null = null;
    let context: armConfiguration.ArmForwardContext | null = null;
    const planFrom = ArmDriver.prototype.planFrom;
    const spy = vi.spyOn(ArmDriver.prototype, 'planFrom').mockImplementation(function (
      this: ArmDriver,
      ...args
    ) {
      if (this === driver) {
        start = Float64Array.from(args[0]);
        context = args[1];
      }
      return planFrom.apply(this, args);
    });
    body.rig.reset();
    body.body.update(DT);
    body.body.play('cover', 'R');
    for (let i = 0; i < 140; i++) {
      body.rig.reset();
      body.body.update(DT);
    }
    spy.mockRestore();
    const r = driver.request;
    const request: armPath.ArmPathRequest = {
      wrist: r.wrist.clone(),
      hand: r.hand.clone(),
      palm: r.palm?.clone() ?? null,
      elbow: r.elbow.clone(),
      curls: { ...r.curls },
      spread: { ...r.spread },
    };
    let q = must<Float64Array>(start, 'a captured plan');
    const ctx = must<armConfiguration.ArmForwardContext>(context, 'a captured context');
    for (let call = 0; call < 30; call++) {
      const out = driver.solver.plan(
        request,
        q,
        ctx,
        driver.fillBounds(q, 0, false),
        driver.environment,
        driver.output,
      );
      q = Float64Array.from(out.q);
      if (out.status === 'stationary') break;
    }
  });
}

/** Up to `budget` stream values of calls: the cheapest call with each flag, then an even spread. */
function chooseSolverCalls(calls: SolverCallSummary[], budget: number): number[] {
  const chosen = new Set<number>();
  let spent = 0;
  const take = (i: number) => {
    if (chosen.has(i) || spent + calls[i].cost > budget) return false;
    chosen.add(i);
    spent += calls[i].cost;
    return true;
  };
  for (const flag of SOLVER_FLAGS) {
    const having = calls
      .map((_, i) => i)
      .filter((i) => calls[i].flags.has(flag))
      .sort((a, b) => calls[a].cost - calls[b].cost);
    if (having.some((i) => chosen.has(i))) continue;
    for (const i of having) if (take(i)) break;
  }
  for (let stride = calls.length; stride >= 1; stride = Math.floor(stride / 2)) {
    for (let i = 0; i < calls.length; i += stride) take(i);
  }
  return [...chosen].sort((a, b) => a - b);
}

/** A deep copy of the inputs of one call, which the drivers keep in reused buffers. */
function cloneSolverInputs(args: SolverArgs) {
  const [r, start, c, b] = args;
  const request: armPath.ArmPathRequest = {
    wrist: r.wrist.clone(),
    hand: r.hand.clone(),
    palm: r.palm?.clone() ?? null,
    curls: { ...r.curls },
    spread: { ...r.spread },
    ...(r.elbow ? { elbow: r.elbow.clone() } : {}),
  };
  const context: armConfiguration.ArmForwardContext = {
    ...c,
    shoulder: c.shoulder.clone(),
    up: c.up.clone(),
    right: c.right.clone(),
    forward: c.forward.clone(),
    upperParentWorld: c.upperParentWorld.clone(),
  };
  const bounds = { lower: Float64Array.from(b.lower), upper: Float64Array.from(b.upper) };
  return { request, start: Float64Array.from(start), context, bounds };
}

/**
 * The solver battery's files: `-a` and `-b` the synthetic scenarios, `-c` the drivers' requests
 * on solvers of their own build with a free and a one-plane environment, and one against the
 * upper arm's torso rows alone, `-d` and `-e` the
 * drivers' own calls with their own environment, the cheapest call that exercises each step
 * first.
 */
function recordArmPathSolverBattery(): Map<string, Recorded> {
  const files = new Map<string, Recorded>();
  pathFingerGeometry();
  for (const part of [0, 1] as const) {
    const s = new SolverStream();
    withCoreMath(() => recordSyntheticSolverCalls(s, part));
    files.set(
      `arm-path-solver-battery-${'ab'[part]}`,
      s.recorded(`arm-path-solver-battery-${'ab'[part]}`),
    );
  }

  const first = observeSolverCalls(runArmDrivers, (_i, solver, method, args) =>
    method === 'plan' ? PLAN.apply(solver, args) : RESTORE.apply(solver, args),
  );
  const DRIVER_BUDGET = 19_000;
  const chosen = chooseSolverCalls(first, 2 * DRIVER_BUDGET);
  const fileOf = new Map<number, number>();
  let spent = 0;
  for (const i of chosen) {
    spent += first[i].cost;
    fileOf.set(i, spent > DRIVER_BUDGET ? 1 : 0);
  }
  const driverStreams = [new SolverStream(), new SolverStream()];
  const ownStream = new SolverStream();
  const own = new WeakMap<armPath.ArmStepSolver, armPath.ArmStepSolver>();
  const OWN_CALLS = 36;
  const ownPicks = new Set(
    Array.from({ length: OWN_CALLS }, (_, k) => Math.floor(((k + 0.5) * first.length) / OWN_CALLS)),
  );
  // The drivers reach an infeasible elbow step only in calls too long to record whole; the
  // first one's inputs reach it again against just the upper arm's torso rows.
  const infeasible = first.findIndex((c) => c.flags.has('infeasible'));
  const second = observeSolverCalls(runArmDrivers, (i, solver, method, args) => {
    if (i === infeasible) {
      const internals = solver as unknown as SolverInternals;
      const mine = new armPath.ArmStepSolver(
        internals.calibration,
        internals.handGeometry,
        internals.handLength,
        internals.resolution,
      );
      const { request, start, context, bounds } = cloneSolverInputs(args);
      const full = args[4];
      const scratch = armPath.makeArmPathPlanOutput(
        internals.calibration,
        internals.handGeometry,
        full.rowCount,
      ).clearances;
      const kept = Array.from({ length: TORSO_SAMPLES + 1 }, (_, point) => point * 3);
      const torso: armPath.ArmPathEnvironment = {
        rowCount: kept.length,
        sample: (points, rows) => {
          full.sample(points, scratch);
          kept.forEach((from, slot) => {
            const r = scratch[from];
            Object.assign(rows[slot], { key: r.key, pointIndex: r.pointIndex, valid: r.valid });
            rows[slot].distance = r.distance;
            rows[slot].normal.copy(r.normal);
          });
        },
      };
      const o = armPath.makeArmPathPlanOutput(
        internals.calibration,
        internals.handGeometry,
        kept.length,
      );
      ownStream.plan(mine, request, start, context, bounds, torso, o);
    }
    if (ownPicks.has(i) && method === 'plan') {
      const internals = solver as unknown as SolverInternals;
      let mine = own.get(solver);
      if (!mine) {
        mine = new armPath.ArmStepSolver(
          internals.calibration,
          internals.handGeometry,
          internals.handLength,
          internals.resolution,
        );
        own.set(solver, mine);
      }
      const { request, start, context, bounds } = cloneSolverInputs(args);
      const output = armPath.makeArmPathPlanOutput(
        internals.calibration,
        internals.handGeometry,
        0,
      );
      const free = ownStream.plan(mine, request, start, context, bounds, PATH_FREE, output);
      const from = armConfiguration.forwardArm(
        pathConfiguration(start),
        internals.calibration,
        context,
        armConfiguration.makeArmForwardResult(),
      );
      const proxy = (f: armConfiguration.ArmForwardResult) =>
        f.wrist.clone().addScaledVector(f.h, (internals.handLength * HAND_CONTACT) / TORSO_SAMPLES);
      const a = proxy(from);
      const b = proxy(free.forward);
      if (a.distanceTo(b) > 1e-6) {
        const axis = b.clone().sub(a).normalize();
        const plane = pathPlane(HAND_PROXY, axis, (a.dot(axis) + b.dot(axis)) / 2);
        const o = armPath.makeArmPathPlanOutput(internals.calibration, internals.handGeometry, 1);
        ownStream.plan(mine, request, start, context, bounds, plane, o);
      }
    }
    const file = fileOf.get(i);
    if (file === undefined)
      return method === 'plan' ? PLAN.apply(solver, args) : RESTORE.apply(solver, args);
    return driverStreams[file].call(solver, method, args);
  });
  expect(second.length, 'solver calls across the two runs').toBe(first.length);
  files.set('arm-path-solver-battery-c', ownStream.recorded('arm-path-solver-battery-c'));
  for (const [k, stream] of driverStreams.entries()) {
    const name = `arm-path-solver-battery-${'de'[k]}`;
    files.set(name, stream.recorded(name));
  }
  // The battery is only worth its bytes if the chosen calls reach every step the drivers take.
  // A step only calls too long to fit a file reach is left to the synthetic scenarios.
  const covered = new Set(chosen.flatMap((i) => [...first[i].flags]));
  const reached = new Set(
    first.filter((c) => c.cost <= DRIVER_BUDGET).flatMap((c) => [...c.flags]),
  );
  expect(SOLVER_FLAGS.filter((f) => reached.has(f) && !covered.has(f))).toEqual([]);
  return files;
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

  it('match a fresh recording of the arm-path solver battery', () => {
    for (const [name, recorded] of recordArmPathSolverBattery()) settle(name, recorded);
  });
});
