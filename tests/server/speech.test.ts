import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '@/server/hub';
import { forgetTakes, SpeechWatch, speak, TAKE_MAX, TAKE_TTL_MS } from '@/server/speech';

/**
 * Whether the server can tell a machine with no voice from a voice that died.
 *
 * The distinction is the whole feature. A sidecar is missing on almost every
 * machine — it wants a purchased voice and three gigabytes of PyTorch — so a
 * server that warned about every absence would be warning permanently, and the
 * one time it mattered nobody would be reading. What has to be caught is the
 * narrower case: something answered on that port and stopped, which on air is
 * invisible from the panel because the queue still drains and the mouth still
 * moves.
 */

/** A `/health` reply, as `fetch` would hand it over. */
const health = (ready: boolean): Response =>
  ({ ok: true, json: async () => ({ ready }) }) as unknown as Response;

/** Nothing listening: what `fetch` does to a closed port. */
const refused = (): never => {
  throw new Error('connect ECONNREFUSED 127.0.0.1:8770');
};

let watch: SpeechWatch;
let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  watch = new SpeechWatch();
  forgetTakes();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  watch.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('what the watch makes of an answer', () => {
  it('is ready when the sidecar says its model is loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => health(true)),
    );
    expect(await watch.start()).toBe('ready');
    expect(watch.current).toBe('ready');
  });

  it('is loading while the model is still coming up, which is not a fault', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => health(false)),
    );
    expect(await watch.start()).toBe('loading');
  });

  it('is absent when nothing has ever answered', async () => {
    vi.stubGlobal('fetch', vi.fn(refused));
    expect(await watch.start()).toBe('absent');
  });

  it('is absent when something else holds the port', async () => {
    // Not a voice, and the only thing worth reporting about that is the same
    // thing as an empty port: there is no speech here.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response),
    );
    expect(await watch.start()).toBe('absent');
  });

  it('is absent when the answer is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => {
              throw new SyntaxError('Unexpected token');
            },
          }) as unknown as Response,
      ),
    );
    expect(await watch.start()).toBe('absent');
  });
});

describe('the difference between never here and gone', () => {
  it('calls it down once it has answered and then stops', async () => {
    const fetcher = vi.fn(async () => health(true));
    vi.stubGlobal('fetch', fetcher);
    await watch.start();

    fetcher.mockImplementation(refused);
    expect(await watch.check()).toBe('down');
  });

  it('stays absent through any number of silent probes', async () => {
    vi.stubGlobal('fetch', vi.fn(refused));
    await watch.start();
    expect(await watch.check()).toBe('absent');
    expect(await watch.check()).toBe('absent');
    expect(warn).not.toHaveBeenCalled();
  });

  it('comes back to ready when the sidecar is started again', async () => {
    const fetcher = vi.fn(refused as () => Promise<Response>);
    vi.stubGlobal('fetch', fetcher);
    await watch.start();

    fetcher.mockImplementation(async () => health(true));
    expect(await watch.check()).toBe('ready');
  });
});

describe('what reaches the console', () => {
  it('says nothing about the first answer, which the banner already carries', async () => {
    vi.stubGlobal('fetch', vi.fn(refused));
    await watch.start();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once when the voice goes, not once per probe', async () => {
    const fetcher = vi.fn(async () => health(true));
    vi.stubGlobal('fetch', fetcher);
    await watch.start();

    fetcher.mockImplementation(refused);
    await watch.check();
    await watch.check();
    await watch.check();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('stopped answering');
  });

  it('logs the recovery rather than leaving the warning as the last word', async () => {
    const fetcher = vi.fn(refused as () => Promise<Response>);
    vi.stubGlobal('fetch', fetcher);
    await watch.start();
    fetcher.mockImplementation(async () => health(true));

    await watch.check();
    expect(String(log.mock.calls[0]?.[0])).toContain('answering');
  });
});

