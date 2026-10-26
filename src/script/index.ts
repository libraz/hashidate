import { extname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { parseLine } from '../engine/cues';
import { readExactFile, readSafeFile } from '../files';
import {
  type Command,
  commandSchema,
  type InlineCueAction,
  RUN_VERBS,
  type TurnRequest,
  turnSchema,
} from '../protocol';

/**
 * A script: a run of turns, written out in advance.
 *
 * ## Why this exists at all, given what this runtime is not
 *
 * Nothing here decides what to say. A script is somebody having already decided
 * — a demo, a rehearsal, an opening segment that is the same every week — and
 * the alternative to a file was a shell script full of `yarn ctl say`, which
 * cannot express a turn's staging and reorders itself the moment anybody edits
 * it. So this is a way to *write down* turns, not a way to generate them, and
 * that is the whole of the difference.
 *
 * ## It invents no vocabulary
 *
 * A line is a `TurnRequest` — literally the payload of `say`, schema and all.
 * A setup entry is a `Command`, spelled exactly as it goes on the wire. Neither
 * is re-described here, and that is deliberate: a script format with its own
 * words for a camera framing would be a second dialect for the three processes
 * to drift across, which is the failure `src/protocol` exists to prevent.
 *
 * The cost is that `setup` reads as a list of `cmd:` objects rather than as
 * prose. That is the right trade — the file says what will actually be sent.
 *
 * ## Two halves, because they have two lifetimes
 *
 * `setup` is applied once, before anything is said: which avatar, what it is
 * wearing, where the picture sits in the frame. `lines` are the turns, and each
 * carries its own `stage` for the shot it is delivered in. The split is the one
 * the command set already makes between what outlives a turn and what is
 * released with it — see `sayCommandSchema.stage`.
 *
 * A line's `stage` is also why a whole script can be handed over at once
 * instead of a line at a time: the staging travels with the run, so the queue
 * stays deep enough to prepare the next line's audio while the current one is
 * being said.
 */

/** Where a script goes when it is not given as a path. */
export const SCRIPTS_DIR = 'show/scripts';

/** YAML first; JSON is YAML, so both come through one parser. */
const EXTENSIONS = ['.yaml', '.yml', '.json'];
const MAX_BYTES = 1024 * 1024;

/**
 * Setup and teardown refuse the run verbs (`RUN_VERBS`): a `say` in setup is a
 * line outside the list, a `clear` in teardown deletes whatever was queued after
 * the script. Stated as a refusal rather than a narrower union, so a command
 * added to the wire is available here the day it exists.
 */
export const setupCommandSchema = commandSchema.refine((command) => !RUN_VERBS.has(command.cmd), {
  error: 'setup takes the state a script assumes, not its lines — put those under `lines`',
});

export const teardownCommandSchema = commandSchema.refine(
  (command) => !RUN_VERBS.has(command.cmd),
  { error: 'teardown takes the state a script leaves behind, not more lines' },
);

export const scriptSchema = z.object({
  /**
   * What the script is, for whoever opens the file and for `--check`.
   *
   * A plain string and not a `Localized`, unlike the labels in the engine: a
   * script is written in one language because its lines are, and a title that
   * had to be given in two would be answered by translating a Japanese segment
   * name into English for nobody to read.
   */
  title: z.string().optional(),
  /** The author's own notes. Never sent, never spoken. */
  note: z.string().optional(),
  setup: z.array(setupCommandSchema).optional(),
  lines: z.array(turnSchema).min(1),
  /**
   * Applied by the server once the last line has been said and nothing else is
   * waiting — typically `idle on`, undoing the setup that switched it off.
   */
  teardown: z.array(teardownCommandSchema).optional(),
});

export type Script = z.infer<typeof scriptSchema>;

/** A script, with where it came from — which is what a failure has to name. */
export interface LoadedScript {
  /** The filename without its extension, used to stamp the queue entries. */
  id: string;
  path: string;
  script: Script;
}

/** A script that could not be read, parsed or validated. Carries the path. */
export class ScriptError extends Error {}

/**
 * The paths a name could mean, in the order they are tried.
 *
 * A name is looked for in `show/scripts/`, which is what makes `play demo` work
 * from anywhere in the tree — and it is a name whether or not it carries an
 * extension, on the same rule `deck` follows. What separates the two cases is a
 * separator: anything with one, or an absolute path, is read exactly where it
 * says. There is no fallback between them. An operator who typed a path meant a
 * path, and quietly looking somewhere else for it is how a run ends up being a
 * different script from the one on screen.
 *
 * So a script in the working directory is `./opening.yaml`, spelled out.
 */
export function scriptCandidates(nameOrPath: string, dir = SCRIPTS_DIR): string[] {
  if (isAbsolute(nameOrPath) || nameOrPath.includes('/')) return [resolve(nameOrPath)];
  if (EXTENSIONS.includes(extname(nameOrPath).toLowerCase())) return [resolve(dir, nameOrPath)];
  return EXTENSIONS.map((extension) => resolve(dir, `${nameOrPath}${extension}`));
}

/**
 * Read one script, or say why it is not one.
 *
 * Validated here rather than at the moment each line is sent. A script is run
 * against a live stream, and a run that stops halfway because line nine names a
 * camera framing that does not exist has already put eight lines on air.
 */
export async function loadScript(nameOrPath: string, dir = SCRIPTS_DIR): Promise<LoadedScript> {
  const candidates = scriptCandidates(nameOrPath, dir);
  const explicit = isAbsolute(nameOrPath) || nameOrPath.includes('/');
  const extension = extname(nameOrPath).toLowerCase();
  const loaded = explicit
    ? await readExactFile(candidates[0], { extensions: EXTENSIONS, maxBytes: MAX_BYTES })
    : EXTENSIONS.includes(extension)
      ? await readSafeFile(resolve(dir), nameOrPath.slice(0, -extension.length), {
          extensions: [extension],
          logical: true,
          maxBytes: MAX_BYTES,
        })
      : await readSafeFile(resolve(dir), nameOrPath, {
          extensions: EXTENSIONS,
          logical: true,
          maxBytes: MAX_BYTES,
        });
  if (loaded.ok) {
    return {
      id: scriptId(loaded.path),
      path: loaded.path,
      script: parseScript(loaded.path, loaded.bytes.toString('utf8')),
    };
  }
  if (loaded.code !== 'missing') {
    throw new ScriptError(`${candidates[0]}: ${loaded.error}`);
  }
  throw new ScriptError(
    candidates.length === 1
      ? `no script at ${candidates[0]}`
      : `no script called ${nameOrPath} in ${resolve(dir)}`,
  );
}

function scriptId(path: string): string {
  const name = path.split('/').pop() ?? path;
  const extension = extname(name);
  return (extension ? name.slice(0, -extension.length) : name).normalize('NFC');
}

/** An issue path with array positions counted from 1, as `outline` numbers lines. */
function where(path: ReadonlyArray<PropertyKey>): string {
  return path.map((key) => (typeof key === 'number' ? key + 1 : String(key))).join('.') || 'script';
}

/** Parse and validate the text of a script. Separate so a test needs no file. */
export function parseScript(path: string, raw: string): Script {
  let value: unknown;
  try {
    value = parseYaml(raw) as unknown;
  } catch (error) {
    throw new ScriptError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = scriptSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `\n  ${where(issue.path)}: ${issue.message}`)
      .join('');
    throw new ScriptError(`${path} is not a script:${detail}`);
  }
  return parsed.data;
}

