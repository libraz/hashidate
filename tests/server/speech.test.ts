import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '@/server/hub';
import {
  forgetTakes,
  handleSpeech,
  SpeechWatch,
  speak,
  TAKE_MAX,
  TAKE_TTL_MS,
} from '@/server/speech';
import { askSidecar, type SidecarReply } from '@/speech/sidecar';

/**
 * Whether the server can tell a machine with no voice from a voice that died.
 *
 * The distinction is the whole feature. A sidecar is missing on almost every
 * machine — it wants a purchased voice and three gigabytes of PyTorch — so a
 * server that warned about every absence would be warning permanently, and the
 * one time it mattered nobody would be reading. What has to be caught is the
 * narrower case: something answered and stopped, which on air is invisible from
 * the panel because the queue still drains and the mouth still moves.
 *
 * The round trip is stubbed at the transport rather than at `fetch`, because
 * the sidecar answers on a UNIX socket and there is no URL anywhere in this.
 * See `askSidecar`.
 */

vi.mock('@/speech/sidecar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/speech/sidecar')>()),
  askSidecar: vi.fn(),
}));

const asked = vi.mocked(askSidecar);

/** A `/health` reply, as the sidecar hands it over. */
const health = (ready: boolean): SidecarReply => ({
  status: 200,
  contentType: 'application/json',
  body: Buffer.from(JSON.stringify({ ready }), 'utf8'),
});

/** Nothing behind the socket: what a connection to it does. */
const refused = (): never => {
  throw new Error('connect ENOENT tools/tts/.run/speech.sock');
};

/** Something answering that is not the voice. */
const wrongService = (): SidecarReply => ({
  status: 404,
  contentType: 'text/plain',
  body: Buffer.from('not found', 'utf8'),
});

let watch: SpeechWatch;
let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  watch = new SpeechWatch();
  forgetTakes();
  asked.mockReset();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  watch.stop();
  vi.restoreAllMocks();
});

describe('what the watch makes of an answer', () => {
  it('is ready when the sidecar says its model is loaded', async () => {
    asked.mockResolvedValue(health(true));
    expect(await watch.start()).toBe('ready');
    expect(watch.current).toBe('ready');
  });

  it('is loading while the model is still coming up, which is not a fault', async () => {
    asked.mockResolvedValue(health(false));
    expect(await watch.start()).toBe('loading');
  });

  it('takes a 2xx reply without a boolean ready as no answer, not as loading', async () => {
    for (const body of [{}, { ready: 'yes' }, null, []]) {
      asked.mockResolvedValue({
        status: 200,
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(body), 'utf8'),
      });
      expect(await new SpeechWatch().check()).toBe('absent');
    }
  });

  it('is absent when nothing has ever answered', async () => {
    asked.mockImplementation(refused);
    expect(await watch.start()).toBe('absent');
  });

  it('is absent when something else is answering there', async () => {
    // Not a voice, and the only thing worth reporting about that is the same
    // thing as a socket nobody holds: there is no speech here.
    asked.mockResolvedValue(wrongService());
    expect(await watch.start()).toBe('absent');
  });

  it('is absent when the answer is not JSON', async () => {
    asked.mockResolvedValue({
      status: 200,
      contentType: 'text/html',
      body: Buffer.from('<html>', 'utf8'),
    });
    expect(await watch.start()).toBe('absent');
  });
});

describe('the difference between never here and gone', () => {
  it('calls it down once it has answered and then stops', async () => {
    asked.mockResolvedValue(health(true));
    await watch.start();

    asked.mockImplementation(refused);
    expect(await watch.check()).toBe('down');
  });

  it('stays absent through any number of silent probes', async () => {
    asked.mockImplementation(refused);
    await watch.start();
    expect(await watch.check()).toBe('absent');
    expect(await watch.check()).toBe('absent');
    expect(warn).not.toHaveBeenCalled();
  });

  it('comes back to ready when the sidecar is started again', async () => {
    asked.mockImplementation(refused);
    await watch.start();

    asked.mockResolvedValue(health(true));
    expect(await watch.check()).toBe('ready');
  });
});

describe('what reaches the console', () => {
  it('says nothing about the first answer, which the banner already carries', async () => {
    asked.mockImplementation(refused);
    await watch.start();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once when the voice goes, not once per probe', async () => {
    asked.mockResolvedValue(health(true));
    await watch.start();

    asked.mockImplementation(refused);
    await watch.check();
    await watch.check();
    await watch.check();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('stopped answering');
  });

  it('logs the recovery rather than leaving the warning as the last word', async () => {
    asked.mockImplementation(refused);
    await watch.start();
    asked.mockResolvedValue(health(true));

    await watch.check();
    expect(String(log.mock.calls[0]?.[0])).toContain('answering');
  });
});

describe('what the panel is told', () => {
  it('reads the watch through the snapshot', async () => {
    asked.mockResolvedValue(health(true));
    const hub = new Hub(null, watch);
    await watch.start();
    expect(hub.snapshot().speech).toBe('ready');
  });

  it('answers absent from a hub that was never given one to watch', () => {
    expect(new Hub().snapshot().speech).toBe('absent');
  });
});

