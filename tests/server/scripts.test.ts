import { mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScriptError } from '@/script';
import { Scripts } from '@/server/scripts';

const readFileCalls = vi.hoisted(() => [] as unknown[][]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: (...args: Parameters<typeof original.readFile>) => {
      readFileCalls.push(args);
      return original.readFile(...args);
    },
  };
});

/**
 * The script directory, read as the control server reads it.
 *
 * Real files throughout, on the same reasoning as the document and motion
 * readers beside it: what is being tested is that a file an operator saved is
 * found, understood and refused for the right reasons, and a stubbed parser
 * would test the stub.
 */

let root: string;
let scripts: Scripts;

const DEMO = `
title: Opening
note: for the tests
setup:
  - { cmd: camera, frame: bust }
  - { cmd: deck, id: intro }
lines:
  - { text: こんばんは }
  - { text: はじめます, perform: hello }
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hashidate-scripts-'));
  scripts = new Scripts(root);
  readFileCalls.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('Scripts.list', () => {
  it('is empty for a directory that is not there', async () => {
    expect(await new Scripts(join(root, 'nowhere')).list()).toEqual({ scripts: [], errors: [] });
  });

  it('summarises a script without shipping its turns', async () => {
    await writeFile(join(root, 'opening.yaml'), DEMO);
    const { scripts: found, errors } = await scripts.list();
    expect(errors).toEqual([]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 'opening', title: 'Opening', lines: 2, setup: 2 });
    // The lines themselves are not on the roster: a run of turns reaches the
    // runtime by being queued, never by being sent to a picker.
    expect(found[0]).not.toHaveProperty('lines.0');
    expect(Object.keys(found[0]).sort()).toEqual(['at', 'bytes', 'id', 'lines', 'setup', 'title']);
  });

  it('takes .yml and .json as well as .yaml, since JSON parses as YAML', async () => {
    await writeFile(join(root, 'a.yml'), 'lines: [{ text: あ }]');
    await writeFile(join(root, 'b.json'), '{"lines":[{"text":"い"}]}');
    await writeFile(join(root, 'notes.txt'), 'lines: [{ text: う }]');
    const { scripts: found } = await scripts.list();
    expect(found.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('leaves out the title a file does not give, so the id is the name', async () => {
    await writeFile(join(root, 'plain.yaml'), 'lines: [{ text: あ }]');
    const { scripts: found } = await scripts.list();
    expect(found[0]?.title).toBeUndefined();
  });

  it('lists a file that will not parse with its reason rather than dropping it', async () => {
    // A name missing from the list reads as a name typed wrong, which is the one
    // thing it is not: the operator saved this file and needs to see it arrived
    // and is broken.
    await writeFile(join(root, 'broken.yaml'), 'lines: []');
    await writeFile(join(root, 'good.yaml'), 'lines: [{ text: あ }]');
    const { scripts: found, errors } = await scripts.list();
    expect(found.map((s) => s.id)).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.id).toBe('broken');
    expect(errors[0]?.error).toContain('lines');
    // The absolute path is stripped: the row already is the file, and leaving it
    // in would open every error in the panel with a path nobody can read.
    expect(errors[0]?.error).not.toContain(root);
  });

  it('refuses a setup that says a line, which is what `lines` is for', async () => {
    await writeFile(
      join(root, 'wrong.yaml'),
      'setup: [{ cmd: say, text: あ }]\nlines: [{ text: い }]',
    );
    const { errors } = await scripts.list();
    expect(errors[0]?.id).toBe('wrong');
  });

  it('puts the newest first, which is the one about to be reached for', async () => {
    await writeFile(join(root, 'older.yaml'), 'lines: [{ text: あ }]');
    await new Promise((done) => setTimeout(done, 12));
    await writeFile(join(root, 'newer.yaml'), 'lines: [{ text: い }]');
    const { scripts: found } = await scripts.list();
    expect(found.map((s) => s.id)).toEqual(['newer', 'older']);
  });

  it('reads the directory again rather than answering from a scan', async () => {
    await writeFile(join(root, 'a.yaml'), 'lines: [{ text: あ }]');
    expect((await scripts.list()).scripts[0]?.lines).toBe(1);
    await writeFile(join(root, 'a.yaml'), 'lines: [{ text: あ }, { text: い }]');
    expect((await scripts.list()).scripts[0]?.lines).toBe(2);
  });

  it('rejects an oversized file before reading its body', async () => {
    const path = join(root, 'too-large.yaml');
    await writeFile(path, '');
    await truncate(path, 1024 * 1024 + 1);

    const result = await scripts.list();

    expect(result).toEqual({
      scripts: [],
      errors: [{ id: 'too-large', error: 'larger than 1048576 bytes' }],
    });
    expect(readFileCalls.some(([calledPath]) => calledPath === path)).toBe(false);
  });

  it('reports but never reads a symlink to a script outside the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'hashidate-scripts-outside-'));
    try {
      await writeFile(join(outside, 'secret.yaml'), 'lines: [{ text: secret }]');
      await symlink(join(outside, 'secret.yaml'), join(root, 'linked.yaml'));

      const result = await scripts.list();

      expect(result.scripts).toEqual([]);
      expect(result.errors).toEqual([{ id: 'linked', error: 'symbolic links are not allowed' }]);
      expect(readFileCalls.some(([calledPath]) => calledPath === join(root, 'linked.yaml'))).toBe(
        false,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('Scripts.get', () => {
  it('answers the script a roster id names, ready to run', async () => {
    await writeFile(join(root, 'opening.yaml'), DEMO);
    const loaded = await scripts.get('opening');
    expect(loaded?.id).toBe('opening');
    expect(loaded?.script.lines.map((l) => l.text)).toEqual(['こんばんは', 'はじめます']);
    expect(loaded?.script.setup).toHaveLength(2);
  });

  it('answers null for an id no file is behind, which is a stale roster', async () => {
    expect(await scripts.get('missing')).toBeNull();
  });

  it('throws for a file that is there and is not a script', async () => {
    // A different answer from "no such script", and deliberately: the fix is to
    // edit the file rather than to pick another name.
    await writeFile(join(root, 'broken.yaml'), 'lines: []');
    await expect(scripts.get('broken')).rejects.toBeInstanceOf(ScriptError);
  });

  it('refuses an id that could climb out of the directory', async () => {
    await writeFile(join(root, 'opening.yaml'), DEMO);
    for (const id of ['../opening', '..', '.', '', '.hidden', 'a/b']) {
      expect(await scripts.get(id), id).toBeNull();
    }
  });

  it('finds a name that is composed in the id and decomposed on disk', async () => {
    // The filesystem stores this decomposed and every other surface composes it.
    // They are one name except in a string comparison, which is the one place
    // this would notice.
    const onDisk = join(root, '台本ダ.yaml'.normalize('NFD'));
    await writeFile(onDisk, 'lines: [{ text: あ }]');
    const { scripts: found } = await scripts.list();
    expect(found[0]?.id).toBe('台本ダ'.normalize('NFC'));

    const loaded = await scripts.get('台本ダ'.normalize('NFC'));
    expect(loaded).not.toBeNull();
    // The path is asserted rather than only the lookup succeeding, because the
    // two come apart per platform: a lookup on macOS ignores the normalisation
    // form, so a path composed back out of the id opens there and opens nothing
    // on Linux. Pinning the name the directory actually holds is what fails on
    // both when this regresses.
    expect(loaded?.path).toBe(onDisk);
  });

  it('rejects an oversized file before reading its body', async () => {
    const path = join(root, 'too-large.yaml');
    await writeFile(path, '');
    await truncate(path, 1024 * 1024 + 1);

    await expect(scripts.get('too-large')).rejects.toThrow(`${path}: larger than 1048576 bytes`);
    expect(readFileCalls.some(([calledPath]) => calledPath === path)).toBe(false);
  });
});
