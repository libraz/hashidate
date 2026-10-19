import { mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSafeFile } from '@/files';
import { loadScript } from '@/script';
import { Decks } from '@/server/decks';
import { Scripts } from '@/server/scripts';

let root: string;
let scripts: Scripts;

const script = (text: string) => `title: ${text}\nlines: [{ text: ${text} }]\n`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hashidate-logical-ids-'));
  scripts = new Scripts(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('logical file ids with extension-like suffixes', () => {
  it('keeps a dotted logical id distinct from its shorter filename', async () => {
    const singlePath = join(root, 'opening.yaml');
    const doubledPath = join(root, 'opening.yaml.yaml');
    await writeFile(singlePath, script('short opening'));
    await writeFile(doubledPath, script('dotted opening'));

    const listing = await scripts.list();
    expect(listing.errors).toEqual([]);
    expect(listing.scripts.map(({ id }) => id).sort()).toEqual(['opening', 'opening.yaml']);

    const short = await scripts.get('opening');
    const dotted = await scripts.get('opening.yaml');
    expect(short).toMatchObject({ id: 'opening', path: singlePath });
    expect(short?.script.lines[0]?.text).toBe('short opening');
    expect(dotted).toMatchObject({ id: 'opening.yaml', path: doubledPath });
    expect(dotted?.script.lines[0]?.text).toBe('dotted opening');

    const shortCli = await loadScript('opening.yaml', root);
    const dottedCli = await loadScript('opening.yaml.yaml', root);
    expect(shortCli).toMatchObject({ id: 'opening', path: singlePath });
    expect(shortCli.script.lines[0]?.text).toBe('short opening');
    expect(dottedCli).toMatchObject({ id: 'opening.yaml', path: doubledPath });
    expect(dottedCli.script.lines[0]?.text).toBe('dotted opening');
  });

  it.each([
    ['memo.yml.yml', 'memo.yml'],
    ['record.json.json', 'record.json'],
  ])('loads repeated %s suffixes as logical id %s through the CLI loader', async (name, id) => {
    const path = join(root, name);
    await writeFile(path, script('repeated suffix'));

    const listing = await scripts.list();
    expect(listing.errors).toEqual([]);
    expect(listing.scripts.map(({ id: found }) => found)).toContain(id);

    const fromRoster = await scripts.get(id);
    const fromCli = await loadScript(name, root);
    expect(fromRoster).toMatchObject({ id, path });
    expect(fromCli).toMatchObject({ id, path });
    expect(fromCli.script.lines[0]?.text).toBe('repeated suffix');
  });

  it('keeps server and CLI resolution aligned across allowed suffixes', async () => {
    const path = join(root, 'opening.yaml.json');
    await writeFile(path, script('cross suffix'));

    const fromRoster = await scripts.get('opening.yaml');
    const fromCli = await loadScript('opening.yaml.json', root);
    expect(fromRoster).toMatchObject({ id: 'opening.yaml', path });
    expect(fromCli).toMatchObject({ id: 'opening.yaml', path });
    expect(fromCli.script.lines[0]?.text).toBe('cross suffix');
  });

  it('keeps an ordinary explicit CLI filename on its own path and contents', async () => {
    const path = join(root, 'ordinary.yaml');
    await writeFile(path, script('ordinary file'));

    const loaded = await loadScript(path, root);
    expect(loaded).toMatchObject({ id: 'ordinary', path });
    expect(loaded.script.lines[0]?.text).toBe('ordinary file');
  });

  it('resolves a deck id that itself ends in the deck extension', async () => {
    const path = join(root, 'intro.pdf.pdf');
    await writeFile(path, Buffer.from([0x01, 0x02, 0x03]));

    expect(await new Decks(root).file('intro.pdf')).toBe(path);
  });

  it('counts the whole logical id while keeping exact filename stem limits', async () => {
    await writeFile(join(root, 'aaa.yaml.yaml'), 'accepted');
    await writeFile(join(root, 'aaaa.yaml.yaml'), 'too long');
    await writeFile(join(root, '12345678.yaml'), 'exact');

    const logicalOptions = { extensions: ['.yaml'], logical: true, maxIdLength: 8 } as const;
    const accepted = await resolveSafeFile(root, 'aaa.yaml', logicalOptions);
    const tooLong = await resolveSafeFile(root, 'aaaa.yaml', logicalOptions);
    const exact = await resolveSafeFile(root, '12345678.yaml', {
      extensions: ['.yaml'],
      maxIdLength: 8,
    });

    expect(accepted).toMatchObject({ ok: true, path: join(root, 'aaa.yaml.yaml') });
    expect(tooLong).toMatchObject({ ok: false, code: 'invalid' });
    expect(exact).toMatchObject({ ok: true, path: join(root, '12345678.yaml') });
  });

  it('finds a repeated-extension filename by its composed NFC logical id', async () => {
    const id = '台本ダ.yaml';
    const onDisk = `${id.normalize('NFD')}.yaml`;
    const path = join(root, onDisk);
    await writeFile(path, 'decomposed filename');

    const found = await resolveSafeFile(root, id, {
      extensions: ['.yaml'],
      logical: true,
    });

    expect(found).toMatchObject({ ok: true, path });
  });

  it('preserves lexical safety checks for logical requests', async () => {
    const options = { extensions: ['.yaml'], logical: true } as const;
    for (const request of ['.hidden', 'nested/name', 'nested\\name', 'bad\u0000id']) {
      expect(await resolveSafeFile(root, request, options), request).toMatchObject({
        ok: false,
        code: 'invalid',
      });
    }
    expect(await resolveSafeFile(root, 'plain', { logical: true })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });

  it('still refuses doubled-extension symlinks and oversized files', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'hashidate-logical-outside-'));
    try {
      const externalPath = join(outside, 'outside.yaml');
      const linkedPath = join(root, 'linked.yaml.yaml');
      await writeFile(externalPath, 'outside');
      await symlink(externalPath, linkedPath);

      const largePath = join(root, 'large.yaml.yaml');
      await writeFile(largePath, '');
      await truncate(largePath, 5);

      expect(
        await resolveSafeFile(root, 'linked.yaml', {
          extensions: ['.yaml'],
          logical: true,
        }),
      ).toMatchObject({ ok: false, code: 'symlink' });
      expect(
        await resolveSafeFile(root, 'large.yaml', {
          extensions: ['.yaml'],
          logical: true,
          maxBytes: 4,
        }),
      ).toMatchObject({ ok: false, code: 'too-large' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
