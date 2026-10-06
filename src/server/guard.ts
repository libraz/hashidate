import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The address check every request passes before any route sees it.
 *
 * Binding to loopback keeps other machines out and nothing more: a page open in
 * the operator's own browser can still reach 127.0.0.1, either by naming it from
 * another origin or by rebinding its own hostname onto it. Both arrive here
 * with a giveaway — a `Host` that is not a loopback name, or an `Origin` (or a
 * `Sec-Fetch-Site`) saying the page is not ours — and both are refused before a
 * command is applied or a byte of a licensed asset is read.
 *
 * Any loopback port is accepted, not only this server's: `yarn dev` reaches it
 * through the viewer's dev server, which forwards the browser's own `Host` and
 * `Origin`. What makes a request ours is that its origin is the host it was
 * sent to. A caller with no browser behind it — the CLI, the MCP adapter, curl —
 * sends no `Origin` and passes on its `Host` alone.
 *
 * No CORS header is sent on the refusal or anywhere else; see `main.ts`.
 */

/** The names a request may use for this machine. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost']);

/** What a browser says about a request's initiator when it is not one of our pages. */
const FOREIGN_FETCH_SITES = new Set(['cross-site', 'same-site']);

/** The reason a request is not ours, or null when it is. */
export function foreignReason(req: IncomingMessage): string | null {
  const host = req.headers.host?.toLowerCase();
  if (host === undefined || !LOOPBACK_NAMES.has(host.replace(/:\d+$/, ''))) {
    return 'host is not loopback';
  }
  const origin = req.headers.origin?.toLowerCase();
  if (origin !== undefined && origin !== `http://${host}`) return 'foreign origin';
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && FOREIGN_FETCH_SITES.has(site.toLowerCase())) {
    return 'foreign origin';
  }
  return null;
}

/** Answer 403 to a request that is not ours. True when it was refused. */
export function refuseForeign(req: IncomingMessage, res: ServerResponse): boolean {
  const reason = foreignReason(req);
  if (reason === null) return false;
  const body = Buffer.from(JSON.stringify({ error: `forbidden: ${reason}` }), 'utf8');
  res.writeHead(403, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
  // Unread, a refused body would sit in the socket until the client gave up.
  req.resume();
  return true;
}
