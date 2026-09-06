// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { History } from '@/panel/queue/History';
import type { HistoryEntry } from '@/protocol';

const api = vi.hoisted(() => ({
  readHistory: vi.fn(),
  queueRewind: vi.fn(),
}));

vi.mock('@/panel/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/panel/api')>();
  return { ...actual, ...api };
});

const historyEntry = (id: string, text: string): HistoryEntry => ({
  id,
  text,
  at: 1_800_000_000,
  saidAt: 1_800_000_060,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('History polling', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    api.queueRewind.mockResolvedValue({ queue: [], viewers: 0 });
  });

  afterEach(() => {
    if (root !== null) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    vi.clearAllMocks();
  });

  const renderHistory = async (refresh = vi.fn()) => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(History, { refresh }));
      await Promise.resolve();
    });
    return refresh;
  };

  it('ignores an old response after close and reopen', async () => {
    const oldResponse = deferred<{ history: HistoryEntry[] }>();
    const newResponse = deferred<{ history: HistoryEntry[] }>();
    api.readHistory
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(newResponse.promise);
    await renderHistory();

    const head = host?.querySelector('button');
    if (!head) throw new Error('history toggle missing');
    await act(async () => {
      head.click();
    });
    await act(async () => {
      head.click();
    });
    await act(async () => {
      head.click();
    });

    await act(async () => {
      oldResponse.resolve({ history: [historyEntry('old', 'stale')] });
      newResponse.resolve({ history: [historyEntry('new', 'current')] });
      await Promise.resolve();
    });

    expect(host?.textContent).toContain('current');
    expect(host?.textContent).not.toContain('stale');
  });

  it('refreshes history once after a successful rewind', async () => {
    api.readHistory.mockResolvedValue({ history: [historyEntry('q1', 'repeat')] });
    const refresh = await renderHistory();
    const head = host?.querySelector('button');
    if (!head) throw new Error('history toggle missing');
    await act(async () => {
      head.click();
      await Promise.resolve();
    });
    api.readHistory.mockClear();
    api.queueRewind.mockClear();

    const rewind = [...(host?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'From here',
    );
    if (!rewind) throw new Error('rewind button missing');
    await act(async () => {
      rewind.click();
      await Promise.resolve();
    });

    expect(api.queueRewind).toHaveBeenCalledOnce();
    expect(api.readHistory).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
