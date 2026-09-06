import type { ReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BgmLibrary, handleBgm } from '@/server/bgm';
import { serveStatic } from '@/server/static';

describe('aborted file transfers', () => {
  it.each(['static', 'bgm'] as const)('closes the %s file when the client leaves', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'hashidate-stream-abort-'));
    const filename = kind === 'static' ? 'large.pdf' : 'large.mp3';
    const file = await open(join(root, filename), 'w');
    await file.truncate(32 * 1024 * 1024);
    await file.close();
    const library = new BgmLibrary(root);
    let source: ReadStream | undefined;
    const server = createServer((req, res) => {
      // Observe the actual filesystem stream handed to the HTTP response.
      res.once('pipe', (stream: ReadStream) => {
        source = stream;
      });
      if (kind === 'static') serveStatic(req, res, root, '/slides');
      else handleBgm(req, res, library);
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      const path = kind === 'static' ? `/slides/${filename}` : `/bgm/${filename}`;
      await new Promise<void>((resolve, reject) => {
        const request = get(`http://127.0.0.1:${address.port}${path}`, (response) => {
          response.once('error', reject);
          response.once('data', () => {
            response.destroy();
            resolve();
          });
        });
        request.once('error', reject);
      });
      await vi.waitFor(() => {
        expect(source).toBeDefined();
        expect(source?.closed).toBe(true);
      });
      expect(source?.bytesRead).toBeLessThan(32 * 1024 * 1024);
    } finally {
      source?.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
