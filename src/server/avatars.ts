import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { listSafeIds, readSafeFile } from '../files';
import { type AvatarsWire, parseAvatar } from '../protocol';

/**
 * The avatar descriptors on disk, as the control server finds them.
 *
 * One file is one avatar and the filename is its id. The server validates each
 * file and answers with the raw object, `id` injected; the renderer parses it
 * again, because a RegExp cannot cross JSON. Nothing is cached, so editing a
 * descriptor and reloading the page is the whole loop. A missing directory is
 * no avatars, and `export/` beside the files is a directory with no extension,
 * which the listing skips.
 */

/** JSON first; both come through `parseYaml`, as motions do. */
const EXTENSIONS = ['.json', '.yaml', '.yml'];

const MAX_ID_LENGTH = 64;

/** A descriptor is a page of settings; anything past this is in the wrong directory. */
const MAX_BYTES = 256 * 1024;

export class Avatars {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Every avatar that parsed, and every file that would not become one, sorted by id. */
  async list(): Promise<AvatarsWire> {
    const listed = await listSafeIds(this.root, {
      extensions: EXTENSIONS,
      maxIdLength: MAX_ID_LENGTH,
      noun: 'avatar',
    });
    const avatars: object[] = [];
    const errors = [...listed.errors];
    for (const { id, file } of listed.entries) {
      const found = await this.read(id, file);
      if ('error' in found) errors.push({ id, error: found.error });
      else avatars.push({ id, ...found.value });
    }
    errors.sort((a, b) => a.id.localeCompare(b.id));
    return { avatars, errors };
  }

  private async read(id: string, file: string): Promise<{ value: object } | { error: string }> {
    const bytes = await readSafeFile(this.root, file, {
      extensions: EXTENSIONS,
      maxBytes: MAX_BYTES,
      maxIdLength: MAX_ID_LENGTH,
    });
    if (!bytes.ok) return { error: bytes.error };
    let value: unknown;
    try {
      value = parseYaml(bytes.bytes.toString('utf8')) as unknown;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { error: 'avatar: not an object' };
    }
    const parsed = parseAvatar(id, value);
    return parsed.ok ? { value } : { error: parsed.error };
  }
}
