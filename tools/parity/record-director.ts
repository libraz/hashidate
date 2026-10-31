/**
 * Record, compare or time the director on a real avatar in the viewer, frame by frame.
 *
 *     yarn tsx tools/parity/record-director.ts --avatars manuka,yoka,neru --frames 1800
 *     yarn tsx tools/parity/record-director.ts --avatars neru --frames 1800 --compare
 *     yarn tsx tools/parity/record-director.ts --avatars neru --frames 1800 --time
 *
 * The page is made deterministic before any of its own scripts run: animation frames are
 * delivered by hand, `performance.now` and `Date.now` read a clock that advances 1/60 s per
 * frame, `Math.random` is splitmix64, the page is muted and no turn is sent. Recording and
 * `--compare` also answer the transcendentals the core fixes from the core (see
 * `tests/helpers/core-math.ts`), so the TypeScript layers around the rig see the values the
 * synthetic golden sees. The page's entry script, and so the avatar download, waits until the
 * core is loaded and the page has passed the checks the rig's constants rely on: engine modules
 * compute constants as they load.
 *
 * After each frame is drawn the page hashes it with `parityKit`'s `writeDirectorFrame`, the
 * same writer the synthetic golden uses. Recording writes `backup/parity/<avatar>.director.json`;
 * `--compare` records again and reports the first frame that differs. `--time` keeps the host's
 * `Math`, measures each frame with the real clock, split into the part the Rust core runs
 * (rig and anatomy calls, the root's world updates, `Skeleton.update`, the sway update) and the
 * rest, and writes the medians to `backup/parity/<avatar>.director-time.json`. `backup/` is
 * ignored because the files describe a purchased model.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright';
import { BOUNDARY } from '../../tests/helpers/director-fixtures';
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
import { parityKit } from './hash';

const OUT_DIR = 'backup/parity';
const SIZE = '160x90';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Frames delivered per round trip to the page. */
const BATCH = 30;

type Mode = 'record' | 'compare' | 'time';

interface Progress {
  error: string | null;
  frames: number;
}

/** What `--time` writes: per-frame medians in milliseconds. */
interface Timing {
  avatar: string;
  frames: number;
  median: { moved: number; rest: number; total: number };
  parts: { boundary: number; rootUpdate: number; skeleton: number; spring: number };
}

