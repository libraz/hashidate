import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expandGreedy, normaliseWait, takeBase } from '@/cli/args';
import { ControlClient } from '@/cli/client';
import { say } from '@/cli/commands/turn';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('option terminator', () => {
  it('takes --base before -- and preserves every following token', () => {
    const base = 'http://127.0.0.1:8765/api';

    expect(takeBase(['say', '--base', base, '--', `--base=${base}`, 'literal'])).toEqual({
      base,
      rest: ['say', '--', `--base=${base}`, 'literal'],
    });
  });

  it('normalises a bare --wait before -- and leaves the tail alone', () => {
    expect(normaliseWait(['--wait', '--', '--wait', '--emotion'])).toEqual([
      '--wait=1',
      '--',
      '--wait',
      '--emotion',
    ]);
  });

  it('expands a greedy flag before -- and leaves the tail alone', () => {
    expect(
      expandGreedy(
        ['--emotion', 'joy=0.8', '--', '--emotion', 'relaxed=0.2', 'energy=0.3'],
        '--emotion',
      ),
    ).toEqual(['--emotion', 'joy=0.8', '--', '--emotion', 'relaxed=0.2', 'energy=0.3']);
  });

  it('sends text beginning with an option token unchanged', async () => {
    let received: { url: string | undefined; command: unknown } | undefined;
    const server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        received = { url: req.url, command: JSON.parse(body) as unknown };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('server did not bind');
      const base = `http://127.0.0.1:${address.port}/api`;
      const { base: selectedBase, rest } = takeBase([
        '--base',
        base,
        'say',
        '--',
        '--wait',
        `--base=${base}`,
        '--emotion',
      ]);
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await say(new ControlClient(selectedBase), rest.slice(1));

      expect(received).toEqual({
        url: '/api/command',
        command: { cmd: 'say', text: '--wait' },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
