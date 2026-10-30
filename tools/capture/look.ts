/**
 * Render each avatar through a fixed set of shots and stages and write the
 * frames next to an index, so two looks can be compared on the same shot.
 *
 *     yarn look --label <name> [--avatars yoka,manuka] [--compare <label>]
 *
 * Writes `backup/look/<label>/<avatar>-<shot>-<stage>.png` and `index.html`;
 * `backup/` is ignored because a frame is a render of a purchased model. The
 * pose idles, so frames are for the eye and never compared pixel for pixel.
 *
 * Runs its own control server and dev server on free loopback ports rather than
 * borrowing a running `make dev`: a command reaches every attached renderer.
 * The control server is restarted per page so a previous page's avatar status
 * cannot satisfy the readiness poll. Exits 2 on a usage error or an existing
 * output directory, and 1 on a shader error or an alpha violation.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import {
  avatarReady,
  freePort,
  HOST,
  killAll,
  type Proc,
  READY_TIMEOUT_MS,
  ROOT,
  sleep,
  startControl,
  startVite,
  stop,
  until,
} from '../shared/dev-servers';

const VIEWPORT = { width: 1280, height: 720 };
const SETTLE_MS = 2_500;
const OUT_ROOT = 'backup/look';
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SHOTS = [
  { name: 'bust-front', frame: 'bust', yaw: 0, pitch: 0 },
  { name: 'bust-side', frame: 'bust', yaw: -35, pitch: 5 },
  { name: 'full', frame: 'full', yaw: 20, pitch: 0 },
] as const;
const STAGES = ['flat', 'morning', 'night', 'transparent'] as const;

function usage(message: string): never {
  console.error(message);
  console.error('usage: yarn look --label <name> [--avatars yoka,manuka] [--compare <label>]');
  process.exit(2);
}

async function sendCamera(control: number, shot: (typeof SHOTS)[number]): Promise<void> {
  const res = await fetch(`http://${HOST}:${control}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cmd: 'camera',
      frame: shot.frame,
      yaw: shot.yaw,
      pitch: shot.pitch,
      zoom: 1,
    }),
  });
  if (!res.ok) throw new Error(`camera command refused: ${res.status} ${await res.text()}`);
}

/** Alpha of the pixel at (x, y). */
function alphaAt(png: PNG, x: number, y: number): number {
  return png.data[(png.width * y + x) * 4 + 3];
}

function checkTransparent(file: string, bytes: Buffer, centre: boolean): string[] {
  const png = PNG.sync.read(bytes);
  const { width: w, height: h } = png;
  const violations: string[] = [];
  const corners: [number, number][] = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ];
  for (const [x, y] of corners) {
    const alpha = alphaAt(png, x, y);
    if (alpha !== 0) violations.push(`${file}: alpha at (${x},${y}) is ${alpha}, expected 0`);
  }
  if (centre) {
    const x = Math.floor(w / 2);
    const y = Math.floor(h / 2);
    const alpha = alphaAt(png, x, y);
    if (alpha !== 255)
      violations.push(`${file}: alpha at centre (${x},${y}) is ${alpha}, expected 255`);
  }
  return violations;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function indexHtml(label: string, avatars: string[], compare: string | null): string {
  const cell = (file: string): string => {
    const own = `<a href="./${file}"><img src="./${file}" alt="${file}" loading="lazy"></a>`;
    if (compare === null) return own;
    const other = `../${compare}/${file}`;
    return `<div class="pair"><a href="${other}"><img src="${other}" alt="${compare}: ${file}" loading="lazy"></a>${own}</div>`;
  };
  const head = STAGES.map((stage) => `<th>${stage}</th>`).join('');
  const rows = avatars
    .flatMap((avatar) =>
      SHOTS.map((shot) => {
        const cells = STAGES.map(
          (stage) => `<td>${cell(`${avatar}-${shot.name}-${stage}.png`)}</td>`,
        ).join('');
        return `<tr><th>${escapeHtml(`${avatar}-${shot.name}`)}</th>${cells}</tr>`;
      }),
    )
    .join('\n');
  const title = compare === null ? label : `${compare} vs ${label}`;
  return `<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 13px system-ui, sans-serif; margin: 16px; background: #888; }
  table { border-collapse: collapse; }
  th, td { padding: 4px; vertical-align: top; }
  img { width: 320px; display: block; background: #fff; }
  .pair { display: flex; gap: 2px; }
</style>
<h1>${escapeHtml(title)}</h1>
<table>
<tr><th></th>${head}</tr>
${rows}
</table>
`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      label: { type: 'string' },
      avatars: { type: 'string' },
      compare: { type: 'string' },
    },
  });
  const label = values.label;
  if (label === undefined || !LABEL.test(label))
    usage('--label takes a name of letters, digits, . _ -');
  const compare = values.compare ?? null;
  if (compare !== null && !LABEL.test(compare))
    usage('--compare takes a label of letters, digits, . _ -');
  const avatars = (values.avatars ?? 'yoka,manuka')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (avatars.length === 0 || avatars.some((id) => !LABEL.test(id))) {
    usage('--avatars takes a comma-separated list of avatar ids');
  }

  const outDir = resolve(ROOT, OUT_ROOT, label);
  if (existsSync(outDir)) usage(`${join(OUT_ROOT, label)} already exists; choose another label`);
  await mkdir(outDir, { recursive: true });

  const violations: string[] = [];
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
      // Stages outermost so a page is never followed by one of the same avatar
      // and stage, and every page starts on a freshly started control server.
      for (const stage of STAGES) {
        for (const avatar of avatars) {
          controlProc = await startControl(control);
          const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
          try {
            const page = await context.newPage();
            const tag = `${avatar}-${stage}`;
            page.on('console', (message) => {
              if (message.type() === 'error' && message.text().includes('THREE.WebGLProgram')) {
                violations.push(`${tag}: shader error: ${message.text().split('\n')[0]}`);
              }
            });
            const query = new URLSearchParams({ mute: '1', size: '1280x720', avatar });
            if (stage === 'transparent') query.set('transparent', '1');
            else if (stage !== 'flat') query.set('backdrop', stage);
            await page.goto(`http://${HOST}:${vite}/?${query}`, { timeout: READY_TIMEOUT_MS });
            await until(
              `avatar ${avatar} to be ready`,
              () => avatarReady(control, avatar),
              READY_TIMEOUT_MS,
            );
            for (const shot of SHOTS) {
              await sendCamera(control, shot);
              await sleep(SETTLE_MS);
              const file = `${avatar}-${shot.name}-${stage}.png`;
              const bytes = await page.screenshot({ omitBackground: stage === 'transparent' });
              await writeFile(join(outDir, file), bytes);
              if (stage === 'transparent') {
                violations.push(...checkTransparent(file, bytes, shot.name === 'bust-front'));
              }
              console.log(`wrote ${join(OUT_ROOT, label, file)}`);
            }
          } finally {
            await context.close();
            const proc = controlProc;
            controlProc = null;
            await stop(proc, control);
          }
        }
      }
    } finally {
      await browser.close();
    }
    await writeFile(join(outDir, 'index.html'), indexHtml(label, avatars, compare));
  } finally {
    if (controlProc !== null) await stop(controlProc, control).catch(killAll);
    if (viteProc !== null) await stop(viteProc, vite).catch(killAll);
  }

  if (violations.length > 0) {
    console.error(`${violations.length} violation(s):`);
    for (const violation of violations) console.error(`  ${violation}`);
    return 1;
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
