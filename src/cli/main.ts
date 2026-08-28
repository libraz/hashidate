import { parseArgs } from 'node:util';
import type { ZodType } from 'zod';
import { getLocale, type Localized, pick } from '../i18n/locale';
import {
  avatarCommandSchema,
  backdropCommandSchema,
  cameraCommandSchema,
  commandSchema,
  debugCommandSchema,
  deckCommandSchema,
  emotionCommandSchema,
  expressionCommandSchema,
  gestureCommandSchema,
  hopCommandSchema,
  idleCommandSchema,
  lookCommandSchema,
  overlayCommandSchema,
  pauseCommandSchema,
  performCommandSchema,
  placeCommandSchema,
  pointCommandSchema,
  roomCommandSchema,
  sayCommandSchema,
  slideCommandSchema,
  tuneCommandSchema,
  type Vocabulary,
  wearCommandSchema,
} from '../protocol';
import { loadScript, outline, ScriptError } from '../script';
import { runScript } from '../script/run';
import { ControlClient, DEFAULT_BASE, fail } from './client';

/**
 * A two-language label, printed in one of them.
 *
 * The wire carries both. This is a terminal, and everything else it prints is
 * English, so it takes the locale in force — which falls back to English when
 * nothing has said otherwise.
 */
const localized = (text: Localized): string => pick(text, getLocale());

/**
 * Command-line client for the hashidate control API.
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
 *     yarn ctl play demo
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
      if (value === undefined) fail('--base needs a URL');
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
  if (!Number.isFinite(value)) fail(`${label} takes a number: ${raw}`);
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
    fail(`Invalid arguments: ${detail}`);
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
      deck: { type: 'string' },
      slide: { type: 'string' },
      wait: { type: 'string' },
    },
    allowPositionals: true,
  });
  const text = positionals[0];
  if (text === undefined) fail('say needs the text to be read out');
  // The shot, if any of it was named. Built as a whole or not at all, because
  // an empty object is a staging instruction that stages nothing — harmless,
  // but it would put a `stage: {}` on every line the wire ever carried.
  //
  // An empty string is how a shell says null here: `--room ''` is dry, `--room`
  // left off leaves the room where it is. The standalone commands make that
  // distinction by having an argument or not, which a flag cannot do.
  const empty = (v: string | undefined): string | null | undefined =>
    v === undefined ? undefined : v === '' ? null : v;
  // `--deck ''` takes the document down, matching `--room ''` beside it and
  // deliberately unlike the standalone `deck`, whose word for that is `none`.
  // There the id is a required positional and a bare command would far more
  // often be a name that went missing than an instruction to clear the screen;
  // a flag left off already says "leave it", so the empty value is free.
  //
  // A layout is not here. It is four numbers and an anchor, which is a page of
  // flags for the one thing this client is worst at — an operator moving the
  // character by hand runs `place` and watches it. A line carrying one is a
  // script, and a script has room to write it out; see `src/script`.
  const staged = ['camera', 'backdrop', 'room', 'deck', 'slide'] as const;
  const stage = staged.every((key) => values[key] === undefined)
    ? undefined
    : {
        camera: values.camera,
        backdrop: empty(values.backdrop),
        room: empty(values.room),
        deck: empty(values.deck),
        slide: values.slide === undefined ? undefined : Number(values.slide),
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
  if (positionals.length === 0) fail('emotion needs pairs such as joy=0.8');
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
  if (id === undefined) fail('overlay needs the id of an effect');
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

/**
 * `yarn ctl camera full --yaw 25 --zoom 1.3`, and any subset of that.
 *
 * The framing is a positional because it is what is nearly always meant; the
 * three offsets are flags because they are the rarer half and because leaving
 * one out has to mean "leave it alone" rather than "zero". See `Shot`.
 */
