// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { type Shortcut, shortcut } from '@/panel/shortcuts';

/**
 * The panel's keys.
 *
 * Each binding is a stop, a hold or a tab change made without looking, so the
 * cases that matter as much as the bindings are the ones that must do nothing:
 * a key typed into a field, a key the IME is still converting, a key held down,
 * and anything with a modifier that belongs to the browser.
 */

type Target = 'body' | 'input' | 'textarea' | 'editable';
type Modifier = 'none' | 'ctrl' | 'meta' | 'alt';

function element(target: Target): HTMLElement {
  if (target === 'input') return document.createElement('input');
  if (target === 'textarea') return document.createElement('textarea');
  const div = document.createElement('div');
  if (target === 'editable') div.contentEditable = 'true';
  return div;
}

function press(
  key: string,
  over: {
    shift?: boolean;
    modifier?: Modifier;
    repeat?: boolean;
    composing?: boolean;
    target?: Target;
  } = {},
): Shortcut | null {
  const modifier = over.modifier ?? 'none';
  return shortcut({
    key,
    shiftKey: over.shift ?? false,
    ctrlKey: modifier === 'ctrl',
    metaKey: modifier === 'meta',
    altKey: modifier === 'alt',
    repeat: over.repeat ?? false,
    isComposing: over.composing ?? false,
    target: element(over.target ?? 'body'),
  });
}

describe('the panel shortcuts', () => {
  it('stop on Shift+Esc and hold on Shift+Space', () => {
    expect(press('Escape', { shift: true })).toEqual({ kind: 'stop' });
    expect(press(' ', { shift: true })).toEqual({ kind: 'hold' });
  });

  it('leave a bare Esc and a bare Space alone', () => {
    expect(press('Escape')).toBeNull();
    expect(press(' ')).toBeNull();
  });

  it('pick a tab with 1 to 9, and nothing with 0', () => {
    expect(press('1')).toEqual({ kind: 'tab', index: 0 });
    expect(press('9')).toEqual({ kind: 'tab', index: 8 });
    expect(press('0')).toBeNull();
  });

  it('do not stop or hold again while the key is held down', () => {
    expect(press('Escape', { shift: true, repeat: true })).toBeNull();
    expect(press(' ', { shift: true, repeat: true })).toBeNull();
  });

  // Pairwise over key × shift × modifier × repeat × composing × target, from a
  // generated covering array; the expected value is the rule restated.
  const rows: Array<[string, boolean, Modifier, boolean, boolean, Target]> = [
    ['0', true, 'none', false, true, 'input'],
    [' ', false, 'none', true, false, 'body'],
    ['Escape', true, 'meta', true, true, 'body'],
    ['a', false, 'ctrl', false, true, 'textarea'],
    ['9', true, 'alt', true, true, 'editable'],
    ['1', true, 'alt', true, false, 'textarea'],
    ['1', false, 'meta', false, true, 'editable'],
    ['a', true, 'ctrl', true, false, 'input'],
    ['9', false, 'meta', false, false, 'input'],
    ['0', false, 'none', true, false, 'editable'],
    ['Escape', true, 'alt', false, false, 'body'],
    ['0', false, 'ctrl', false, false, 'body'],
    ['Escape', false, 'none', false, true, 'textarea'],
    ['a', false, 'none', false, false, 'body'],
    ['Escape', false, 'alt', false, false, 'input'],
    [' ', true, 'meta', true, true, 'body'],
    ['a', true, 'meta', true, false, 'textarea'],
    ['0', false, 'meta', true, true, 'textarea'],
    ['a', false, 'alt', true, false, 'editable'],
    [' ', true, 'none', false, false, 'textarea'],
    ['Escape', false, 'ctrl', false, false, 'editable'],
    ['1', false, 'ctrl', false, true, 'input'],
    ['1', true, 'none', false, true, 'body'],
    ['9', true, 'none', true, false, 'input'],
    [' ', true, 'alt', false, true, 'editable'],
    ['9', false, 'ctrl', false, true, 'body'],
    ['9', false, 'none', false, false, 'textarea'],
    [' ', false, 'ctrl', true, false, 'textarea'],
    [' ', false, 'none', true, false, 'input'],
    ['0', true, 'alt', false, true, 'body'],
  ];

  it.each(rows)(
    'key %j shift=%s modifier=%s repeat=%s composing=%s in %s',
    (key, shift, modifier, repeat, composing, target) => {
      const quiet = modifier !== 'none' || repeat || composing || target !== 'body';
      let expected: Shortcut | null = null;
      if (!quiet && shift && key === 'Escape') expected = { kind: 'stop' };
      else if (!quiet && shift && key === ' ') expected = { kind: 'hold' };
      else if (!(quiet || shift) && /^[1-9]$/.test(key))
        expected = { kind: 'tab', index: Number(key) - 1 };
      expect(press(key, { shift, modifier, repeat, composing, target })).toEqual(expected);
    },
  );
});