/**
 * One line asked for by every renderer, answered once.
 *
 * This is the part that is about the mouth rather than about speed. Every
 * viewer asks for every line — a muted one included, deliberately, so that its
 * timing matches the one on air — and the sidecar serialises the GPU under a
 * lock. Three renderers meant three passes over the same sentence, one after
 * another, and whichever renderer was served last had already given up and
 * fallen back to the text estimate: the mouth moves and nothing is said, with
 * no fault anywhere to find.
 */

/** A take, as the sidecar would hand it over. `size` distinguishes two of them. */
const take = (size = 8): SidecarReply => ({
  status: 200,
  contentType: 'audio/wav',
  body: Buffer.alloc(size),
});

class TestResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  readonly writeHead = vi.fn();
  readonly end = vi.fn(() => {
    this.writableEnded = true;
  });
}

const response = (destroyed = false): ServerResponse => {
  const res = new TestResponse();
  res.destroyed = destroyed;
  return res as unknown as ServerResponse;
};

describe('asking the sidecar for a line', () => {
  it('asks once for the renderers that all want it at the same moment', async () => {
    asked.mockResolvedValue(take());

    const answers = await Promise.all([
      speak({ text: 'こんばんは' }),
      speak({ text: 'こんばんは' }),
      speak({ text: 'こんばんは' }),
    ]);

    expect(asked).toHaveBeenCalledTimes(1);
    // The same take, not merely an equal one: the model samples, so two passes
    // over one sentence are two different lengths, and a preview showing a
    // different length is a preview that drifts out of step.
    expect(answers[1]).toBe(answers[0]);
    expect(answers[2]).toBe(answers[0]);
    expect(answers[0].status).toBe(200);
  });

  it('lets one renderer leave while the remaining subscribers keep one upstream take', async () => {
    let resolveTake!: (reply: SidecarReply) => void;
    const pending = new Promise<SidecarReply>((resolve) => {
      resolveTake = resolve;
    });
    let upstreamSignal: AbortSignal | undefined;
    asked.mockImplementation(async (_endpoint, _path, request) => {
      upstreamSignal = request.signal;
      return pending;
    });

    const firstController = new AbortController();
    const secondController = new AbortController();
    const thirdController = new AbortController();
    const first = speak({ text: 'shared cancellation' }, firstController.signal);
    const second = speak({ text: 'shared cancellation' }, secondController.signal);
    const third = speak({ text: 'shared cancellation' }, thirdController.signal);
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));

    firstController.abort();
    await expect(first).resolves.toMatchObject({ status: 499, ok: false });
    expect(upstreamSignal?.aborted).toBe(false);

    secondController.abort();
    await expect(second).resolves.toMatchObject({ status: 499, ok: false });
    expect(upstreamSignal?.aborted).toBe(false);

    resolveTake(take(17));
    const answer = await third;
    expect(answer.status).toBe(200);
    expect(answer.body.length).toBe(17);
    expect(upstreamSignal?.aborted).toBe(false);
  });

  it('aborts the upstream work after the last subscriber and protects a replacement flight', async () => {
    let resolveOld!: (reply: SidecarReply) => void;
    const old = new Promise<SidecarReply>((resolve) => {
      resolveOld = resolve;
    });
    let oldSignal: AbortSignal | undefined;
    asked
      .mockImplementationOnce(async (_endpoint, _path, request) => {
        oldSignal = request.signal;
        return old;
      })
      .mockResolvedValueOnce(take(23));

    const controller = new AbortController();
    const abandoned = speak({ text: 'replace me' }, controller.signal);
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(abandoned).resolves.toMatchObject({ status: 499, ok: false });
    expect(oldSignal?.aborted).toBe(true);

    const replacement = await speak({ text: 'replace me' });
    expect(replacement.status).toBe(200);
    expect(replacement.body.length).toBe(23);

    resolveOld(take(4));
    await Promise.resolve();
    await Promise.resolve();
    const cached = await speak({ text: 'replace me' });
    expect(cached).toBe(replacement);
    expect(cached.body.length).toBe(23);
    expect(asked).toHaveBeenCalledTimes(2);
  });

  it('hands the same one back to a renderer that asks a moment later', async () => {
    asked.mockResolvedValue(take());

    const first = await speak({ text: 'a' });
    const second = await speak({ text: 'a' });

    expect(asked).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('goes back to the sidecar for a line it no longer holds', async () => {
    vi.useFakeTimers();
    try {
      asked.mockResolvedValue(take());

      await speak({ text: 'a' });
      vi.advanceTimersByTime(TAKE_TTL_MS + 1);
      await speak({ text: 'a' });

      // Anything this old is a line being said again on purpose, and the voice
      // may have been retuned in between.
      expect(asked).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets the oldest once it is holding more than it will', async () => {
    asked.mockResolvedValue(take());

    await speak({ text: 'first' });
    for (let i = 0; i < TAKE_MAX; i += 1) await speak({ text: `line ${i}` });
    await speak({ text: 'first' });

    expect(asked).toHaveBeenCalledTimes(TAKE_MAX + 2);
  });

  it('keys on what actually goes upstream, which is the reading when there is one', async () => {
    asked.mockResolvedValue(take());

    // Two lines written differently that spell the same pronunciation are one
    // synthesis, because the reading is the only thing the sidecar is told.
    await speak({ text: '一二三', reading: 'ひふみ' });
    await speak({ text: '１２３', reading: 'ひふみ' });
    await speak({ text: 'ひふみ' });

    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked.mock.calls[0]?.[1]).toBe('/speak');
    expect(asked.mock.calls[0]?.[2]).toMatchObject({
      body: JSON.stringify({ text: 'ひふみ' }),
    });
  });

  it('tells two different lines apart', async () => {
    asked.mockImplementation(async (_endpoint, _path, ask) => take(String(ask.body).length));

    const a = await speak({ text: 'short' });
    const b = await speak({ text: 'a considerably longer line' });

    expect(asked).toHaveBeenCalledTimes(2);
    expect(a.body.length).not.toBe(b.body.length);
  });
});

