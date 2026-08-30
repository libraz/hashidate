import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
    // Saved decomposed, which is what the filesystem it was typed on stores,
    // and asked for composed, which is what the deck roster hands the browser.
    await writeFile(join(root, '資料ダ.pdf'.normalize('NFD')), 'PDF-ish');
    const composed = encodeURIComponent('資料ダ.pdf'.normalize('NFC'));
    const response = await fetch(`${origin}/slides/${composed}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(await response.text()).toBe('PDF-ish');
  });

  it('prefers the exact slide filename over a normalization fallback', async () => {
    const nfc = join(root, 'é.pdf'.normalize('NFC'));
    const nfd = join(root, 'é.pdf'.normalize('NFD'));
    await writeFile(nfc, 'NFC');
    await writeFile(nfd, 'NFD');
    if ((await readdir(root)).length < 2) return;

    const response = await fetch(`${origin}/slides/${encodeURIComponent('é.pdf')}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('NFC');
  });

  it('refuses ambiguous normalization-equivalent slide filenames', async () => {
    const first = 'e\u0301.pdf';
    const second = 'e\u0341.pdf';
    expect(first).not.toBe(second);
    expect(first.normalize('NFC')).toBe('é.pdf');
    expect(second.normalize('NFC')).toBe('é.pdf');
    await writeFile(join(root, first), 'first');
    await writeFile(join(root, second), 'second');
    if ((await readdir(root)).length < 2) return;

    const response = await fetch(`${origin}/slides/${encodeURIComponent('é.pdf')}`);

    expect(response.status).toBe(404);
  });

  it('is still a 404 for a name no spelling of which is there', async () => {
    expect((await fetch(`${origin}/slides/${encodeURIComponent('無い.pdf')}`)).status).toBe(404);
  });

  it('does not stream a final or intermediate symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'hashidate-static-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret');
      await symlink(join(outside, 'secret.txt'), join(root, 'linked.txt'));
      await symlink(outside, join(root, 'linked-directory'));

      expect((await fetch(`${origin}/slides/linked.txt`)).status).toBe(404);
      expect((await fetch(`${origin}/slides/linked-directory/secret.txt`)).status).toBe(404);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

/**
 * The document root, which is served without a prefix and is reached by three
 * directory URLs rather than by naming a file.
 *
 * Every page in the application arrives this way — `/`, `/panel/`, `/monitor/`
 * — so a guard that refuses a name with no extension takes all three down at
 * once and leaves the shell showing two windows that say "not found".
 */
describe('serving the document root', () => {
  let pages: Server;
  let root2: string;

  beforeEach(async () => {
    root2 = await mkdtemp(join(tmpdir(), 'hashidate-static-root-'));
    pages = createServer((req, res) => serveStatic(req, res, root2));
    await new Promise<void>((ready) => pages.listen(0, '127.0.0.1', ready));
    const address = pages.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${address.port}`;
    await writeFile(join(root2, 'index.html'), '<!doctype html>viewer');
    for (const page of ['panel', 'monitor']) {
      await mkdir(join(root2, page));
      await writeFile(join(root2, page, 'index.html'), `<!doctype html>${page}`);
    }
  });

  afterEach(async () => {
    await new Promise<void>((closed) => pages.close(() => closed()));
    await rm(root2, { recursive: true, force: true });
  });

  it('answers each page directory with its index', async () => {
    for (const [path, body] of [
      ['/', 'viewer'],
      ['/panel/', 'panel'],
      ['/monitor/', 'monitor'],
    ]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await response.text()).toBe(`<!doctype html>${body}`);
    }
  });

  it('keeps the query when it adds the trailing slash a page directory needs', async () => {
    // The stage window is opened muted by asking for `/monitor?mute=1`, and a
    // redirect that drops the query is a window that quietly makes a sound.
    const response = await fetch(`${origin}/monitor?mute=1`, { redirect: 'manual' });
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/monitor/?mute=1');
  });

  it('does not list a directory that has no index', async () => {
    await mkdir(join(root2, 'assets'));
    await writeFile(join(root2, 'assets', 'app.js'), 'console.log(1)');
    expect((await fetch(`${origin}/assets/`)).status).toBe(404);
    expect((await fetch(`${origin}/assets/app.js`)).status).toBe(200);
  });

  it('still refuses a file the root does not serve', async () => {
    await writeFile(join(root2, 'notes.md'), '# no');
    expect((await fetch(`${origin}/notes.md`)).status).toBe(404);
  });
});
