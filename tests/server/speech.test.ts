import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '@/server/hub';
import { SpeechWatch } from '@/server/speech';

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