/**
 * A one-line-per-turn summary, for `--check` and for a listing.
 *
 * What it prints is what would actually be sent: the words with their cue
 * markup still in them, and beside each the performance and the staging that
 * travel with it. A summary that showed the line as it would be *heard* would
 * be hiding exactly the part a script gets wrong.
 */
export function outline(script: Script): string[] {
  return script.lines.map((line, i) => {
    const parts = [`${String(i + 1).padStart(3)}  ${describe(line)}`];
    const marks = [
      line.perform && `perform ${line.perform}`,
      line.gesture && `gesture ${line.gesture}`,
      line.side && `side ${line.side}`,
      line.expression && `expression ${line.expression}`,
      line.emotion && `emotion ${Object.keys(line.emotion).join('+')}`,
      line.stage &&
        `stage ${Object.entries(line.stage)
          .map(([key, value]) => `${key}=${axis(value)}`)
          .join(' ')}`,
    ].filter(Boolean);
    if (marks.length > 0) parts.push(`      ${marks.join('  ')}`);
    return parts.join('\n');
  });
}

/**
 * One staging axis as a word.
 *
 * Four of the five are scalars and print themselves; `place` is two nested
 * partials and would come out as `[object Object]`, which is worse than not
 * printing it at all — the outline exists to be read against the file.
 */
