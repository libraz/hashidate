/**
 * Frame hashes for comparing the sway solver and the transparent-triangle
 * kernel across implementations.
 *
 * A frame is serialised to bytes and hashed with SHA-256, keeping the first 16
 * hex digits. Numbers are little-endian f64 with every NaN written as
 * `0x7ff8000000000000` (so payloads do not matter and -0 stays distinct from
 * +0); booleans are one byte; a string is its UTF-8 byte length as u32 followed
 * by the bytes; index arrays are u32 each.
 */

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type * as THREE from 'three';

const CANONICAL_NAN = 0x7ff8000000000000n;

/** Where each serialised value of a frame sits, for naming the first one that differs. */
export interface FieldSpan {
  label: string;
  offset: number;
  length: number;
}

/** Appends values to a growing buffer, optionally noting where each one went. */
export class ByteWriter {
  #bytes = new Uint8Array(1 << 16);
  #view = new DataView(this.#bytes.buffer);
  #length = 0;
  readonly spans: FieldSpan[] | null;

  constructor(labelled = false) {
    this.spans = labelled ? [] : null;
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
    if (Number.isNaN(value)) this.#view.setBigUint64(this.#length, CANONICAL_NAN, true);
    else this.#view.setFloat64(this.#length, value, true);
    this.#length += 8;
  }

  /** `values` as consecutive f64, labelled `label[i]`. */
  f64s(values: ArrayLike<number>, label = ''): void {
    const named = this.spans !== null;
    for (let i = 0; i < values.length; i++) this.f64(values[i], named ? `${label}[${i}]` : '');
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

/** `value` with the keys of every object in lexicographic order. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortedKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * One frame of a sway solver and the tree it poses, taken right after `update`.
 *
 * Local transforms, the manual `matrix` of nodes that do not auto-update, then
 * (after a world update from `root`, which this does) every `matrixWorld`;
 * the joints; the step accumulator; `missing`; the anchor diagnostics as
 * key-sorted JSON; the groups' switches. Joint limits and spans go out as f64.
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

export async function writeHashFile(path: string, file: HashFile): Promise<void> {
  await writeFile(path, `${JSON.stringify(file)}\n`);
}
