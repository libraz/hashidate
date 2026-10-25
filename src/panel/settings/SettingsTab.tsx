import { useT } from '@/i18n';
import { LocalePicker } from '@/ui/LocalePicker';
import { Section } from '@/ui/Section';

/**
 * What the operator sets once and then wants out of the way.
 *
 * Off the bar because the bar is read all through a broadcast, and a control
 * touched once a machine has no claim on that space.
 */
export function SettingsTab() {
  const { t } = useT();
  return (
    <Section title={t('locale.label')}>
      <LocalePicker />
    </Section>
  );
}
