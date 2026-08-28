import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type Motion, type MotionsResponse, parseMotion } from '../protocol';

/**
 * The motions on disk, as the control server finds them.
 *
 * One file is one gesture and the filename is its id, exactly as a document's
 * is — see `decks.ts`, which this deliberately resembles. What differs is that
 * nothing is cached: the renderer asks once when it connects, so a scan costs
 * one read of a directory holding a handful of small files, and reading it
 * afresh means editing a motion and reloading the page is the whole loop.
 *
 * A missing directory is no motions. The feature is optional in the strong
 * sense — the gesture table this project ships is complete on its own, and a
 * checkout with nothing in `show/motions/` is the ordinary case.
 */

/** YAML first; JSON parses as YAML, so both come through one path. */
const EXTENSIONS = ['.yaml', '.yml', '.json'];

/** Long enough for a sentence of a filename, short enough not to be an attack. */
const MAX_ID_LENGTH = 64;

/** The separators and the control characters. See `FORBIDDEN_IN_ID` in decks.ts. */
const FORBIDDEN_IN_ID = /[/\\]|\p{Cc}/u;

/**
 * A cap on what will be read, because this reads whole files into memory.
 *
 * A motion is a page of numbers. Anything past this is a file that landed in
 * the wrong directory, and reporting it as too large says so more usefully than
 * a parse error three hundred lines in.
 */
const MAX_BYTES = 256 * 1024;

function isId(raw: string): boolean {
  if (raw.length === 0 || raw.length > MAX_ID_LENGTH) return false;
  if (raw.startsWith('.')) return false;
  return !FORBIDDEN_IN_ID.test(raw);
}

export class Motions {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Every motion in the directory, and every file that would not become one.
   *
   * Sorted by id rather than by modification time, which is the other way round
   * from the document roster. A deck list is a stack an operator is working
   * down and the newest is the one being reached for; motions are a vocabulary,
   * and a vocabulary that reorders itself between two readings is harder to use
   * than one that is simply alphabetical.
   */
  async list(): Promise<MotionsResponse> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    const motions: Motion[] = [];
    const errors: MotionsResponse['errors'] = [];
    for (const name of names) {
      const extension = extname(name).toLowerCase();
      if (!EXTENSIONS.includes(extension)) continue;
      // Composed, for the same reason a document id is: a name with a Japanese
      // character in it is decomposed on this filesystem and composed
      // everywhere else, and the two are one name except in a comparison.
      const id = basename(name, extname(name)).normalize('NFC');
      if (!isId(id)) continue;
      const target = resolve(this.root, name);
      // The listing is the only thing that names a file here, so this cannot be
      // reached by an id from outside. Checked anyway, on the rule the document
      // reader follows: a path guard that is only correct because of who calls
      // it stops being correct the first time somebody else calls it.
      if (!target.startsWith(this.root + sep)) continue;
      const found = await this.read(id, target);
      if ('error' in found) errors.push({ id, error: found.error });
      else motions.push(found.motion);
    }
    motions.sort((a, b) => a.id.localeCompare(b.id));
    errors.sort((a, b) => a.id.localeCompare(b.id));
    return { motions, errors };
  }

  private async read(id: string, path: string): Promise<{ motion: Motion } | { error: string }> {
    let raw: string;
    try {
      const bytes = await readFile(path);
      if (bytes.byteLength > MAX_BYTES) return { error: `larger than ${MAX_BYTES} bytes` };
      raw = bytes.toString('utf8');
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    let value: unknown;
    try {
      value = parseYaml(raw) as unknown;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    return parseMotion(id, value);
  }
}