describe('a sidecar that is not there', () => {
  it('refuses empty audio and synthesises the same line again after recovery', async () => {
    asked.mockResolvedValueOnce(take(0)).mockResolvedValueOnce(take());

    const empty = await speak({ text: 'retry empty audio' });
    expect(empty.status).toBe(502);
    expect(empty.ok).toBe(false);

    const recovered = await speak({ text: 'retry empty audio' });
    expect(recovered.status).toBe(200);
    expect(recovered.ok).toBe(true);
    expect(recovered.body.length).toBeGreaterThan(0);
    expect(asked).toHaveBeenCalledTimes(2);
  });

  it('shares one refusal rather than one round trip each', async () => {
    asked.mockImplementation(refused);

    const answers = await Promise.all([speak({ text: 'a' }), speak({ text: 'a' })]);

    expect(asked).toHaveBeenCalledTimes(1);
    expect(answers.map((r) => r.status)).toEqual([503, 503]);
    expect(answers[0].ok).toBe(false);
  });

  it('does not keep the refusal, so a voice that comes up is reached', async () => {
    asked.mockImplementation(refused);
    expect((await speak({ text: 'a' })).status).toBe(503);

    // The model finished loading between one line and the next, which on a
    // machine that has a voice at all is the ordinary case at the top of a run.
    asked.mockResolvedValue(take());
    expect((await speak({ text: 'a' })).status).toBe(200);
    expect(asked).toHaveBeenCalledTimes(2);
  });

  it('reports something else answering there as the sidecar answering badly', async () => {
    asked.mockResolvedValue(wrongService());
    const answer = await speak({ text: 'a' });
    expect(answer.status).toBe(502);
    expect(JSON.parse(answer.body.toString('utf8'))).toMatchObject({ error: expect.any(String) });
  });

  it('refuses and does not cache a 2xx response that is not audio', async () => {
    asked
      .mockResolvedValueOnce({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        // The proxy must not pass a potentially large non-audio body through.
        body: Buffer.alloc(1024 * 1024, 0x78),
      })
      .mockResolvedValueOnce(take());

    const refusedTake = await speak({ text: 'retry me' });
    expect(refusedTake.status).toBe(502);
    expect(refusedTake.ok).toBe(false);
    expect(refusedTake.body.length).toBeLessThan(256);

    const retriedTake = await speak({ text: 'retry me' });
    expect(retriedTake.status).toBe(200);
    expect(retriedTake.ok).toBe(true);
    expect(asked).toHaveBeenCalledTimes(2);
  });
});

describe('an HTTP renderer that goes away mid-synthesis', () => {
  it('cancels its subscriber and does not write after the response closes', async () => {
    let resolveTake!: (reply: SidecarReply) => void;
    const pending = new Promise<SidecarReply>((resolve) => {
      resolveTake = resolve;
    });
    let upstreamSignal: AbortSignal | undefined;
    asked.mockImplementation(async (_endpoint, _path, request) => {
      upstreamSignal = request.signal;
      return pending;
    });

    const res = response();
    const work = handleSpeech(res, { text: 'renderer left' });
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    res.emit('close');

    await expect(work).resolves.toBeUndefined();
    expect(upstreamSignal?.aborted).toBe(true);
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.listenerCount('close')).toBe(0);
    resolveTake(take());
  });

  it('does not cancel a completed response when its close event arrives', async () => {
    asked.mockResolvedValue(take());
    const res = response();

    await handleSpeech(res, { text: 'renderer stayed' });
    const upstreamSignal = asked.mock.calls[0]?.[2].signal;
    expect(upstreamSignal?.aborted).toBe(false);
    expect(res.writeHead).toHaveBeenCalledOnce();
    expect(res.end).toHaveBeenCalledOnce();

    res.emit('close');
    expect(upstreamSignal?.aborted).toBe(false);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('does not start synthesis for a response already closed before the handler starts', async () => {
    asked.mockResolvedValue(take());
    const res = response(true);

    await handleSpeech(res, { text: 'already closed' });

    expect(asked).not.toHaveBeenCalled();
    expect(res.listenerCount('close')).toBe(0);
  });
});
