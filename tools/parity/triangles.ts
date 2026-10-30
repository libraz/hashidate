/**
 * Compare the transparent-triangle controller with the core kernel on real avatars.
 *
 *     yarn tsx tools/parity/triangles.ts --avatars manuka,yoka,neru --frames 600
 *
 * Opens each avatar in the viewer and wraps `TransparentTriangleController#withDraw`
 * in the page. Each frame, before the controller runs, a `TriangleKernel` per
 * target sorts the same mesh for the same camera; inside the draw, after the
 * controller has sorted, its shell index is compared with the kernel's, element
 * by element. A frame is a `withDraw` call. A kernel that reports a non-finite
 * depth keeps its previous order, so that pair is counted and skipped. Exits 1
 * on any mismatch, naming the avatar, frame and target, and on a run that
 * compared nothing.
 */

import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright';
import {
  avatarReady,
  freePort,
  HOST,
  killAll,
  type Proc,
  READY_TIMEOUT_MS,
  startControl,
  startVite,
  stop,
  until,
} from '../shared/dev-servers';

const SIZE = '160x90';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface Mismatch {
  frame: number;
  key: string;
  detail: string;
}

interface Report {
  error: string | null;
  frames: number;
  pairs: number;
  skipped: number;
  inactive: number;
  targets: string[];
  meshes: number;
  reasons: Record<string, number>;
  mismatches: Mismatch[];
  mismatchCount: number;
}

