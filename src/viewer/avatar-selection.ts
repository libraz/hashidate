import { AVATARS, DEFAULT_AVATAR_ID, getAvatar } from '@/avatars';
import type { AvatarDescriptor } from '@/engine/types';

/**
 * Which avatar to load, and remembering the choice.
 *
 * Browser policy, not avatar data, which is why it lives here rather than in
 * the registry: the engine must not touch `location`, `localStorage` or
 * `history`, or it stops being runnable outside a page — under a test, or under
 * whatever eventually drives the production stream.
 */

const STORAGE_KEY = 'hashidate.avatar';

/**
 * `?avatar=<id>` wins, so a link can pin one and a reload cannot drift off it.
 * Otherwise the last choice is remembered, because switching is something an
 * operator does while working on one avatar rather than a per-visit decision.
 */
export function initialAvatar(): AvatarDescriptor {
  const fromUrl = new URLSearchParams(location.search).get('avatar');
  const pinned = fromUrl ? getAvatar(fromUrl) : null;
  if (pinned) return pinned;

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const remembered = saved ? getAvatar(saved) : null;
    if (remembered) return remembered;
  } catch {
    // Private-mode storage throws on access; the default is a fine answer.
  }
  return getAvatar(DEFAULT_AVATAR_ID) ?? AVATARS[0];
}

export function rememberAvatar(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Not being able to remember the choice is not worth failing a switch over.
  }
  const url = new URL(location.href);
  url.searchParams.set('avatar', id);
  history.replaceState(null, '', url);
}
