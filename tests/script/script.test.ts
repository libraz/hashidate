import { readFile } from 'node:fs/promises';
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
});
