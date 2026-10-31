/**
 * Frame hashes for comparing the engine across implementations.
 *
 * A frame is serialised to bytes: numbers are little-endian f64 with every NaN
 * written as `0x7ff8000000000000` (so payloads do not matter and -0 stays
 * distinct from +0); f32 values are little-endian with every NaN written as
 * `0x7fc00000`; booleans are one byte; a string is its UTF-8 byte length as u32
 * followed by the bytes; index arrays are u32 each.
 *
 * The sway solver and the transparent triangles hash those bytes with SHA-256
 * and keep 16 hex digits. The director's golden uses 64-bit FNV-1a instead
 * (`Fnv64`), because a real avatar's frames are hashed inside the page, where
 * there is no `node:crypto`. Everything the page needs lives in `parityKit`,
 * which references nothing outside itself so its source can be handed to the
 * page as it is.
 */

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type * as THREE from 'three';

/** Where each serialised value of a frame sits, for naming the first one that differs. */
export interface FieldSpan {
  label: string;
  offset: number;
  length: number;
}

/** What a frame is written into: a buffer that keeps the bytes, or a running hash. */
export interface HashSink {
  /** Whether labels are kept; a writer that ignores them is spared computing them. */
  readonly labelled: boolean;
  f64(value: number, label?: string): void;
  f64s(values: ArrayLike<number>, label?: string): void;
  f32(value: number, label?: string): void;
  f32s(values: ArrayLike<number>, label?: string): void;
  bool(value: boolean, label?: string): void;
  u32(value: number, label?: string): void;
  string(value: string, label?: string): void;
}

/** The part of a sway solver, `Spring` or `CoreSpring`, that a frame hash reads. */
export interface SpringState {
  readonly groups: ReadonlyArray<{
    readonly enabled: boolean;
    readonly joints: ReadonlyArray<{
      readonly cur: THREE.Vector3;
      readonly prev: THREE.Vector3;
      readonly solvedQ: THREE.Quaternion;
      readonly prevSolvedQ: THREE.Quaternion;
      readonly swing: THREE.Vector3;
      readonly limits: ArrayLike<number>;
      readonly spans: ArrayLike<number>;
    }>;
  }>;
  readonly _acc: number;
  readonly missing: readonly string[];
  readonly anchorDiagnostics: readonly unknown[];
}

/** What one director frame hash reads. Structural, so the page's objects fit it too. */
export interface DirectorFrameSource {
  /** The avatar root; every node under it, in `traverse` order, is hashed. */
  readonly root: THREE.Object3D;
  readonly profile: {
    readonly faceMeshes: readonly THREE.Mesh[];
    readonly morphTargets: ReadonlyMap<string, ReadonlyArray<{ readonly mesh: THREE.Mesh }>>;
  };
  readonly spring: SpringState;
  readonly armSolverOff: readonly string[];
}

/** A running 64-bit FNV-1a over everything written to it. */
export interface Fnv64Sink extends HashSink {
  /** Feed raw bytes. */
  bytes(values: Uint8Array): void;
  /** The hash so far as 16 hex digits. */
  digest(): string;
  /** Start again from the offset basis. */
  reset(): this;
}

/**
 * The hasher and the frame layouts, as one function that closes over nothing.
 *
 * `tools/parity/record-director.ts` hands `parityKit.toString()` to the page,
 * so the real-avatar frames and the synthetic golden are written by the same
 * code. Nothing in here may reference a module-level binding.
 */
