import { afterEach, describe, expect, it, vi } from 'vitest';

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalLocale = process.env.HASHIDATE_LOCALE;

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }

  if (originalLocale === undefined) {
    delete process.env.HASHIDATE_LOCALE;
  } else {
    process.env.HASHIDATE_LOCALE = originalLocale;
  }

  vi.resetModules();
});

describe('locale storage access', () => {
  it('keeps detection and locale changes working when accessing storage throws', async () => {
    process.env.HASHIDATE_LOCALE = 'ja';
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage is blocked');
      },
    });

    vi.resetModules();
    const { getLocale, setLocale, subscribeLocale } = await import('@/i18n/locale');
    expect(getLocale()).toBe('ja');

    const listener = vi.fn();
    const unsubscribe = subscribeLocale(listener);
    try {
      expect(() => setLocale('en')).not.toThrow();
      expect(getLocale()).toBe('en');
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('notifies subscribers when persisting a locale hits a throwing storage getter', async () => {
    vi.resetModules();
    const { getLocale, setLocale, subscribeLocale } = await import('@/i18n/locale');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage is blocked');
      },
    });

    const listener = vi.fn();
    const unsubscribe = subscribeLocale(listener);
    const next = getLocale() === 'en' ? 'ja' : 'en';
    try {
      expect(() => setLocale(next)).not.toThrow();
      expect(getLocale()).toBe(next);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });
});
