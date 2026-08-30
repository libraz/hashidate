import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadScript, outline, parseScript, ScriptError, scriptCandidates } from '@/script';

/**
 * Scripts, as the CLI reads them.
 *
 * What is worth testing here is not YAML — that is somebody else's library —
 * but the two promises this format makes. A line is a turn and nothing else, so
 * anything the wire would refuse is refused here rather than halfway through a
 * run; and `setup` holds the state a script assumes, so a verb that belongs to
 * the run itself cannot hide in it.
 *
 * `demo.yaml` is read from the repository rather than assembled. It is the one
 * script this project ships, it is the first thing anybody runs, and a
 * validation that skipped it would let it rot without anything saying so.
 */

const script = (body: string) => parseScript('test.yaml', body);

describe('parseScript', () => {
  it('reads a line as a turn, cues and staging included', () => {
    const parsed = script(`
lines:
  - text: "[hello]こんばんは。"
    perform: hello
    stage: { camera: bust, room: hall }
`);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0].text).toBe('[hello]こんばんは。');
    expect(parsed.lines[0].stage).toEqual({ camera: 'bust', room: 'hall' });
  });

  it('reads the hand a line names, and refuses one that is not a hand', () => {
    const parsed = script('lines:\n  - { text: "ピース。", gesture: peace, side: L }');
    expect(parsed.lines[0].side).toBe('L');
    expect(() => script('lines:\n  - { text: "x", gesture: peace, side: left }')).toThrow(
      ScriptError,
    );
  });

  it('shows the hand in the outline, since that is what --check is read against', () => {
    const parsed = script('lines:\n  - { text: "ピース。", gesture: peace, side: L }');
    expect(outline(parsed).join('\n')).toContain('side L');
  });

  it('refuses a line whose cue markup does not close', () => {
    expect(() => script('lines:\n  - text: "[hello こんばんは"')).toThrow(ScriptError);
  });

  it('refuses a camera framing that is not one', () => {
    expect(() => script('lines:\n  - { text: "x", stage: { camera: wide } }')).toThrow(ScriptError);
  });

  it('refuses a reading with cue markup in it', () => {
    expect(() => script('lines:\n  - { text: "x", reading: "[hello]えっくす" }')).toThrow(
      ScriptError,
    );
  });

  it('refuses an empty reading on the same path used by play --check', () => {
    expect(() => script('lines:\n  - { text: "x", reading: "" }')).toThrow(
      /test\.yaml.*lines\.0\.reading/s,
    );
  });

  it('wants at least one line', () => {
    expect(() => script('lines: []')).toThrow(ScriptError);
  });

  it('reports the path and the field that was wrong', () => {
    expect(() => script('lines:\n  - { text: "x", stage: { camera: wide } }')).toThrow(
      /test\.yaml.*lines\.0\.stage\.camera/s,
    );
  });
});

describe('setup', () => {
  it('takes commands exactly as they go on the wire', () => {
    const parsed = script(`
setup:
  - { cmd: avatar, id: yoka }
  - { cmd: camera, frame: bust, zoom: 1.2 }
lines:
  - text: "x"
`);
    expect(parsed.setup).toEqual([
      { cmd: 'avatar', id: 'yoka' },
      { cmd: 'camera', frame: 'bust', zoom: 1.2 },
    ]);
  });

  /**
   * The four that would race the queue this script is about to fill. A `say` in
   * setup is a line outside the list; a `clear` deletes what was queued before.
   */
  it.each(['say', 'queue', 'interrupt', 'clear'])('refuses %s', (cmd) => {
    expect(() =>
      script(`setup:\n  - { cmd: ${cmd}, text: "x", turns: [] }\nlines:\n  - text: x`),
    ).toThrow(ScriptError);
  });

  it('refuses a verb that is not a command at all', () => {
    expect(() => script('setup:\n  - { cmd: sing }\nlines:\n  - text: x')).toThrow(ScriptError);
  });
});

describe('scriptCandidates', () => {
  it('looks a bare name up under each extension', () => {
    expect(scriptCandidates('demo', 'show/scripts').map((p) => p.split('/').pop())).toEqual([
      'demo.yaml',
      'demo.yml',
      'demo.json',
    ]);
  });

  it('takes a name with an extension as one name in that directory', () => {
    expect(scriptCandidates('opening.yaml', 'show/scripts')).toEqual([
      scriptCandidates('opening', 'show/scripts')[0],
    ]);
  });

  /** A path that was typed is the path that is read; looking elsewhere for it
   *  is how a run ends up being a different script from the one on screen. */
  it('takes anything with a separator as written', () => {
    expect(scriptCandidates('some/where.yaml')).toEqual([`${process.cwd()}/some/where.yaml`]);
    expect(scriptCandidates('./opening.yaml')).toEqual([`${process.cwd()}/opening.yaml`]);
  });
});

