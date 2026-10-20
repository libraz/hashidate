// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ChainSlider } from '@/panel/voice/ChainSlider';

describe('ChainSlider report reconciliation', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let committed: number[] = [];

  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    committed = [];
  });

  const mount = async (reported: number, step = 0.01) => {
    if (host === null) {
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
    }

    await act(async () => {
      root?.render(
        createElement(ChainSlider, {
          label: 'Gain',
          reported,
          min: 0,
          max: 1,
          step,
          onCommit: (value) => committed.push(value),
        }),
      );
    });
  };

  const dragTo = async (value: number) => {
    const input = host?.querySelector<HTMLInputElement>('input[type="range"]');
    if (input === null || input === undefined) throw new Error('slider input missing');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter === undefined) throw new Error('native input value setter missing');

    await act(async () => {
      setter.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const expectDisplay = (value: number) => {
    const input = host?.querySelector<HTMLInputElement>('input[type="range"]');
    const output = host?.querySelector('output');
    expect(input?.value).toBe(String(value));
    expect(output?.textContent).toBe(value.toFixed(2));
  };

  const sendTwoValues = async () => {
    await dragTo(0.2);
    await dragTo(0.7);
    expect(committed).toEqual([0.2, 0.7]);
  };

  it('keeps the latest local value when an older intermediate report arrives', async () => {
    await mount(0.1);
    await sendTwoValues();

    await mount(0.2);

    expectDisplay(0.7);
    expect(committed).toEqual([0.2, 0.7]);
  });

  it('adopts an external return to an earlier sent value after the latest value is reported', async () => {
    await mount(0.1);
    await sendTwoValues();

    await mount(0.7);
    expectDisplay(0.7);
    await mount(0.2);

    expectDisplay(0.2);
    expect(committed).toEqual([0.2, 0.7]);
  });

  it('releases the drag on a Float32 echo of the latest sent value', async () => {
    await mount(0.1);
    await sendTwoValues();

    await mount(Math.fround(0.7));
    expectDisplay(Math.fround(0.7));
    await mount(0.2);

    expectDisplay(0.2);
    expect(committed).toEqual([0.2, 0.7]);
  });

  it('releases the drag on an exact latest echo when step is zero', async () => {
    await mount(0.1, 0);
    await dragTo(0.2);
    await dragTo(0.7);
    expect(committed).toEqual([0.2, 0.7]);

    await mount(0.7, 0);
    await mount(0.2, 0);

    expectDisplay(0.2);
    expect(committed).toEqual([0.2, 0.7]);
  });
});
