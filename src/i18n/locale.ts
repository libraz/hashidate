/**
 * Which language the operator is being addressed in.
 *
 * Two, and deliberately only two. The panel and the console are the surfaces a
 * person drives a stream from, so the labels have to be readable at a glance
 * rather than merely present; a locale nobody proof-reads is worse than an
 * English fallback, because a half-translated button looks like a bug in the
 * renderer rather than a gap in a catalogue.
 */
export const LOCALES = ['en', 'ja'] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * A string that exists in both languages at the point it is defined.
 *
 * Used for the avatar-derived vocabulary — wardrobe slots, performances,
 * backdrops, camera frames — rather than the message catalogue. Those labels
 * belong next to the data that produces them: a wardrobe slot is discovered
 * from an avatar's meshes, so its name arrives with the avatar and would go
 * stale the moment it were copied into a catalogue keyed by hand.
 *
 * It also has to survive the wire. The panel never imports the avatar tables —
 * it learns the vocabulary from the control server — so both languages travel
 * together and the client picks one, instead of the server guessing which
 * language the person watching the panel reads.
 */
export interface Localized {
  en: string;
  ja: string;
}

/** Resolve a two-language value against the locale in force. */
export function pick(text: Localized, locale: Locale): string {
  return text[locale];
}

/**
 * A label that reads the same in both languages.
 *
 * Not laziness — most of these cannot be translated at all. Expression and
 * overlay names are *discovered* from an avatar's own shape keys, so the label
 * is whatever the model's author typed into Blender, and a product name is a
 * product name. Saying so with a helper keeps those cases visibly distinct from
 * a pair that simply has not been filled in yet.
 */
export function same(text: string): Localized {
  return { en: text, ja: text };
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

const STORAGE_KEY = 'hashidate.locale';

/**
 * The default when nothing has been chosen and nothing can be detected.
 *
 * English, because that is what the code, the CLI and the logs are already in.
 * A browser that reports Japanese overrides it below; a terminal does not, and
 * a terminal is where the fallback actually lands.
 */
const FALLBACK: Locale = 'en';

function fromStorage(): Locale | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isLocale(stored) ? stored : null;
  } catch {
    // Private-mode Safari throws on access rather than returning null.
    return null;
  }
}

function fromNavigator(): Locale | null {
  if (typeof navigator === 'undefined') return null;
  for (const tag of navigator.languages ?? [navigator.language]) {
    // Match on the primary subtag: `ja`, `ja-JP` and `ja-JP-u-ca-japanese`
    // are all the same answer to the only question being asked here.
    const primary = tag.split('-')[0]?.toLowerCase();
    if (isLocale(primary)) return primary;
  }
  return null;
}

function fromEnv(): Locale | null {
  if (typeof process === 'undefined') return null;
  const raw = process.env?.HASHIDATE_LOCALE;
  return isLocale(raw) ? raw : null;
}

/**
 * An explicit choice outranks a detected one, and detection outranks the
 * fallback. `HASHIDATE_LOCALE` sits between the two so that a script can pin the
 * language of a CLI run without writing to anyone's browser storage.
 */
function detect(): Locale {
  return fromStorage() ?? fromEnv() ?? fromNavigator() ?? FALLBACK;
}

let current: Locale = detect();
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

/**
 * Switch language for everything on the page at once.
 *
 * Persisted, because the alternative is a panel that reverts every time the
 * operator reloads mid-stream, and re-entrant-safe: the store is read through
 * `useSyncExternalStore`, so React re-renders from the subscription rather than
 * from whatever component happened to call this.
 */
export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not being able to remember the choice is not a reason to refuse it.
    }
  }
  for (const listener of [...listeners]) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Re-run detection from scratch.
 *
 * Only the tests need this — the store is module state, and a suite that
 * switches locale in one case would otherwise leak it into the next.
 */
export function resetLocale(): void {
  current = detect();
  for (const listener of [...listeners]) listener();
}
