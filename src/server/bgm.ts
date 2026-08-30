import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, resolve, sep } from 'node:path';
import type { BgmResponse, BgmTrack } from '../protocol';

/**
 * The operator's BGM files, kept outside the build output.
 *
 * The directory is intentionally flat. A track id is the complete filename,
 * including its extension, so `opening.mp3` and `opening.flac` can coexist and
 * the URL never needs a second, implicit format lookup. Files are read again
 * for every roster request: adding a track beside a running show must not
 * require a server restart.
 */

const EXTENSIONS = new Set(['.mp3', '.flac']);
const MIME: Record<string, BgmTrack['mime']> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
};
/** How long the synchronous snapshot roster may be reused. */
export const BGM_SCAN_FLOOR_SECONDS = 1.0;
const MAX_ID_LENGTH = 255;
const FORBIDDEN_IN_ID = /[/\\]|\p{Cc}/u;

function isId(raw: string): boolean {
  if (raw.length === 0 || raw.length > MAX_ID_LENGTH || raw.startsWith('.')) return false;
  if (FORBIDDEN_IN_ID.test(raw)) return false;
  return EXTENSIONS.has(extname(raw).toLowerCase());
}

function contained(root: string, target: string): boolean {
  return root === sep ? target.startsWith(sep) : target.startsWith(`${root}${sep}`);
}

/** What the hub needs without waiting for a directory read. */
export interface BgmSource {
  readonly current: BgmTrack[];
}

export class BgmLibrary implements BgmSource {
  private readonly root: string;
  private tracks: BgmTrack[] = [];
  private paths = new Map<string, string>();
  private scannedAt = 0;
  private scanning: Promise<BgmTrack[]> | null = null;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Scan now and return a fresh roster. A missing root is an empty roster. */
  list(): Promise<BgmTrack[]> {
    return this.rescan();
  }

  /** The last completed roster; stale reads trigger a refresh in the background. */
  get current(): BgmTrack[] {
    // The snapshot is synchronous. Keep its normal polling path cheap while the
    // named GET endpoint above remains explicitly fresh.
    if (Date.now() / 1000 - this.scannedAt >= BGM_SCAN_FLOOR_SECONDS) void this.rescan();
    return this.tracks;
  }

  /**
   * Resolve a complete filename to a candidate path, with no path traversal.
   * The caller still performs lstat before serving because a file can vanish or
   * change type after a roster was read.
   */
  path(id: string): string | null {
    const normalized = id.normalize('NFC');
    if (!isId(normalized)) return null;
    const found = this.paths.get(normalized);
    if (found !== undefined) return found;
    const target = resolve(this.root, normalized);
    return contained(this.root, target) ? target : null;
  }

  /** Find a path after refreshing once when this id was not in the last scan. */
  async file(id: string): Promise<string | null> {
    const normalized = id.normalize('NFC');
    if (!isId(normalized)) return null;
    const known = this.path(normalized);
    if (known !== null) {
      const info = await lstat(known).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) return known;
    }
    await this.list();
    const refreshed = this.paths.get(normalized);
    if (refreshed === undefined) return null;
    const info = await lstat(refreshed).catch(() => null);
    return info?.isFile() && !info.isSymbolicLink() ? refreshed : null;
  }

  private rescan(): Promise<BgmTrack[]> {
    this.scanning ??= this.scan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async scan(): Promise<BgmTrack[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const found: BgmTrack[] = [];
    const paths = new Map<string, string>();
    for (const entry of entries) {
      // Dirent.isFile() excludes symlinks, and lstat below closes the race where
      // a directory entry is replaced while a scan is in progress.
      if (!entry.isFile()) continue;
      const id = basename(entry.name).normalize('NFC');
      if (!isId(id)) continue;
      const target = resolve(this.root, entry.name);
      if (!contained(this.root, target)) continue;
      const info = await lstat(target).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) continue;
      const extension = extname(entry.name).toLowerCase();
      const mime = MIME[extension];
      if (mime === undefined || paths.has(id)) continue;
      paths.set(id, target);
      found.push({
        id,
        label: entry.name.normalize('NFC'),
        mime,
        bytes: info.size,
        at: info.mtimeMs / 1000,
      });
    }
    found.sort((a, b) => a.id.localeCompare(b.id));
    this.paths = paths;
    this.tracks = found;
    this.scannedAt = Date.now() / 1000;
    return found;
  }
}

/** The JSON shape returned by the fresh BGM roster route. */
export async function listBgm(library: BgmLibrary | null): Promise<BgmResponse> {
  return { tracks: library === null ? [] : await library.list() };
}

/**
 * Handle `/bgm/<encoded filename>`. Returns false for another path so the
 * caller can continue with the normal document root.
 */
export function handleBgm(
  req: IncomingMessage,
  res: ServerResponse,
  library: BgmLibrary | null,
): boolean {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!url.pathname.startsWith('/bgm/')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    plain(res, 404, 'not found');
    return true;
  }
  void serve(req, res, library, url.pathname.slice('/bgm/'.length));
  return true;
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  library: BgmLibrary | null,
  encodedId: string,
): Promise<void> {
  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    return plain(res, 400, 'bad request');
  }
  if (id === '' || id.includes('/')) return plain(res, 404, 'not found');
  const target = await library?.file(id);
  if (target === null || target === undefined) return plain(res, 404, 'not found');
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) return plain(res, 404, 'not found');

  const range = parseRange(req.headers.range, info.size);
  if (range === 'invalid') {
    res.writeHead(416, {
      'Content-Range': `bytes */${info.size}`,
      'Content-Length': '0',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, info.size - 1);
  const length = range === undefined ? info.size : end - start + 1;
  res.writeHead(range === undefined ? 200 : 206, {
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    ...(range === undefined ? {} : { 'Content-Range': `bytes ${start}-${end}/${info.size}` }),
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }
  const file = createReadStream(target, { start, end });
  res.on('error', () => file.destroy());
  file.on('error', () => res.end());
  file.pipe(res);
}

type ByteRange = { start: number; end: number };

function parseRange(raw: string | undefined, size: number): ByteRange | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match || (match[1] === '' && match[2] === '') || size === 0) return 'invalid';
  const startText = match[1];
  const endText = match[2];
  let start: number;
  let end: number;
  if (startText === '') {
    const suffix = Number(endText);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    if (!Number.isSafeInteger(start) || start >= size) return 'invalid';
    end = endText === '' ? size - 1 : Number(endText);
    if (!Number.isSafeInteger(end) || end < start) return 'invalid';
    end = Math.min(end, size - 1);
  }
  return { start, end };
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
