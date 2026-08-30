import { describe, expect, it } from 'vitest';
import { lineEditorKeyAction } from '@/panel/queue/LineEditor';

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
