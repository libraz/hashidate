import { useT } from '@/i18n';
import type { Snapshot } from '@/protocol';
import { Chip, ChipRow } from '@/ui/Chip';
import { Field } from '@/ui/Field';
import { Section } from '@/ui/Section';
import { wear, wearPreset } from '../api';

/**
 * The wardrobe.
 *
 * Entirely avatar-derived, on both sides: the slots and garments come from the
 * vocabulary the renderer reported, and what is currently on comes from the
 * reported state. An avatar that states no wardrobe gets one line of text rather
 * than an empty tab.
 *
 * The console's version of this holds no state of its own either, but for the
 * opposite reason — it writes mesh visibility directly and repaints itself. Here
 * the round trip through the renderer is what lights the chip, which is slower
 * to respond and correct about a garment somebody else changed.
 */
export function DressTab({ snapshot, refresh }: { snapshot: Snapshot; refresh: () => void }) {
  const slots = Object.entries(snapshot.vocabulary.wardrobe ?? {});
  const presets = snapshot.vocabulary.wardrobePresets ?? [];
  const worn = snapshot.state.wardrobe ?? {};
  const { t, tx } = useT();

  const run = (job: Promise<unknown>): void => void job.then(refresh);

  if (!slots.length) {
    return (
      <Section title={t('panel.dress.title')}>
        <p>{t('panel.dress.none')}</p>
      </Section>
    );
  }

  return (
    <>
      {presets.length ? (
        <Section
          title={t('panel.dress.presets')}
          meta={`${presets.length}`}
          note={[t('panel.dress.presets.note')]}
        >
          <ChipRow>
            {presets.map((preset) => (
              <Chip
                key={preset.id}
                label={tx(preset.label)}
                title={preset.id}
                onClick={() => run(wearPreset(preset.id))}
              />
            ))}
          </ChipRow>
        </Section>
      ) : null}

      <Section
        title={t('panel.dress.slots')}
        meta={t('panel.dress.slotCount', { count: slots.length })}
        note={[t('panel.dress.slots.note')]}
      >
        {slots.map(([slot, def]) => (
          <Field key={slot} label={tx(def.label)}>
            <ChipRow>
              {def.items.map((item) => (
                <Chip
                  key={item.id}
                  label={tx(item.label)}
                  title={item.id}
                  state={worn[slot] === item.id ? 'on' : 'off'}
                  onClick={() => run(wear(slot, item.id))}
                />
              ))}
              {/* A state and not an action: an empty slot is one of the things
                  the slot can be, and it is picked the same way the garments
                  are. As an action it took the action variant's transparent
                  fill over the selection tint, so the one chip in the row that
                  was chosen was the one drawn as though it were not. */}
              <Chip
                label={t('panel.dress.bare')}
                state={worn[slot] === null ? 'on' : 'off'}
                onClick={() => run(wear(slot, null))}
              />
            </ChipRow>
          </Field>
        ))}
      </Section>
    </>
  );
}
