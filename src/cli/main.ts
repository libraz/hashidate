import { parseArgs } from 'node:util';
import type { ZodType } from 'zod';
import {
  avatarCommandSchema,
  backdropCommandSchema,
  cameraCommandSchema,
  commandSchema,
  emotionCommandSchema,
  expressionCommandSchema,
  gestureCommandSchema,
  hopCommandSchema,
  idleCommandSchema,
  lookCommandSchema,
  overlayCommandSchema,
  performCommandSchema,
  pointCommandSchema,
  roomCommandSchema,
  sayCommandSchema,
  tuneCommandSchema,
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
 *     yarn ctl perform happy
 *     yarn ctl say "こんばんは" --perform hello --wait
 *     yarn ctl say "こんばんは" --emotion joy=0.8 --gesture wave --wait
 *     yarn ctl say "[hello]こんばんは。[explain]今日はこの話をします。"
 *     yarn ctl say "8月27日だよ" --reading "はちがつにじゅうしちにちだよ"
 *     yarn ctl say "これが、ホール。" --camera full --room hall
 *     yarn ctl expression F_NIKONIKO
 *     yarn ctl overlay option_guruguru
 *     yarn ctl hop bounce
 *     yarn ctl point 40 25 --extent 0.9
 *     yarn ctl reset
 *     yarn ctl interrupt
 *     yarn ctl camera bust
 *     yarn ctl backdrop dusk
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
      reading: { type: 'string' },
      emotion: { type: 'string', multiple: true },
      expression: { type: 'string' },
      gesture: { type: 'string' },
      perform: { type: 'string' },
      hold: { type: 'boolean' },
      camera: { type: 'string' },
      backdrop: { type: 'string' },
      room: { type: 'string' },
      wait: { type: 'string' },
    },
    allowPositionals: true,
  });
  const text = positionals[0];
  if (text === undefined) fail('say には読み上げるテキストが必要');
  // The shot, if any of it was named. Built as a whole or not at all, because
  // an empty object is a staging instruction that stages nothing — harmless,
  // but it would put a `stage: {}` on every line the wire ever carried.
  //
  // An empty string is how a shell says null here: `--room ''` is dry, `--room`
  // left off leaves the room where it is. The standalone commands make that
  // distinction by having an argument or not, which a flag cannot do.
  const empty = (v: string | undefined): string | null | undefined =>
    v === undefined ? undefined : v === '' ? null : v;
  const stage =
    values.camera === undefined && values.backdrop === undefined && values.room === undefined
      ? undefined
      : {
          camera: values.camera,
          backdrop: empty(values.backdrop),
          room: empty(values.room),
        };
  const command = build(sayCommandSchema, {
    cmd: 'say',
    text,
    reading: values.reading,
    emotion: parseVec(values.emotion),
    expression: values.expression,
    gesture: values.gesture,
    perform: values.perform,
    hold: values.hold ? true : undefined,
    stage,
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

/**
 * A face and a movement together, which is what most callers actually want.
 * With no id it releases the one that is up, like `gesture`.
 */
const perform: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  show(
    await client.command(
      build(performCommandSchema, {
        cmd: 'perform',
        id: positionals[0],
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

const hop: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  show(
    await client.command(
      build(hopCommandSchema, {
        cmd: 'hop',
        hop: positionals[0],
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

/** No id is dry, matching `perform` and `gesture` rather than needing a word for it. */
const room: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  show(
    await client.command(
      build(roomCommandSchema, {
        cmd: 'room',
        id: positionals[0] ?? null,
      }),
    ),
  );
};

/** Same shape as `room` beside it, and the same rule: no id is the bare stage. */
const backdrop: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  show(
    await client.command(
      build(backdropCommandSchema, {
        cmd: 'backdrop',
        id: positionals[0] ?? null,
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

/** One positional, and no default: there is no such thing as no avatar. */
const avatar: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  show(await client.command(build(avatarCommandSchema, { cmd: 'avatar', id: positionals[0] })));
};

/**
 * The set-once layer, as dotted assignments: `yarn ctl tune sway.stiffness=2`.
 *
 * Fourteen numbers in five groups, so a flag apiece would be a page of options
 * for a command that is almost always used to move one of them. The path is the
 * field's own path in `tuneCommandSchema`, which means there is nothing to
 * remember and nothing here that has to be kept in step with it — an unknown
 * one is refused by the schema rather than by a table in this file.
 */
const tune: Handler = async (client, args) => {
  const { positionals, values } = parseArgs({
    args,
    options: { settle: { type: 'boolean' } },
    allowPositionals: true,
  });

  const patch: Record<string, Record<string, unknown>> = {};
  for (const assignment of positionals) {
    const [path, raw] = splitOnce(assignment, '=');
    const [group, field] = splitOnce(path, '.');
    if (raw === null || field === null) fail(`調律は group.field=値 の形で書く: ${assignment}`);
    // Numbers stay numbers and the two words stay booleans; anything else is
    // left as written so the schema can say what is wrong with it.
    const value = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
    patch[group] = { ...patch[group], [field]: value };
  }

  show(
    await client.command(
      build(tuneCommandSchema, {
        cmd: 'tune',
        ...patch,
        ...(values.settle ? { settle: true } : {}),
      }),
    ),
  );
};

/** Split on the first separator only. `null` when there is none. */
function splitOnce(value: string, separator: string): [string, string | null] {
  const at = value.indexOf(separator);
  return at === -1 ? [value, null] : [value.slice(0, at), value.slice(at + separator.length)];
}

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
  // Performances first: a caller reading this to decide what to send should see
  // the composed vocabulary before the parts it is composed from. What each one
  // is made of is printed alongside, so the listing also answers "and what does
  // that do" without a second round trip.
  const performances: Vocabulary['performances'] = vocabulary.performances ?? [];
  console.log(`performances (${performances.length})`);
  for (const item of performances) {
    const parts = [item.gesture, item.hop].filter(Boolean).join(' + ') || '表情のみ';
    const held = item.sustain ? ' *' : '';
    console.log(`  ${item.id.padEnd(16)} ${item.label.padEnd(12)} [${item.group}] ${parts}${held}`);
  }
  for (const key of ['emotions', 'expressions', 'overlays', 'gestures'] as const) {
    const items = vocabulary[key] ?? [];
    console.log(`${key} (${items.length})`);
    for (const item of items) {
      const extra = 'group' in item ? `  [${item.group}]` : '';
      console.log(`  ${item.id.padEnd(16)} ${item.label}${extra}`);
    }
  }
  const hops: Vocabulary['hops'] = vocabulary.hops ?? [];
  console.log(`hops: ${hops.map((h) => `${h.id} (${h.label})`).join(', ')}`);
  const cameras: Vocabulary['cameras'] = vocabulary.cameras ?? [];
  console.log(`cameras: ${cameras.join(', ')}`);
  const rooms: Vocabulary['rooms'] = vocabulary.rooms ?? [];
  console.log(
    `rooms: ${rooms.length === 0 ? '(音声なし)' : rooms.map((r) => `${r.id} (${r.label})`).join(', ')}`,
  );
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
  perform,
  gesture,
  hop,
  point,
  camera,
  room,
  backdrop,
  wear,
  avatar,
  tune,
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
      '  yarn ctl perform happy',
      '  yarn ctl say "こんばんは" --perform hello --wait',
      '  yarn ctl say "[hello]こんばんは。[explain]今日はこの話をします。"',
      '  yarn ctl say "コメント3件ありがとう" --reading "コメントさんけんありがとう"',
      '  yarn ctl point 40 25 --extent 0.9',
      '  yarn ctl idle on',
      '  yarn ctl avatar manuka',
      '  yarn ctl tune sway.stiffness=2 idle.breathDepth=1.2',
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
