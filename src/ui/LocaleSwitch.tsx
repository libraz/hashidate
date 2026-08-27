import { LOCALES, useLocale, useT } from '@/i18n';
import styles from './LocaleSwitch.module.css';

/**
 * The one control that is never translated.
 *
 * Each option is written in the language it selects — `English` and `日本語` —
 * because the person who needs it is by definition looking at a language they
 * did not want. Labelling the Japanese option "Japanese" would only be readable
 * to someone who was already fine.
 *
 * A grouped pair of buttons rather than the segmented picker: that one is a
 * tablist, and this switches nothing that behaves like a tab. `fieldset` is the
 * element that carries grouping natively, so it is used instead of a `div` with
 * `role="group"` bolted on.
 */
export function LocaleSwitch() {
  const [locale, choose] = useLocale();
  const { t } = useT();

  return (
    <fieldset className={styles.track} aria-label={t('locale.label')}>
      {LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === locale}
          className={`${styles.option} ${option === locale ? styles.on : ''}`}
          onClick={() => choose(option)}
        >
          {option === 'en' ? 'English' : '日本語'}
        </button>
      ))}
    </fieldset>
  );
}