describe('what the panel is told', () => {
  it('reads the watch through the snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => health(true)),
    );
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
const take = (size = 8): Response =>
  ({
    ok: true,
    headers: { get: () => 'audio/wav' },
    arrayBuffer: async () => new ArrayBuffer(size),
  }) as unknown as Response;

describe('asking the sidecar for a line', () => {
  it('asks once for the renderers that all want it at the same moment', async () => {
    const fetcher = vi.fn(async () => take());
    vi.stubGlobal('fetch', fetcher);

    const answers = await Promise.all([
      speak({ text: 'こんばんは' }),
      speak({ text: 'こんばんは' }),
      speak({ text: 'こんばんは' }),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    // The same take, not merely an equal one: the model samples, so two passes
    // over one sentence are two different lengths, and a preview showing a
    // different length is a preview that drifts out of step.
    expect(answers[1]).toBe(answers[0]);
    expect(answers[2]).toBe(answers[0]);
    expect(answers[0].status).toBe(200);
  });

  it('hands the same one back to a renderer that asks a moment later', async () => {
    const fetcher = vi.fn(async () => take());
    vi.stubGlobal('fetch', fetcher);

    const first = await speak({ text: 'a' });
    const second = await speak({ text: 'a' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('goes back to the sidecar for a line it no longer holds', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => take());
      vi.stubGlobal('fetch', fetcher);

      await speak({ text: 'a' });
      vi.advanceTimersByTime(TAKE_TTL_MS + 1);
      await speak({ text: 'a' });

      // Anything this old is a line being said again on purpose, and the voice
      // may have been retuned in between.
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets the oldest once it is holding more than it will', async () => {
    const fetcher = vi.fn(async () => take());
    vi.stubGlobal('fetch', fetcher);

    await speak({ text: 'first' });
    for (let i = 0; i < TAKE_MAX; i += 1) await speak({ text: `line ${i}` });
    await speak({ text: 'first' });

    expect(fetcher).toHaveBeenCalledTimes(TAKE_MAX + 2);
  });

  it('keys on what actually goes upstream, which is the reading when there is one', async () => {
    const fetcher = vi.fn(async (_url: unknown, _init: unknown) => take());
    vi.stubGlobal('fetch', fetcher);

    // Two lines written differently that spell the same pronunciation are one
    // synthesis, because the reading is the only thing the sidecar is told.
    await speak({ text: '一二三', reading: 'ひふみ' });
    await speak({ text: '１２３', reading: 'ひふみ' });
    await speak({ text: 'ひふみ' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ text: 'ひふみ' }),
    });
  });

  it('tells two different lines apart', async () => {
    const fetcher = vi.fn(async (_url: unknown, init: unknown) =>
      take(String((init as { body: string }).body).length),
    );
    vi.stubGlobal('fetch', fetcher);

    const a = await speak({ text: 'short' });
    const b = await speak({ text: 'a considerably longer line' });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(a.body.length).not.toBe(b.body.length);
  });
});

describe('a sidecar that is not there', () => {
  it('shares one refusal rather than one round trip each', async () => {
    const fetcher = vi.fn(refused as () => Promise<Response>);
    vi.stubGlobal('fetch', fetcher);

    const answers = await Promise.all([speak({ text: 'a' }), speak({ text: 'a' })]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(answers.map((r) => r.status)).toEqual([503, 503]);
    expect(answers[0].ok).toBe(false);
  });

  it('does not keep the refusal, so a voice that comes up is reached', async () => {
    const fetcher = vi.fn(refused as () => Promise<Response>);
    vi.stubGlobal('fetch', fetcher);
    expect((await speak({ text: 'a' })).status).toBe(503);

    // The model finished loading between one line and the next, which on a
    // machine that has a voice at all is the ordinary case at the top of a run.
    fetcher.mockImplementation(async () => take());
    expect((await speak({ text: 'a' })).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports something else on the port as the sidecar answering badly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response),
    );
    const answer = await speak({ text: 'a' });
    expect(answer.status).toBe(502);
    expect(JSON.parse(answer.body.toString('utf8'))).toMatchObject({ error: expect.any(String) });
  });
});
