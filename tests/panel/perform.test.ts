// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { same } from '@/i18n/locale';
import { blend, type HeldBlend, settleBlend } from '@/panel/perform/blend';
import type { Snapshot } from '@/protocol';

const sent = vi.hoisted(() => ({ perform: [] as Array<string | null>, resets: 0 }));

vi.mock('@/panel/api', async (original) => ({
  ...(await original<typeof import('@/panel/api')>()),
  perform: async (id: string | null) => {
    sent.perform.push(id);
  },
  resetFace: async () => {
    sent.resets += 1;
  },
}));

const { PerformTab } = await import('@/panel/perform/PerformTab');

describe('blend', () => {
  it('does not resend an earlier weight from a report that is a poll behind', () => {
    const held: HeldBlend = {};
    const first = blend({}, held, 'joy', 0.8);
    expect(first).toEqual({ joy: 0.8 });
    // The report still shows nothing when the second mood moves.
    const second = blend({}, held, 'anger', 0.3);
    expect(second).toEqual({ joy: 0.8, anger: 0.3 });
  });

  it('lets the report take over once it settles or disagrees', () => {
    const held: HeldBlend = {};
    blend({}, held, 'joy', 0.8);
    settleBlend(held, { joy: 0.8 });
    expect(held).toEqual({});

    blend({}, held, 'joy', 0.8);
    settleBlend(held, { joy: 0.1 });
    expect(blend({ joy: 0.1 }, held, 'anger', 0.3)).toEqual({ joy: 0.1, anger: 0.3 });
  });

  it('keeps an older echo of the drag held', () => {
    const held: HeldBlend = {};
    blend({}, held, 'joy', 0.2);
    blend({}, held, 'joy', 0.9);
    settleBlend(held, { joy: 0.2 });
    expect(held.joy).toEqual([0.2, 0.9]);
  });

  it('falls back to neutral when everything is zero', () => {
    expect(blend({ joy: 1 }, {}, 'joy', 0)).toEqual({ neutral: 1 });
  });
});

describe('the lit performance chip', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    root = null;
    host?.remove();
    sent.perform.length = 0;
    sent.resets = 0;
  });

  it('releases the performance rather than resetting the whole face', async () => {
    const snapshot = {
      vocabulary: {
        performances: [
          {
            id: 'hello',
            label: same('hello-chip'),
            group: 'greeting',
            emotion: {},
            gesture: null,
            hop: null,
            sustain: false,
          },
        ],
      },
      state: { performance: 'hello' },
    } as unknown as Snapshot;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(PerformTab, { snapshot, refresh: () => {} }));
    });
    const chip = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('hello-chip'),
    );
    expect(chip).toBeDefined();
    await act(async () => {
      chip?.click();
    });
    expect(sent.perform).toEqual([null]);
    expect(sent.resets).toBe(0);
  });
});
