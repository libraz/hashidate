import { afterEach, describe, expect, it, vi } from 'vitest';
import { isFailure, queuePop, queueShift, queueUpdate } from '@/panel/api';
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
});
