/**
 * Run a recorded avatar session through the sway solver.
 *
 *     yarn tsx tools/parity/replay-spring.ts --avatars manuka,yoka,neru
 *
 * Reads what `record-spring.ts` wrote and rebuilds the avatar's tree. The parity pass runs
 * `Spring` under `withCoreMath` (so the transcendentals are the core's) on the recorded `dt` and
 * compares the hash of every frame with `backup/parity/<avatar>.spring.expected.json`, which was
 * written from the reference implementation. Only the recorded-`dt` pass has expected hashes. The
 * timing pass runs `Spring` on the host's `Math` over the recorded `dt` and over every frame at
 * 1/60 s, since a recording made on software GL is capped at 50 ms per frame, and reports the
 * median `update`.
 *
 * Exits 1 on the first mismatch of any avatar.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import * as THREE from 'three';
import { Spring } from '../../src/engine/secondary';
import type { AvatarDescriptor, Profile } from '../../src/engine/types';
import { coreMathCalls, withCoreMath } from '../../tests/helpers/core-math';
import { loadCoreForNode } from '../rust-core/node';
import { ROOT } from '../shared/dev-servers';
import { ByteWriter, type HashFile, hashBytes, writeSpringState } from './hash';

const RECORD_DIR = 'backup/parity';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Floats per node state in the recording; see `record-spring.ts`. */
const NODE_FLOATS = 46;
const NOMINAL_DT = 1 / 60;

const KIND_UPDATE = 0;
const KIND_ENABLE = 1;
const KIND_CALIBRATE = 2;
const KIND_RESET = 3;

const FLAG_AUTO = 1;
const FLAG_WORLD_AUTO = 2;
const FLAG_PIVOT = 4;

interface Header {
  avatar: string;
  frames: number;
  rootIndex: number;
  nodes: Array<{ name: string; parent: number; bone: boolean }>;
  groups: Array<{ id: string; joints: number[]; roots: number[] }>;
  ids: string[];
  anchorMeta: Record<string, unknown>;
}

interface Change {
  id: number;
  flags: number;
  /** Position, rotation, scale. */
  pose: Float64Array;
  pivot: Float64Array | null;
  matrix: Float64Array | null;
  world: Float64Array | null;
}

interface Event {
  kind: number;
  born: Float64Array[];
  changes: Change[];
  dt: number;
  enabled: boolean;
  figures: [number, number, number];
  groupEnabled: Float64Array;
  drives: Float64Array;
  id: string;
  poses: Float64Array;
}

/** `value` with the `{ negativeZero: true }` markers turned back into -0. */
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0][0] === 'negativeZero') return -0;
    return Object.fromEntries(entries.map(([k, v]) => [k, decode(v)]));
  }
  return value;
}