/** Runs in the page once the avatar is up; resolves when the wrappers are in. */
async function installComparison({ frames }: { frames: number }): Promise<void> {
  interface Matrix {
    copy(other: Matrix): unknown;
  }
  interface Mesh {
    name: string;
    isMesh?: boolean;
    isSkinnedMesh?: boolean;
    geometry: { index: { count: number } | null };
    material: unknown;
    matrixWorld: Matrix;
    matrixAutoUpdate: boolean;
    matrixWorldAutoUpdate: boolean;
    skeleton?: unknown;
    bindMode?: unknown;
    bindMatrix: Matrix;
    bindMatrixInverse: Matrix;
    morphTargetInfluences?: unknown;
    morphTargetDictionary?: unknown;
  }
  interface Root {
    traverse(visit: (object: Mesh) => void): void;
  }
  interface TargetRecord {
    key: string;
    shellIndex: { array: ArrayLike<number> } | null;
  }
  interface Controller {
    recordList: TargetRecord[];
    activeRecords: TargetRecord[];
    enabled: boolean;
    reconcile(targets: Array<{ key: string; mesh: Mesh }>): void;
    inspect(): { targets: Array<{ key: string; active: boolean; reason: string | null }> };
    dispose(): void;
  }
  interface Kernel {
    sourceIndices: Uint32Array;
    update(camera: unknown): string | null;
    writeIndex(out: Uint32Array): void;
    dispose(): void;
  }
  type WithDraw = (this: Controller, camera: unknown, draw: () => unknown) => unknown;

  const state = {
    done: false,
    error: null as string | null,
    frames: 0,
    pairs: 0,
    skipped: 0,
    inactive: 0,
    mismatchCount: 0,
    mismatches: [] as Mismatch[],
    targets: new Set<string>(),
    reasons: {} as Record<string, number>,
    meshes: 0,
  };
  const controllerModule = '/src/engine/scene/transparent-triangles.ts';
  const kernelModule = '/src/engine/scene/triangle-sort-core.ts';
  const secondaryModule = '/src/engine/secondary/index.ts';
  const [controllerExports, kernelExports, secondaryExports] = await Promise.all([
    import(/* @vite-ignore */ controllerModule),
    import(/* @vite-ignore */ kernelModule),
    import(/* @vite-ignore */ secondaryModule),
  ]);
  // The viewer's own copy of three, found through the import the dev server rewrote.
  const served = await (await fetch(controllerModule)).text();
  const threeUrl = /from\s*"([^"]*three\.js[^"]*)"/.exec(served)?.[1];
  if (threeUrl === undefined) throw new Error('could not find the dev server path of three');
  const three = (await import(/* @vite-ignore */ threeUrl)) as Record<string, unknown>;
  type MeshClass = new (geometry: unknown, material: unknown) => Mesh;
  const plain = three.Mesh as MeshClass;
  const skinned = three.SkinnedMesh as MeshClass;
  const basic = three.MeshBasicMaterial as new (parameters: Record<string, unknown>) => unknown;

  const proto = controllerExports.TransparentTriangleController.prototype as {
    withDraw: WithDraw;
  };
  const KernelClass = kernelExports.TriangleKernel as new (mesh: Mesh) => Kernel;
  const original = proto.withDraw;

  // The avatar's root, from the sway solver, which is built on it.
  let root: Root | null = null;
  const springProto = secondaryExports.Spring.prototype as {
    update: (this: { root: Root }, dt: number) => unknown;
  };
  const update = springProto.update;
  springProto.update = function (this: { root: Root }, dt: number) {
    root = this.root;
    return update.call(this, dt);
  };

  interface Proxy {
    key: string;
    source: Mesh;
    proxy: Mesh;
    kernel: Kernel;
  }
  let side: Controller | null = null;
  const proxies: Proxy[] = [];

  /** A stand-in per avatar mesh, sharing its geometry, skeleton and morph weights. */
  const build = (avatar: Root): Controller => {
    avatar.traverse((source) => {
      if (source.isMesh !== true || Array.isArray(source.material)) return;
      const material = new basic({
        transparent: true,
        side: three.DoubleSide,
        depthWrite: false,
      });
      const proxy = source.isSkinnedMesh
        ? new skinned(source.geometry, material)
        : new plain(source.geometry, material);
      if (source.isSkinnedMesh) {
        proxy.bindMode = source.bindMode;
        proxy.skeleton = source.skeleton;
      }
      proxy.morphTargetInfluences = source.morphTargetInfluences;
      proxy.morphTargetDictionary = source.morphTargetDictionary;
      proxy.matrixAutoUpdate = false;
      proxy.matrixWorldAutoUpdate = false;
      const key = `mesh:${proxies.length}:${source.name}`;
      proxies.push({ key, source, proxy, kernel: new KernelClass(proxy) });
    });
    state.meshes = proxies.length;
    const controller = new controllerExports.TransparentTriangleController() as Controller;
    controller.reconcile(proxies.map(({ key, proxy }) => ({ key, mesh: proxy })));
    return controller;
  };

  const mismatch = (key: string, detail: string): void => {
    state.mismatchCount++;
    if (state.mismatches.length < 20) state.mismatches.push({ frame: state.frames, key, detail });
  };

  proto.withDraw = function (this: Controller, camera: unknown, draw: () => unknown) {
    if (state.done || this === side || root === null) return original.call(this, camera, draw);
    if (side === null) side = build(root);
    const expected = new Map<string, Uint32Array>();
    const reasons = new Map<string, string>();
    for (const { key, source, proxy, kernel } of proxies) {
      proxy.matrixWorld.copy(source.matrixWorld);
      if (source.isSkinnedMesh) {
        proxy.bindMatrix.copy(source.bindMatrix);
        proxy.bindMatrixInverse.copy(source.bindMatrixInverse);
      }
      try {
        const reason = kernel.update(camera);
        if (reason !== null) {
          reasons.set(key, reason);
          continue;
        }
        const out = new Uint32Array(kernel.sourceIndices.length);
        kernel.writeIndex(out);
        expected.set(key, out);
      } catch (error) {
        reasons.set(key, `kernel threw: ${String(error)}`);
      }
    }
    const controller = side;
    original.call(controller, camera, () => {
      try {
        for (const record of controller.activeRecords) {
          const want = expected.get(record.key);
          const reason = reasons.get(record.key);
          if (want === undefined) {
            if (reason === 'non-finite-depth') state.skipped++;
            else mismatch(record.key, `controller sorted, kernel gave none (${reason})`);
            continue;
          }
          const got = record.shellIndex?.array;
          if (got === undefined || got.length !== want.length) {
            mismatch(record.key, `index length ${got?.length} against ${want.length}`);
            continue;
          }
          state.targets.add(record.key);
          state.pairs++;
          for (let k = 0; k < want.length; k++) {
            if (got[k] !== want[k]) {
              mismatch(record.key, `index[${k}]: controller ${got[k]}, kernel ${want[k]}`);
              break;
            }
          }
        }
        state.inactive += controller.recordList.length - controller.activeRecords.length;
      } catch (error) {
        state.error = `comparison threw: ${String(error)}`;
        state.done = true;
      }
      return undefined;
    });
    state.frames++;
    if (state.frames === 1) {
      for (const t of controller.inspect().targets) {
        if (!t.active)
          state.reasons[t.reason ?? 'unknown'] = (state.reasons[t.reason ?? 'unknown'] ?? 0) + 1;
      }
    }
    if (state.frames >= frames) {
      state.done = true;
      for (const { kernel } of proxies) kernel.dispose();
      controller.dispose();
    }
    return original.call(this, camera, draw);
  };

  (globalThis as unknown as { __triangles: unknown }).__triangles = {
    state,
    report: () => ({ ...state, targets: [...state.targets] }),
  };
}

