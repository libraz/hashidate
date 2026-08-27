import { useState } from 'react';
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
      <Section title="衣装">
        <p>このアバターは着せ替えを持たない。</p>
      </Section>
    );
  }

  return (
    <>
      {presets.length ? (
        <Section title="組み合わせ" meta={`${presets.length}`}>
          <ChipRow>
            {presets.map(([id, p]) => (
              <Chip
                key={id}
                label={p.label}
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
        title="パーツ"
        meta={`${slots.length} スロット`}
        note={wardrobe.note ? [wardrobe.note] : undefined}
      >
        {slots.map(([slot, def]) => (
          <Field key={slot} label={def.label}>
            <ChipRow>
              {def.items.map((item) => (
                <Chip
                  key={item.id}
                  label={item.label}
                  title={item.meshes.join(', ')}
                  state={wardrobe.state[slot] === item.id ? 'on' : 'off'}
                  onClick={() => {
                    wardrobe.set(slot, item.id);
                    repaint();
                  }}
                />
              ))}
              <Chip
                label="なし"
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
          title="適用中の隠しシェイプ"
          meta={`${wardrobe.activeHides.length}`}
          note={[
            '衣装が素体を貫通しないように、覆われる部分のシェイプを上げている。VRChat 系は頂点を潰す *Hide、別の作者は手足を細める Shrink_* を使う — 役割は同じで呼び名と仕組みが違う。',
          ]}
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
