import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relative: string): string {
  return readFileSync(resolve(root, relative), 'utf8');
}

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`route section not found: ${start}`);
  return source.slice(from, to);
}

function casePaths(source: string): string[] {
  return [...source.matchAll(/case '([^']+)':/g)].map((match) => match[1]);
}

function documentedEndpoints(source: string): Set<string> {
  const heading = ['## Endpoints', '## エンドポイント'].find((candidate) =>
    source.includes(candidate),
  );
  const start = heading === undefined ? -1 : source.indexOf(heading);
  const end = source.indexOf('\n## ', start + (heading?.length ?? 0));
  if (start < 0 || end < 0) throw new Error('endpoint table not found');
  const table = source.slice(start, end);
  return new Set(
    [...table.matchAll(/^\| `(GET|POST) ([^`]+)` \|/gm)].map(
      ([, method, path]) => `${method} ${path}`,
    ),
  );
}

describe('control API endpoint documentation', () => {
  it('documents every queue route implemented by the server in both locales', () => {
    const routes = read('src/server/routes.ts');
    const getRoutes = casePaths(between(routes, 'function get(', 'async function listDecks'));
    const queueRoutes = casePaths(between(routes, 'function queue(', '/** SSE down-channel.'));
    const implemented = [
      ...getRoutes
        .filter((path) => path === '/api/queue' || path === '/api/history')
        .map((path) => `GET ${path}`),
      ...queueRoutes.map((path) => `POST ${path}`),
    ];

    const en = documentedEndpoints(read('docs/en/control-api.md'));
    const ja = documentedEndpoints(read('docs/ja/control-api.md'));

    expect(en).toEqual(ja);
    for (const endpoint of implemented) expect(en.has(endpoint), endpoint).toBe(true);
  });
});
