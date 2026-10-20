/**
 * Whether a keystroke is somebody typing.
 *
 * Every page-wide key binding asks this first, so a field that has focus keeps
 * its own keys — the caret's arrows, a digit typed into a page number.
 */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
