/**
 * Record what the sway solver is given while a real avatar idles in the viewer,
 * so `replay-spring.ts` can run the same inputs through both implementations.
 *
 *     yarn tsx tools/parity/record-spring.ts --avatars manuka,yoka,neru --frames 1800
 *
 * Writes `backup/parity/<avatar>.spring.json` (hierarchy and bookkeeping) and
 * `.bin` (little-endian f64, one block per event). `backup/`
 * is ignored because the files hold a purchased model's skeleton.
 *
 * The recorder wraps `Spring.prototype` in the page, from a script that runs
 * before the page's own, and holds the avatar download until the wrappers are
 * in, so the calls made while the avatar mounts are seen too. Frames are counted
 * by `update` calls. An event is the tree's change since the previous event (what
 * other layers wrote), then the call. A joint bone found to differ from what the
 * solver last left on it fails the run: replay assumes nothing else writes joints.
 *
 * Event block (f64): kind; born-node count, then a 46-float state per node that
 * joined the tree since the last event (flags, position(3), rotation(4), scale(3),
 * pivot(3), matrix(16), matrixWorld(16); ids are consecutive, ancestors of the
 * root first); changed-node count, then per changed node
 * `id, flags, position(3), rotation(4), scale(3), [pivot(3)], [matrix(16)],
 * [matrixWorld(16)]` (pivot when flag 4; matrix when flag 1 is clear; matrixWorld
 * for ancestors of the root and when flag 2 is clear), then
 *   update (0): dt, enabled, stiffness, inertia, gravity, group count, enabled per
 *               group, driven count, drive quaternion per driven joint
 *   enableDrive (1): id index
 *   calibrateDrive (2): id index, pose count, poses (4 each)
 *   reset (3): nothing
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright';
import {
  avatarReady,
  freePort,
  HOST,
  killAll,
  type Proc,
  READY_TIMEOUT_MS,
  ROOT,
  startControl,
  startVite,
  stop,
  until,
} from '../shared/dev-servers';

const OUT_DIR = 'backup/parity';
const SIZE = '160x90';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CHUNK_FLOATS = 1 << 20;
/** Floats per node in the table: flags, position, rotation, scale, pivot, matrix, matrixWorld. */
const NODE_FLOATS = 46;

/** What the page reports once the frames are in. */
interface Summary {
  error: string | null;
  updates: number;
  floats: number;
  nodes: Array<{ name: string; parent: number; bone: boolean }>;
  rootIndex: number;
  groups: Array<{ id: string; joints: number[]; roots: number[] }>;
  ids: string[];
  anchorMeta: Record<string, unknown>;
  dt: { min: number; max: number; mean: number; capped: number };
}

