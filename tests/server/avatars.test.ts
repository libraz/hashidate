import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Avatars } from '@/server/avatars';

/**
 * The avatar directory, read as the control server reads it. Real files
 * throughout: what is under test is that something an operator saved is found,
 * judged and reported, and a stubbed parser would test the stub.
 */

const GOOD = { label: { en: 'Example', ja: '例' }, url: '/models/example.glb' };

let root: string;
let avatars: Avatars;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hashidate-avatars-'));
  avatars = new Avatars(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const put = (name: string, body: unknown) =>
  writeFile(join(root, name), typeof body === 'string' ? body : JSON.stringify(body));

describe('Avatars', () => {
  it('is empty for a directory that is not there', async () => {
    expect(await new Avatars(join(root, 'nowhere')).list()).toEqual({ avatars: [], errors: [] });
  });

  it('is empty for an empty directory', async () => {
    expect(await avatars.list()).toEqual({ avatars: [], errors: [] });
  });

  it('serves the raw object with the filename as its id', async () => {
    await put('example.json', GOOD);
    expect(await avatars.list()).toEqual({ avatars: [{ id: 'example', ...GOOD }], errors: [] });
  });

  it('accepts yaml and yml beside json', async () => {
    await put('a.yaml', 'label: { en: A, ja: あ }\n');
    await put('b.yml', 'label: { en: B, ja: び }\n');
    await put('c.json', GOOD);
    const listed = await avatars.list();
    expect(listed.avatars.map((entry) => (entry as { id: string }).id)).toEqual(['a', 'b', 'c']);
    expect(listed.errors).toEqual([]);
  });

  it('lists in id order and ignores other extensions', async () => {
    await put('b.json', GOOD);
    await put('a.json', GOOD);
    await put('notes.txt', 'hello');
    const listed = await avatars.list();
    expect(listed.avatars.map((entry) => (entry as { id: string }).id)).toEqual(['a', 'b']);
    expect(listed.errors).toEqual([]);
  });

  it('reports an unparsable file without dropping a good one', async () => {
    await put('good.json', GOOD);
    await put('broken.json', '{ "label": ');
    const listed = await avatars.list();
    expect(listed.avatars).toHaveLength(1);
    expect(listed.errors).toHaveLength(1);
    expect(listed.errors[0].id).toBe('broken');
    expect(listed.errors[0].error.length).toBeGreaterThan(0);
  });

  it('reports a descriptor the schema rejects, naming the path', async () => {
    await put('good.json', GOOD);
    await put('typo.json', { ...GOOD, lable: 1 });
    const listed = await avatars.list();
    expect(listed.avatars).toHaveLength(1);
    expect(listed.errors).toEqual([{ id: 'typo', error: expect.stringContaining('lable') }]);
  });

  it.each([['[]'], ['null'], ['3'], ['"x"']])('rejects a top level of %s', async (text) => {
    await put('odd.json', text);
    const listed = await avatars.list();
    expect(listed.avatars).toEqual([]);
    expect(listed.errors).toEqual([{ id: 'odd', error: 'avatar: not an object' }]);
  });

  it('reports a file over the size cap', async () => {
    await put('big.json', JSON.stringify({ ...GOOD, pad: 'x'.repeat(300 * 1024) }));
    const listed = await avatars.list();
    expect(listed.avatars).toEqual([]);
    expect(listed.errors).toEqual([{ id: 'big', error: expect.stringContaining('larger than') }]);
  });

  it('reports two names that compose to one id instead of choosing', async () => {
    const composed = 'é';
    const decomposed = 'é';
    await put(`${composed}.json`, GOOD);
    await put(`${decomposed}.yaml`, 'label: { en: E, ja: え }\n');
    const listed = await avatars.list();
    // Some filesystems fold the two names into one; only assert when they did not.
    if (listed.errors.length === 0) return;
    expect(listed.avatars).toEqual([]);
    expect(listed.errors).toEqual([{ id: composed, error: expect.stringContaining('ambiguous') }]);
  });

  it('reports a directory named like a descriptor as not a regular file', async () => {
    await put('good.json', GOOD);
    await mkdir(join(root, 'x.json'));
    const listed = await avatars.list();
    expect(listed.avatars).toHaveLength(1);
    expect(listed.errors).toEqual([{ id: 'x', error: 'not a regular file' }]);
  });

  it('skips the export directory beside the descriptors', async () => {
    await mkdir(join(root, 'export'));
    await writeFile(join(root, 'export', 'example.json'), '{}');
    await put('example.json', GOOD);
    const listed = await avatars.list();
    expect(listed.avatars).toHaveLength(1);
    expect(listed.errors).toEqual([]);
  });

  it('reports a name too long to be an id', async () => {
    const name = `${'a'.repeat(65)}.json`;
    await put(name, GOOD);
    const listed = await avatars.list();
    expect(listed.errors).toEqual([
      {
        id: name,
        error: 'not a usable avatar id (at most 64 characters, no control characters)',
      },
    ]);
  });

  it('reads fresh on every call', async () => {
    expect((await avatars.list()).avatars).toEqual([]);
    await put('late.json', GOOD);
    expect((await avatars.list()).avatars).toHaveLength(1);
  });
});
