import { parseArgs } from 'node:util';
import type { ZodType } from 'zod';
import {
  cameraCommandSchema,
  commandSchema,
  emotionCommandSchema,
  expressionCommandSchema,
  gestureCommandSchema,
  idleCommandSchema,
  lookCommandSchema,
  overlayCommandSchema,
  pointCommandSchema,
  sayCommandSchema,
  type Vocabulary,
  wearCommandSchema,
} from '../protocol';
import { ControlClient, DEFAULT_BASE, fail } from './client';

/**
 * Command-line client for the AITuber control API.
 *
 * For driving the avatar by hand and for checking the API without writing a
 * client. An orchestrator would post the same JSON directly.
 *
 *     yarn ctl vocab
 *     yarn ctl state
 *     yarn ctl idle on
 *     yarn ctl say "こんばんは" --emotion joy=0.8 --gesture wave --wait
 *     yarn ctl expression F_NIKONIKO
 *     yarn ctl overlay option_guruguru
 *     yarn ctl point 40 25 --extent 0.9
 *     yarn ctl reset
 *     yarn ctl interrupt
 *     yarn ctl camera bust
 *     yarn ctl wear --preset stream
 *     yarn ctl watch
 *
 * Every command is built through the protocol schemas before it goes on the
 * wire, so a line this client accepts is a line the viewer understands: the CLI
 * drifting from the renderer is the failure this design is meant to remove.
 */

/** Matches the server's own long-poll default, so `watch` never idles out. */
const WATCH_WAIT_SECONDS = 30;

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

type Handler = (client: ControlClient, args: string[]) => Promise<void>;

// --- argv shims -------------------------------------------------------------

/**
 * `--base` overrides the server, and may appear anywhere on the line.
 *
 * Taken out before the subcommand is picked, because `parseArgs` is run once
 * per subcommand with that subcommand's own options and knows nothing global.
 */
function takeBase(argv: string[]): { base: string; rest: string[] } {
  let base = DEFAULT_BASE;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--base') {
      const value = argv[i + 1];
      if (value === undefined) fail('--base には URL が必要');
      base = value;
      i += 1;
      continue;
    }
    if (token.startsWith('--base=')) {
      base = token.slice('--base='.length);
      continue;
    }
    rest.push(token);
  }
  return { base, rest };
}

/**
 * `--emotion joy=0.8 relaxed=0.2` takes as many values as follow it, which
 * `parseArgs` has no form for — it reads exactly one. The extra values are
 * folded back into repeats of the flag before parsing.
 */
function expandGreedy(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    out.push(args[i]);
    if (args[i] !== flag) continue;
    for (let taken = 0; i + 1 < args.length && !args[i + 1].startsWith('-'); taken += 1) {
      if (taken > 0) out.push(flag);
      out.push(args[i + 1]);
      i += 1;
    }
  }
  return out;
}

/**
 * `--wait` takes an optional number of seconds; bare, it means "wait, with the
 * server's default timeout". `parseArgs` has no optional-value form, so a bare
 * one is rewritten to the `1` that the server reads as that default.
 */
function normaliseWait(args: string[]): string[] {
  return args.map((token, i) => {
    if (token !== '--wait') return token;
    const next = args[i + 1];
    return next !== undefined && NUMBER.test(next) ? token : '--wait=1';
  });
}

/**
 * Pull the numeric positionals out ahead of `parseArgs`, which reads a leading
 * `-` as a short option — without this a negative bearing is an unknown flag
 * rather than a direction.
 */
function extractNumbers(
  args: string[],
  valueFlags: string[],
): { numbers: string[]; rest: string[] } {
  const numbers: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (valueFlags.includes(token)) {
      rest.push(token);
      if (args[i + 1] !== undefined) {
        rest.push(args[i + 1]);
        i += 1;
      }
      continue;
    }
    if (NUMBER.test(token)) numbers.push(token);
    else rest.push(token);
  }
  return { numbers, rest };
}

// --- values -----------------------------------------------------------------

function toNumber(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) fail(`${label} には数値を指定する: ${raw}`);
  return value;
}

