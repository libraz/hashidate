import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveStatic } from '@/server/static';

/**
 * The document root, served the way the control server serves it.
 *
 * A real socket and a real directory: what is being tested is which bytes come
 * back for a URL, and both the path guard and the lookup below it are things a
 * mocked request would answer for itself.
 */

let root: string;
let server: Server;
let origin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hashidate-static-'));
  server = createServer((req, res) => serveStatic(req, res, root, '/slides'));
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((closed) => server.close(() => closed()));
  await rm(root, { recursive: true, force: true });
});

describe('serving a file under a prefix', () => {
  it('answers with the bytes and the type the extension names', async () => {
    await writeFile(join(root, 'notes.txt'), 'hello');
    const response = await fetch(`${origin}/slides/notes.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('hello');
  });

  it('refuses a path that climbs out of the root', async () => {
    await writeFile(join(root, 'notes.txt'), 'hello');
    // Encoded as well as plain, because the prefix is stripped after decoding
    // and a guard that runs before it would be looking at the wrong string.
    for (const path of ['/slides/../../etc/passwd', '/slides/..%2f..%2fetc%2fpasswd']) {
      expect((await fetch(`${origin}${path}`)).status, path).toBe(404);
    }
  });

  it('finds a document the directory spells in the other normalisation form', async () => {
    // Saved decomposed, which is what the filesystem it was typed on stores, and
    // asked for composed, which is what the roster hands the browser. macOS
    // resolves the difference in the kernel and Linux does not, so without the
    // lookup this is the document that is listed in the panel and 404s on air.
    await writeFile(join(root, '資料ダ.pdf'.normalize('NFD')), 'PDF-ish');
    const composed = encodeURIComponent('資料ダ.pdf'.normalize('NFC'));
    const response = await fetch(`${origin}/slides/${composed}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(await response.text()).toBe('PDF-ish');
  });

  it('is still a 404 for a name no spelling of which is there', async () => {
    expect((await fetch(`${origin}/slides/${encodeURIComponent('無い.pdf')}`)).status).toBe(404);
  });
});
