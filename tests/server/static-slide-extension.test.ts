import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Decks } from '@/server/decks';
import { serveStatic } from '@/server/static';

let root: string;
let server: Server;
let origin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hashidate-slide-extension-'));
  server = createServer((req, res) => serveStatic(req, res, root, '/slides'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

it.each(['.pdf', '.PDF', '.Pdf'])(
  'serves the viewer URL for a document saved with %s',
  async (extension) => {
    const id = '資料ダ';
    const filename = `${id.normalize('NFD')}${extension}`;
    await writeFile(join(root, filename), 'document bytes');
    // The control server and the viewer must resolve the same document id.
    expect(await new Decks(root).file(id)).not.toBeNull();

    const response = await fetch(`${origin}/slides/${encodeURIComponent(id)}.pdf`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(await response.text()).toBe('document bytes');
  },
);

it('still distinguishes the case of the document id', async () => {
  await writeFile(join(root, 'Intro.PDF'), 'document bytes');
  expect(await new Decks(root).file('intro')).toBeNull();
  expect((await fetch(`${origin}/slides/intro.pdf`)).status).toBe(404);
});
