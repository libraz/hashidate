import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function makeGlb(target: string, blender: string): Promise<number | null> {
  const dir = await mkdtemp(join(tmpdir(), 'hashidate-glb-'));
  try {
    const fake = join(dir, 'blender');
    await writeFile(fake, `#!/bin/sh\n${blender.replaceAll('$OUT', join(dir, 'out'))}\n`);
    await chmod(fake, 0o755);
    return spawnSync(
      'make',
      ['--no-print-directory', target, `BLENDER=${fake}`, `OUT=${join(dir, 'out')}`],
      { cwd: ROOT, encoding: 'utf8' },
    ).status;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('make glb', () => {
  it.each(['glb', 'manuka-glb'])(
    '%s fails when the export script did not finish',
    async (target) => {
      expect(await makeGlb(target, 'echo "Error: boom"; exit 0')).not.toBe(0);
      expect(await makeGlb(target, 'echo "@@@ EXPORTED x 1 bytes"; exit 1')).not.toBe(0);
    },
  );

  it.each(['glb', 'manuka-glb'])(
    '%s succeeds once the marker and the file exist',
    async (target) => {
      const name = target === 'glb' ? 'yoka.glb' : 'manuka.glb';
      expect(await makeGlb(target, `echo "@@@ EXPORTED x 1 bytes"; echo x > "$OUT/${name}"`)).toBe(
        0,
      );
    },
  );
});