function usage(message: string): never {
  console.error(message);
  console.error('usage: tsx tools/parity/triangles.ts --avatars manuka,yoka,neru --frames 600');
  process.exit(2);
}

async function compareAvatar(
  page: Page,
  avatar: string,
  control: number,
  vite: number,
  frames: number,
): Promise<Report> {
  page.on('pageerror', (error) => console.error(`[${avatar}] page error: ${error.message}`));
  const query = new URLSearchParams({ mute: '1', size: SIZE, avatar });
  await page.goto(`http://${HOST}:${vite}/?${query}`, { timeout: READY_TIMEOUT_MS });
  await until(`avatar ${avatar} to be ready`, () => avatarReady(control, avatar), READY_TIMEOUT_MS);
  await page.evaluate(`globalThis.__name = (f) => f;`);
  await page.evaluate(installComparison, { frames });

  const started = Date.now();
  let shown = -1;
  await until(
    `${frames} frames of ${avatar}`,
    async () => {
      const progress = await page.evaluate(() => {
        const s = (globalThis as unknown as { __triangles: { state: Record<string, unknown> } })
          .__triangles.state;
        return { done: s.done as boolean, frames: s.frames as number };
      });
      if (progress.frames >= shown + 200) {
        shown = progress.frames;
        const seconds = Math.round((Date.now() - started) / 1000);
        console.log(`${avatar}: ${progress.frames}/${frames} (${seconds}s)`);
      }
      return progress.done;
    },
    Math.max(600_000, frames * 1500),
  );
  return (await page.evaluate(() =>
    (globalThis as unknown as { __triangles: { report: () => unknown } }).__triangles.report(),
  )) as Report;
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
  const frames = Number(values.frames ?? 600);
  if (!Number.isInteger(frames) || frames < 1) usage('--frames takes a positive integer');

  let failed = false;
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
        controlProc = await startControl(control);
        const [width, height] = SIZE.split('x').map(Number);
        const context = await browser.newContext({ viewport: { width, height } });
        try {
          const page = await context.newPage();
          const report = await compareAvatar(page, avatar, control, vite, frames);
          const reasons = Object.entries(report.reasons)
            .map(([reason, n]) => `${reason} x${n}`)
            .join(', ');
          console.log(
            `${avatar}: ${report.frames} frames, ${report.meshes} meshes, ` +
              `${report.targets.length} sorted by the controller, ` +
              `${report.pairs} frame-target pairs compared, ` +
              `${report.skipped} skipped (non-finite depth), ${report.mismatchCount} mismatches; ` +
              `not eligible: ${reasons || 'none'}`,
          );
          if (report.error) {
            console.error(`${avatar}: ${report.error}`);
            failed = true;
          }
          if (report.pairs === 0) {
            console.error(`${avatar}: nothing was compared`);
            failed = true;
          }
          for (const m of report.mismatches) {
            console.error(`${avatar}: MISMATCH frame ${m.frame} target ${m.key}: ${m.detail}`);
            failed = true;
          }
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
  return failed ? 1 : 0;
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
