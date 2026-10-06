// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY } from '@/panel/hooks';
import { QueueTab } from '@/panel/queue/QueueTab';
import type { QueueEntry } from '@/protocol';

const api = vi.hoisted(() => ({
  queueMove: vi.fn(),
  queueAdd: vi.fn(),
  queueUpdate: vi.fn(),
  readScripts: vi.fn(),
}));

vi.mock('@/panel/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/panel/api')>();
  return { ...actual, ...api };
});

const entry = (id: string, text: string): QueueEntry => ({ id, text, at: 1_800_000_000 });

describe('QueueTab drag and edit boundaries', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    api.queueMove.mockResolvedValue({ queue: [], viewers: 0 });
    api.queueAdd.mockResolvedValue({ queue: [], viewers: 0 });
    api.queueUpdate.mockResolvedValue({ queue: [], viewers: 0 });
    api.readScripts.mockResolvedValue({ scripts: [], errors: [] });
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

  const renderQueue = async (queue: QueueEntry[]) => {
    if (host === null) {
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
    }
    await act(async () => {
      root?.render(
        createElement(QueueTab, {
          snapshot: { ...EMPTY, queue },
          refresh: () => {},
        }),
      );
      await Promise.resolve();
    });
  };

  const dragEvent = (type: string, clientY = 0): Event => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clientY', { value: clientY });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        effectAllowed: '',
        dropEffect: '',
        setData: vi.fn(),
      },
    });
    return event;
  };

  it('commits one move from a row drop and lets dragend only clean up', async () => {
    await renderQueue([entry('q1', 'first'), entry('q2', 'second')]);
    const rows = host?.querySelectorAll('li[draggable]');
    if (rows?.length !== 2) throw new Error('queue rows missing');

    await act(async () => {
      rows[0].dispatchEvent(dragEvent('dragstart'));
    });
    await act(async () => {
      rows[1].dispatchEvent(dragEvent('dragover', 0));
    });
    await act(async () => {
      rows[1].dispatchEvent(dragEvent('drop', 0));
      await Promise.resolve();
    });

    expect(api.queueMove).toHaveBeenCalledOnce();
    expect(api.queueMove).toHaveBeenCalledWith('q1', 1);
  });

  it('does not call the move API when a drag is cancelled outside the list', async () => {
    await renderQueue([entry('q1', 'first'), entry('q2', 'second')]);
    const row = host?.querySelector('li[draggable]');
    if (!row) throw new Error('queue row missing');

    await act(async () => {
      row.dispatchEvent(dragEvent('dragstart'));
      row.dispatchEvent(dragEvent('dragend'));
    });

    expect(api.queueMove).not.toHaveBeenCalled();
  });

  it('keeps an open draft, with a notice, when its entry leaves the queue', async () => {
    await renderQueue([entry('q1', 'first'), entry('q2', 'second')]);
    const edit = host?.querySelector<HTMLButtonElement>('li[draggable] button[title="Edit"]');
    const buttons = [...(host?.querySelectorAll('li[draggable] button') ?? [])];
    const open = edit ?? buttons.find((b) => b.getAttribute('title')?.match(/edit/i));
    if (!open) throw new Error('edit button missing');
    await act(async () => {
      (open as HTMLButtonElement).click();
    });
    const area = host?.querySelector('textarea');
    if (!area) throw new Error('editor missing');
    expect(area.value).toBe('first');

    // The line went on air: no longer pending.
    await renderQueue([entry('q2', 'second')]);
    expect(host?.querySelector('textarea')?.value).toBe('first');
    expect(host?.querySelector('textarea')).toBe(area);

    // Saving it adds it again rather than updating an id nothing holds.
    const submit = [...(host?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Add to the end',
    );
    await act(async () => {
      submit?.click();
      await Promise.resolve();
    });
    expect(api.queueUpdate).not.toHaveBeenCalled();
    expect(api.queueAdd).toHaveBeenCalledOnce();
    expect(host?.querySelector('textarea')).toBeNull();
  });
});