/** Runs in the page before any of its own scripts; everything it needs is inside it. */
function installParity({
  frames,
  mode,
  boundary,
}: {
  frames: number;
  mode: Mode;
  /** The facade boundary's methods by class, as `BOUNDARY` lists them. */
  boundary: Record<string, string[]>;
}): void {
  type Fn = (...args: unknown[]) => unknown;
  type Proto = Record<string, unknown>;
  interface Node3 {
    parent: Node3 | null;
    isSkinnedMesh?: boolean;
    skeleton?: { update: Fn };
    updateMatrixWorld: Fn;
    traverse(fn: (o: Node3) => void): void;
  }
  interface DirectorLike {
    p: { root: Node3 };
    spring: { update: Fn };
    rig: { armSolverOff: string[] };
  }
  interface Kit {
    makeHasher(): { reset(): unknown; digest(): string };
    writeDirectorFrame(out: unknown, src: unknown): void;
  }

  const realNow = performance.now.bind(performance);
  const state = {
    installed: false,
    error: null as string | null,
    frames: 0,
    hashes: [] as string[],
    total: [] as number[],
    boundary: [] as number[],
    rootUpdate: [] as number[],
    skeleton: [] as number[],
    spring: [] as number[],
  };
  const fail = (message: string): void => {
    if (state.error === null) state.error = message;
  };

  // Frames by hand, on a clock that advances one 60 Hz frame per frame.
  const STEP_MS = 1000 / 60;
  let clock = 0;
  const epoch = Date.UTC(2026, 0, 1);
  performance.now = () => clock;
  Date.now = () => epoch + Math.floor(clock);
  let queue: Array<{ id: number; cb: FrameRequestCallback }> = [];
  let nextId = 1;
  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    queue = queue.filter((q) => q.id !== id);
  };

  // splitmix64 for every draw the page makes.
  const MASK = (1n << 64n) - 1n;
  let seed = 0x6861_7368_6964_6174n;
  Math.random = () => {
    seed = (seed + 0x9e37_79b9_7f4a_7c15n) & MASK;
    let z = seed;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK;
    z ^= z >> 31n;
    return Number(z >> 11n) / 2 ** 53;
  };

  const host = { log: Math.log, cbrt: Math.cbrt };
  const g = globalThis as unknown as {
    __hdCore?: Record<string, (...a: number[]) => number>;
    __hdParityKit: Kit;
    __parity: unknown;
  };
  if (mode !== 'time') {
    const math = Math as unknown as Record<string, Fn>;
    const core = (name: string) => {
      const f = g.__hdCore?.[name];
      if (!f) throw new Error(`${name} called before the core was loaded`);
      return f;
    };
    for (const name of [
      'sin',
      'cos',
      'acos',
      'asin',
      'atan2',
      'tanh',
      'expm1',
      'exp',
      'log',
      'cbrt',
    ]) {
      const exported = `hd_math_${name}`;
      math[name] = (...a: unknown[]) => core(exported)(...(a as number[]));
    }
    // Two and three arguments are the core's. Other counts come from outside the engine (the
    // descriptor schema checks a quaternion with four) and stay the host's, the same in every run.
    const hostHypot = Math.hypot;
    math.hypot = (...a: unknown[]) => {
      if (a.length === 2) return core('hd_math_hypot2')(...(a as number[]));
      if (a.length === 3) return core('hd_math_hypot3')(...(a as number[]));
      return hostHypot(...(a as number[]));
    };
  }

  const kit = g.__hdParityKit;
  const sink = kit.makeHasher();

  let bound: DirectorLike | null = null;
  let updated = false;

  // The part the core takes over, timed at its outermost entry only.
  let depth = 0;
  let part: 'boundary' | 'rootUpdate' | 'skeleton' | 'spring' = 'boundary';
  const acc = { boundary: 0, rootUpdate: 0, skeleton: 0, spring: 0 };
  const timed = (which: typeof part, original: Fn): Fn =>
    function (this: unknown, ...args: unknown[]) {
      if (depth > 0) return original.apply(this, args);
      depth++;
      part = which;
      const t0 = realNow();
      try {
        return original.apply(this, args);
      } finally {
        acc[part] += realNow() - t0;
        depth--;
      }
    };
  const timeProto = (proto: Proto, names: readonly string[]): void => {
    for (const name of names) {
      const original = proto[name];
      if (typeof original !== 'function') throw new Error(`${name} is not a method`);
      proto[name] = timed('boundary', original as Fn);
    }
  };

  const bind = (d: DirectorLike): void => {
    bound = d;
    if (mode !== 'time') return;
    const root = d.p.root;
    root.updateMatrixWorld = timed('rootUpdate', root.updateMatrixWorld);
    d.spring.update = timed('spring', d.spring.update.bind(d.spring));
    let skeletonProto: Proto | null = null;
    root.traverse((o) => {
      if (!skeletonProto && o.isSkinnedMesh && o.skeleton) {
        skeletonProto = Object.getPrototypeOf(o.skeleton) as Proto;
      }
    });
    if (skeletonProto) {
      const proto = skeletonProto as Proto;
      proto.update = timed('skeleton', proto.update as Fn);
    }
  };

  const installed = (async () => {
    // Through a variable, so neither the type checker nor the bundler resolves them here.
    type Module = Record<string, { prototype: Proto } & Fn> & { default: string };
    const load = (path: string) => import(/* @vite-ignore */ path) as Promise<Module>;
    // The core first: engine modules compute constants as they load, through the core.
    const [coreModule, wasm] = await Promise.all(
      ['/src/core/index.ts', '/src/core/generated/hashidate.wasm?url'].map(load),
    );
    await coreModule.initCore(() => fetch(wasm.default).then((r: Response) => r.arrayBuffer()));
    g.__hdCore = coreModule.core() as unknown as Record<string, (...a: number[]) => number>;
    const [directorModule, rig, anatomy, face, frame, transaction] = await Promise.all(
      [
        '/src/engine/director.ts',
        '/src/engine/rig/rig.ts',
        '/src/engine/anatomy/arm.ts',
        '/src/engine/anatomy/face.ts',
        '/src/engine/motion/frame.ts',
        '/src/engine/motion/arm-transaction.ts',
      ].map(load),
    );

    // The rig's constants are literals, the page's `**` must square exactly, and the
    // core's constants must be the bits the TS literals spell.
    const bits = (x: number) => new BigUint64Array(new Float64Array([x]).buffer)[0];
    const constant = (i: number) =>
      (g.__hdCore as Record<string, (i: number) => number>).hd_math_rig_constant(i);
    const checks: Array<[string, boolean]> = [
      ['log(0.75)', bits(host.log(0.75)) === 0xbfd269621134db92n],
      ['cbrt(EPSILON)', bits(host.cbrt(Number.EPSILON)) === 0x3ed965fea53d6e3dn],
      ['EPSILON ** (2 / 3)', bits(Number.EPSILON ** (2 / 3)) === 0x3dc428a2f98d7292n],
      [
        'core SWIVEL_RATE',
        bits(constant(0)) ===
          bits(-60 * new Float64Array(new BigUint64Array([0xbfd269621134db92n]).buffer)[0]),
      ],
      ['core CBRT_EPSILON', bits(constant(1)) === 0x3ed965fea53d6e3dn],
      ['core EPSILON_2_3', bits(constant(2)) === 0x3dc428a2f98d7292n],
    ];
    let square = true;
    for (let i = 0; i < 1000; i++) {
      const x = (Math.random() - 0.5) * 2 ** ((i % 40) - 20);
      if (!Object.is(x ** 2, x * x)) square = false;
    }
    checks.push(['x ** 2 === x * x', square]);
    const failed = checks.filter(([, ok]) => !ok).map(([what]) => what);
    if (failed.length)
      throw new Error(`the page fails the rig's arithmetic checks: ${failed.join(', ')}`);

    const proto = directorModule.Director.prototype as Proto;
    const update = proto.update as Fn;
    proto.update = function (this: DirectorLike, ...args: unknown[]) {
      if (bound === null) bind(this);
      else if (bound !== this) fail('a second Director was updated');
      updated = true;
      return update.apply(this, args);
    };
    if (mode === 'time') {
      if (!crossOriginIsolated) throw new Error('the page is not cross-origin isolated');
      const classes: Record<string, Module> = {
        Rig: rig,
        ArmAnatomy: anatomy,
        FaceSurface: face,
        CharacterFrame: frame,
        ArmTransaction: transaction,
      };
      for (const [cls, names] of Object.entries(boundary)) {
        timeProto(classes[cls][cls].prototype, names);
      }
    }
    state.installed = true;
  })();
  installed.catch((error: unknown) => fail(`install failed: ${String(error)}`));

  /** Deliver one animation frame; true once it ran a director update and was counted. */
  const step = (): boolean => {
    clock += STEP_MS;
    const due = queue;
    queue = [];
    updated = false;
    acc.boundary = 0;
    acc.rootUpdate = 0;
    acc.skeleton = 0;
    acc.spring = 0;
    const t0 = realNow();
    for (const { cb } of due) cb(clock);
    const total = realNow() - t0;
    if (!(updated && bound)) return false;
    state.frames++;
    if (mode === 'time') {
      state.total.push(total);
      state.boundary.push(acc.boundary);
      state.rootUpdate.push(acc.rootUpdate);
      state.skeleton.push(acc.skeleton);
      state.spring.push(acc.spring);
    } else {
      const d = bound as DirectorLike;
      sink.reset();
      kit.writeDirectorFrame(sink, {
        root: d.p.root,
        profile: d.p,
        spring: d.spring,
        armSolverOff: d.rig.armSolverOff,
      });
      state.hashes.push(sink.digest());
    }
    return true;
  };

  g.__parity = {
    state,
    /** Deliver frames until `count` more have been counted, or the page has failed. */
    run(count: number): { error: string | null; frames: number } {
      let left = Math.min(count, frames - state.frames);
      let idle = 0;
      while (left > 0 && state.error === null) {
        try {
          if (step()) {
            left--;
            idle = 0;
          } else if (++idle > 600) fail('600 animation frames without a director update');
        } catch (error) {
          fail(`frame ${state.frames}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { error: state.error, frames: state.frames };
    },
  };
}

function usage(message: string): never {
  console.error(message);
  console.error(
    'usage: tsx tools/parity/record-director.ts --avatars manuka,yoka,neru --frames 1800 [--compare | --time]',
  );
  process.exit(2);
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

interface PageResult {
  hashes: string[];
  series: Record<'total' | 'boundary' | 'rootUpdate' | 'skeleton' | 'spring', number[]>;
}

async function runAvatar(
  page: Page,
  avatar: string,
  control: number,
  vite: number,
  frames: number,
  mode: Mode,
): Promise<PageResult> {
  await page.addInitScript('globalThis.__name = (f) => f;');
  // The frame writer is `parityKit` itself, handed over as source.
  await page.addInitScript(`globalThis.__hdParityKit = (${parityKit.toString()})();`);
  const boundary = Object.fromEntries(
    Object.entries(BOUNDARY).map(([cls, methods]) => [cls, Object.keys(methods)]),
  );
  await page.addInitScript(installParity, { frames, mode, boundary });
  page.on('pageerror', (error) => console.error(`[${avatar}] page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[${avatar}] console: ${message.text()}`);
  });
  // The page's own entry waits for the installer, so nothing of the page runs before the core
  // answers its transcendentals, and the director is built behind the wrappers.
  await page.route('**/src/viewer/main.tsx*', async (route) => {
    await page.waitForFunction(
      () => {
        const s = (globalThis as unknown as { __parity?: { state: Record<string, unknown> } })
          .__parity?.state;
        return s?.installed === true || typeof s?.error === 'string';
      },
      null,
      { polling: 50, timeout: READY_TIMEOUT_MS },
    );
    await route.continue();
  });
  // Timed pages are cross-origin isolated, so the real clock reads in microseconds rather than
  // in 100 µs steps. Isolation also refuses the dev server's reload socket, which nothing needs.
  if (mode === 'time') {
    await page.route(
      (url) => url.pathname === '/',
      async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          headers: {
            ...response.headers(),
            'cross-origin-opener-policy': 'same-origin',
            'cross-origin-embedder-policy': 'require-corp',
          },
        });
      },
    );
  }
  const query = new URLSearchParams({ mute: '1', size: SIZE, avatar });
  await page.goto(`http://${HOST}:${vite}/?${query}`, { timeout: READY_TIMEOUT_MS });
  const pageState = () =>
    page.evaluate(() => {
      const s = (globalThis as unknown as { __parity?: { state: Record<string, unknown> } })
        .__parity?.state;
      return s ? { installed: s.installed as boolean, error: s.error as string | null } : null;
    });
  try {
    await until(
      `avatar ${avatar} to be ready`,
      async () => {
        const error = (await pageState())?.error;
        if (error) throw new Error(`${avatar}: ${error}`);
        return avatarReady(control, avatar);
      },
      READY_TIMEOUT_MS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} (page: ${JSON.stringify(await pageState())})`);
  }

  const started = Date.now();
  let done = 0;
  while (done < frames) {
    const progress = (await page.evaluate(
      (n) =>
        (globalThis as unknown as { __parity: { run: (n: number) => Progress } }).__parity.run(n),
      BATCH,
    )) as Progress;
    if (progress.error) throw new Error(`${avatar}: ${progress.error}`);
    if (Math.floor(progress.frames / 300) > Math.floor(done / 300)) {
      console.log(
        `${avatar}: ${progress.frames}/${frames} (${Math.round((Date.now() - started) / 1000)}s)`,
      );
    }
    done = progress.frames;
  }
  return (await page.evaluate(() => {
    const s = (globalThis as unknown as { __parity: { state: Record<string, unknown> } }).__parity
      .state;
    return {
      hashes: s.hashes,
      series: {
        total: s.total,
        boundary: s.boundary,
        rootUpdate: s.rootUpdate,
        skeleton: s.skeleton,
        spring: s.spring,
      },
    };
  })) as PageResult;
}

async function settle(
  avatar: string,
  frames: number,
  mode: Mode,
  result: PageResult,
): Promise<void> {
  const base = join(ROOT, OUT_DIR, avatar);
  if (mode === 'time') {
    const s = result.series;
    const moved = s.total.map(
      (_, i) => s.boundary[i] + s.rootUpdate[i] + s.skeleton[i] + s.spring[i],
    );
    const timing: Timing = {
      avatar,
      frames,
      median: {
        moved: median(moved),
        rest: median(s.total.map((t, i) => t - moved[i])),
        total: median(s.total),
      },
      parts: {
        boundary: median(s.boundary),
        rootUpdate: median(s.rootUpdate),
        skeleton: median(s.skeleton),
        spring: median(s.spring),
      },
    };
    await writeFile(`${base}.director-time.json`, `${JSON.stringify(timing, null, 1)}\n`);
    console.log(
      `${avatar}: median ms per frame, moved ${timing.median.moved.toFixed(3)} ` +
        `(rig and anatomy ${timing.parts.boundary.toFixed(3)}, root updates ` +
        `${timing.parts.rootUpdate.toFixed(3)}, skeleton ${timing.parts.skeleton.toFixed(3)}, ` +
        `sway ${timing.parts.spring.toFixed(3)}), rest ${timing.median.rest.toFixed(3)}`,
    );
    return;
  }
  const path = `${base}.director.json`;
  if (mode === 'record') {
    await writeFile(path, `${JSON.stringify({ avatar, frames, hashes: result.hashes })}\n`);
    console.log(`${avatar}: recorded ${result.hashes.length} frames`);
    return;
  }
  const recorded = JSON.parse(await readFile(path, 'utf8')) as { frames: number; hashes: string[] };
  if (recorded.frames !== frames) {
    throw new Error(`${avatar}: recorded ${recorded.frames} frames, compared ${frames}`);
  }
  const first = result.hashes.findIndex((h, i) => h !== recorded.hashes[i]);
  if (first >= 0) throw new Error(`${avatar}: frame ${first} differs from the recording`);
  console.log(`${avatar}: all ${frames} frames match the recording`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      avatars: { type: 'string' },
      frames: { type: 'string' },
      compare: { type: 'boolean' },
      time: { type: 'boolean' },
    },
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
  if (values.compare && values.time) usage('--compare and --time are separate runs');
  const mode: Mode = values.compare ? 'compare' : values.time ? 'time' : 'record';

  await mkdir(join(ROOT, OUT_DIR), { recursive: true });
  const [control, vite] = [await freePort(), await freePort()];
  let controlProc: Proc | null = null;
  let viteProc: Proc | null = null;
  try {
    viteProc = await startVite(vite, control);
    // On macOS the page draws through Metal: software GL took fourteen cores on neru, and the
    // hashes are the same either way, since nothing hashed is computed on the GPU.
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        ...(process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu'] : []),
      ],
    });
    try {
      // One avatar at a time: each gets its own control server and page.
      for (const avatar of avatars) {
        controlProc = await startControl(control);
        const [width, height] = SIZE.split('x').map(Number);
        const context = await browser.newContext({ viewport: { width, height } });
        try {
          const page = await context.newPage();
          const result = await runAvatar(page, avatar, control, vite, frames, mode);
          await settle(avatar, frames, mode, result);
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
