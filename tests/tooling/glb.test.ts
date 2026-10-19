import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ID = 'sample';

interface Run {
  status: number | null;
  stderr: string;
}

interface Options {
  /** Pass AVATAR=<id> (default true). */
  avatar?: boolean;
  /** Write the export profile (default true). */
  profile?: boolean;
}

async function makeGlb(
  blender: string,
  { avatar = true, profile = true }: Options = {},
): Promise<Run> {
  const dir = await mkdtemp(join(tmpdir(), 'hashidate-glb-'));
  try {
    const fake = join(dir, 'blender');
    await writeFile(fake, `#!/bin/sh\n${blender.replaceAll('$OUT', join(dir, 'out'))}\n`);
    await chmod(fake, 0o755);
    const avatars = join(dir, 'avatars');
    await mkdir(join(avatars, 'export'), { recursive: true });
    if (profile) {
      await writeFile(
        join(avatars, 'export', `${ID}.json`),
        JSON.stringify({
          source: 'x.fbx',
          textures: 'tex',
          separator: '^_+(.+?)_+$',
          keep_groups: [],
        }),
      );
    }
    const args = ['--no-print-directory', 'glb', `BLENDER=${fake}`, `OUT=${join(dir, 'out')}`];
    args.push(`AVATARS=${avatars}`);
    if (avatar) args.push(`AVATAR=${ID}`);
    const { status, stderr } = spawnSync('make', args, { cwd: ROOT, encoding: 'utf8' });
    return { status, stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('make glb', () => {
  it('fails when the export script did not finish', async () => {
    expect((await makeGlb('echo "Error: boom"; exit 0')).status).not.toBe(0);
    expect((await makeGlb('echo "@@@ EXPORTED x 1 bytes"; exit 1')).status).not.toBe(0);
  });

  it('fails when the EXPORTED marker is missing', async () => {
    expect((await makeGlb(`echo x > "$OUT/${ID}.glb"`)).status).not.toBe(0);
  });

  it('succeeds once the marker and the file exist', async () => {
    const run = await makeGlb(`echo "@@@ EXPORTED x 1 bytes"; echo x > "$OUT/${ID}.glb"`);
    expect(run.status).toBe(0);
  });

  it('exits non-zero with a usage message without AVATAR', async () => {
    const run = await makeGlb('exit 0', { avatar: false });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('usage: make glb AVATAR=<id>');
  });

  it('exits non-zero when the export profile is missing', async () => {
    const run = await makeGlb('exit 0', { profile: false });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('no export profile');
  });
});