async function loadRecord(avatar: string): Promise<{ header: Header; events: Event[] }> {
  const base = join(ROOT, RECORD_DIR, `${avatar}.spring`);
  const header = JSON.parse(await readFile(`${base}.json`, 'utf8')) as Header;
  const file = await readFile(`${base}.bin`);
  const f = new Float64Array(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const events: Event[] = [];
  let at = 0;
  const take = (n: number): Float64Array => {
    const view = f.subarray(at, at + n);
    at += n;
    return view;
  };
  while (at < f.length) {
    const ev: Event = {
      kind: f[at++],
      born: [],
      changes: [],
      dt: 0,
      enabled: true,
      figures: [1, 1, 1],
      groupEnabled: new Float64Array(0),
      drives: new Float64Array(0),
      id: '',
      poses: new Float64Array(0),
    };
    for (let n = f[at++]; n > 0; n--) ev.born.push(take(NODE_FLOATS));
    for (let n = f[at++]; n > 0; n--) {
      const id = f[at++];
      const flags = f[at++];
      const pose = take(10);
      const pivot = flags & FLAG_PIVOT ? take(3) : null;
      const matrix = flags & FLAG_AUTO ? null : take(16);
      const world = id < header.rootIndex || !(flags & FLAG_WORLD_AUTO) ? take(16) : null;
      ev.changes.push({ id, flags, pose, pivot, matrix, world });
    }
    if (ev.kind === KIND_UPDATE) {
      ev.dt = f[at++];
      ev.enabled = f[at++] !== 0;
      ev.figures = [f[at++], f[at++], f[at++]];
      ev.groupEnabled = take(f[at++]);
      ev.drives = take(4 * f[at++]);
    } else if (ev.kind === KIND_ENABLE) {
      ev.id = header.ids[f[at++]];
    } else if (ev.kind === KIND_CALIBRATE) {
      ev.id = header.ids[f[at++]];
      ev.poses = take(4 * f[at++]);
    } else if (ev.kind !== KIND_RESET) {
      throw new Error(`${avatar}: unknown event kind ${ev.kind} at float ${at}`);
    }
    events.push(ev);
  }
  header.anchorMeta = decode(header.anchorMeta) as Record<string, unknown>;
  return { header, events };
}

/** One rebuilt copy of the recorded tree. */
class Tree {
  readonly nodes: THREE.Object3D[] = [];
  /** Set once the solver exists; the hierarchy is fixed from then on but for plain leaves. */
  built = false;
  readonly #parents: Set<number>;

  constructor(private readonly header: Header) {
    this.#parents = new Set(header.nodes.map((n) => n.parent));
  }

  get root(): THREE.Object3D {
    return this.nodes[this.header.rootIndex];
  }

  birth(state: Float64Array): void {
    const id = this.nodes.length;
    const info = this.header.nodes[id];
    // A node born after the solver is an outline: a childless mesh, which the viewer adds as a
    // plain leaf. The recording does not say "mesh", so a bone or a parent there is refused.
    if (this.built && (info.bone || this.#parents.has(id))) {
      throw new Error(
        `${this.header.avatar}: ${info.name} was born after construction and is not a childless mesh`,
      );
    }
    const node = info.bone
      ? new THREE.Bone()
      : this.built
        ? new THREE.Mesh()
        : new THREE.Object3D();
    node.name = info.name;
    this.nodes.push(node);
    if (info.parent >= 0) this.nodes[info.parent].add(node);
    const meta = this.header.anchorMeta[id];
    if (meta !== undefined) node.userData.skinPointAnchor = structuredClone(meta);
    const flags = state[0];
    this.pose(node, flags, state.subarray(1, 11), state.subarray(11, 14));
    if (!(flags & FLAG_AUTO)) node.matrix.fromArray(state, 14);
    if (id < this.header.rootIndex || !(flags & FLAG_WORLD_AUTO))
      node.matrixWorld.fromArray(state, 30);
  }

  change(c: Change): void {
    const node = this.nodes[c.id];
    this.pose(node, c.flags, c.pose, c.pivot);
    if (c.matrix) node.matrix.fromArray(c.matrix);
    if (c.world) node.matrixWorld.fromArray(c.world);
  }

  private pose(
    node: THREE.Object3D,
    flags: number,
    pose: Float64Array,
    pivot: Float64Array | null,
  ): void {
    node.matrixAutoUpdate = (flags & FLAG_AUTO) !== 0;
    node.matrixWorldAutoUpdate = (flags & FLAG_WORLD_AUTO) !== 0;
    node.position.set(pose[0], pose[1], pose[2]);
    node.quaternion.set(pose[3], pose[4], pose[5], pose[6]);
    node.scale.set(pose[7], pose[8], pose[9]);
    if (flags & FLAG_PIVOT && pivot)
      node.pivot = (node.pivot ?? new THREE.Vector3()).fromArray(pivot);
    else node.pivot = null;
  }

  apply(ev: Event): void {
    for (const state of ev.born) this.birth(state);
    for (const c of ev.changes) this.change(c);
  }
}

/** One `Spring` on one rebuilt tree. */
class Side {
  spring!: Spring;
  constructor(
    readonly tree: Tree,
    private readonly build: (profile: Profile) => Spring,
  ) {}

  construct(): void {
    this.spring = this.build({ root: this.tree.root } as Profile);
    this.tree.built = true;
  }

  /** Everything an update frame hands the solver, as the recording has it. */
  feed(ev: Event): void {
    const s = this.spring;
    s.enabled = ev.enabled;
    [s.stiffnessScale, s.inertiaScale, s.gravityScale] = ev.figures;
    if (s.groups.length !== ev.groupEnabled.length) {
      throw new Error(`group count ${s.groups.length}, recorded ${ev.groupEnabled.length}`);
    }
    s.groups.forEach((g, k) => {
      g.enabled = ev.groupEnabled[k] !== 0;
    });
    if (s.drivenJoints.length * 4 !== ev.drives.length) {
      throw new Error(`driven joints ${s.drivenJoints.length}, recorded ${ev.drives.length / 4}`);
    }
    s.drivenJoints.forEach((j, k) => {
      j.drive.set(
        ev.drives[4 * k],
        ev.drives[4 * k + 1],
        ev.drives[4 * k + 2],
        ev.drives[4 * k + 3],
      );
    });
  }

  call(ev: Event): void {
    const s = this.spring;
    if (ev.kind === KIND_ENABLE) s.enableDrive(ev.id);
    else if (ev.kind === KIND_CALIBRATE) {
      const poses: THREE.Quaternion[] = [];
      for (let k = 0; k < ev.poses.length; k += 4) {
        poses.push(
          new THREE.Quaternion(ev.poses[k], ev.poses[k + 1], ev.poses[k + 2], ev.poses[k + 3]),
        );
      }
      s.calibrateDrive(ev.id, poses);
    } else if (ev.kind === KIND_RESET) s.reset();
  }
}

/** The solver's group and joint layout, to check against what the page had. */
function checkLayout(header: Header, side: Side): void {
  const index = new Map<THREE.Object3D, number>();
  side.tree.nodes.forEach((n, i) => {
    index.set(n, i);
  });
  const got = side.spring.groups.map((g) => ({
    id: g.id,
    joints: g.joints.map((j) => index.get(j.bone) ?? -1),
  }));
  const want = header.groups.map((g) => ({ id: g.id, joints: g.joints }));
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${header.avatar}: built groups differ from the recorded ones`);
  }
}

interface ParityResult {
  frames: number;
  events: number;
  /** Update frames in which `Math.acos` ran, and in which any replaced function did. */
  acosFrames: number;
  transcendentalFrames: number;
  mismatch: string | null;
}

/** `Spring` over the recording under `withCoreMath`, each frame's hash against `expected`. */
function parityPass(
  header: Header,
  events: Event[],
  descriptor: AvatarDescriptor,
  expected: readonly string[],
): ParityResult {
  const side = new Side(new Tree(header), (profile) =>
    withCoreMath(() => new Spring(profile, descriptor)),
  );
  const result: ParityResult = {
    frames: 0,
    events: 0,
    acosFrames: 0,
    transcendentalFrames: 0,
    mismatch: null,
  };
  try {
    for (const [n, ev] of events.entries()) {
      side.tree.apply(ev);
      if (n === 0) {
        side.construct();
        checkLayout(header, side);
      }
      if (ev.kind === KIND_UPDATE) {
        side.feed(ev);
        let acos = 0;
        const before = coreMathCalls();
        withCoreMath(() => {
          const real = Math.acos;
          Math.acos = (x: number) => {
            acos++;
            return real(x);
          };
          try {
            side.spring.update(ev.dt);
          } finally {
            Math.acos = real;
          }
        });
        if (acos > 0) result.acosFrames++;
        if (coreMathCalls() > before) result.transcendentalFrames++;
      } else {
        withCoreMath(() => side.call(ev));
      }
      if (ev.kind === KIND_UPDATE) {
        const hash = withCoreMath(() =>
          hashBytes(writeSpringState(new ByteWriter(), side.spring, side.tree.root).bytes()),
        );
        if (hash !== expected[result.frames]) {
          result.mismatch = `${header.avatar} event ${n} (frame ${result.frames}): hash ${hash}, expected ${expected[result.frames]}`;
          break;
        }
        result.frames++;
      } else {
        // Serialising refreshes the world matrices, as it did when the hashes were recorded.
        withCoreMath(() => writeSpringState(new ByteWriter(), side.spring, side.tree.root));
      }
      result.events++;
    }
  } finally {
    side.spring?.dispose();
  }
  return result;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Median `update` on the host's `Math`. */
function timingPass(
  header: Header,
  events: Event[],
  descriptor: AvatarDescriptor,
  nominal: boolean,
): number {
  const side = new Side(new Tree(header), (profile) => new Spring(profile, descriptor));
  const times: number[] = [];
  try {
    for (const [n, ev] of events.entries()) {
      side.tree.apply(ev);
      if (n === 0) side.construct();
      if (ev.kind !== KIND_UPDATE) {
        side.call(ev);
        continue;
      }
      side.feed(ev);
      const start = performance.now();
      side.spring.update(nominal ? NOMINAL_DT : ev.dt);
      times.push(performance.now() - start);
    }
  } finally {
    side.spring?.dispose();
  }
  return median(times);
}

function usage(message: string): never {
  console.error(message);
  console.error('usage: tsx tools/parity/replay-spring.ts --avatars manuka,yoka,neru');
  process.exit(2);
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { avatars: { type: 'string' } } });
  const avatars = (values.avatars ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (avatars.length === 0 || avatars.some((id) => !NAME.test(id))) {
    usage('--avatars takes a comma-separated list of avatar ids');
  }
  await loadCoreForNode();

  let failed = false;
  for (const avatar of avatars) {
    const { header, events } = await loadRecord(avatar);
    const descriptor = JSON.parse(
      await readFile(join(ROOT, 'avatars', `${avatar}.json`), 'utf8'),
    ) as AvatarDescriptor;
    const expectedFile = JSON.parse(
      await readFile(join(ROOT, RECORD_DIR, `${avatar}.spring.expected.json`), 'utf8'),
    ) as HashFile;
    const expected = expectedFile.fixtures[avatar]?.hashes;
    if (!expected) throw new Error(`${avatar}: no expected hashes in ${expectedFile.generator}`);
    const parity = parityPass(header, events, descriptor, expected);
    console.log(
      `${avatar}: parity on recorded dt: ${parity.frames}/${header.frames} frames, ` +
        `${parity.events}/${events.length} events, slerp branch (acos) in ${parity.acosFrames} frames, ` +
        `any replaced function in ${parity.transcendentalFrames}`,
    );
    if (parity.mismatch !== null) {
      console.error(`${avatar}: MISMATCH ${parity.mismatch}`);
      failed = true;
    } else if (parity.frames !== expected.length || parity.frames !== header.frames) {
      console.error(
        `${avatar}: MISMATCH ${parity.frames} frames replayed, ${expected.length} expected, ${header.frames} recorded`,
      );
      failed = true;
    }
    for (const [label, flag] of [
      ['recorded dt', false],
      ['1/60 s', true],
    ] as const) {
      console.log(
        `${avatar}: update median (${label}): ${timingPass(header, events, descriptor, flag).toFixed(3)} ms`,
      );
    }
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  },
);
