import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type Command, commandSchema, type TurnRequest, turnSchema } from '../protocol';

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

/**
 * The verbs that may not appear in `setup`.
 *
 * All four are about the run itself rather than about the state it assumes, and
 * every one of them would race the queue this script is about to fill: a `say`
 * in setup is a line delivered ahead of line one and outside the list, and a
 * `clear` is the script deleting the lines that were queued before it.
 *
 * Stated as a refusal rather than by building a narrower union, so that a
 * command added to the wire is available here the day it exists and nobody has
 * to remember this file.
 */
const RUN_VERBS = new Set<Command['cmd']>(['say', 'queue', 'interrupt', 'clear']);

export const setupCommandSchema = commandSchema.refine((command) => !RUN_VERBS.has(command.cmd), {
  error: 'setup takes the state a script assumes, not its lines — put those under `lines`',
});

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
  for (const path of candidates) {
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (raw === null) continue;
    return { id: scriptId(path), path, script: parseScript(path, raw) };
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
      .map((issue) => `\n  ${issue.path.map(String).join('.') || 'script'}: ${issue.message}`)
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
