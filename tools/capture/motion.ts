/**
 * Capture a short visual review of gesture entrances and transitions on the
 * operator's installed avatars.
 *
 *   yarn tsx tools/capture/motion.ts --label before [--avatars yoka,manuka]
 *     [--gestures listen,cover,faceCover,wave,chin]
 *
 * Each sample records when its screenshot request began and finished relative
 * to the start of the control API request. The image can be rendered at any
 * point in that interval; it is not an exact frame timestamp. Screenshots and
 * the manifest stay under ignored backup/ because they show purchased avatars.
 *
 * The tool starts its own loopback-only viewer and control server. It never
 * sends a command to another renderer attached to the operator's dev server.
 */

import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page, type Video } from 'playwright';
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

const OUT_ROOT = 'backup/motion-review';
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VIEWPORT = { width: 1280, height: 720 };
const INDIVIDUAL_SAMPLES_MS = [100, 250, 500, 870, 1_400, 2_000, 3_000] as const;
const TRANSITION_SAMPLES_MS = [100, 250, 500, 870, 1_400, 2_000] as const;
const SPARSE_SAMPLES_MS = [100, 1_500, 3_000] as const;
const NOD_SAMPLES_MS = [100, 200, 300, 450, 600, 800] as const;
const STATE_REPORT_SETTLE_MS = 750;
const DEFAULT_GESTURES = ['listen', 'cover', 'faceCover', 'wave', 'chin'];
const DEFAULT_CHAIN = ['listen', 'cover', 'listen', 'faceCover', 'faceCover', null] as const;

interface Gesture {
  id: string;
  group: string;
  sustain: boolean;
}

interface Sample {
  expectedOffsetMs: number;
  screenshotRequestedOffsetMs: number;
  screenshotCompletedOffsetMs: number;
  file: string;
}

interface Capture {
  avatar: string;
  sequence: string;
  command: { gesture: string | null; side?: 'L' | 'R' };
  requestStartedAt: string;
  acceptedAt: string;
  samples: Sample[];
}

interface NeutralWait {
  avatar: string;
  requestStartedAt: string;
  stopAcceptedAt: string;
  stateReachedNullAt: string;
  waitedMs: number;
}

function usage(message: string): never {
  console.error(message);
  console.error(
    'usage: yarn tsx tools/capture/motion.ts --label <name> [--avatars yoka,manuka] [--gestures listen,cover,faceCover,wave,chin] [--chain|--no-chain] [--sparse] [--video-only]',
  );
  process.exit(2);
}

function elapsedMs(since: bigint): number {
  return Number(process.hrtime.bigint() - since) / 1_000_000;
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-');
}

async function getJson<T>(port: number, pathname: string): Promise<T> {
  const response = await fetch(`http://${HOST}:${port}${pathname}`);
  if (!response.ok)
    throw new Error(`${pathname} returned ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function sendGesture(
  port: number,
  gesture: string | null,
  side: 'L' | 'R',
): Promise<{ requestStartedAt: string; acceptedAt: string; startedAt: bigint }> {
  const startedAt = process.hrtime.bigint();
  const requestStartedAt = new Date().toISOString();
  const response = await fetch(`http://${HOST}:${port}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      gesture === null ? { cmd: 'gesture' } : { cmd: 'gesture', id: gesture, side },
    ),
  });
  const acceptedAt = new Date().toISOString();
  if (!response.ok) {
    throw new Error(
      `gesture ${gesture ?? '<stop>'} refused: ${response.status} ${await response.text()}`,
    );
  }
  const outcome = (await response.json()) as { ok?: boolean; viewers?: number };
  if (outcome.ok !== true || outcome.viewers !== 1) {
    throw new Error(
      `gesture ${gesture ?? '<stop>'} did not reach exactly one renderer: ${JSON.stringify(outcome)}`,
    );
  }
  return { acceptedAt, requestStartedAt, startedAt };
}

async function captureWindow(
  page: Page,
  control: number,
  avatar: string,
  sequence: string,
  gesture: string | null,
  side: 'L' | 'R',
  offsets: readonly number[],
  directory: string,
): Promise<Capture> {
  const { acceptedAt, requestStartedAt, startedAt } = await sendGesture(control, gesture, side);
  const samples: Sample[] = [];
  for (const expectedOffsetMs of offsets) {
    const remaining = expectedOffsetMs - elapsedMs(startedAt);
    if (remaining > 0) await sleep(remaining);
    const screenshotRequestedOffsetMs = Math.round(elapsedMs(startedAt));
    const file = `${slug(sequence)}-t${String(expectedOffsetMs).padStart(4, '0')}.png`;
    await page.screenshot({ path: join(directory, file) });
    const screenshotCompletedOffsetMs = Math.round(elapsedMs(startedAt));
    samples.push({
      expectedOffsetMs,
      screenshotRequestedOffsetMs,
      screenshotCompletedOffsetMs,
      file,
    });
  }
  return {
    avatar,
    sequence,
    command: { gesture, side: gesture === null ? undefined : side },
    requestStartedAt,
    acceptedAt,
    samples,
  };
}

