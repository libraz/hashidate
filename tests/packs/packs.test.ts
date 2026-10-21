import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAvatar } from '@/protocol';

// Every pack is copied into avatars/ as it stands by `make import`, so a schema
// change that breaks one breaks the import of a model somebody bought.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKS = join(ROOT, 'packs');
const ids = readdirSync(PACKS).filter((name) => statSync(join(PACKS, name)).isDirectory());

describe('packs', () => {
  it('has packs to check', () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  it.each(ids)('%s has a descriptor the runtime accepts', (id) => {
    const result = parseAvatar(
      id,
      JSON.parse(readFileSync(join(PACKS, id, 'avatar.json'), 'utf8')),
    );
    if (!result.ok) throw new Error(result.error);
  });

  it.each(ids)('%s has a pack.json and export.json the importer accepts', (id) => {
    const { status, stderr } = spawnSync(
      'python3',
      [
        '-I',
        '-c',
        'import sys; sys.path.insert(0, sys.argv[1]); import import_pack; import_pack.load_pack(sys.argv[2], sys.argv[3])',
        join(ROOT, 'tools/blender'),
        PACKS,
        id,
      ],
      { encoding: 'utf8' },
    );
    expect(stderr).toBe('');
    expect(status).toBe(0);
  });
});
