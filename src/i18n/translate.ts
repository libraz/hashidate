import type { Locale } from './locale';
import { CATALOGS, type MessageKey } from './messages';

export type Params = Record<string, string | number>;

/**
 * Placeholders are `{name}`, and there is no plural machinery.
 *
 * Neither language here needs one: Japanese does not inflect for number, and
 * the only English counts on these surfaces sit next to their own noun in a
 * status line — "Connected 3" — where a plural rule would have nothing to
 * choose between. A catalogue that grows a case the format cannot express is a
 * reason to reword the message, not to grow a formatter.
 */
export function translate(key: MessageKey, locale: Locale, params?: Params): string {
  const template = CATALOGS[locale][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}