/** Stop the current gesture, let one renderer report arrive, then wait for its actual null state. */
async function waitForNeutral(
  page: Page,
  control: number,
  avatar: string,
  waits: NeutralWait[],
): Promise<void> {
  const startedAt = process.hrtime.bigint();
  const stopped = await sendGesture(control, null, 'R');
  await page.waitForTimeout(STATE_REPORT_SETTLE_MS);
  await until(
    `avatar ${avatar} gesture to release`,
    async () => {
      const snapshot = await getJson<{ state?: { gesture?: string | null } }>(
        control,
        '/api/state',
      );
      return snapshot.state?.gesture === null;
    },
    READY_TIMEOUT_MS,
  );
  waits.push({
    avatar,
    requestStartedAt: stopped.requestStartedAt,
    stopAcceptedAt: stopped.acceptedAt,
    stateReachedNullAt: new Date().toISOString(),
    waitedMs: Math.round(elapsedMs(startedAt)),
  });
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      label: { type: 'string' },
      avatars: { type: 'string' },
      gestures: { type: 'string' },
      chain: { type: 'boolean', default: true },
      'no-chain': { type: 'boolean', default: false },
      sparse: { type: 'boolean', default: false },
      'video-only': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const label = values.label;
  if (!(label && LABEL.test(label))) usage('--label takes letters, digits, . _ -');
  const avatars = (values.avatars ?? 'yoka,manuka')
    .split(',')
    .map((avatar) => avatar.trim())
    .filter(Boolean);
  if (avatars.length === 0 || avatars.some((avatar) => !LABEL.test(avatar))) {
    usage('--avatars takes a comma-separated list of avatar ids');
  }
  const requested = (values.gestures ?? DEFAULT_GESTURES.join(','))
    .split(',')
    .map((gesture) => gesture.trim())
    .filter(Boolean);
  const all = requested.length === 1 && requested[0] === 'all';
  if (!all && (requested.length === 0 || requested.some((gesture) => !LABEL.test(gesture)))) {
    usage('--gestures takes a comma-separated list of ids or all');
  }
  const captureChain = values.chain && !values['no-chain'];

  const output = resolve(ROOT, OUT_ROOT, label);
  if (existsSync(output)) usage(`${join(OUT_ROOT, label)} already exists; choose a new label`);
  await mkdir(output, { recursive: true });

  const [control, vite] = [await freePort(), await freePort()];
  let controlProc: Proc | null = null;
  let viteProc: Proc | null = null;
  const captures: Capture[] = [];
  const neutralWaits: NeutralWait[] = [];
  const videos: Array<{ avatar: string; file: string; pageCreatedAt: string }> = [];
  try {
    controlProc = await startControl(control);
    viteProc = await startVite(vite, control);
    const browser = await chromium.launch({
      headless: true,
      args: ['--enable-webgl', '--ignore-gpu-blocklist'],
    });
    try {
      for (const avatar of avatars) {
        const directory = join(output, avatar);
        await mkdir(directory, { recursive: true });
        const context = await browser.newContext({
          viewport: VIEWPORT,
          deviceScaleFactor: 1,
          recordVideo: { dir: directory, size: VIEWPORT },
        });
        let video: Video | null = null;
        let pageCreatedAt = '';
        try {
          const page = await context.newPage();
          pageCreatedAt = new Date().toISOString();
          video = page.video();
          const pageErrors: string[] = [];
          page.on('pageerror', (error) => pageErrors.push(error.message));
          page.on('console', (message) => {
            if (message.type() === 'error' && message.text().includes('THREE.WebGLProgram')) {
              pageErrors.push(message.text().split('\n')[0]);
            }
          });
          const query = new URLSearchParams({ mute: '1', size: '1280x720', avatar });
          await page.goto(`http://${HOST}:${vite}/?${query}`, { timeout: READY_TIMEOUT_MS });
          await until(
            `avatar ${avatar} to be ready`,
            () => avatarReady(control, avatar),
            READY_TIMEOUT_MS,
          );
          await page.waitForTimeout(750);

          const reportedVocabulary: { value: { gestures?: Gesture[] } | null } = { value: null };
          await until(
            `gesture vocabulary for ${avatar}`,
            async () => {
              const reported = await getJson<{ gestures?: Gesture[] } | null>(
                control,
                '/api/vocabulary',
              );
              if (!Array.isArray(reported?.gestures)) return false;
              reportedVocabulary.value = reported;
              return true;
            },
            READY_TIMEOUT_MS,
          );
          const vocabulary = reportedVocabulary.value;
          if (vocabulary === null || !Array.isArray(vocabulary.gestures)) {
            throw new Error(`avatar ${avatar} did not report gesture vocabulary`);
          }
          const available = new Map(vocabulary.gestures.map((gesture) => [gesture.id, gesture]));
          const gestures = all ? vocabulary.gestures.map((gesture) => gesture.id) : requested;
          const missing = gestures.filter((id) => !available.has(id));
          if (missing.length) {
            throw new Error(`avatar ${avatar} does not advertise gestures: ${missing.join(', ')}`);
          }

          for (const gesture of gestures) {
            // Establish the same neutral departure for every standalone take.
            await waitForNeutral(page, control, avatar, neutralWaits);
            captures.push(
              await captureWindow(
                page,
                control,
                avatar,
                `gesture-${gesture}-R`,
                gesture,
                'R',
                values['video-only']
                  ? []
                  : values.sparse
                    ? SPARSE_SAMPLES_MS
                    : gesture === 'nod'
                      ? NOD_SAMPLES_MS
                      : INDIVIDUAL_SAMPLES_MS,
                directory,
              ),
            );
            if (values['video-only']) await page.waitForTimeout(3_000);
          }

          if (captureChain) {
            await waitForNeutral(page, control, avatar, neutralWaits);
            for (let index = 0; index < DEFAULT_CHAIN.length; index += 1) {
              const gesture = DEFAULT_CHAIN[index];
              const side = index === 4 ? 'L' : 'R';
              if (gesture !== null && !available.has(gesture)) {
                throw new Error(`avatar ${avatar} does not advertise chain gesture ${gesture}`);
              }
              const name = `${String(index + 1).padStart(2, '0')}-${gesture ?? 'stop'}-${side}`;
              captures.push(
                await captureWindow(
                  page,
                  control,
                  avatar,
                  `chain-${name}`,
                  gesture,
                  side,
                  values['video-only'] ? [] : TRANSITION_SAMPLES_MS,
                  directory,
                ),
              );
              if (values['video-only']) await page.waitForTimeout(2_000);
            }
          }
          if (pageErrors.length > 0) {
            throw new Error(`avatar ${avatar} page errors:\n${pageErrors.join('\n')}`);
          }
        } finally {
          await context.close();
          const videoPath = video === null ? null : await video.path();
          if (videoPath !== null) {
            const file = `${avatar}-review.webm`;
            const destination = join(directory, file);
            await rename(videoPath, destination);
            videos.push({ avatar, file: join(avatar, file), pageCreatedAt });
          }
        }
      }
    } finally {
      await browser.close();
    }
    await writeFile(
      join(output, 'manifest.json'),
      `${JSON.stringify(
        {
          label,
          capturedAt: new Date().toISOString(),
          avatars,
          requestedGestures: all ? 'all' : requested,
          chain: captureChain,
          videoOnly: values['video-only'],
          samplingOffsetsMs: {
            individual: values['video-only']
              ? []
              : values.sparse
                ? SPARSE_SAMPLES_MS
                : INDIVIDUAL_SAMPLES_MS,
            nod: values['video-only'] ? [] : values.sparse ? SPARSE_SAMPLES_MS : NOD_SAMPLES_MS,
            transition: values['video-only'] ? [] : TRANSITION_SAMPLES_MS,
          },
          videos,
          transitionSequence: DEFAULT_CHAIN,
          commandClock:
            'expectedOffsetMs, screenshotRequestedOffsetMs, and screenshotCompletedOffsetMs use monotonic time from request start. The screenshot can be rendered anywhere within the requested/completed interval. requestStartedAt and acceptedAt provide the UTC request bracket.',
          videoClock:
            'pageCreatedAt is an approximate UTC anchor for the WebM timeline. Playwright does not expose the exact first-frame timestamp; command request times provide later UTC anchors.',
          captures,
          neutralWaits,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (controlProc !== null) await stop(controlProc, control).catch(killAll);
    if (viteProc !== null) await stop(viteProc, vite).catch(killAll);
  }
  console.log(
    `captured ${captures.length} windows for ${avatars.join(', ')} at ${join(OUT_ROOT, label)}`,
  );
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
