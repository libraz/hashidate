import { isTyping } from '@/ui/typing';

/**
 * The panel's keys, for the moments the operator's eyes are on the picture.
 *
 * Stop is Shift+Esc rather than Esc: a bare Esc is pressed by habit to close a
 * popover or abandon an edit, and here it would cut the character off mid-word.
 * Hold is Shift+Space for the same reason — a bare Space presses whichever
 * button has focus. The digits pick a tab in the rail's order.
 */
export type Shortcut = { kind: 'stop' } | { kind: 'hold' } | { kind: 'tab'; index: number };

/** What `aria-keyshortcuts` says, and what a title shows a person. */
export const KEYS = {
  stop: { aria: 'Shift+Escape', shown: 'Shift+Esc' },
  hold: { aria: 'Shift+Space', shown: 'Shift+Space' },
} as const;

/** A title with its key after it, so the binding is found by hovering. */
export const withKey = (title: string, shown: string): string => `${title} (${shown})`;

type KeyLike = Pick<
  KeyboardEvent,
  'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat' | 'isComposing' | 'target'
>;

export function shortcut(event: KeyLike): Shortcut | null {
  // A modifier other than Shift is the browser's or the system's shortcut.
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  // Mid-conversion keys belong to the IME, and a held key would toggle the hold
  // back and forth at the repeat rate.
  if (event.isComposing || event.repeat) return null;
  if (isTyping(event.target)) return null;
  if (event.shiftKey) {
    if (event.key === 'Escape') return { kind: 'stop' };
    if (event.key === ' ') return { kind: 'hold' };
    return null;
  }
  if (/^[1-9]$/.test(event.key)) return { kind: 'tab', index: Number(event.key) - 1 };
  return null;
}