describe('the shipped demo', () => {
  it('is a script', async () => {
    const loaded = await loadScript('demo');
    expect(loaded.id).toBe('demo');
    expect(loaded.script.lines.length).toBeGreaterThan(10);
  });

  /**
   * Drawn expressions and overlays are one model's data, and a checkout has no
   * model in it. A demo that named one would be a demo that runs on the machine
   * it was written on.
   */
  it('names nothing that belongs to a particular avatar', async () => {
    const { script: demo } = await loadScript('demo');
    for (const line of demo.lines) {
      expect(line.expression ?? null).toBeNull();
    }
    for (const command of demo.setup ?? []) {
      expect(['avatar', 'wear', 'expression', 'overlay']).not.toContain(command.cmd);
    }
  });

  it('has an outline with a row per line', async () => {
    const { script: demo } = await loadScript('demo');
    expect(outline(demo)).toHaveLength(demo.lines.length);
  });

  /** The file on disk, not a copy of it: the point is that what ships parses. */
  it('parses from its own bytes', async () => {
    const raw = await readFile('show/scripts/demo.yaml', 'utf8');
    expect(parseScript('show/scripts/demo.yaml', raw).lines.length).toBeGreaterThan(10);
  });
});

describe('loadScript', () => {
  it('names what it looked for when there is nothing there', async () => {
    await expect(loadScript('no-such-script')).rejects.toThrow(/no script called no-such-script/);
  });

  it('resolves a logical NFC name to an NFD filename on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hashidate-script-logical-'));
    try {
      const onDisk = join(root, '台本ダ.yaml'.normalize('NFD'));
      await writeFile(onDisk, 'lines: [{ text: あ }]');

      const loaded = await loadScript('台本ダ'.normalize('NFC'), root);

      expect(loaded.path).toBe(onDisk);
      expect(loaded.id).toBe('台本ダ'.normalize('NFC'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prefers an exact logical spelling when both normalization forms exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hashidate-script-exact-'));
    try {
      const nfc = join(root, 'é.yaml'.normalize('NFC'));
      const nfd = join(root, 'é.yaml'.normalize('NFD'));
      await writeFile(nfc, 'lines: [{ text: nfc }]');
      await writeFile(nfd, 'lines: [{ text: nfd }]');
      // APFS may canonicalise the two entries into one directory entry, in
      // which case the exact-spelling distinction is not observable.
      if ((await readdir(root)).length < 2) return;

      const loaded = await loadScript('é'.normalize('NFC'), root);

      expect(loaded.path).toBe(nfc);
      expect(loaded.script.lines[0]?.text).toBe('nfc');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps an explicit path exact instead of applying logical lookup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hashidate-script-explicit-'));
    try {
      const onDisk = join(root, 'é.yaml'.normalize('NFD'));
      await writeFile(onDisk, 'lines: [{ text: exact }]');

      const loaded = await loadScript(onDisk);

      expect(loaded.path).toBe(onDisk);
      expect(loaded.script.lines[0]?.text).toBe('exact');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an explicit path through an intermediate symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hashidate-script-explicit-link-'));
    const outside = await mkdtemp(join(tmpdir(), 'hashidate-script-explicit-outside-'));
    try {
      const link = join(root, 'linked');
      const target = join(outside, 'opening.yaml');
      await writeFile(target, 'lines: [{ text: outside }]');
      await writeFile(join(root, 'unused.yaml'), 'lines: [{ text: inside }]');
      await symlink(outside, link);

      await expect(loadScript(join(link, 'opening.yaml'))).rejects.toThrow(/symbolic links/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('resolves an extension-bearing logical NFD name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hashidate-script-logical-extension-'));
    try {
      const onDisk = join(root, '台本ダ.yaml'.normalize('NFD'));
      await writeFile(onDisk, 'lines: [{ text: あ }]');

      const loaded = await loadScript('台本ダ.yaml'.normalize('NFC'), root);

      expect(loaded.path).toBe(onDisk);
      expect(loaded.id).toBe('台本ダ'.normalize('NFC'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows hidden directories in explicit paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hashidate-script-hidden-'));
    try {
      const directory = join(root, '.scripts');
      const onDisk = join(directory, 'opening.yaml');
      await mkdir(directory);
      await writeFile(onDisk, 'lines: [{ text: hidden }]');

      const loaded = await loadScript(onDisk);

      expect(loaded.path).toBe(onDisk);
      expect(loaded.script.lines[0]?.text).toBe('hidden');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses ambiguous normalization-equivalent logical names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hashidate-script-ambiguous-'));
    try {
      const first = 'e\u0301.yaml';
      const second = 'e\u0341.yaml';
      expect(first).not.toBe(second);
      expect(first.normalize('NFC')).toBe('é.yaml');
      expect(second.normalize('NFC')).toBe('é.yaml');
      await writeFile(join(root, first), 'lines: [{ text: first }]');
      await writeFile(join(root, second), 'lines: [{ text: second }]');
      // APFS may canonicalise the two entries into one directory entry, so
      // there is no ambiguity to observe on that filesystem.
      if ((await readdir(root)).length < 2) return;

      await expect(loadScript('é'.normalize('NFC'), root)).rejects.toThrow(/ambiguous/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
