import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

/**
 * File serving for the document root, and nothing else.
 *
 * **Never let the browser cache anything served from here.** Everything under
 * the document root is regenerated during development — the GLB most of all.
 * Re-exporting an avatar and then loading the previous one out of the browser
 * cache produces a failure that looks exactly like a bug in the runtime: shapes
 * the profile expects are simply not there. Chased that once already.
 *
 * The only cost is re-reading a few megabytes over loopback.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Serve one GET or HEAD out of `root`. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, root: string): void {
  void send(req, res, root);
}

async function send(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return plain(res, 400, 'bad request');
  }

  // `resolve` normalises the `..` away, so anything that climbs out of the root
  // lands outside it and is refused rather than followed.
  let target = resolve(root, `.${pathname}`);
  if (target !== root && !target.startsWith(root + sep)) return plain(res, 404, 'not found');

  let info = await stat(target).catch(() => null);
  if (info?.isDirectory()) {
    // A relative import inside index.html resolves against the directory, so
    // the trailing slash has to be there before the page loads.
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { Location: `${pathname}/${url.search}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    // No directory listing: everything under the root is reached by a path the
    // viewer already knows.
    target = join(target, 'index.html');
    info = await stat(target).catch(() => null);
  }
  if (!info?.isFile()) return plain(res, 404, 'not found');

  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(info.size),
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const file = createReadStream(target);
  // The browser navigated away or was reloaded mid-transfer. Routine during
  // development, and one stack trace per reload hides anything that actually
  // went wrong.
  res.on('error', () => file.destroy());
  file.on('error', () => res.end());
  file.pipe(res);
}

function plain(res: ServerResponse, status: number, message: string): void {
  const body = Buffer.from(`${message}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
