import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isBuiltInGestureName } from '../engine/motion';
import { listSafeIds, readSafeFile } from '../files';
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

/**
 * A cap on what will be read, because this reads whole files into memory.
 *
 * A motion is a page of numbers. Anything past this is a file that landed in
 * the wrong directory, and reporting it as too large says so more usefully than
 * a parse error three hundred lines in.
 */
const MAX_BYTES = 256 * 1024;

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
    const listed = await listSafeIds(this.root, {
      extensions: EXTENSIONS,
      maxIdLength: MAX_ID_LENGTH,
      noun: 'motion',
    });
    const motions: Motion[] = [];
    const errors: MotionsResponse['errors'] = [...listed.errors];
    for (const { id, file } of listed.entries) {
      if (isBuiltInGestureName(id)) {
        errors.push({ id, error: 'reserved built-in gesture name' });
        continue;
      }
      const found = await this.read(id, file);
      if ('error' in found) errors.push({ id, error: found.error });
      else motions.push(found.motion);
    }
    errors.sort((a, b) => a.id.localeCompare(b.id));
    return { motions, errors };
  }

  private async read(id: string, name: string): Promise<{ motion: Motion } | { error: string }> {
    const bytes = await readSafeFile(this.root, name, {
      extensions: EXTENSIONS,
      maxBytes: MAX_BYTES,
      maxIdLength: MAX_ID_LENGTH,
    });
    if (!bytes.ok) return { error: bytes.error };
    const raw = bytes.bytes.toString('utf8');
    let value: unknown;
    try {
      value = parseYaml(raw) as unknown;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    return parseMotion(id, value);
  }
}
