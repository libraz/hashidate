import { basename, extname, resolve } from 'node:path';
import { readSafeDirectory, readSafePath, resolveSafeFile } from '../files';
import type { ScriptSummary, ScriptsResponse } from '../protocol';
import { type LoadedScript, parseScript, ScriptError } from '../script';

/**
 * The scripts on disk, as the control server finds them.
 *
 * One file is one run of turns and the filename is its id, exactly as a
 * document's and a motion's are — see `decks.ts` and `motions.ts`, which this
 * deliberately resembles. What it adds to those two is that a script can be
 * *run*, and running one is the only thing anybody does with it: the turns
 * never travel as data, they are added to the queue, which is where they were
 * always going to end up.
 *
 * ## The parser is the script module's, not a copy of it
 *
 * `parseScript` is imported rather than reimplemented, which is the same rule
 * that keeps a script from inventing a vocabulary in the first place: a line is
 * a `TurnRequest` and a setup entry is a `Command`, and a second reader here
 * would be a second opinion about what those are. A file that the CLI refuses
 * is a file this refuses, with the same message.
 *
 * ## Nothing is cached
 *
 * The roster is read afresh, as the motion roster is. A script is edited in a
 * text editor beside the panel and re-run a moment later, and the whole loop is
 * "save, press the chip again" — a cache would put a stale run of turns on air
 * and give the operator no way to tell.
 *
 * A missing directory is no scripts. The feature is optional in the same sense
 * the others are.
 */

/** YAML first; JSON parses as YAML, so both come through one path. */
const EXTENSIONS = ['.yaml', '.yml', '.json'];

/** Long enough for a sentence of a filename, short enough not to be an attack. */
const MAX_ID_LENGTH = 128;

/** The separators and the control characters. See `FORBIDDEN_IN_ID` in decks.ts. */
const FORBIDDEN_IN_ID = /[/\\]|\p{Cc}/u;

/**
 * A cap on what will be read, because this reads whole files into memory.
 *
 * A script is a page or two of dialogue. Anything past this is a file that
 * landed in the wrong directory, and reporting it as too large says so more
 * usefully than a parse error four thousand lines in.
 */
const MAX_BYTES = 1024 * 1024;

function isId(raw: string): boolean {
  if (raw.length === 0 || raw.length > MAX_ID_LENGTH) return false;
  if (raw.startsWith('.')) return false;
  return !FORBIDDEN_IN_ID.test(raw);
}

export class Scripts {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Where the files are, for a launcher that opens the directory. */
  get directory(): string {
    return this.root;
  }

  /**
   * Every script in the directory, and every file that would not become one.
   *
   * Newest first, which is the document roster's order rather than the motion
   * roster's, because a script is the same kind of thing a document is: the one
   * an operator is about to reach for is almost always the one they just
   * finished writing. Ties fall back to the id so two files saved in the same
   * millisecond do not swap places between polls.
   */
  async list(): Promise<ScriptsResponse> {
    const names = (await readSafeDirectory(this.root)) ?? [];
    const scripts: ScriptSummary[] = [];
    const errors: ScriptsResponse['errors'] = [];
    const candidates = new Map<string, string[]>();
    for (const name of names) {
      if (!EXTENSIONS.includes(extname(name).toLowerCase())) continue;
      // Composed, for the same reason a document id is: a name with a Japanese
      // character in it is decomposed on this filesystem and composed
      // everywhere else, and the two are one name except in a comparison.
      const id = basename(name, extname(name)).normalize('NFC');
      if (!isId(id)) continue;
      candidates.set(id, [...(candidates.get(id) ?? []), name]);
    }
    for (const [id, matching] of candidates) {
      if (matching.length > 1) {
        errors.push({
          id,
          error: `ambiguous normalization-equivalent files: ${matching.join(', ')}`,
        });
        continue;
      }
      const target = resolve(this.root, matching[0]);
      const found = await this.summarise(id, target);
      if ('error' in found) errors.push({ id, error: found.error });
      else scripts.push(found.script);
    }
    scripts.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    errors.sort((a, b) => a.id.localeCompare(b.id));
    return { scripts, errors };
  }

  /**
   * One script, ready to run, or null for an id that names no file.
   *
   * Throws `ScriptError` for a file that is there and is not a script. The two
   * are different answers to different questions — "no such script" is a stale
   * roster and "this will not parse" is a file to go and fix — and a caller
   * that had to tell them apart from one null could not.
   */
  async get(id: string): Promise<LoadedScript | null> {
    if (!isId(id)) return null;
    const name = id.normalize('NFC');
    const target = await this.locate(id);
    if (!target.ok) {
      if (target.code === 'missing') return null;
      const expected = resolve(this.root, `${name}${EXTENSIONS[0]}`);
      throw new ScriptError(`${expected}: ${target.error}`);
    }
    const raw = await this.read(target.path);
    if (raw === null) return null;
    if ('error' in raw) throw new ScriptError(`${target.path}: ${raw.error}`);
    return { id: name, path: target.path, script: parseScript(target.path, raw.value) };
  }

  /**
   * The file a composed id names, in whichever form the directory holds it.
   *
   * `list` composes every id on the way out, and a filename with a Japanese
   * character in it is decomposed on the filesystem it was typed on. Spelling
   * the path back out as `<root>/<id><extension>` therefore asks for a name the
   * directory may not hold — and macOS hides that, because a lookup there
   * ignores which normalisation form the name is in. On Linux it finds nothing,
   * so the script that the panel is listing is the script that refuses to run.
   *
   * Matching against the listing is the only lookup that agrees with the roster
   * on both. `EXTENSIONS` stays the outer loop so a directory holding two
   * spellings of one name resolves in the same order it did when the path was
   * built by hand.
   */
  private async locate(name: string) {
    return resolveSafeFile(this.root, name, {
      extensions: EXTENSIONS,
      logical: true,
      maxBytes: MAX_BYTES,
      maxIdLength: MAX_ID_LENGTH,
    });
  }

  private async summarise(
    id: string,
    path: string,
  ): Promise<{ script: ScriptSummary } | { error: string }> {
    const raw = await this.read(path);
    if (raw === null) return { error: 'could not be read' };
    if ('error' in raw) return { error: raw.error };
    const info = raw.info;
    try {
      const script = parseScript(path, raw.value);
      return {
        script: {
          id,
          ...(script.title === undefined ? {} : { title: script.title }),
          lines: script.lines.length,
          setup: script.setup?.length ?? 0,
          bytes: info.size,
          at: info.mtimeMs / 1000,
        },
      };
    } catch (error) {
      // The path is stripped back off: `parseScript` puts it in front of every
      // message so the CLI can say which file, and here the row already is the
      // file. Left in, every error in the panel would open with an absolute
      // path nobody can read at that width.
      const message = error instanceof ScriptError ? error.message : String(error);
      return {
        error: message.startsWith(`${path}`) ? message.slice(path.length + 1).trim() : message,
      };
    }
  }

  /** The text, `null` for a file that is not there, or why it was refused. */
  private async read(
    path: string,
  ): Promise<{ value: string; info: import('node:fs').Stats } | { error: string } | null> {
    const result = await readSafePath(this.root, path, {
      extensions: EXTENSIONS,
      maxBytes: MAX_BYTES,
    });
    if (!result.ok) {
      if (result.code === 'missing') return null;
      return { error: result.error };
    }
    return { value: result.bytes.toString('utf8'), info: result.info };
  }
}
