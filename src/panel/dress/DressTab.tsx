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

  const run = (job: Promise<unknown>): void => void job.then(refresh);

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
        <Section
          title="組み合わせ"
          meta={`${presets.length}`}
          note={[
            'ひと揃いを一度に着せる。押した時点で、下のスロットはすべてこの組み合わせのものになる。',
          ]}
        >
          <ChipRow>
            {presets.map((preset) => (
              <Chip
                key={preset.id}
                label={preset.label}
                title={preset.id}
                onClick={() => run(wearPreset(preset.id))}
              />
            ))}
          </ChipRow>
        </Section>
      ) : null}

      <Section
        title="パーツ"
        meta={`${slots.length} スロット`}
        note={[
          'スロットひとつにつき一着。衣装が素体を貫通しないように、覆われる部分のシェイプは着替えと同時に自動で上がる。',
        ]}
      >
        {slots.map(([slot, def]) => (
          <Field key={slot} label={def.label}>
            <ChipRow>
              {def.items.map((item) => (
                <Chip
                  key={item.id}
                  label={item.label}
                  title={item.id}
                  state={worn[slot] === item.id ? 'on' : 'off'}
                  onClick={() => run(wear(slot, item.id))}
                />
              ))}
              <Chip
                label="なし"
                variant="action"
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
