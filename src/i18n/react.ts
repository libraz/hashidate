import { useCallback, useSyncExternalStore } from 'react';
import { getLocale, type Locale, type Localized, pick, setLocale, subscribeLocale } from './locale';
import type { MessageKey } from './messages';
import { type Params, translate } from './translate';

/**
 * No provider.
 *
 * The locale is one value for the whole page, it is read from module state that
 * already survives a remount, and there is exactly one writer. A context would
 * add a wrapper to both entry points and a way to render half the tree in the
 * wrong language, and buy nothing: `useSyncExternalStore` subscribes each
 * consumer directly and re-renders only what actually asked for a string.
 */
export function useLocale(): [Locale, (next: Locale) => void] {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return [locale, setLocale];
}

export interface Translator {
  /** A message from the catalogue, by key. */
  t: (key: MessageKey, params?: Params) => string;
  /** A two-language value that arrived with the data, usually over the wire. */
  tx: (text: Localized) => string;
  locale: Locale;
}

export function useT(): Translator {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  const t = useCallback(
    (key: MessageKey, params?: Params) => translate(key, locale, params),
    [locale],
  );
  const tx = useCallback((text: Localized) => pick(text, locale), [locale]);
  return { t, tx, locale };
}