/** Runs in the page before any of its own scripts; everything it needs is inside it. */
function installRecorder({ frames, nodeFloats }: { frames: number; nodeFloats: number }): void {
  interface Vec {
    x: number;
    y: number;
    z: number;
  }
  interface Quat extends Vec {
    w: number;
  }
  interface Node3 {
    name: string;
    parent: Node3 | null;
    children: Node3[];
    isBone?: boolean;
    position: Vec;
    quaternion: Quat;
    scale: Vec;
    pivot: Vec | null;
    matrixAutoUpdate: boolean;
    matrixWorldAutoUpdate: boolean;
    matrix: { elements: ArrayLike<number> };
    matrixWorld: { elements: ArrayLike<number> };
    userData: Record<string, unknown>;
  }
  interface Joint {
    bone: Node3;
    drive: Quat;
  }
  interface Spring {
    root: Node3;
    groups: Array<{ id: string; enabled: boolean; joints: Joint[]; rootJoints: Joint[] }>;
    drivenJoints: Joint[];
    enabled: boolean;
    stiffnessScale: number;
    inertiaScale: number;
    gravityScale: number;
    _acc: number;
    _live: boolean;
    _pending: boolean;
  }
  type Method = (this: Spring, ...args: never[]) => unknown;

  const KIND_UPDATE = 0;
  const KIND_ENABLE = 1;
  const KIND_CALIBRATE = 2;
  const KIND_RESET = 3;

  let out = new Float64Array(1 << 20);
  let length = 0;
  const push = (v: number): void => {
    if (length === out.length) {
      const next = new Float64Array(length * 2);
      next.set(out);
      out = next;
    }
    out[length++] = v;
  };

  const state = {
    installed: false,
    active: true,
    done: false,
    error: null as string | null,
    updates: 0,
  };
  const dts = { min: Number.POSITIVE_INFINITY, max: 0, sum: 0, capped: 0 };
  (globalThis as unknown as { __parity: unknown }).__parity = {
    state,
    summary: () => summary(),
    slice: (from: number, to: number) => {
      const bytes = new Uint8Array(out.buffer, from * 8, (to - from) * 8);
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(text);
    },
  };
  const fail = (message: string): void => {
    if (state.error === null) state.error = message;
    state.active = false;
    state.done = true;
  };

  let bound: Spring | null = null;
  const nodes: Node3[] = [];
  const parents: number[] = [];
  const models: Float64Array[] = [];
  const known = new Map<Node3, number>();
  let rootIndex = 0;
  const scratch = new Float64Array(nodeFloats);
  const jointNodes = new Set<number>();
  const ids: string[] = [];
  let depth = 0;

  const read = (node: Node3, at: number, into: Float64Array): void => {
    const { position: p, quaternion: q, scale: s, pivot } = node;
    into[at] =
      (node.matrixAutoUpdate ? 1 : 0) | (node.matrixWorldAutoUpdate ? 2 : 0) | (pivot ? 4 : 0);
    into[at + 1] = p.x;
    into[at + 2] = p.y;
    into[at + 3] = p.z;
    into[at + 4] = q.x;
    into[at + 5] = q.y;
    into[at + 6] = q.z;
    into[at + 7] = q.w;
    into[at + 8] = s.x;
    into[at + 9] = s.y;
    into[at + 10] = s.z;
    into[at + 11] = pivot ? pivot.x : 0;
    into[at + 12] = pivot ? pivot.y : 0;
    into[at + 13] = pivot ? pivot.z : 0;
    const m = node.matrix.elements;
    const w = node.matrixWorld.elements;
    for (let i = 0; i < 16; i++) {
      into[at + 14 + i] = m[i];
      into[at + 30 + i] = w[i];
    }
  };

  const differs = (
    a: Float64Array,
    ai: number,
    b: Float64Array,
    bi: number,
    n: number,
  ): boolean => {
    for (let i = 0; i < n; i++) if (!Object.is(a[ai + i], b[bi + i])) return true;
    return false;
  };

  /** Emit the nodes the tree gained since the last event, and fail if it lost or moved any. */
  const sync = (spring: Spring): void => {
    const slot = length;
    push(0);
    let born = 0;
    const birth = (n: Node3): void => {
      known.set(n, nodes.length);
      nodes.push(n);
      parents.push(n.parent ? (known.get(n.parent) ?? -1) : -1);
      const model = new Float64Array(nodeFloats);
      read(n, 0, model);
      models.push(model);
      for (let k = 0; k < nodeFloats; k++) push(model[k]);
      born++;
    };
    const first = nodes.length === 0;
    if (first) {
      const chain: Node3[] = [];
      for (let n = spring.root.parent; n; n = n.parent) chain.unshift(n);
      rootIndex = chain.length;
      for (const n of chain) birth(n);
    }
    let ancestors = 0;
    for (let n = spring.root.parent; n; n = n.parent) ancestors++;
    const existing = nodes.length - rootIndex;
    let visited = 0;
    let moved = false;
    const walk = (n: Node3): void => {
      const id = known.get(n);
      if (id === undefined) birth(n);
      else {
        visited++;
        if (parents[id] !== (n.parent ? (known.get(n.parent) ?? -1) : -1)) moved = true;
      }
      for (const c of n.children) walk(c);
    };
    walk(spring.root);
    if (moved || visited !== existing || ancestors !== rootIndex) {
      fail('a node was removed or moved while recording');
    }
    out[slot] = born;
    if (first) {
      for (const g of spring.groups) {
        for (const j of g.joints) jointNodes.add(known.get(j.bone) ?? -1);
      }
    }
  };

  /** Emit the tree's change since the last event. */
  const diff = (): void => {
    const slot = length;
    push(0);
    let changed = 0;
    for (let i = 0; i < nodes.length; i++) {
      const model = models[i];
      read(nodes[i], 0, scratch);
      const hasWorld = i < rootIndex || (scratch[0] & 2) === 0;
      const same =
        !differs(scratch, 0, model, 0, 14) &&
        ((scratch[0] & 1) !== 0 || !differs(scratch, 14, model, 14, 16)) &&
        !(hasWorld && differs(scratch, 30, model, 30, 16));
      if (same) continue;
      if (jointNodes.has(i) && differs(scratch, 1, model, 1, 10)) {
        fail(`joint bone ${nodes[i].name} changed between solver calls (frame ${state.updates})`);
        return;
      }
      changed++;
      push(i);
      push(scratch[0]);
      for (let k = 1; k < 11; k++) push(scratch[k]);
      if ((scratch[0] & 4) !== 0) for (let k = 11; k < 14; k++) push(scratch[k]);
      if ((scratch[0] & 1) === 0) for (let k = 14; k < 30; k++) push(scratch[k]);
      if (hasWorld) for (let k = 30; k < 46; k++) push(scratch[k]);
      model.set(scratch);
    }
    out[slot] = changed;
  };

  /** Take the tree as the solver left it. */
  const settle = (): void => {
    for (let i = 0; i < nodes.length; i++) read(nodes[i], 0, models[i]);
  };

  /** Open an event: its kind, the nodes born since the last one, and what changed. */
  const begin = (kind: number, spring: Spring): void => {
    push(kind);
    sync(spring);
    if (state.active) diff();
  };

  const idIndex = (id: string): number => {
    let k = ids.indexOf(id);
    if (k < 0) {
      k = ids.length;
      ids.push(id);
    }
    return k;
  };

  /** Whether `spring` is the one being recorded, binding it on first sight. */
  const mine = (spring: Spring, what: string): boolean => {
    if (!state.active) return false;
    if (bound === null) {
      const late =
        spring._live || spring._acc !== 0 || spring._pending || spring.drivenJoints.length > 0;
      if (late) {
        fail(`recorder installed after the solver was in use (first call: ${what})`);
        return false;
      }
      bound = spring;
    }
    if (spring !== bound) {
      fail('a second Spring instance was used');
      return false;
    }
    return true;
  };

  const wrap = (proto: Record<string, Method>, name: string, around: Method): void => {
    const original = proto[name];
    proto[name] = function (this: Spring, ...args: never[]) {
      return around.call(this, original as never, ...(args as never[]));
    } as Method;
  };

  const module = '/src/engine/secondary/index.ts';
  const installed = import(/* @vite-ignore */ module).then((mod: Record<string, unknown>) => {
    const proto = (mod.Spring as { prototype: Record<string, Method> }).prototype;

    wrap(proto, 'update', function (this: Spring, original: never, dt: never) {
      const call = original as unknown as (dt: number) => unknown;
      const step = dt as unknown as number;
      if (!mine(this, 'update')) return call.call(this, step);
      begin(KIND_UPDATE, this);
      if (!state.active) return call.call(this, step);
      push(step);
      push(this.enabled ? 1 : 0);
      push(this.stiffnessScale);
      push(this.inertiaScale);
      push(this.gravityScale);
      push(this.groups.length);
      for (const g of this.groups) push(g.enabled ? 1 : 0);
      push(this.drivenJoints.length);
      for (const j of this.drivenJoints) {
        push(j.drive.x);
        push(j.drive.y);
        push(j.drive.z);
        push(j.drive.w);
      }
      dts.min = Math.min(dts.min, step);
      dts.max = Math.max(dts.max, step);
      dts.sum += step;
      if (step >= 0.05) dts.capped++;
      try {
        return call.call(this, step);
      } finally {
        settle();
        state.updates++;
        if (state.updates >= frames) {
          state.active = false;
          state.done = true;
        }
      }
    } as unknown as Method);

    wrap(proto, 'enableDrive', function (this: Spring, original: never, id: never) {
      const call = original as unknown as (id: string) => unknown;
      const group = id as unknown as string;
      if (depth === 0 && mine(this, 'enableDrive')) {
        begin(KIND_ENABLE, this);
        push(idIndex(group));
      }
      const result = call.call(this, group);
      if (state.active && bound === this) settle();
      return result;
    } as unknown as Method);

    wrap(proto, 'calibrateDrive', function (
      this: Spring,
      original: never,
      id: never,
      poses: never,
    ) {
      const call = original as unknown as (id: string, poses: Quat[]) => unknown;
      const group = id as unknown as string;
      const list = poses as unknown as Quat[];
      if (mine(this, 'calibrateDrive')) {
        begin(KIND_CALIBRATE, this);
        push(idIndex(group));
        push(list?.length ?? 0);
        for (const q of list ?? []) {
          push(q.x);
          push(q.y);
          push(q.z);
          push(q.w);
        }
      }
      depth++;
      try {
        return call.call(this, group, list);
      } finally {
        depth--;
        if (state.active && bound === this) settle();
      }
    } as unknown as Method);

    wrap(proto, 'reset', function (this: Spring, original: never) {
      const call = original as unknown as () => unknown;
      if (depth === 0 && mine(this, 'reset')) {
        begin(KIND_RESET, this);
      }
      return call.call(this);
    } as unknown as Method);

    state.installed = true;
  });
  installed.catch((error: unknown) => fail(`recorder install failed: ${String(error)}`));

  /** `value` with -0 spelled out, since JSON cannot carry it. */
  const encode = (value: unknown): unknown => {
    if (typeof value === 'number') return Object.is(value, -0) ? { negativeZero: true } : value;
    if (Array.isArray(value)) return value.map(encode);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
    }
    return value;
  };

  const summary = (): Summary => {
    const anchorMeta: Record<string, unknown> = {};
    nodes.forEach((n, i) => {
      if (n.userData?.skinPointAnchor !== undefined) {
        anchorMeta[i] = encode(JSON.parse(JSON.stringify(n.userData.skinPointAnchor)));
      }
    });
    return {
      error: state.error,
      updates: state.updates,
      floats: length,
      nodes: nodes.map((n, i) => ({ name: n.name, parent: parents[i], bone: n.isBone === true })),
      rootIndex,
      groups: (bound?.groups ?? []).map((g) => ({
        id: g.id,
        joints: g.joints.map((j) => known.get(j.bone) ?? -1),
        roots: g.rootJoints.map((j) => known.get(j.bone) ?? -1),
      })),
      ids,
      anchorMeta,
      dt: {
        min: dts.min,
        max: dts.max,
        mean: state.updates ? dts.sum / state.updates : 0,
        capped: dts.capped,
      },
    };
  };
}

