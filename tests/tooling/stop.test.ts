import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const tempRoots: string[] = [];

async function runStop(socket: string): Promise<{ status: number; output: string }> {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve, reject) => {
    const child = spawn(
      'make',
      ['--no-print-directory', 'stop', 'VIEWER_PORT=0', 'CONTROL_PORT=0', `TTS_SOCK=${socket}`],
      { cwd: ROOT },
    );
    const output: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk));
    child.once('error', reject);
    child.once('close', (status) =>
      resolve({ status: status ?? -1, output: Buffer.concat(output).toString() }),
    );
  });
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hashidate-stop-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) await rm(root, { force: true, recursive: true });
  }
});

describe('make stop speech socket boundary', () => {
  it.each(['regular file', 'symlink'])('rejects an existing %s before probing', async (kind) => {
    const root = await makeTempRoot();
    const target = join(root, 'target file');
    const socket = join(root, `${kind} path`);
    await writeFile(target, 'keep me');
    if (kind === 'symlink') await symlink(target, socket);
    else await writeFile(socket, 'keep me');

    const result = await runStop(socket);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('non-socket speech path');
    expect((await lstat(socket)).isSymbolicLink()).toBe(kind === 'symlink');
    expect(await readFile(target, 'utf8')).toBe('keep me');
  });

  it('removes only a confirmed stale socket, including a path with spaces', async () => {
    const root = await makeTempRoot();
    const socket = join(root, 'stale speech socket');
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(socket, () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      listener.close((error) => (error === undefined ? resolve() : reject(error)));
    });

    const result = await runStop(socket);

    expect(result.status).toBe(0);
    await expect(lstat(socket)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('make speech socket path', () => {
  it('hands every recipe the same absolute path for a relative override', async () => {
    const { spawnSync } = await import('node:child_process');
    const run = spawnSync('make', ['--no-print-directory', '-f', 'Makefile', '-f', '-', 'probe'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, HASHIDATE_TTS_SOCKET: 'run/x.sock' },
      input: 'probe:\n\t@echo "$$HASHIDATE_TTS_SOCKET|$(TTS_SOCK)"\n',
    });
    const expected = join(ROOT.replace(/\/$/, ''), 'run/x.sock');
    expect(run.stdout.trim()).toBe(`${expected}|${expected}`);
  });
});
