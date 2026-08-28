import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Motions } from '@/server/motions';

/**
 * The motion directory, read as the control server reads it.
 *
 * Real files throughout, on the same reasoning as the document reader beside
 * it: what is being tested is that something an operator saved is found and
 * understood, and a stubbed parser would test the stub.
 */

let root: string;
let motions: Motions;

const GOOD = `
label: { en: Salute, ja: 敬礼 }
group: greeting
lead: 0.3
hold: 1.2
frames:
  - at: 0
    arms:
      R: { upperArm: [0.3, -0.9, 0.1], hand: [0.1, -0.9, 0.2] }
  - at: 0.4
    arms:
      R: { upperArm: [0.4, -0.2, 0.3], hand: [0.2, 0.7, 0.6] }
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hashidate-motions-'));
  motions = new Motions(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Motions', () => {
  it('is empty for a directory that is not there', async () => {
    expect(await new Motions(join(root, 'nowhere')).list()).toEqual({ motions: [], errors: [] });
  });

  it('reads a motion and names it after its file', async () => {
    await writeFile(join(root, 'salute.yaml'), GOOD);
    const { motions: found } = await motions.list();
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('salute');
    expect(found[0].label.ja).toBe('敬礼');
    expect(found[0].frames).toHaveLength(2);
  });

  it('reads .yml and .json as well, since JSON is YAML', async () => {
    await writeFile(join(root, 'a.yml'), GOOD);
    await writeFile(
      join(root, 'b.json'),
      JSON.stringify({
        label: { en: 'B', ja: 'び' },
        group: 'pose',
        lead: 0.1,
        hold: 0.1,
        frames: [{ at: 0 }],
      }),
    );
    const { motions: found } = await motions.list();
    expect(found.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('ignores anything that is not one of those', async () => {
    await writeFile(join(root, 'notes.md'), '# not a motion');
    await writeFile(join(root, '.hidden.yaml'), GOOD);
    expect((await motions.list()).motions).toEqual([]);
  });

  /**
   * Listed with its reason rather than dropped. A motion that is simply absent
   * reads as a filename typed wrong, which is the one thing it is not — the
   * same rule the document reader follows for a PDF that will not open.
   */
  it('reports a file that will not parse, beside the ones that did', async () => {
    await writeFile(join(root, 'salute.yaml'), GOOD);
    await writeFile(join(root, 'broken.yaml'), 'label: { en: X, ja: X }\ngroup: dancing\n');
    const { motions: found, errors } = await motions.list();
    expect(found.map((m) => m.id)).toEqual(['salute']);
    expect(errors).toHaveLength(1);
    expect(errors[0].id).toBe('broken');
    expect(errors[0].error).toMatch(/group/);
  });

  it('reports a file that is not YAML at all', async () => {
    await writeFile(join(root, 'bad.yaml'), 'a: [1,\n  b: {{{\n');
    expect((await motions.list()).errors[0].id).toBe('bad');
  });

  /** A vocabulary that reorders itself between two readings is harder to use
   *  than one that is simply alphabetical. */
  it('sorts by id', async () => {
    for (const name of ['zebra', 'alpha', 'mid']) {
      await writeFile(join(root, `${name}.yaml`), GOOD);
    }
    expect((await motions.list()).motions.map((m) => m.id)).toEqual(['alpha', 'mid', 'zebra']);
  });

  it('reads a name with Japanese in it', async () => {
    await writeFile(join(root, '敬礼.yaml'), GOOD);
    expect((await motions.list()).motions[0].id).toBe('敬礼'.normalize('NFC'));
  });
});
