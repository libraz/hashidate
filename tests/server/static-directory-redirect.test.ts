import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serveStatic } from '@/server/static';

let root: string | undefined;
let server: Server | undefined;

afterEach(async () => {
  if (server) {
    const closing = server;
    server = undefined;
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe.each(['', '/slides'])('directory redirects under %s', (prefix) => {
  it.each(['deck#1', 'deck?1', 'deck%20', 'deck space', '資料', 'parent/deck#1'])(
    'keeps the directory name %s encoded and preserves the query',
    async (name) => {
      const directory = await mkdtemp(join(tmpdir(), 'hashidate-static-redirect-'));
      root = directory;
      await mkdir(join(directory, name), { recursive: true });
      await writeFile(join(directory, name, 'index.html'), 'directory index');
      server = createServer((req, res) => serveStatic(req, res, directory, prefix));
      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server did not bind');
      const origin = `http://127.0.0.1:${address.port}`;
      const path = `${prefix}/${name.split('/').map(encodeURIComponent).join('/')}`;

      const response = await fetch(`${origin}${path}?mute=1`, { redirect: 'manual' });

      expect(response.status).toBe(301);
      expect(response.headers.get('location')).toBe(`${path}/?mute=1`);
      const redirected = await fetch(`${origin}${response.headers.get('location')}`);
      expect(redirected.status).toBe(200);
      expect(await redirected.text()).toBe('directory index');
    },
  );
});
