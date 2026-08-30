import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

/**
 * File serving for the document root, and for the slide directory beside it.
 *
 * **Never let the browser cache anything served from here.** Everything under
 * the document root is regenerated during development — the GLB most of all.
 * Re-exporting an avatar and then loading the previous one out of the browser
 * cache produces a failure that looks exactly like a bug in the runtime: shapes
 * the profile expects are simply not there. Chased that once already.
 *
 * The only cost is re-reading a few megabytes over loopback. It is also exactly
 * what a slide directory wants: an operator who fixes a typo and saves over a
 * document expects the next page turn to show the fix.
 *
 * A second root is reached by naming a URL prefix rather than by a second
 * function, so the path guard below is the only one there is. Two of them is how
 * one of them comes to be the one that was not fixed.
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
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Serve one GET or HEAD out of `root`.
 *
 * `prefix` is the part of the URL that names the root rather than the file
 * inside it, and is stripped before anything is joined. Empty for the document
 * root, `/slides` for the documents; see the module docstring.
 */
export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  prefix = '',
): void {
  void send(req, res, root, prefix);
}

async function send(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  prefix: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return plain(res, 400, 'bad request');
  }
  // Stripped after decoding, so that a prefix spelled with an escape still
  // names the root it was meant to name rather than a file called `%73lides`.
  if (prefix !== '') {
    if (!pathname.startsWith(prefix)) return plain(res, 404, 'not found');
    pathname = pathname.slice(prefix.length);
  }

  // `resolve` normalises the `..` away, so anything that climbs out of the root
  // lands outside it and is refused rather than followed.
  let target = resolve(root, `.${pathname}`);
  if (target !== root && !target.startsWith(root + sep)) return plain(res, 404, 'not found');

  let info = await stat(target).catch(() => null);
  if (info === null) {
    const spelled = await otherSpelling(root, target);
    if (spelled !== null) {
      target = spelled;
      info = await stat(target).catch(() => null);
    }
  }
  if (info?.isDirectory()) {
    // A relative import inside index.html resolves against the directory, so
    // the trailing slash has to be there before the page loads.
    if (!pathname.endsWith('/')) {
      res.writeHead(301, {
        Location: `${prefix}${pathname}/${url.search}`,
        'Cache-Control': 'no-store',
      });
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

/**
 * The same file under the other normalisation form, or null.
 *
 * A filename with a Japanese character in it is stored decomposed by the
 * filesystem it was typed on and arrives composed in the URL a browser sends.
 * One name, two strings: macOS looks a path up without regard to which form it
 * is in and never notices, and ext4 compares bytes, so the document an operator
 * saved is a 404 on the machine the broadcast actually runs on.
 *
 * Reached only after a miss, so an ordinary request pays nothing for it and the
 * cost lands on a path that was about to be answered with `not found` anyway. A
 * name that both forms leave alone — which is every ASCII name, and so nearly
 * everything under the document root — is refused before the directory is read.
 *
 * The name comes back out of a directory that is already inside the root, so it
 * cannot climb out; checked again regardless, because the module docstring says
 * there is one guard here and this is it.
 */
async function otherSpelling(root: string, target: string): Promise<string | null> {
  const name = basename(target);
  if (name.normalize('NFC') === name && name.normalize('NFD') === name) return null;
  const directory = dirname(target);
  const wanted = name.normalize('NFC');
  for (const entry of await readdir(directory).catch(() => [] as string[])) {
    if (entry.normalize('NFC') !== wanted) continue;
    const found = resolve(directory, entry);
    if (found === root || found.startsWith(root + sep)) return found;
  }
  return null;
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
