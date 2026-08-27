import type { Locale } from '../locale';
import { commonEn, commonJa } from './common';
import { consoleEn, consoleJa } from './console';
import { panelEn, panelJa } from './panel';

/**
 * English is the key set.
 *
 * Not because it is the more important language, but because something has to
 * be, and every other catalogue is then typed as `Record<keyof typeof …En,
 * string>`. That one line is the whole parity check: a key added to English and
 * forgotten in Japanese is a type error at the file that forgot it, rather than
 * a button that silently renders its own key at three in the morning.
 */
export const EN = {
  ...commonEn,
  ...panelEn,
  ...consoleEn,
} as const;

export type MessageKey = keyof typeof EN;

const JA: Record<MessageKey, string> = {
  ...commonJa,
  ...panelJa,
  ...consoleJa,
};

export const CATALOGS: Record<Locale, Record<MessageKey, string>> = {
  en: EN,
  ja: JA,
};
