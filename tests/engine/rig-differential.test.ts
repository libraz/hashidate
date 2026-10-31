import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArmAnatomy } from '@/engine/anatomy';
import { FaceSurface } from '@/engine/anatomy/face';
import { Autopilot } from '@/engine/autopilot';
import { Director } from '@/engine/director';
import { ArmTransaction } from '@/engine/motion/arm-transaction';
import { CharacterFrame } from '@/engine/motion/frame';
import { Rig } from '@/engine/rig';
import {
  CoreArmAnatomy,
  CoreArmTransaction,
  CoreCharacterFrame,
  CoreFaceSurface,
  CoreRig,
} from '@/engine/rig/core';
import type { Side } from '@/engine/types';
import { withSide } from '@/server/side';
import {
  type DirectorHashFile,
  type Fnv64Sink,
  type HashSink,
  makeFnv64,
  writeDirectorFrame,
} from '../../tools/parity/hash';
import { withCoreMath } from '../helpers/core-math';
import {
  type Action,
  BOUNDARY,
  DIRECTOR_FIXTURES,
  type DirectorFixture,
  prepareFixture,
  splitmix64,
} from '../helpers/director-fixtures';
import { must } from '../helpers/must';

/**
 * The core's rig against the TS rig, call by call.
 *
 * Each fixture builds two identical avatars and runs one Director on the TS rig and one on
 * `CoreRig`, frame by frame under the same `withCoreMath` and random streams as the golden.
 * Every call across the facade boundary (`BOUNDARY`) is serialised as the golden's calls hash
 * reads it — the method, its arguments and result after the call, then every node's position,
 * quaternion, scale, matrixWorld and matrixWorldNeedsUpdate with no update — plus the root's
 * ancestors' matrices, and the two runs' records are compared after every frame. The first
 * difference is reported with its fixture, frame, call and field. Both runs' frames and folded
 * calls must also equal `director-parity.json`.
 *
 * The step loop is `runDirectorFixture`'s, step for step, so the TS run reproduces the golden.
 */

const recorded = JSON.parse(
  readFileSync(new URL('./director-parity.json', import.meta.url), 'utf8'),
) as DirectorHashFile;

/** As the golden's run seeds the server's side draws. */
const SIDE_SEED = 0x6861_7368_6964_6174n ^ 1n;
const CAMERA = new THREE.Vector3(0, 1.35, 1.8);
const ARM_EDIT = {
  shoulder: [0.34, -0.83, 0.44],
  upperArm: [0.38, -0.79, 0.48],
  lowerArm: [0.08, -0.36, 0.93],
  hand: [0.1, -0.2, 0.97],
} as const;

/** Bytes per node in the dump: position 3, quaternion 4, scale 3, matrixWorld 16, a flag. */
const NODE_BYTES = 8 * 26 + 1;

/** A resettable byte record in the hash's encoding. */
class Tape implements HashSink {
  readonly labelled = false;
  #bytes = new Uint8Array(1 << 20);
  #view = new DataView(this.#bytes.buffer);
  #text = new TextEncoder();
  length = 0;

  reset(): void {
    this.length = 0;
  }

  bytes(): Uint8Array {
    return this.#bytes.subarray(0, this.length);
  }