function usage(message: string): never {
  console.error(message);
  console.error(
    'usage: tsx tools/parity/record-spring.ts --avatars manuka,yoka,neru --frames 1800',
  );
  process.exit(2);
}

async function recordAvatar(
  page: Page,
  avatar: string,
  control: number,
  vite: number,
  frames: number,
): Promise<{ summary: Summary; bin: Buffer }> {
  await page.addInitScript('globalThis.__name = (f) => f;');
  await page.addInitScript(installRecorder, { frames, nodeFloats: NODE_FLOATS });
  page.on('pageerror', (error) => console.error(`[${avatar}] page error: ${error.message}`));
  // The avatar's download waits for the wrappers, so the solver is built behind them.
  await page.route('**/*.glb', async (route) => {
    await page.waitForFunction(
      () =>
        (globalThis as unknown as { __parity?: { state: { installed: boolean } } }).__parity?.state
          .installed === true,
      null,
      { polling: 50, timeout: READY_TIMEOUT_MS },
    );
    await route.continue();
  });
  const query = new URLSearchParams({ mute: '1', size: SIZE, avatar });
  await page.goto(`http://${HOST}:${vite}/?${query}`, { timeout: READY_TIMEOUT_MS });
  await until(`avatar ${avatar} to be ready`, () => avatarReady(control, avatar), READY_TIMEOUT_MS);

  const started = Date.now();
  let seen = -1;
  await until(
    `${frames} frames of ${avatar}`,
    async () => {
      const progress = await page.evaluate(() => {
        const s = (globalThis as unknown as { __parity: { state: Record<string, unknown> } })
          .__parity.state;
        return { done: s.done as boolean, updates: s.updates as number, error: s.error as string };
      });
      if (progress.error) throw new Error(`${avatar}: ${progress.error}`);
      if (progress.updates >= seen + 300) {
        seen = progress.updates;
        console.log(
          `${avatar}: ${progress.updates}/${frames} (${Math.round((Date.now() - started) / 1000)}s)`,
        );
      }
      return progress.done;
    },
    // Software GL: a heavy avatar can take minutes.
    Math.max(600_000, frames * 1000),
  );

  const summary = (await page.evaluate(() =>
    (globalThis as unknown as { __parity: { summary: () => unknown } }).__parity.summary(),
  )) as Summary;
  if (summary.error) throw new Error(`${avatar}: ${summary.error}`);
  const parts: Buffer[] = [];
  for (let from = 0; from < summary.floats; from += CHUNK_FLOATS) {
    const to = Math.min(summary.floats, from + CHUNK_FLOATS);
    const text = await page.evaluate(
      ([a, b]) =>
        (
          globalThis as unknown as { __parity: { slice: (a: number, b: number) => string } }
        ).__parity.slice(a, b),
      [from, to] as const,
    );
    parts.push(Buffer.from(text, 'base64'));
  }
  return { summary, bin: Buffer.concat(parts) };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { avatars: { type: 'string' }, frames: { type: 'string' } },
  });
  const avatars = (values.avatars ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (avatars.length === 0 || avatars.some((id) => !NAME.test(id))) {
    usage('--avatars takes a comma-separated list of avatar ids');
  }
  const frames = Number(values.frames ?? 1800);
  if (!Number.isInteger(frames) || frames < 1) usage('--frames takes a positive integer');

  await mkdir(join(ROOT, OUT_DIR), { recursive: true });
  const [control, vite] = [await freePort(), await freePort()];
  let controlProc: Proc | null = null;
  let viteProc: Proc | null = null;
  try {
    viteProc = await startVite(vite, control);
    const browser = await chromium.launch({
      headless: true,
      args: ['--enable-webgl', '--ignore-gpu-blocklist'],
    });
    try {
      for (const avatar of avatars) {
        const began = Date.now();
        controlProc = await startControl(control);
        const [width, height] = SIZE.split('x').map(Number);
        const context = await browser.newContext({ viewport: { width, height } });
        try {
          const page = await context.newPage();
          const { summary, bin } = await recordAvatar(page, avatar, control, vite, frames);
          const header = {
            avatar,
            frames: summary.updates,
            nodeFloats: NODE_FLOATS,
            floats: summary.floats,
            rootIndex: summary.rootIndex,
            nodes: summary.nodes,
            groups: summary.groups,
            ids: summary.ids,
            anchorMeta: summary.anchorMeta,
            dt: summary.dt,
          };
          await writeFile(join(ROOT, OUT_DIR, `${avatar}.spring.json`), JSON.stringify(header));
          await writeFile(join(ROOT, OUT_DIR, `${avatar}.spring.bin`), bin);
          console.log(
            `${avatar}: ${summary.updates} frames, ${summary.nodes.length} nodes, ` +
              `${summary.groups.length} groups, ${(bin.length / 1e6).toFixed(1)} MB, ` +
              `dt mean ${summary.dt.mean.toFixed(4)} max ${summary.dt.max.toFixed(4)} ` +
              `capped ${summary.dt.capped}, ${Math.round((Date.now() - began) / 1000)}s`,
          );
        } finally {
          await context.close();
          const proc = controlProc;
          controlProc = null;
          await stop(proc, control);
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    if (controlProc !== null) await stop(controlProc, control).catch(killAll);
    if (viteProc !== null) await stop(viteProc, vite).catch(killAll);
  }
  return 0;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    killAll();
    process.exit(130);
  });
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    killAll();
    process.exit(1);
  },
);
