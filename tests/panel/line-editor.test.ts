// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { type LineDraft, LineEditor, lineEditorKeyAction } from '@/panel/queue/LineEditor';

const keyEvent = (
  key: string,
  overrides: Partial<Parameters<typeof lineEditorKeyAction>[0]> = {},
) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  ...overrides,
});

describe('LineEditor keyboard decisions', () => {
  it('does not cancel while Escape belongs to an active IME composition', () => {
    expect(lineEditorKeyAction(keyEvent('Escape', { isComposing: true }))).toBeNull();
  });

  it('cancels on Escape after composition has ended', () => {
    expect(lineEditorKeyAction(keyEvent('Escape'))).toBe('cancel');
  });

  it('keeps modified Enter as the submit shortcut', () => {
    expect(lineEditorKeyAction(keyEvent('Enter', { metaKey: true }))).toBe('submit');
    expect(lineEditorKeyAction(keyEvent('Enter', { ctrlKey: true }))).toBe('submit');
  });
});

describe('LineEditor commits', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (root !== null) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    host = null;
  });

  it('sends explicit edit clears while leaving unrelated fields out of the patch', async () => {
    let submitted: LineDraft | null = null;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        createElement(LineEditor, {
          initial: { text: 'hello', reading: 'kana', perform: 'wave', hold: true },
          vocabulary: {},
          editing: true,
          submitLabel: 'Save',
          onSubmit: (draft) => {
            submitted = draft;
          },
          onCancel: () => {},
        }),
      );
    });

    const reading = host.querySelectorAll('input').item(0);
    const hold = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!(reading && hold)) throw new Error('editor inputs missing');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(reading, '   ');
      reading.dispatchEvent(new Event('input', { bubbles: true }));
      hold.click();
      host?.querySelectorAll('button').item(0)?.click();
    });

    const none = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'None',
    );
    if (!none) throw new Error('performance clear button missing');
    const formHost = host;
    await act(async () => {
      none.click();
    });
    await act(async () => {
      const save = [...formHost.querySelectorAll('button')].find(
        (button) => button.textContent === 'Save',
      );
      save?.click();
    });

    expect(submitted).toEqual({ text: 'hello', reading: null, perform: null, hold: false });
  });

  it('keeps a failed draft and prevents a second submission while the first is pending', async () => {
    let calls = 0;
    let release: ((value: { error: string }) => void) | null = null;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        createElement(LineEditor, {
          initial: { text: 'hello', reading: 'kana' },
          vocabulary: {},
          editing: true,
          submitLabel: 'Save',
          onSubmit: () => {
            calls += 1;
            return new Promise<{ error: string }>((resolve) => {
              release = resolve;
            });
          },
          onCancel: () => {},
        }),
      );
    });

    const save = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save',
    );
    if (!save) throw new Error('save button missing');
    const reading = host.querySelectorAll('input').item(0);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(reading, '[');
    reading?.dispatchEvent(new Event('input', { bubbles: true }));
    await act(async () => {
      save.click();
      save.click();
    });
    expect(calls).toBe(1);
    expect(save.disabled).toBe(true);

    await act(async () => {
      release?.({ error: 'invalid patch' });
      await Promise.resolve();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('invalid patch');
    expect(host.querySelector('textarea')?.value).toBe('hello');
  });
});