/** `--emotion joy=0.8 relaxed=0.2` -> `{ joy: 0.8, relaxed: 0.2 }`. */
function parseVec(pairs: string[] | undefined): Record<string, number> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  const vec: Record<string, number> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const name = at === -1 ? pair : pair.slice(0, at);
    const raw = at === -1 ? '' : pair.slice(at + 1);
    vec[name] = raw === '' ? 1.0 : toNumber(raw, 1.0, `--emotion ${name}`);
  }
  return vec;
}

/**
 * Validate one command before it goes on the wire.
 *
 * An emotion name or a camera frame the avatar does not have is caught here,
 * against the same schema the viewer applies, rather than being posted and
 * silently ignored at the other end.
 */
function build<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || 'command'}: ${issue.message}`)
      .join(', ');
    fail(`引数が不正: ${detail}`);
  }
  return parsed.data;
}

function show(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

// --- subcommands ------------------------------------------------------------

const say: Handler = async (client, args) => {
  const { values, positionals } = parseArgs({
    args: expandGreedy(normaliseWait(args), '--emotion'),
    options: {
      emotion: { type: 'string', multiple: true },
      expression: { type: 'string' },
      gesture: { type: 'string' },
      hold: { type: 'boolean' },
      wait: { type: 'string' },
    },
    allowPositionals: true,
  });
  const text = positionals[0];
  if (text === undefined) fail('say には読み上げるテキストが必要');
  const command = build(sayCommandSchema, {
    cmd: 'say',
    text,
    emotion: parseVec(values.emotion),
    expression: values.expression,
    gesture: values.gesture,
    hold: values.hold ? true : undefined,
  });
  show(await client.command(command, values.wait));
};

const emotion: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  if (positionals.length === 0) fail('emotion には joy=0.8 のような組が必要');
  show(
    await client.command(
      build(emotionCommandSchema, {
        cmd: 'emotion',
        vec: parseVec(positionals),
      }),
    ),
  );
};

const expression: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  show(
    await client.command(
      build(expressionCommandSchema, {
        cmd: 'expression',
        id: positionals[0],
      }),
    ),
  );
};

/**
 * Drawn effects layer over whatever face is showing, so unlike `expression`
 * several can be up at once and each is cleared by name.
 */
const overlay: Handler = async (client, args) => {
  const { values, positionals } = parseArgs({
    args,
    options: { weight: { type: 'string' }, off: { type: 'boolean' } },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (id === undefined) fail('overlay にはエフェクトの id が必要');
  show(
    await client.command(
      build(overlayCommandSchema, {
        cmd: 'overlay',
        id,
        weight: values.off ? 0.0 : toNumber(values.weight, 1.0, '--weight'),
      }),
    ),
  );
};

const gesture: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  show(
    await client.command(
      build(gestureCommandSchema, {
        cmd: 'gesture',
        id: positionals[0],
      }),
    ),
  );
};

/**
 * Angular, not a pose name: the arm is back-solved from where the fingertip has
 * to be. `point` with no arguments releases, like `gesture` with no id.
 */
const point: Handler = async (client, args) => {
  const { numbers, rest } = extractNumbers(args, ['--extent', '--side', '--finger']);
  const { values } = parseArgs({
    args: rest,
    options: {
      extent: { type: 'string' },
      side: { type: 'string' },
      finger: { type: 'string' },
    },
    allowPositionals: true,
  });
  if (numbers.length === 0) {
    show(await client.command(build(pointCommandSchema, { cmd: 'point' })));
    return;
  }
  // Degrees on the wire: 0 azimuth is straight ahead and positive is toward the
  // character's right, 0 elevation is shoulder height and positive is up.
  show(
    await client.command(
      build(pointCommandSchema, {
        cmd: 'point',
        azimuth: toNumber(numbers[0], 0.0, 'azimuth'),
        elevation: toNumber(numbers[1], 0.0, 'elevation'),
        extent: toNumber(values.extent, 0.8, '--extent'),
        side: values.side ?? 'R',
        finger: values.finger ?? 'index',
      }),
    ),
  );
};

const camera: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  show(
    await client.command(
      build(cameraCommandSchema, {
        cmd: 'camera',
        frame: positionals[0],
      }),
    ),
  );
};

const wear: Handler = async (client, args) => {
  const { values } = parseArgs({
    args,
    options: {
      slot: { type: 'string' },
      item: { type: 'string' },
      preset: { type: 'string' },
    },
    allowPositionals: true,
  });
  show(
    await client.command(
      build(wearCommandSchema, {
        cmd: 'wear',
        slot: values.slot,
        item: values.item,
        preset: values.preset,
      }),
    ),
  );
};

const idle: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const on = positionals[0];
  if (on !== 'on' && on !== 'off') fail('idle on|off');
  show(await client.command(build(idleCommandSchema, { cmd: 'idle', on: on === 'on' })));
};

const look: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  if (positionals[0] === undefined) fail('look には 0..1 の量が必要');
  show(
    await client.command(
      build(lookCommandSchema, {
        cmd: 'look',
        amount: toNumber(positionals[0], 1.0, 'amount'),
      }),
    ),
  );
};

/**
 * The three that take nothing at all. Validated against the union, which is the
 * same schema by another name.
 */
function bare(cmd: 'reset' | 'interrupt' | 'clear'): Handler {
  return async (client) => {
    show(await client.command(build(commandSchema, { cmd })));
  };
}

const vocab: Handler = async (client) => {
  const vocabulary = await client.vocabulary();
  if (Object.keys(vocabulary).length === 0) {
    console.log('語彙なし（ビューアが未接続）');
    return;
  }
  // First, because the rest of the listing is this avatar's vocabulary and
  // means nothing without knowing which one is loaded.
  console.log(`avatar: ${vocabulary.avatar?.label ?? '?'} (${vocabulary.avatar?.id ?? '?'})`);
  for (const key of ['emotions', 'expressions', 'overlays', 'gestures'] as const) {
    const items = vocabulary[key] ?? [];
    console.log(`${key} (${items.length})`);
    for (const item of items) {
      const extra = 'group' in item ? `  [${item.group}]` : '';
      console.log(`  ${item.id.padEnd(16)} ${item.label}${extra}`);
    }
  }
  const cameras: Vocabulary['cameras'] = vocabulary.cameras ?? [];
  console.log(`cameras: ${cameras.join(', ')}`);
  const wardrobe: Vocabulary['wardrobe'] = vocabulary.wardrobe ?? {};
  for (const [slot, entry] of Object.entries(wardrobe)) {
    console.log(
      `wear ${slot.padEnd(8)} ${entry.label}: ${entry.items.map((i) => i.id).join(', ')}`,
    );
  }
};

const state: Handler = async (client) => {
  const snapshot = await client.state();
  if (!snapshot.connected) console.log('ビューア未接続');
  show(snapshot.state);
};

/** Follow the event log. Useful to see how turns actually sequence. */
const watch: Handler = async (client) => {
  let since = (await client.state()).seq;
  console.log(`seq=${since} から追従（Ctrl-C で終了）`);
  for (;;) {
    const response = await client.events(since, WATCH_WAIT_SECONDS);
    since = response.seq;
    for (const event of response.events) {
      const extra: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(event)) {
        if (key !== 'seq' && key !== 'at' && key !== 'type') extra[key] = value;
      }
      const seq = String(event.seq ?? 0).padStart(5);
      console.log(`${seq}  ${event.type.padEnd(18)} ${JSON.stringify(extra)}`);
    }
  }
};

const HANDLERS: Record<string, Handler> = {
  say,
  emotion,
  expression,
  overlay,
  gesture,
  point,
  camera,
  wear,
  idle,
  look,
  reset: bare('reset'),
  interrupt: bare('interrupt'),
  clear: bare('clear'),
  vocab,
  state,
  watch,
};

function usage(): never {
  fail(
    [
      '使い方: yarn ctl [--base URL] <コマンド> [引数...]',
      `コマンド: ${Object.keys(HANDLERS).join(', ')}`,
      '',
      '  yarn ctl say "こんばんは" --emotion joy=0.8 --gesture wave --wait',
      '  yarn ctl point 40 25 --extent 0.9',
      '  yarn ctl idle on',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const { base, rest } = takeBase(process.argv.slice(2));
  const action = rest[0];
  if (action === undefined || !Object.hasOwn(HANDLERS, action)) usage();
  await HANDLERS[action](new ControlClient(base), rest.slice(1));
}

main().catch((error: unknown) => fail(String(error)));