const camera: Handler = async (client, args) => {
  const { positionals, values } = parseArgs({
    args,
    options: { yaw: { type: 'string' }, pitch: { type: 'string' }, zoom: { type: 'string' } },
    allowPositionals: true,
  });
  const degrees = (raw: string | undefined) => (raw === undefined ? undefined : Number(raw));
  show(
    await client.command(
      build(cameraCommandSchema, {
        cmd: 'camera',
        frame: positionals[0],
        yaw: degrees(values.yaw),
        pitch: degrees(values.pitch),
        zoom: degrees(values.zoom),
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

/**
 * Which document is behind the character.
 *
 * The id is required and taking one down is the word `none`, which is where
 * this differs from `room` and `backdrop` above. Those have an empty value that
 * is also their resting state, so a bare command reads as "back to nothing". A
 * document is put up deliberately and taken down deliberately in the middle of
 * a segment, and a bare `deck` is far more likely to be a typed id that went
 * missing than an instruction to clear the screen.
 */
const deck: Handler = async (client, args) => {
  const { positionals, values } = parseArgs({
    args,
    options: { page: { type: 'string' } },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (id === undefined) fail('deck needs the id of a document (to take one down, deck none)');
  show(
    await client.command(
      build(deckCommandSchema, {
        cmd: 'deck',
        id: id === 'none' ? null : id,
        page: values.page === undefined ? undefined : Number(values.page),
      }),
    ),
  );
};

/**
 * Turn a page: `next`, `prev`, or the page to go to.
 *
 * Bare is next, which is what the wire means by a `slide` with neither field —
 * stated as `by: 1` here anyway, so the JSON that gets printed says what was
 * actually done rather than leaving the reader to know the default.
 */
const slide: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const where = positionals[0];
  show(await client.command(build(slideCommandSchema, { cmd: 'slide', ...move(where) })));
};

function move(where: string | undefined): { page?: number; by?: number } {
  if (where === undefined || where === 'next') return { by: 1 };
  if (where === 'prev') return { by: -1 };
  if (NUMBER.test(where)) return { page: Number.parseInt(where, 10) };
  fail(`slide takes next / prev / a page number: ${where}`);
}

/**
 * Where the two layers sit in the broadcast frame.
 *
 * The layer is a positional and defaults to the character, which is the one
 * that gets moved: a document is usually left filling the frame and the
 * character is slid into a corner of it. Every field is optional and an absent
 * one is left alone, so this moves what it names and nothing else.
 */
const place: Handler = async (client, args) => {
  const { positionals, values } = parseArgs({
    args,
    options: {
      anchor: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      margin: { type: 'string' },
      fit: { type: 'string' },
    },
    allowPositionals: true,
  });
  const layer = positionals[0] ?? 'avatar';
  if (layer !== 'avatar' && layer !== 'slide') fail(`place takes avatar or slide: ${layer}`);
  // `fit` is how a picture fills its rectangle, which the character's does not
  // have — it is a render of a scene rather than an image with edges.
  if (layer === 'avatar' && values.fit !== undefined) fail('--fit can only be given for slide');
  const number = (raw: string | undefined) => (raw === undefined ? undefined : Number(raw));
  const placement = {
    anchor: values.anchor,
    width: number(values.width),
    height: number(values.height),
    margin: number(values.margin),
    ...(layer === 'slide' ? { fit: values.fit } : {}),
  };
  show(await client.command(build(placeCommandSchema, { cmd: 'place', [layer]: placement })));
};

/**
 * Run a script: the setup once, then its lines onto the queue.
 *
 * The lines go on the server's queue rather than out as `say` commands, and
 * that is the whole reason this is worth having over a shell script. The queue
 * survives a viewer reload, is editable from the panel while it plays, and is
 * deep enough for the renderer to prepare the next line's audio during the
 * current one — sending a script a line at a time costs about a second of
 * silence between every pair of them.
 *
 * `--check` reads and validates without a server, which is what an author wants
 * between edits. It is also the only subcommand here that works with nothing
 * running.
 *
 * `--hold` loads the run without starting it, so the shot can be framed against
 * a queue that is already being synthesised. Off by default here, and on by
 * default in the panel's recording tab: this is the live path, and a `play`
 * that stopped playing would be a different command.
 */
const play: Handler = async (client, args) => {
  const { positionals, values } = parseArgs({
    args,
    options: {
      check: { type: 'boolean' },
      replace: { type: 'boolean' },
      hold: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const name = positionals[0];
  if (name === undefined) fail('play needs a script: a name in show/scripts/, or a path to one');

  const loaded = await loadScript(name).catch((error: unknown) =>
    fail(error instanceof ScriptError ? error.message : String(error)),
  );
  const { id, path, script } = loaded;

  if (values.check) {
    console.log(`${script.title ?? id}  —  ${path}`);
    if (script.note) console.log(script.note);
    if (script.setup?.length) console.log(`setup   ${script.setup.map((c) => c.cmd).join(', ')}`);
    console.log(`lines   ${script.lines.length}`);
    for (const line of outline(script)) console.log(line);
    return;
  }

  const result = await runScript(client, loaded, {
    replace: values.replace,
    hold: values.hold,
  });
  if (result.setup !== undefined) {
    show(result.setup);
    // The two halves have different fates when no renderer is attached: the
    // lines wait on the server's queue and play when one arrives, the setup was
    // a live command and is simply gone. Said out loud, because the difference
    // is invisible in a run that otherwise looks like it worked.
    if (
      typeof result.setup === 'object' &&
      result.setup !== null &&
      (result.setup as { ok?: unknown }).ok === false
    ) {
      console.error('setup was not delivered: no viewer is connected');
      console.error(
        'the lines still queue, but they will play against whatever state a renderer comes up in',
      );
    }
  }
  // Stamped with the script's own name. A queue holding a scripted segment, a
  // comment somebody answered and a line typed by hand is only legible if each
  // row says which it is.
  console.log(
    `${script.lines.length} queued from ${id}: ${result.queue.queue.length} pending, ${result.queue.viewers} viewer(s)`,
  );
  // Said out loud for the same reason the setup failure above is: a held queue
  // and a queue nothing is attached to look identical from a prompt.
  if (values.hold) console.log('held — `yarn ctl resume` starts it');
};

/**
 * The motions the server can see. Not avatar data and not in the vocabulary;
 * see `Motions` — this is a directory, and only the process with a filesystem
 * can answer what is in it.
 */
const motions: Handler = async (client) => {
  const { motions: found, errors } = await client.motions();
  if (found.length === 0 && errors.length === 0) {
    console.log('no motions (put a YAML file in show/motions/)');
    return;
  }
  for (const item of found) {
    const held = item.sustain ? ' *' : '';
    const runs = item.loop ? ' loop' : '';
    console.log(
      `  ${item.id.padEnd(16)} ${localized(item.label).padEnd(16)} [${item.group}] ${item.frames.length}f${runs}${held}`,
    );
  }
  // Beside the ones that worked rather than instead of them: a file that will
  // not parse has to be visible, or it reads as a filename typed wrong.
  for (const { id, error } of errors) console.log(`  ${id.padEnd(16)} ${error}`);
};

/** What the server can see in the document directory. Not avatar data; see `deckSchema`. */
const decks: Handler = async (client) => {
  const { decks: found } = await client.decks();
  if (found.length === 0) {
    console.log('no documents (put a PDF in slides/)');
    return;
  }
  for (const item of found) {
    console.log(
      `  ${item.id.padEnd(16)} ${String(item.pages).padStart(3)}p  ${localized(item.label)}`,
    );
  }
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
    if (raw === null || field === null)
      fail(`a tuning is written group.field=value: ${assignment}`);
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

/**
 * Hold the queue, and let it go again.
 *
 * Two names rather than `hold on|off`, because these are the two ends of one
 * movement and each is typed in a hurry. Neither touches the line being spoken:
 * that finishes, and nothing is discarded — `interrupt` cuts and `clear` drops.
 */
const hold: Handler = async (client) => {
  show(await client.command(build(pauseCommandSchema, { cmd: 'pause', on: true })));
};

const resume: Handler = async (client) => {
  show(await client.command(build(pauseCommandSchema, { cmd: 'pause', on: false })));
};

/**
 * The measurements over the frame, on every renderer attached.
 *
 * A bare `debug` turns it on, which is the way round it is nearly always
 * wanted — the question arrives, the readout goes up, and `debug off` puts it
 * away. Nothing remembers it, so a renderer that reloads comes back clean.
 */
const debug: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const on = positionals[0] ?? 'on';
  if (on !== 'on' && on !== 'off') fail('debug [on|off]');
  show(await client.command(build(debugCommandSchema, { cmd: 'debug', on: on === 'on' })));
};

const look: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  if (positionals[0] === undefined) fail('look needs an amount in 0..1');
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
    console.log('no vocabulary (no viewer connected)');
    return;
  }
  // First, because the rest of the listing is this avatar's vocabulary and
  // means nothing without knowing which one is loaded.
  console.log(
    `avatar: ${vocabulary.avatar?.label ? localized(vocabulary.avatar.label) : '?'} (${vocabulary.avatar?.id ?? '?'})`,
  );
  // Performances first: a caller reading this to decide what to send should see
  // the composed vocabulary before the parts it is composed from. What each one
  // is made of is printed alongside, so the listing also answers "and what does
  // that do" without a second round trip.
  const performances: Vocabulary['performances'] = vocabulary.performances ?? [];
  console.log(`performances (${performances.length})`);
  for (const item of performances) {
    const parts = [item.gesture, item.hop].filter(Boolean).join(' + ') || 'expression only';
    const held = item.sustain ? ' *' : '';
    console.log(
      `  ${item.id.padEnd(16)} ${localized(item.label).padEnd(12)} [${item.group}] ${parts}${held}`,
    );
  }
  for (const key of ['emotions', 'expressions', 'overlays', 'gestures'] as const) {
    const items = vocabulary[key] ?? [];
    console.log(`${key} (${items.length})`);
    for (const item of items) {
      const extra = 'group' in item ? `  [${item.group}]` : '';
      console.log(`  ${item.id.padEnd(16)} ${localized(item.label)}${extra}`);
    }
  }
  const hops: Vocabulary['hops'] = vocabulary.hops ?? [];
  console.log(`hops: ${hops.map((h) => `${h.id} (${localized(h.label)})`).join(', ')}`);
  const cameras: Vocabulary['cameras'] = vocabulary.cameras ?? [];
  console.log(`cameras: ${cameras.join(', ')}`);
  const rooms: Vocabulary['rooms'] = vocabulary.rooms ?? [];
  console.log(
    `rooms: ${rooms.length === 0 ? '(no audio)' : rooms.map((r) => `${r.id} (${localized(r.label)})`).join(', ')}`,
  );
  const wardrobe: Vocabulary['wardrobe'] = vocabulary.wardrobe ?? {};
  for (const [slot, entry] of Object.entries(wardrobe)) {
    console.log(
      `wear ${slot.padEnd(8)} ${localized(entry.label)}: ${entry.items.map((i) => i.id).join(', ')}`,
    );
  }
};

const state: Handler = async (client) => {
  const snapshot = await client.state();
  if (!snapshot.connected) console.log('no viewer connected');
  show(snapshot.state);
};

/** Follow the event log. Useful to see how turns actually sequence. */
const watch: Handler = async (client) => {
  let since = (await client.state()).seq;
  console.log(`following from seq=${since} (Ctrl-C to stop)`);
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
  deck,
  slide,
  place,
  decks,
  play,
  motions,
  wear,
  avatar,
  tune,
  idle,
  look,
  debug,
  hold,
  resume,
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
      'usage: yarn ctl [--base URL] <command> [args...]',
      `commands: ${Object.keys(HANDLERS).join(', ')}`,
      '',
      '  yarn ctl perform happy',
      '  yarn ctl say "こんばんは" --perform hello --wait',
      '  yarn ctl say "[hello]こんばんは。[explain]今日はこの話をします。"',
      '  yarn ctl say "コメント3件ありがとう" --reading "コメントさんけんありがとう"',
      '  yarn ctl point 40 25 --extent 0.9',
      '  yarn ctl idle on',
      '  yarn ctl debug        # overlay the measurements on every viewer (off clears them)',
      '  yarn ctl avatar manuka',
      '  yarn ctl tune sway.stiffness=2 idle.breathDepth=1.2',
      '  yarn ctl deck intro --page 3',
      '  yarn ctl slide next',
      '  yarn ctl play demo --check   # read show/scripts/demo.yaml without a server',
      '  yarn ctl play demo --replace # drop what is pending and run it',
      '  yarn ctl place avatar --anchor bottom-right --width 0.32 --height 0.6 --margin 0.02',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const { base, rest } = takeBase(process.argv.slice(2));
  const action = rest[0];
  if (action === undefined || !Object.hasOwn(HANDLERS, action)) usage();
  await HANDLERS[action](new ControlClient(base), rest.slice(1));
}

// The message alone, not the class in front of it: a transport failure here is
// something the operator reads and acts on ("start the server"), and prefixing
// it with `Error:` says nothing they did not already know from it being printed.
main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