  #room(n: number): void {
    if (this.length + n <= this.#bytes.length) return;
    const next = new Uint8Array(Math.max(this.#bytes.length * 2, this.length + n));
    next.set(this.#bytes.subarray(0, this.length));
    this.#bytes = next;
    this.#view = new DataView(next.buffer);
  }

  f64(value: number): void {
    this.#room(8);
    if (Number.isNaN(value)) {
      this.#view.setUint32(this.length, 0, true);
      this.#view.setUint32(this.length + 4, 0x7ff80000, true);
    } else this.#view.setFloat64(this.length, value, true);
    this.length += 8;
  }

  f64s(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.f64(values[i]);
  }

  f32(value: number): void {
    this.#room(4);
    if (Number.isNaN(value)) this.#view.setUint32(this.length, 0x7fc00000, true);
    else this.#view.setFloat32(this.length, value, true);
    this.length += 4;
  }

  f32s(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.f32(values[i]);
  }

  bool(value: boolean): void {
    this.#room(1);
    this.#bytes[this.length++] = value ? 1 : 0;
  }

  u32(value: number): void {
    this.#room(4);
    this.#view.setUint32(this.length, value, true);
    this.length += 4;
  }

  string(value: string): void {
    const encoded = this.#text.encode(value);
    this.u32(encoded.length);
    this.#room(encoded.length);
    this.#bytes.set(encoded, this.length);
    this.length += encoded.length;
  }
}

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

/** A method's argument and result schemas, as `BOUNDARY` lists them. */
type MethodShape = (typeof BOUNDARY.Rig)['reset'];

/** One call as recorded: where its bytes end on the tape, and where its node dump starts. */
interface Mark {
  id: string;
  nodesAt: number;
  end: number;
  ancestorsEnd: number;
}

/** One director's boundary calls in the current frame. */
class Recorder {
  readonly tape = new Tape();
  /** The root's ancestors after each call; compared, not folded into the golden's hash. */
  readonly ancestors = new Tape();
  readonly marks: Mark[] = [];
  /** Every call as the golden folds it. */
  readonly calls: Fnv64Sink = makeFnv64();
  count = 0;
  /**
   * Above 0 while the TS rig calls its own boundary methods from its constructor or the
   * `limitsEnabled` setter: the golden folds those calls, and the core makes them inside itself.
   */
  internal = 0;
  /** Runs after each compared call with its index in the frame. */
  afterCall: ((index: number) => void) | null = null;
  /** The call to describe, by index in the frame, and what was found there. */
  describeAt = -1;
  described: string | null = null;

  constructor(
    readonly nodes: readonly THREE.Object3D[],
    readonly chain: readonly THREE.Object3D[],
  ) {}

  record(id: string, shape: MethodShape, args: unknown[], result: unknown): void {
    if (args.length > shape.args.length) throw new Error(`${id} called with ${args.length} args`);
    const t = this.tape;
    const start = t.length;
    t.string(id);
    shape.args.forEach((schema, i) => {
      schema(t, args[i], `${id} argument ${i}`);
    });
    shape.ret(t, result, `${id} result`);
    writeNodes(t, this.nodes);
    this.calls.bytes(t.bytes().subarray(start));
    if (this.internal > 0) {
      t.length = start;
      return;
    }
    this.#mark(id, start + (t.length - start - NODE_BYTES * this.nodes.length), args, result);
  }

  /** A write to `limitsEnabled`: compared like a call, and not in the golden's fold. */
  recordSetter(id: string, value: unknown): void {
    const t = this.tape;
    t.string(id);
    t.bool(value === true);
    const nodesAt = t.length;
    writeNodes(t, this.nodes);
    this.#mark(id, nodesAt, [value], undefined);
  }

  #mark(id: string, nodesAt: number, args: unknown[], result: unknown): void {
    for (const a of this.chain) {
      this.ancestors.f64s(a.matrix.elements);
      this.ancestors.f64s(a.matrixWorld.elements);
      this.ancestors.bool(a.matrixWorldNeedsUpdate);
    }
    const index = this.marks.length;
    if (index === this.describeAt) this.described = describeCall(id, args, result);
    this.marks.push({ id, nodesAt, end: this.tape.length, ancestorsEnd: this.ancestors.length });
    this.count++;
    this.afterCall?.(index);
  }

  /** Starts the next frame's record. */
  endFrame(): void {
    this.tape.reset();
    this.ancestors.reset();
    this.marks.length = 0;
  }
}

/** Arguments and result as JSON, three's values as their components. */
function describeCall(id: string, args: unknown[], result: unknown): string {
  const plain = (_key: string, v: unknown): unknown => {
    if (v instanceof THREE.Vector3) return [v.x, v.y, v.z];
    if (v instanceof THREE.Quaternion) return [v.x, v.y, v.z, v.w];
    if (v instanceof THREE.Matrix3) return Array.from(v.elements);
    if (ArrayBuffer.isView(v)) return Array.from(v as Float64Array);
    if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
    return v;
  };
  return `${id}(${args.map((a) => JSON.stringify(a, plain)).join(', ')}) -> ${JSON.stringify(result, plain)}`;
}

const TS_CLASSES = {
  Rig: Rig.prototype,
  ArmAnatomy: ArmAnatomy.prototype,
  FaceSurface: FaceSurface.prototype,
  CharacterFrame: CharacterFrame.prototype,
  ArmTransaction: ArmTransaction.prototype,
} as const;

const CORE_CLASSES = {
  Rig: CoreRig.prototype,
  ArmAnatomy: CoreArmAnatomy.prototype,
  FaceSurface: CoreFaceSurface.prototype,
  CharacterFrame: CoreCharacterFrame.prototype,
  ArmTransaction: CoreArmTransaction.prototype,
} as const;

const recorders: { ts: Recorder | null; core: Recorder | null } = { ts: null, core: null };
let depth = 0;

/** Wraps every boundary method of both families; a call from outside the boundary is recorded. */
function watch(): () => void {
  const restore: Array<() => void> = [];
  for (const [family, classes] of [
    ['ts', TS_CLASSES],
    ['core', CORE_CLASSES],
  ] as const) {
    for (const [cls, methods] of Object.entries(BOUNDARY)) {
      const proto = classes[cls as keyof typeof classes] as unknown as Record<string, unknown>;
      for (const [name, shape] of Object.entries(methods)) {
        const original = proto[name];
        if (typeof original !== 'function') {
          // The core's anatomy carries only what motion calls; the rest are the TS rig's own.
          if (family === 'core' && cls === 'ArmAnatomy') continue;
          throw new Error(`${family} ${cls}.${name} is not a method`);
        }
        const id = `${cls}.${name}`;
        proto[name] = function (this: unknown, ...args: unknown[]) {
          depth++;
          let result: unknown;
          try {
            result = original.apply(this, args);
          } finally {
            depth--;
          }
          if (depth === 0) recorders[family]?.record(id, shape, args, result);
          return result;
        };
        restore.push(() => {
          proto[name] = original;
        });
      }
    }
  }
  for (const [family, proto] of [
    ['ts', Rig.prototype],
    ['core', CoreRig.prototype],
  ] as const) {
    const descriptor = must(Object.getOwnPropertyDescriptor(proto, 'limitsEnabled'), 'setter');
    const set = must(descriptor.set, 'setter');
    Object.defineProperty(proto, 'limitsEnabled', {
      ...descriptor,
      set(this: unknown, on: boolean) {
        const recorder = depth === 0 ? recorders[family] : null;
        if (recorder) recorder.internal++;
        try {
          set.call(this, on);
        } finally {
          if (recorder) {
            recorder.internal--;
            recorder.recordSetter('Rig.limitsEnabled=', on);
          }
        }
      },
    });
    restore.push(() => {
      Object.defineProperty(proto, 'limitsEnabled', descriptor);
    });
  }
  return () => {
    for (const undo of restore) undo();
  };
}

function placeWrapper(
  wrapper: THREE.Object3D,
  pose: NonNullable<DirectorFixture['steps'][number]['wrapper']>,
): void {
  wrapper.position.set(...pose.position);
  wrapper.quaternion.set(...pose.quaternion);
  wrapper.scale.setScalar(pose.scale);
}

function apply(director: Director, action: Action): void {
  if ('perform' in action) director.perform(action.perform);
  else if ('gesture' in action) director.gesture(action.gesture, action.side);
  else if ('point' in action) director.point(action.point, action.spec);
  else if ('hop' in action) director.hop(action.hop);
  else if ('limits' in action) director.rig.limitsEnabled = action.limits;
  else if ('aim' in action) {
    director.rig.aimArm(action.aim, {
      shoulder: [...ARM_EDIT.shoulder],
      upperArm: [...action.upperArm],
      lowerArm: [...ARM_EDIT.lowerArm],
      hand: [...ARM_EDIT.hand],
    });
  } else if ('curl' in action) director.rig.curlFinger(action.curl, action.side, action.amount);
  else if ('hand' in action) director.rig.curlHand(action.hand, action.curls);
  else director.rig.measure(action.measure);
}

/** One director and what drives it, as `runDirectorFixture` sets them up. */
class Run {
  readonly root: THREE.Object3D;
  readonly wrapper: THREE.Group | null;
  readonly profile: ReturnType<typeof prepareFixture>['profile'];
  readonly recorder: Recorder;
  readonly skeletons: THREE.Skeleton[] = [];
  readonly frames: string[] = [];
  #director: Director | null = null;
  #autopilot: Autopilot | null = null;
  readonly #sideRandom = splitmix64(SIDE_SEED);
  readonly #gaze = CAMERA.clone();
  readonly #frameSink = makeFnv64();

  constructor(
    readonly fixture: DirectorFixture,
    readonly family: 'ts' | 'core',
  ) {
    const { root, wrapper, profile } = prepareFixture(fixture);
    this.root = root;
    this.wrapper = wrapper;
    this.profile = profile;
    const nodes: THREE.Object3D[] = [];
    root.traverse((o) => {
      nodes.push(o);
    });
    for (const o of nodes) {
      const s = (o as THREE.SkinnedMesh).isSkinnedMesh ? (o as THREE.SkinnedMesh).skeleton : null;
      if (s && !this.skeletons.includes(s)) this.skeletons.push(s);
    }
    const chain: THREE.Object3D[] = [];
    for (let a = root.parent; a; a = a.parent) chain.push(a);
    this.recorder = new Recorder(nodes, chain);
  }

  get director(): Director {
    return must(this.#director, 'director');
  }

  /** Builds the director, recording the calls its construction makes. */
  build(): void {
    const { family, profile } = this;
    recorders[family] = this.recorder;
    try {
      const random = splitmix64();
      // The one cast the nominal gap needs: `Rig` has private members `CoreRig` does not carry.
      const rig = (p: typeof profile): Rig => {
        this.recorder.internal++;
        try {
          return family === 'core' ? (new CoreRig(p) as unknown as Rig) : new Rig(p);
        } finally {
          this.recorder.internal--;
        }
      };
      this.#director = withCoreMath(() => new Director(profile, undefined, { random, rig }));
      this.#autopilot = this.fixture.idle ? new Autopilot(splitmix64()) : null;
      if (this.#autopilot) this.#director.auto = true;
    } finally {
      recorders[family] = null;
    }
  }

  step(frame: number): void {
    const { family } = this;
    const step = must(this.fixture.steps[frame], 'step');
    const built = this.director;
    recorders[family] = this.recorder;
    try {
      if (step.wrapper && this.wrapper) placeWrapper(this.wrapper, step.wrapper);
      withCoreMath(() => {
        for (const action of step.actions ?? []) apply(built, action);
        for (const choice of this.#autopilot?.advance(step.dt, true) ?? []) {
          if ('act' in choice) {
            const sided = withSide({ cmd: 'idleAct', act: choice.act }, this.#sideRandom) as {
              act: string;
              side?: Side;
            };
            built.idleAct(sided.act, sided.side);
          } else built.idleFace(choice.face);
        }
        if (step.camera) this.#gaze.set(...step.camera);
        built.update(step.dt, { headWorldTarget: this.#gaze });
        this.root.updateMatrixWorld(true);
        for (const s of this.skeletons) s.update();
      });
    } finally {
      recorders[family] = null;
    }
    writeDirectorFrame(this.#frameSink.reset(), {
      root: this.root,
      profile: this.profile,
      spring: built.spring,
      armSolverOff: built.rig.armSolverOff,
    });
    this.frames.push(this.#frameSink.digest());
  }

  dispose(): void {
    this.#director?.dispose();
  }
}

function f64At(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + at, 8).getFloat64(0, true);
}

const NODE_FIELDS: ReadonlyArray<readonly [string, number]> = [
  ['position', 3],
  ['quaternion', 4],
  ['scale', 3],
  ['matrixWorld', 16],
];

/** Where in a node's dump byte `k` falls. */
function nodeField(k: number): string {
  let at = 0;
  for (const [name, n] of NODE_FIELDS) {
    if (k < at + 8 * n) return `${name}[${Math.floor((k - at) / 8)}]`;
    at += 8 * n;
  }
  return 'matrixWorldNeedsUpdate';
}

/** Bytes per ancestor in the dump: matrix 16, matrixWorld 16, a flag. */
const ANCESTOR_BYTES = 8 * 32 + 1;

function ancestorDifference(
  call: number,
  id: string,
  a: Uint8Array,
  b: Uint8Array,
  rel: number,
  start: number,
): string {
  const level = Math.floor(rel / ANCESTOR_BYTES);
  const within = rel % ANCESTOR_BYTES;
  if (within === 8 * 32) {
    const at = start + rel;
    return `call ${call} ${id}: ancestor ${level} matrixWorldNeedsUpdate: TS ${a[at]}, core ${b[at]}`;
  }
  const field = within < 128 ? 'matrix' : 'matrixWorld';
  const at = start + level * ANCESTOR_BYTES + within - (within % 8);
  const e = Math.floor((within % 128) / 8);
  return `call ${call} ${id}: ancestor ${level} ${field}[${e}]: TS ${f64At(a, at)}, core ${f64At(b, at)}`;
}

/** The first byte at which two runs' records of one frame differ, as a sentence; null if none. */
function frameDifference(ts: Recorder, rust: Recorder): { call: number; text: string } | null {
  const [a, b] = [ts.marks, rust.marks];
  const [ta, tb] = [ts.tape.bytes(), rust.tape.bytes()];
  const [aa, ab] = [ts.ancestors.bytes(), rust.ancestors.bytes()];
  const count = Math.min(a.length, b.length);
  let start = 0;
  let ancestorStart = 0;
  for (let i = 0; i < count; i++) {
    const [x, y] = [a[i], b[i]];
    if (x.id !== y.id) return { call: i, text: `call ${i}: ${x.id} against ${y.id}` };
    if (x.end - start !== y.end - start || x.nodesAt !== y.nodesAt) {
      return { call: i, text: `call ${i} ${x.id}: record lengths differ` };
    }
    for (let k = start; k < x.end; k++) {
      if (ta[k] === tb[k]) continue;
      if (k < x.nodesAt) {
        return {
          call: i,
          text: `call ${i} ${x.id}: arguments or result differ at byte ${k - start}`,
        };
      }
      const rel = k - x.nodesAt;
      const node = Math.floor(rel / NODE_BYTES);
      const within = rel % NODE_BYTES;
      const field = nodeField(within);
      const aligned =
        x.nodesAt + node * NODE_BYTES + (within < 8 * 26 ? within - (within % 8) : within);
      const values =
        within < 8 * 26
          ? `TS ${f64At(ta, aligned)}, core ${f64At(tb, aligned)}`
          : `TS ${ta[k]}, core ${tb[k]}`;
      return {
        call: i,
        text: `call ${i} ${x.id}: node ${node} (${ts.nodes[node]?.name}) ${field}: ${values}`,
      };
    }
    for (let k = ancestorStart; k < x.ancestorsEnd; k++) {
      if (aa[k] !== ab[k])
        return {
          call: i,
          text: ancestorDifference(i, x.id, aa, ab, k - ancestorStart, ancestorStart),
        };
    }
    start = x.end;
    ancestorStart = x.ancestorsEnd;
  }
  if (a.length !== b.length) {
    const next = a.length > b.length ? `TS calls ${a[count].id}` : `core calls ${b[count].id}`;
    return { call: count, text: `${a.length} calls against ${b.length}; ${next}` };
  }
  return null;
}

interface Divergence {
  fixture: string;
  frame: number;
  call: number;
  text: string;
}

interface Outcome {
  divergence: Divergence | null;
  calls: number;
  ts: Run;
  core: Run;
}

/** Runs one fixture on both rigs; stops at the first frame whose calls differ. */
function differential(
  fixture: DirectorFixture,
  tamper?: (run: Run, frame: number, index: number) => void,
): Outcome {
  const ts = new Run(fixture, 'ts');
  const rust = new Run(fixture, 'core');
  let divergence: Divergence | null = null;
  try {
    // Frame -1 is construction: Body's calls while the directors are built.
    for (let frame = -1; frame < fixture.steps.length && !divergence; frame++) {
      if (tamper) rust.recorder.afterCall = (index) => tamper(rust, frame, index);
      if (frame < 0) {
        ts.build();
        rust.build();
      } else {
        ts.step(frame);
        rust.step(frame);
      }
      const d = frameDifference(ts.recorder, rust.recorder);
      if (d) divergence = { fixture: fixture.id, frame, ...d };
      ts.recorder.endFrame();
      rust.recorder.endFrame();
    }
  } finally {
    ts.dispose();
    rust.dispose();
  }
  return { divergence, calls: ts.recorder.count, ts, core: rust };
}

/** The divergence, with both sides' arguments and result at that call. */
function explain(fixture: DirectorFixture, d: Divergence): string {
  const ts = new Run(fixture, 'ts');
  const rust = new Run(fixture, 'core');
  try {
    for (let frame = -1; frame <= d.frame; frame++) {
      if (frame === d.frame) {
        ts.recorder.describeAt = d.call;
        rust.recorder.describeAt = d.call;
      }
      if (frame < 0) {
        ts.build();
        rust.build();
      } else {
        ts.step(frame);
        rust.step(frame);
      }
      ts.recorder.endFrame();
      rust.recorder.endFrame();
    }
  } finally {
    ts.dispose();
    rust.dispose();
  }
  return [
    `${d.fixture}, frame ${d.frame}, ${d.text}`,
    `  TS:   ${ts.recorder.described ?? '(no call)'}`,
    `  core: ${rust.recorder.described ?? '(no call)'}`,
  ].join('\n');
}

let unwatch: () => void = () => undefined;

describe('the core rig against the TS rig', () => {
  beforeAll(() => {
    unwatch = watch();
  });
  afterAll(() => unwatch());

  for (const f of DIRECTOR_FIXTURES) {
    it(`matches call for call: ${f.id}`, () => {
      const outcome = differential(f);
      if (outcome.divergence) throw new Error(explain(f, outcome.divergence));
      expect(outcome.calls).toBeGreaterThan(0);
      const golden = must(recorded.fixtures[f.id], f.id);
      // The TS run is the golden's, so the comparison above is against the recorded rig. The
      // core's fold differs by the calls the TS rig makes on itself, so only its frames are.
      expect(outcome.ts.frames).toEqual(golden.frame);
      expect(outcome.ts.recorder.calls.digest()).toBe(golden.calls);
      expect(outcome.core.frames).toEqual(golden.frame);
    });
  }

  it('reports one bit flipped on the core side, at the call after it', () => {
    const f = must(
      DIRECTOR_FIXTURES.find((x) => x.id === 'a heartHands'),
      'a heartHands',
    );
    const bits = new Float64Array(1);
    const word = new BigUint64Array(bits.buffer);
    let flipped = -1;
    const outcome = differential(f, (run, frame, index) => {
      if (frame !== 60 || index !== 5) return;
      const bone = must(run.profile.bones['lowerArm.R'], 'lowerArm.R');
      bits[0] = bone.quaternion.x;
      word[0] ^= 1n;
      // A write through the core-backed node lands in the core's graph, not in three's object.
      bone.quaternion.x = bits[0];
      flipped = index;
    });
    expect(flipped).toBe(5);
    expect(outcome.divergence).not.toBeNull();
    expect(outcome.divergence?.frame).toBe(60);
    expect(outcome.divergence?.call).toBe(6);
  });
});
