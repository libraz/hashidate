import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bloom,
  isFailure,
  queuePop,
  queueShift,
  queueUpdate,
  readError,
  readScripts,
} from '@/panel/api';
import { queueResponseSchema } from '@/protocol';

const response = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('panel queue response adapter', () => {
  it('keeps an omitted entry optional for non-removing queue operations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ queue: [], viewers: 1 })));

    const result = await queueShift();

    expect(isFailure(result)).toBe(false);
    if (isFailure(result)) return;
    expect(result.entry).toBeUndefined();
    expect(queueResponseSchema.parse(result)).toEqual(result);
  });

  it('preserves an explicit null entry when nothing was removed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ queue: [], viewers: 1, entry: null })),
    );

    const result = await queuePop();

    expect(isFailure(result)).toBe(false);
    if (isFailure(result)) return;
    expect(result.entry).toBeNull();
    expect(queueResponseSchema.parse(result)).toEqual(result);
  });

  it('sends null reading so an edit can clear the stored pronunciation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ queue: [], viewers: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await queueUpdate('q1', { text: 'line', reading: null, perform: null, hold: false });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      id: 'q1',
      text: 'line',
      reading: null,
      perform: null,
      hold: false,
    });
  });

  it('sends bloom false as a named command field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await bloom({ enabled: false });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/command',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ cmd: 'bloom', enabled: false }),
      }),
    );
  });
});

describe('a failed read', () => {
  it('is marked unreachable when the server never answered, and says nothing of it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const result = await readScripts();

    expect(isFailure(result)).toBe(true);
    if (!isFailure(result)) return;
    expect(result.unreachable).toBe(true);
    expect(readError(result)).toBeNull();
  });

  it('keeps a refusal from a server that did answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'scripts directory unreadable' }), { status: 500 }),
        ),
    );

    const result = await readScripts();

    expect(isFailure(result)).toBe(true);
    if (!isFailure(result)) return;
    expect(result.unreachable).toBeUndefined();
    expect(readError(result)).toBe('scripts directory unreadable');
  });
});
