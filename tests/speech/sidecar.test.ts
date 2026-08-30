import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  askSidecar,
  defaultSocketPath,
  describeEndpoint,
  SOCKET_NAME,
  speechEndpoint,
} from '@/speech/sidecar';

/**
 * Where the voice is, and how it is reached.
 *
 * Three processes work this out independently — the control server, the shell
 * and `tools/tts/server.py` — and none of them is told by another, so the rule
 * has to be exact rather than merely reasonable. The Python side reads the same
 * two variables in the same order; a change here is a change there.
 */

describe('which sidecar this process talks to', () => {
  it('is the checkout’s own socket when nothing says otherwise', () => {
    const endpoint = speechEndpoint({});
    expect(endpoint).toEqual({ kind: 'socket', path: defaultSocketPath() });
    expect(defaultSocketPath().endsWith(join('tools/tts/.run', SOCKET_NAME))).toBe(true);
  });

  it('goes where the socket variable names, absolute either way', () => {
    expect(speechEndpoint({ HASHIDATE_TTS_SOCKET: '/tmp/other.sock' })).toEqual({
      kind: 'socket',
      path: '/tmp/other.sock',
    });
    // A relative path is resolved rather than refused: a socket is a file, and
    // the shell hands this to a child started in another directory.
    const relative = speechEndpoint({ HASHIDATE_TTS_SOCKET: 'run/voice.sock' });
    expect(relative).toMatchObject({ kind: 'socket' });
    expect(relative.kind === 'socket' && relative.path.startsWith('/')).toBe(true);
  });

  it('takes a port, which is how a different synthesiser stands in', () => {
    expect(speechEndpoint({ HASHIDATE_TTS_PORT: '8770' })).toEqual({ kind: 'port', port: 8770 });
  });

  it('lets the socket win, because naming it is the more specific act', () => {
    expect(
      speechEndpoint({ HASHIDATE_TTS_SOCKET: '/tmp/a.sock', HASHIDATE_TTS_PORT: '8770' }),
    ).toEqual({ kind: 'socket', path: '/tmp/a.sock' });
  });

  it('ignores a port that is not one rather than falling back to 8770', () => {
    // A typo there would otherwise point the voice at a port nobody is on, and
    // silence is the one failure this whole layer exists to explain.
    for (const bad of [
      'nope',
      '8770x',
      '1e3',
      ' 8770',
      '8770 ',
      '+8770',
      '-8770',
      '0',
      '65536',
      '',
    ]) {
      expect(speechEndpoint({ HASHIDATE_TTS_PORT: bad })).toMatchObject({ kind: 'socket' });
    }
    expect(speechEndpoint({ HASHIDATE_TTS_PORT: '1' })).toEqual({ kind: 'port', port: 1 });
    expect(speechEndpoint({ HASHIDATE_TTS_PORT: '65535' })).toEqual({
      kind: 'port',
      port: 65535,
    });
    expect(speechEndpoint({ HASHIDATE_TTS_PORT: `${'0'.repeat(5000)}1` })).toEqual({
      kind: 'port',
      port: 1,
    });
    expect(speechEndpoint({ HASHIDATE_TTS_PORT: '1'.repeat(5001) })).toMatchObject({
      kind: 'socket',
    });
  });

  it('reads back as the place an operator would look', () => {
    expect(describeEndpoint({ kind: 'socket', path: '/tmp/a.sock' })).toBe('/tmp/a.sock');
    expect(describeEndpoint({ kind: 'port', port: 8770 })).toBe('http://127.0.0.1:8770');
  });
});

describe('one round trip, over either transport', () => {
  let server: Server | null = null;
  let directory: string | null = null;

  afterEach(async () => {
    if (server !== null) await new Promise((done) => server?.close(() => done(null)));
    server = null;
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  /** A stand-in sidecar that answers on whichever address it was given. */
  const serve = (): Server =>
    createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(Buffer.concat([Buffer.from(`${req.method} ${req.url} `, 'utf8'), ...chunks]));
      });
    });

  it('carries a body to a socket and the bytes back', async () => {
    directory = mkdtempSync(join(tmpdir(), 'hashidate-'));
    const path = join(directory, SOCKET_NAME);
    server = serve();
    await new Promise((up) => server?.listen(path, () => up(null)));

    const reply = await askSidecar({ kind: 'socket', path }, '/speak', {
      method: 'POST',
      body: JSON.stringify({ text: 'こんばんは' }),
      timeoutMs: 2_000,
    });

    expect(reply.status).toBe(200);
    expect(reply.contentType).toBe('audio/wav');
    expect(reply.body.toString('utf8')).toBe('POST /speak {"text":"こんばんは"}');
  });

  it('rejects rather than answering when nothing holds the socket', async () => {
    directory = mkdtempSync(join(tmpdir(), 'hashidate-'));
    await expect(
      askSidecar({ kind: 'socket', path: join(directory, SOCKET_NAME) }, '/health', {
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow();
  });

  it('still speaks to a port, which is the stand-in case', async () => {
    server = serve();
    await new Promise((up) => server?.listen(0, '127.0.0.1', () => up(null)));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const reply = await askSidecar({ kind: 'port', port: address.port }, '/health', {
      timeoutMs: 2_000,
    });
    expect(reply.body.toString('utf8')).toBe('GET /health ');
  });
});