export function parityKit() {
  const STAGE = 1 << 16;

  /**
   * FNV-1a 64 in two 32-bit halves. Per byte: `lo ^= b`, then multiply by the
   * prime 2^40 + 0x1b3. `lo * 0x1b3` is below 2^41, so it is exact in a double;
   * its low 32 bits are the new `lo` and its high bits carry into `hi`, with
   * `lo << 8` as the 2^40 term's contribution to the high word.
   */
  class Fnv64 implements Fnv64Sink {
    readonly labelled = false;
    #hi = 0xcbf29ce4;
    #lo = 0x84222325;
    readonly #stage = new Uint8Array(STAGE);
    readonly #view = new DataView(this.#stage.buffer);
    #length = 0;
    readonly #text = new TextEncoder();

    reset(): this {
      this.#hi = 0xcbf29ce4;
      this.#lo = 0x84222325;
      this.#length = 0;
      return this;
    }

    #mix(b: Uint8Array, n: number): void {
      let hi = this.#hi;
      let lo = this.#lo;
      for (let i = 0; i < n; i++) {
        lo = (lo ^ b[i]) >>> 0;
        const p = lo * 0x1b3;
        hi = (Math.imul(hi, 0x1b3) + Math.floor(p / 4294967296) + (lo << 8)) >>> 0;
        lo = p >>> 0;
      }
      this.#hi = hi;
      this.#lo = lo;
    }

    #flush(): void {
      this.#mix(this.#stage, this.#length);
      this.#length = 0;
    }

    #room(n: number): void {
      if (this.#length + n > STAGE) this.#flush();
    }

    bytes(values: Uint8Array): void {
      this.#flush();
      this.#mix(values, values.length);
    }

    f64(value: number): void {
      this.#room(8);
      if (Number.isNaN(value)) {
        this.#view.setUint32(this.#length, 0, true);
        this.#view.setUint32(this.#length + 4, 0x7ff80000, true);
      } else this.#view.setFloat64(this.#length, value, true);
      this.#length += 8;
    }

    f64s(values: ArrayLike<number>): void {
      for (let i = 0; i < values.length; i++) this.f64(values[i]);
    }

    f32(value: number): void {
      this.#room(4);
      if (Number.isNaN(value)) this.#view.setUint32(this.#length, 0x7fc00000, true);
      else this.#view.setFloat32(this.#length, value, true);
      this.#length += 4;
    }

    f32s(values: ArrayLike<number>): void {
      for (let i = 0; i < values.length; i++) this.f32(values[i]);
    }

    bool(value: boolean): void {
      this.#room(1);
      this.#stage[this.#length++] = value ? 1 : 0;
    }

    u32(value: number): void {
      this.#room(4);
      this.#view.setUint32(this.#length, value, true);
      this.#length += 4;
    }

    string(value: string): void {
      const encoded = this.#text.encode(value);
      this.u32(encoded.length);
      this.bytes(encoded);
    }

    digest(): string {
      this.#flush();
      return this.#hi.toString(16).padStart(8, '0') + this.#lo.toString(16).padStart(8, '0');
    }
  }

  /** `value` with the keys of every object in lexicographic order. */
  const sortedKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortedKeys);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        out[key] = sortedKeys((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };

  /**
   * The sway solver's own state: (4) the joints, (5) the step accumulator,
   * (6) `missing`, (7) the anchor diagnostics as key-sorted JSON, (8) the groups'
   * switches. Joint limits and spans go out as f64.
   */
  const writeSpringTail = (out: HashSink, spring: SpringState): void => {
    const named = out.labelled;
    spring.groups.forEach((g, gi) => {
      g.joints.forEach((j, k) => {
        const at = named ? `group ${gi} joint ${k}` : '';
        out.f64s(j.cur.toArray(), `${at}.cur`);
        out.f64s(j.prev.toArray(), `${at}.prev`);
        out.f64s(j.solvedQ.toArray(), `${at}.solvedQ`);
        out.f64s(j.prevSolvedQ.toArray(), `${at}.prevSolvedQ`);
        out.f64s(j.swing.toArray(), `${at}.swing`);
        out.f64s(j.limits, `${at}.limits`);
        out.f64s(j.spans, `${at}.spans`);
      });
    });
    out.f64(spring._acc, '_acc');
    out.u32(spring.missing.length, 'missing.length');
    spring.missing.forEach((m, i) => {
      out.string(m, `missing[${i}]`);
    });
    out.string(JSON.stringify(sortedKeys(spring.anchorDiagnostics)), 'anchorDiagnostics');
    spring.groups.forEach((g, gi) => {
      out.bool(g.enabled, `group ${gi}.enabled`);
    });
  };

  /**
   * Why the constrained arm solver can be off, numbered for the hash. The rig
   * writes `<side>: <reason>`; a reason not listed here is a new one and fails
   * the hash rather than going out as text the core would not produce.
   */
  const ARM_SOLVER_OFF = [
    'no palm frame (fingers unresolved)',
    'rest arm pose unreadable',
    'rest arm pose outside the calibrated model',
    'arm bones, limb lengths, palm or finger clearance unresolved',
    'arm bones not conformally scaled',
    'upper arm has no parent',
    'arm calibration axis must be nonzero',
    'upper humeral front must not parallel its axis',
    'hand palm normal must not parallel its axis',
    'wrist hard ranges must stay inside a 90 degree combined bend',
    'measured hand length must be finite and positive',
    'sweep resolution must be finite and positive',
  ];

  /** `rig.armSolverOff` as numbers: the count, then the side (L 0, R 1) and reason of each. */
  const writeArmSolverOff = (out: HashSink, lines: readonly string[]): void => {
    out.u32(lines.length, 'armSolverOff.length');
    for (const line of lines) {
      const side = line.startsWith('L: ') ? 0 : line.startsWith('R: ') ? 1 : -1;
      const reason = ARM_SOLVER_OFF.indexOf(line.slice(3));
      if (side < 0 || reason < 0) throw new Error(`armSolverOff line not in the table: ${line}`);
      out.u32(side, 'armSolverOff.side');
      out.u32(reason, 'armSolverOff.reason');
    }
  };

  /**
   * One director frame, taken after the full update and `Skeleton.update`.
   *
   * Every node under the root in `traverse` order: position, quaternion, scale,
   * matrix, matrixWorld, matrixWorldNeedsUpdate. Then each skeleton's
   * `boneMatrices` (f32, skeletons in the order their first mesh is reached),
   * the morph influences of `profile.faceMeshes` followed by the other meshes
   * of `profile.morphTargets` (each once; length, then values), the sway
   * solver's state, and `armSolverOff` as numbers.
   */
  const writeDirectorFrame = (out: HashSink, src: DirectorFrameSource): void => {
    const named = out.labelled;
    const skeletons: THREE.Skeleton[] = [];
    src.root.traverse((o) => {
      const tag = named ? o.name : '';
      out.f64s(o.position.toArray(), `${tag}.position`);
      out.f64s(o.quaternion.toArray(), `${tag}.quaternion`);
      out.f64s(o.scale.toArray(), `${tag}.scale`);
      out.f64s(o.matrix.elements, `${tag}.matrix`);
      out.f64s(o.matrixWorld.elements, `${tag}.matrixWorld`);
      out.bool(o.matrixWorldNeedsUpdate, `${tag}.matrixWorldNeedsUpdate`);
      const skeleton = (o as THREE.SkinnedMesh).isSkinnedMesh
        ? (o as THREE.SkinnedMesh).skeleton
        : null;
      if (skeleton && !skeletons.includes(skeleton)) skeletons.push(skeleton);
    });
    skeletons.forEach((s, i) => {
      if (s.boneMatrices === null) throw new Error(`skeleton ${i} has no bone matrices`);
      out.f32s(s.boneMatrices, named ? `skeleton ${i}.boneMatrices` : '');
    });
    const meshes: THREE.Mesh[] = [...src.profile.faceMeshes];
    for (const targets of src.profile.morphTargets.values()) {
      for (const t of targets) if (!meshes.includes(t.mesh)) meshes.push(t.mesh);
    }
    for (const mesh of meshes) {
      const influences = mesh.morphTargetInfluences ?? [];
      out.u32(influences.length, named ? `${mesh.name}.morphTargetInfluences.length` : '');
      out.f64s(influences, named ? `${mesh.name}.morphTargetInfluences` : '');
    }
    writeSpringTail(out, src.spring);
    writeArmSolverOff(out, src.armSolverOff);
  };

  const makeHasher = (): Fnv64Sink => new Fnv64();

  return { makeHasher, writeSpringTail, writeDirectorFrame, ARM_SOLVER_OFF };
}

