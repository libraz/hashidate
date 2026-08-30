import { getLocale, type Localized, pick } from '../i18n/locale';

/**
 * What this client prints.
 *
 * Two functions, because there are only two kinds of output: the JSON a command
 * came back with, and a label that arrived in both languages.
 */

export function show(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * A two-language label, printed in one of them.
 *
 * The wire carries both. This is a terminal, and everything else it prints is
 * English, so it takes the locale in force — which falls back to English when
 * nothing has said otherwise.
 */
export const localized = (text: Localized): string => pick(text, getLocale());
