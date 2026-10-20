// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LineEditor } from '@/panel/queue/LineEditor';

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.unstubAllGlobals();
});

it.each(['metaKey', 'ctrlKey'] as const)(
  'leaves %s+Enter to the IME until composition ends',
  async (modifier) => {
    const onSubmit = vi.fn();
    await act(async () => {
      root?.render(
        createElement(LineEditor, {
          initial: { text: '変換中の台詞' },
          vocabulary: {},
          submitLabel: 'Save',
          onSubmit,
          onCancel: vi.fn(),
        }),
      );
    });
    const area = host.querySelector('textarea');
    if (area === null) throw new Error('editor textarea missing');
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter',
      [modifier]: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      area.dispatchEvent(composing);
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(composing.defaultPrevented).toBe(false);

    const completed = new KeyboardEvent('keydown', {
      key: 'Enter',
      [modifier]: true,
      isComposing: false,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      area.dispatchEvent(completed);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ text: '変換中の台詞' });
    expect(completed.defaultPrevented).toBe(true);
  },
);