const kit = parityKit();

/** A fresh running FNV-1a 64 hash. */
export function makeFnv64(): Fnv64Sink {
  return kit.makeHasher();
}

/** The FNV-1a 64 of `bytes` as 16 hex digits. */
export function fnv64(bytes: Uint8Array): string {
  const h = kit.makeHasher();
  h.bytes(bytes);
  return h.digest();
}

export const { writeDirectorFrame, ARM_SOLVER_OFF } = kit;

/** Appends values to a growing buffer, optionally noting where each one went. */
export class ByteWriter implements HashSink {
  #bytes = new Uint8Array(1 << 16);
  #view = new DataView(this.#bytes.buffer);
  #length = 0;
  readonly spans: FieldSpan[] | null;

  constructor(labelled = false) {
    this.spans = labelled ? [] : null;
  }

  get labelled(): boolean {
    return this.spans !== null;
  }

  #room(n: number): void {
    if (this.#length + n <= this.#bytes.length) return;
    let size = this.#bytes.length * 2;
    while (size < this.#length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = next;
    this.#view = new DataView(next.buffer);
  }

  #note(label: string, length: number): void {
    this.spans?.push({ label, offset: this.#length, length });
  }

  f64(value: number, label = ''): void {
    this.#room(8);
    this.#note(label, 8);
    if (Number.isNaN(value)) {
      this.#view.setUint32(this.#length, 0, true);
      this.#view.setUint32(this.#length + 4, 0x7ff80000, true);
    } else this.#view.setFloat64(this.#length, value, true);
    this.#length += 8;
  }

  /** `values` as consecutive f64, labelled `label[i]`. */
  f64s(values: ArrayLike<number>, label = ''): void {
    const named = this.spans !== null;
    for (let i = 0; i < values.length; i++) this.f64(values[i], named ? `${label}[${i}]` : '');
  }

  f32(value: number, label = ''): void {
    this.#room(4);
    this.#note(label, 4);
    if (Number.isNaN(value)) this.#view.setUint32(this.#length, 0x7fc00000, true);
    else this.#view.setFloat32(this.#length, value, true);
    this.#length += 4;
  }

  /** `values` as consecutive f32, labelled `label[i]`. */
  f32s(values: ArrayLike<number>, label = ''): void {
    const named = this.spans !== null;
    for (let i = 0; i < values.length; i++) this.f32(values[i], named ? `${label}[${i}]` : '');
  }

  bool(value: boolean, label = ''): void {
    this.#room(1);
    this.#note(label, 1);
    this.#view.setUint8(this.#length, value ? 1 : 0);
    this.#length += 1;
  }

  u32(value: number, label = ''): void {
    this.#room(4);
    this.#note(label, 4);
    this.#view.setUint32(this.#length, value, true);
    this.#length += 4;
  }

  string(value: string, label = ''): void {
    const bytes = new TextEncoder().encode(value);
    this.#room(4 + bytes.length);
    this.#note(label, 4 + bytes.length);
    this.#view.setUint32(this.#length, bytes.length, true);
    this.#bytes.set(bytes, this.#length + 4);
    this.#length += 4 + bytes.length;
  }

  /** The bytes written so far. */
  bytes(): Uint8Array {
    return this.#bytes.subarray(0, this.#length);
  }
}

/** First 16 hex digits of the SHA-256 of `bytes`. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** The label of the first value that differs between two serialisations of the same shape. */
export function firstDifference(a: ByteWriter, b: ByteWriter): string | null {
  const [sa, sb] = [a.spans, b.spans];
  if (sa === null || sb === null) throw new Error('firstDifference needs labelled writers');
  const [ba, bb] = [a.bytes(), b.bytes()];
  const count = Math.min(sa.length, sb.length);
  for (let i = 0; i < count; i++) {
    const [x, y] = [sa[i], sb[i]];
    if (x.label !== y.label || x.length !== y.length) {
      return `field ${i}: ${x.label} against ${y.label}`;
    }
    for (let k = 0; k < x.length; k++) {
      if (ba[x.offset + k] !== bb[y.offset + k]) return x.label;
    }
  }
  return sa.length === sb.length ? null : `${sa.length} fields against ${sb.length}`;
}

/**
 * One frame of a sway solver and the tree it poses, taken right after `update`.
 *
 * Local transforms, the manual `matrix` of nodes that do not auto-update, then
 * (after a world update from `root`, which this does) every `matrixWorld`;
 * then the solver's own state (see `parityKit`'s `writeSpringTail`).
 */
export function writeSpringState(
  out: ByteWriter,
  spring: SpringState,
  root: THREE.Object3D,
): ByteWriter {
  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => {
    nodes.push(o);
  });
  const named = out.spans !== null;
  const tag = (o: THREE.Object3D, field: string): string => (named ? `${o.name}.${field}` : '');
  for (const o of nodes) {
    out.f64s(o.position.toArray(), tag(o, 'position'));
    out.f64s(o.quaternion.toArray(), tag(o, 'quaternion'));
    out.f64s(o.scale.toArray(), tag(o, 'scale'));
  }
  for (const o of nodes) {
    if (!o.matrixAutoUpdate) out.f64s(o.matrix.elements, tag(o, 'matrix'));
  }
  root.updateMatrixWorld(true);
  for (const o of nodes) out.f64s(o.matrixWorld.elements, tag(o, 'matrixWorld'));
  kit.writeSpringTail(out, spring);
  return out;
}

/** One transparent-triangle target's sorted shell index. */
export interface TriangleTarget {
  key: string;
  index: ArrayLike<number>;
}

/** The targets in key order: each key, then its shell index as u32. */
export function writeTriangles(out: ByteWriter, targets: Iterable<TriangleTarget>): ByteWriter {
  const sorted = [...targets].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const t of sorted) {
    out.string(t.key, `${t.key}.key`);
    for (let i = 0; i < t.index.length; i++) out.u32(t.index[i], `${t.key}.index[${i}]`);
  }
  return out;
}

/** The shape of a recorded hash file. */
export interface HashFile {
  generator: string;
  fixtures: Record<string, { frames: number; hashes: string[] }>;
}

/** The shape of the director's golden: per-frame hashes and one fold of the boundary calls. */
export interface DirectorHashFile {
  generator: string;
  fixtures: Record<string, { frames: number; frame: string[]; calls: string }>;
}

export async function writeHashFile(
  path: string,
  file: HashFile | DirectorHashFile,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(file)}\n`);
}
