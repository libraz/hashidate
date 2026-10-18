import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDeck } from '@/viewer/scene/slides/deck';

// Use the installed Node-compatible parser and observe only task ownership.
vi.mock('pdfjs-dist', async () => {
  const actual = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return { ...actual, getDocument: vi.fn(actual.getDocument) };
});

const tasks = (): ReturnType<typeof pdfjs.getDocument>[] =>
  vi
    .mocked(pdfjs.getDocument)
    .mock.results.flatMap((result) => (result.type === 'return' ? [result.value] : []));
let server: Server | undefined;
let workerSrc: string;

/** A complete one-page PDF without fonts or raster assets. */
function singlePage(): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 4\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return `${body}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

beforeEach(() => {
  vi.mocked(pdfjs.getDocument).mockClear();
  workerSrc = pdfjs.GlobalWorkerOptions.workerSrc;
  // Node uses PDF.js's real worker module through its in-process fallback.
  const require = createRequire(import.meta.url);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ).href;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of tasks()) await task.destroy();
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  if (!server) return;
  const closing = server;
  server = undefined;
  closing.closeAllConnections();
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

async function serve(status: number, body: string): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/pdf' });
    res.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}/slides/deck.pdf`;
}

describe('PDF loading task ownership', () => {
  it.each([
    [200, 'not a PDF', 'InvalidPDFException'],
    [404, 'missing', 'ResponseException'],
  ] as const)('destroys a failed task after HTTP %s', async (status, body, errorName) => {
    const url = await serve(status, body);

    await expect(openDeck(url)).rejects.toHaveProperty('name', errorName);

    expect(tasks()).toHaveLength(1);
    expect(tasks()[0].destroyed).toBe(true);
  });

  it('keeps a readable document alive until its owner disposes it', async () => {
    const source = await openDeck(await serve(200, singlePage()));

    expect(source.pages).toBe(1);
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0].destroyed).toBe(false);

    source.dispose();
    expect(tasks()[0].destroyed).toBe(true);
  });

  it('preserves the loading error when destroying the failed task also fails', async () => {
    const url = await serve(404, 'missing');
    const outcome = openDeck(url).catch((error: unknown) => error);
    const task = tasks()[0];
    const destroy = vi.spyOn(task, 'destroy').mockRejectedValue(new Error('cleanup failed'));
    const loadingError = await task.promise.catch((error: unknown) => error);

    expect(await outcome).toBe(loadingError);
    expect(loadingError).toHaveProperty('name', 'ResponseException');
    expect(destroy).toHaveBeenCalledOnce();
  });
});
