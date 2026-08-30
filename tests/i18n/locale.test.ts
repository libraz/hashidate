import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLocale,
  isLocale,
  LOCALES,
  type Localized,
  pick,
  resetLocale,
  same,
  setLocale,
  subscribeLocale,
} from '@/i18n/locale';
import { CATALOGS, EN } from '@/i18n/messages';
import { translate } from '@/i18n/translate';

/**
 * The language the operator is addressed in.
 *
 * Two things are being protected here. One is that every message exists in both
 * languages, because the failure mode of a missing key is a button that renders
 * nothing at all. The other is that switching is a single store the whole page
 * reads, so that a stream is never half in one language.
 */

afterEach(() => {
  resetLocale();
});

describe('the catalogues', () => {
  it('says everything in both languages', () => {
    for (const key of Object.keys(EN) as Array<keyof typeof EN>) {
      for (const locale of LOCALES) {
        const text = CATALOGS[locale][key];
        expect(text, `${locale}: ${key}`).toBeTruthy();
      }
    }
  });

  it('keeps the placeholders a message declares', () => {
    // A translation that drops `{viewers}` loses the number rather than the
    // word, and reads as a working status line while saying nothing.
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(EN) as Array<keyof typeof EN>) {
      expect(placeholders(CATALOGS.ja[key]), key).toEqual(placeholders(CATALOGS.en[key]));
    }
  });

  it('includes the BGM controls in both operator languages', () => {
    expect(CATALOGS.en['panel.tabs.bgm']).toBe('BGM');
    expect(CATALOGS.ja['panel.tabs.bgm']).toBe('BGM');
    expect(CATALOGS.en['panel.bgm.effects.note']).toContain('Voice effects');
    expect(CATALOGS.ja['panel.bgm.effects.note']).toContain('声');
  });
});

describe('translate', () => {
  it('fills a placeholder', () => {
    expect(translate('panel.status.connected', 'en', { viewers: 3 })).toBe('Connected 3');
    expect(translate('panel.status.connected', 'ja', { viewers: 3 })).toBe('接続 3');
  });

  it('leaves a placeholder it was given nothing for', () => {
    // Better a visible `{viewers}` than the word silently disappearing: the
    // first is reported, the second is read as the truth.
    expect(translate('panel.status.connected', 'en')).toBe('Connected {viewers}');
    expect(translate('panel.status.connected', 'en', { other: 1 })).toBe('Connected {viewers}');
  });
});

describe('localized values', () => {
  it('picks the side asked for', () => {
    const label: Localized = { en: 'Bust', ja: 'バスト' };
    expect(pick(label, 'en')).toBe('Bust');
    expect(pick(label, 'ja')).toBe('バスト');
  });

  it('carries a name that cannot be translated through both sides', () => {
    expect(same('F_NIKONIKO')).toEqual({ en: 'F_NIKONIKO', ja: 'F_NIKONIKO' });
  });
});

describe('the store', () => {
  it('defaults to English away from a browser', () => {
    // Which is where the CLI runs, and the CLI's output is English throughout.
    expect(getLocale()).toBe('en');
  });

  it('tells every subscriber once per change', () => {
    const listener = vi.fn();
    const stop = subscribeLocale(listener);

    setLocale('ja');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getLocale()).toBe('ja');

    // Setting the locale already in force is not a change, and a re-render of
    // the whole panel mid-line is not free.
    setLocale('ja');
    expect(listener).toHaveBeenCalledTimes(1);

    stop();
    setLocale('en');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('isLocale', () => {
  it('accepts only the two that exist', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('ja')).toBe(true);
    for (const raw of ['EN', 'ja-JP', 'fr', '', null, undefined, 3]) {
      expect(isLocale(raw), String(raw)).toBe(false);
    }
  });
});
