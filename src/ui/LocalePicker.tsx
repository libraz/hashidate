import { isLocale, LOCALE_NAMES, LOCALES, useLocale, useT } from '@/i18n';
import { Select } from './Select';

/**
 * The one control that is never translated.
 *
 * Each option is written in the language it selects (see `LOCALE_NAMES`). A
 * menu rather than a row of buttons, so a third locale is one more option and
 * not a wider header.
 */
export function LocalePicker({ id }: { id?: string }) {
  const [locale, choose] = useLocale();
  const { t } = useT();

  return (
    <Select
      id={id}
      ariaLabel={id ? undefined : t('locale.label')}
      value={locale}
      onChange={(value) => {
        if (isLocale(value)) choose(value);
      }}
      options={LOCALES.map((option) => ({ value: option, label: LOCALE_NAMES[option] }))}
    />
  );
}
