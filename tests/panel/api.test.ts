import { afterEach, describe, expect, it, vi } from 'vitest';
import { isFailure, queuePop, queueShift } from '@/panel/api';
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
});
