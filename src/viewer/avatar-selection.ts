import type { AvatarDescriptor } from '@/engine/types';

/**
 * Which avatar to load, and remembering the choice.
 *
 * Browser policy, not avatar data, which is why it lives here rather than in
 * the engine: the engine must not touch `location`, `localStorage` or
 * `history`, or it stops being runnable outside a page — under a test, or under
 * whatever eventually drives the production stream.
 */

const STORAGE_KEY = 'hashidate.avatar';

/** The ids that may win over the server's order; each is null when absent. */
export interface AvatarPreference {
  /** An `avatar` command that arrived before the roster did. */
  pending: string | null;
  /** `?avatar=<id>`. */
  pinned: string | null;
  /** The last choice made on this machine. */
  remembered: string | null;
}

/**
 * The first preference the roster actually contains, else its first entry.
 *
 * Server order is the default and is not re-sorted. A preference naming an
 * avatar that is not there falls through rather than blocking the load; an
 * empty roster answers null, and the stage stays empty.
 */
export function chooseAvatar(
  roster: readonly AvatarDescriptor[],
  { pending, pinned, remembered }: AvatarPreference,
): AvatarDescriptor | null {
  for (const id of [pending, pinned, remembered]) {
    const found = id ? roster.find((a) => a.id === id) : undefined;
    if (found) return found;
  }
  return roster[0] ?? null;
}

/**
 * `?avatar=<id>` wins over the remembered choice, so a link can pin one and a
 * reload cannot drift off it.
 */
export function pinnedAvatar(): string | null {
  return new URLSearchParams(location.search).get('avatar') || null;
}

/**
 * The last choice is remembered, because switching is something an operator
 * does while working on one avatar rather than a per-visit decision.
 */
export function rememberedAvatar(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    // Private-mode storage throws on access; the default is a fine answer.
    return null;
  }
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
