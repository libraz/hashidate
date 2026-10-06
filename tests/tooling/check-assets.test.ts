import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../tools/check-assets.sh', import.meta.url));
const LARGE_BYTES = 4_096;
const MAX_BYTES = 2_048;

type CheckResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runGit(root: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function runCheck(root: string): CheckResult {
  const result = spawnSync('/bin/bash', [SCRIPT, String(MAX_BYTES)], {
    cwd: root,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('check-assets.sh', () => {
  it('separates tracked and untracked large files and ignores excluded ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hashidate-check-assets-'));

    try {
      runGit(root, 'init', '-q');
      await writeFile(join(root, '.gitignore'), 'ignored-large.bin\n');
      await writeFile(join(root, 'tracked-large.bin'), Buffer.alloc(LARGE_BYTES, 0x78));
      await writeFile(join(root, 'untracked-large.bin'), Buffer.alloc(LARGE_BYTES, 0x79));
      await writeFile(join(root, 'ignored-large.bin'), Buffer.alloc(LARGE_BYTES, 0x7a));
      runGit(root, 'add', 'tracked-large.bin');

      const over = runCheck(root);
      const trackedHeader = 'tracked files over 2 KiB:';
      const untrackedHeader = 'untracked non-ignored files over 2 KiB:';
      expect(over.status).toBe(1);
      expect(over.stderr).toContain(trackedHeader);
      expect(over.stderr).toContain(untrackedHeader);
      expect(over.stderr).not.toContain('ignored-large.bin');

      const trackedSection = over.stderr.slice(0, over.stderr.indexOf(untrackedHeader));
      const untrackedSection = over.stderr.slice(over.stderr.indexOf(untrackedHeader));
      expect(trackedSection).toMatch(/^\s*4096\s+tracked-large\.bin$/m);
      expect(trackedSection).not.toMatch(/^\s*4096\s+untracked-large\.bin$/m);
      expect(untrackedSection).toMatch(/^\s*4096\s+untracked-large\.bin$/m);
      expect(untrackedSection).not.toMatch(/^\s*4096\s+tracked-large\.bin$/m);

      await rm(join(root, 'untracked-large.bin'));
      runGit(root, 'rm', '--cached', 'tracked-large.bin');
      await rm(join(root, 'tracked-large.bin'));

      const ignoredOnly = runCheck(root);
      expect(ignoredOnly.status).toBe(0);
      expect(ignoredOnly.stdout).toContain('no tracked file over 2 KiB');
      expect(ignoredOnly.stdout).toContain('no untracked non-ignored file over 2 KiB');
      expect(ignoredOnly.stdout).not.toContain('ignored-large.bin');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a staged blob after it was deleted or shrunk on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hashidate-check-assets-'));

    try {
      runGit(root, 'init', '-q');
      await writeFile(join(root, 'gone.bin'), Buffer.alloc(LARGE_BYTES, 0x78));
      await writeFile(join(root, 'shrunk.bin'), Buffer.alloc(LARGE_BYTES, 0x79));
      runGit(root, 'add', 'gone.bin', 'shrunk.bin');
      await rm(join(root, 'gone.bin'));
      await writeFile(join(root, 'shrunk.bin'), 'tiny');

      const result = runCheck(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/^\s*4096\s+gone\.bin$/m);
      expect(result.stderr).toMatch(/^\s*4096\s+shrunk\.bin$/m);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a tracked file that grew on disk and handles unusual paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hashidate-check-assets-'));

    try {
      runGit(root, 'init', '-q');
      await writeFile(join(root, 'grown.bin'), 'tiny');
      await writeFile(join(root, 'with space.bin'), 'tiny');
      runGit(root, 'add', 'grown.bin', 'with space.bin');
      await writeFile(join(root, 'grown.bin'), Buffer.alloc(LARGE_BYTES, 0x78));
      await writeFile(join(root, 'odd name.bin'), Buffer.alloc(LARGE_BYTES, 0x79));

      const result = runCheck(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/^\s*4096\s+grown\.bin$/m);
      expect(result.stderr).toMatch(/^\s*4096\s+odd name\.bin$/m);
      expect(result.stderr).not.toContain('with space.bin');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
