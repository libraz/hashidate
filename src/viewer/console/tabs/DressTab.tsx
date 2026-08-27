import { useState } from 'react';
import { useT } from '@/i18n';
import { Chip, ChipRow } from '@/ui/Chip';
import { Field } from '@/ui/Field';
import { Section } from '@/ui/Section';
import type { LoadedAvatar } from '../../scene/runtime';

/**
 * The wardrobe.
 *
 * Entirely avatar-derived: the slot names, the garments and the fitting shapes
 * all come from the descriptor, so an avatar that states no wardrobe gets an
 * empty tab rather than a broken one.
 */
export function DressTab({ loaded }: { loaded: LoadedAvatar }) {
  const { t, tx } = useT();
  const { wardrobe } = loaded;
  // The wardrobe writes visibility and morph influences directly rather than
  // holding React state, so the panel keeps its own counter to repaint after a
  // change it made itself.
  const [, bump] = useState(0);
  const repaint = () => bump((n) => n + 1);

  const slots = Object.entries(wardrobe.slots);
  const presets = Object.entries(wardrobe.presetDefs);

  if (!slots.length) {
    return (
      <Section title={t('console.dress.title')}>
        <p>{t('console.dress.empty')}</p>
      </Section>
    );
  }

  return (
    <>
      {presets.length ? (
        <Section title={t('console.dress.presets')} meta={`${presets.length}`}>
          <ChipRow>
            {presets.map(([id, p]) => (
              <Chip
                key={id}
                label={tx(p.label)}
                title={id}
                onClick={() => {
                  wardrobe.applyPreset(id);
                  repaint();
                }}
              />
            ))}
          </ChipRow>
        </Section>
      ) : null}

      <Section
        title={t('console.dress.parts')}
        meta={t('console.dress.slots', { count: slots.length })}
        note={wardrobe.note ? [tx(wardrobe.note)] : undefined}
      >
        {slots.map(([slot, def]) => (
          <Field key={slot} label={tx(def.label)}>
            <ChipRow>
              {def.items.map((item) => (
                <Chip
                  key={item.id}
                  label={tx(item.label)}
                  title={item.meshes.join(', ')}
                  state={wardrobe.state[slot] === item.id ? 'on' : 'off'}
                  onClick={() => {
                    wardrobe.set(slot, item.id);
                    repaint();
                  }}
                />
              ))}
              <Chip
                label={t('console.none')}
                variant="action"
                state={wardrobe.state[slot] === null ? 'on' : 'off'}
                onClick={() => {
                  wardrobe.set(slot, null);
                  repaint();
                }}
              />
            </ChipRow>
          </Field>
        ))}
      </Section>

      {wardrobe.activeHides?.length ? (
        <Section
          title={t('console.dress.hides')}
          meta={`${wardrobe.activeHides.length}`}
          note={[t('console.dress.hides.note')]}
        >
          <ChipRow>
            {wardrobe.activeHides.map((h) => (
              <Chip key={h} label={h} variant="action" onClick={() => {}} disabled />
            ))}
          </ChipRow>
        </Section>
      ) : null}
    </>
  );
}