function axis(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

/** The line itself, or what it is if it has no words. */
function describe(line: TurnRequest): string {
  if (line.text === undefined || line.text === '') return '(no line)';
  return line.text;
}

type Stage = NonNullable<TurnRequest['stage']>;

/** Where a page of a document starts being talked about. See `pageStarts`. */
export interface ScriptPage {
  /** The line, 0 based, during which the page goes up. */
  line: number;
  deck: string;
  page: number;
}

/**
 * The staging a script has reached, and which of it its lines set.
 *
 * Setup is replayed by every run, so only what the lines set is worth carrying
 * into a run that starts part-way: a document setup opened, named again, would
 * be opened again, and the layer is empty while it loads.
 */
interface Reached {
  deck: string | null;
  page: number;
  /** The axes the lines have set, folded in order. `slide` is kept in `page`. */
  lines: Stage;
  /** What the lines' BGM cues have done to the music, folded in order. */
  bgm: ReachedBgm;
}

/**
 * The music as the BGM cues of the lines walked so far left it: the last
 * transport verb, and every setting a `set` or a named `play` changed. The
 * playback position is not part of it — how far a track has run depends on how
 * long the skipped lines took to say, which a script cannot know.
 */
interface ReachedBgm {
  action?: 'play' | 'pause' | 'stop';
  settings: Record<string, unknown>;
}

/** A settings patch folded into what came before it, nested objects field by field. */
function foldSettings(base: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const current = base[key];
    if (isPlainObject(value) && isPlainObject(current)) foldSettings(current, value);
    else base[key] = isPlainObject(value) ? structuredClone(value) : value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function foldBgm(bgm: ReachedBgm, cue: Extract<InlineCueAction, { kind: 'bgm' }>): void {
  if (cue.action === 'set') {
    const { action, ...settings } = cue.settings;
    if (action !== undefined) bgm.action = action;
    foldSettings(bgm.settings, settings);
    return;
  }
  bgm.action = cue.action;
  if (cue.action === 'play' && cue.track !== undefined) bgm.settings.track = cue.track;
}

/** One cue that puts the music where the skipped lines left it, or null if they never touched it. */
function bgmCue(bgm: ReachedBgm): string | null {
  if (bgm.action === undefined && Object.keys(bgm.settings).length === 0) return null;
  const settings = { ...(bgm.action === undefined ? {} : { action: bgm.action }), ...bgm.settings };
  return `[@bgm set ${JSON.stringify(settings)}]`;
}

/** Two halves of a layout folded field by field, as `Standing` folds `place`. */
function foldPlace(base: Stage['place'], next: Stage['place']): Stage['place'] {
  if (next === undefined) return base;
  return {
    ...base,
    ...(next.avatar === undefined ? {} : { avatar: { ...base?.avatar, ...next.avatar } }),
    ...(next.slide === undefined ? {} : { slide: { ...base?.slide, ...next.slide } }),
  };
}

function afterSetup(setup: readonly Command[] | undefined): Reached {
  const at: Reached = { deck: null, page: 1, lines: {}, bgm: { settings: {} } };
  for (const command of setup ?? []) {
    if (command.cmd === 'deck') {
      at.deck = command.id ?? null;
      at.page = command.page ?? 1;
    } else if (command.cmd === 'slide' && command.page !== undefined) {
      at.page = command.page;
    }
  }
  return at;
}

function applyStage(at: Reached, stage: Stage | undefined): void {
  if (stage === undefined) return;
  const { slide, place, ...axes } = stage;
  Object.assign(at.lines, axes);
  at.lines.place = foldPlace(at.lines.place, place);
  if (at.lines.place === undefined) delete at.lines.place;
  // A document named on a line opens at the page given, or at its first.
  if (stage.deck !== undefined) {
    at.deck = stage.deck;
    at.page = slide ?? 1;
  } else if (slide !== undefined) {
    at.page = slide;
  }
}

/**
 * Walk a script line by line. `visit` is given each line with the staging it
 * starts on and the staging it reaches, and again for every page a cue in it
 * turns to; returning true stops the walk.
 */
function walk(
  script: Script,
  visit: (line: number, before: Readonly<Reached>, now: Readonly<Reached>) => boolean,
): void {
  const at = afterSetup(script.setup);
  for (const [index, line] of script.lines.entries()) {
    const before: Reached = {
      ...at,
      lines: { ...at.lines },
      bgm: { ...at.bgm, settings: structuredClone(at.bgm.settings) },
    };
    applyStage(at, line.stage);
    if (visit(index, before, at)) return;
    // A cue turns the page or moves the camera part-way through the line, and
    // what it leaves is what the next line starts on.
    for (const cue of parseLine(line.text ?? '').cues) {
      if (cue.action?.kind === 'slide') {
        at.page = cue.action.page;
        if (visit(index, before, at)) return;
      } else if (cue.action?.kind === 'camera') {
        at.lines.camera = cue.action.frame;
      } else if (cue.action?.kind === 'place') {
        at.lines.place = foldPlace(at.lines.place, cue.action.place);
      } else if (cue.action?.kind === 'bgm') {
        foldBgm(at.bgm, cue.action);
      }
    }
  }
}

/**
 * Every place a page of a document goes up, in the order they are reached.
 *
 * A page a line names in its `stage` starts at that line; one an inline cue
 * turns to starts at the line the cue is in. Lines with no document up are not
 * a page of anything and are left out.
 */
export function pageStarts(script: Script): ScriptPage[] {
  const found: ScriptPage[] = [];
  let shown: { deck: string | null; page: number } = { deck: null, page: 0 };
  walk(script, (line, _before, now) => {
    if (now.deck !== null && (now.deck !== shown.deck || now.page !== shown.page)) {
      found.push({ line, deck: now.deck, page: now.page });
    }
    shown = { deck: now.deck, page: now.page };
    return false;
  });
  return found;
}

/**
 * The lines from `from` to the end, staged as they would be had the run begun
 * at the top.
 *
 * What the earlier lines set is folded into the first one, under its own
 * stage, and the page it starts on is stated outright. Moods are not carried:
 * they are a line's performance rather than the shot, and a line names its own.
 * The music is carried as one `[@bgm set]` cue at the very front of the first
 * line — the only place a cue may go on a line with a reading — so a run that
 * starts after the line that began the music still has it; the track starts
 * from its beginning, since where it would have reached is not knowable here.
 */
export function linesFrom(script: Script, from: number): TurnRequest[] {
  const [first, ...after] = script.lines.slice(from);
  if (first === undefined) return [];
  let reached: Reached | null = null;
  walk(script, (line, before) => {
    if (line !== from) return false;
    reached = { ...before, lines: { ...before.lines } };
    return true;
  });
  const start = reached as Reached | null;
  if (start === null) return [first, ...after];
  const music = bgmCue(start.bgm);

  const own = first.stage ?? {};
  const stage: Stage = { ...start.lines };
  // The page is stated unless this line opens a document of its own, which
  // starts at the page it names or at its first.
  if (start.deck !== null && own.deck === undefined) stage.slide = start.page;
  const place = foldPlace(stage.place, own.place);
  const { place: _ownPlace, ...ownAxes } = own;
  Object.assign(stage, ownAxes);
  if (place !== undefined) stage.place = place;
  const text = music === null ? {} : { text: `${music}${first.text ?? ''}` };
  return [{ ...first, ...text, stage }, ...after];
}
