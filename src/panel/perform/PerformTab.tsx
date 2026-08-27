import { useState } from 'react';
import { GESTURE_GROUPS } from '@/engine/motion';
import { PERFORMANCE_GROUPS } from '@/engine/performance';
import type { EmotionName, EmotionVector, FingerName, Side } from '@/engine/types';
import { type Localized, type MessageKey, type Translator, useT } from '@/i18n';
import type { LabelledId, Snapshot } from '@/protocol';
import { Chip, ChipRow } from '@/ui/Chip';
import { Field } from '@/ui/Field';
import { Section } from '@/ui/Section';
import { Segmented } from '@/ui/Segmented';
import { Slider } from '@/ui/Slider';
import {
  type Aim,
  gesture,
  hop,
  perform,
  point,
  resetFace,
  setEmotion,
  setExpression,
  setLook,
  setOverlay,
} from '../api';

/**
 * The live surface: face, movement, pointing.
 *
 * The console has a tab of the same name reaching into the scene it is drawn
 * beside. This one draws from the vocabulary the renderer reported and sends
 * commands back, which is the whole difference between the two panels — and the
 * reason this one works with the renderer on another screen, in another
 * process, or not yet open.
 *
 * ## Everything here is avatar-derived, including what is missing
 *
 * The drawn expressions and the overlays come from the loaded avatar's own shape
 * groups, so an avatar that has none gets no section rather than an empty one.
 * The performances and gestures are engine tables and are always there; only
 * their group headings are read from the engine directly, because a heading is
 * presentation and putting it on the wire would be shipping a label table to
 * make a panel prettier.
 *
 * ## The chips lag by up to half a second
 *
 * What is lit comes from the reported state, which arrives on the panel's poll.
 * That is the right way round: the autopilot also moves the emotion vector and
 * a chip lit from the last click would be wrong about it. It does mean a chip
 * pressed during a line does not light instantly, which reads as slowness and is
 * not — the character has already moved.
 */

/** Every emotion but neutral: neutral is what Clear means, not a thing to pick. */
const pickable = (emotions: LabelledId[]): LabelledId[] =>
  emotions.filter((emotion) => emotion.id !== 'neutral');

const FINGERS: Array<{ value: FingerName; key: MessageKey }> = [
  { value: 'thumb', key: 'panel.perform.finger.thumb' },
  { value: 'index', key: 'panel.perform.finger.index' },
  { value: 'middle', key: 'panel.perform.finger.middle' },
  { value: 'ring', key: 'panel.perform.finger.ring' },
  { value: 'little', key: 'panel.perform.finger.little' },
];

const SIDES: Array<{ value: Side; key: MessageKey }> = [
  { value: 'R', key: 'panel.perform.side.right' },
  { value: 'L', key: 'panel.perform.side.left' },
];

/** The two hand pickers, named in the operator's language rather than the rig's. */
const options = <T extends string>(
  table: Array<{ value: T; key: MessageKey }>,
  t: Translator['t'],
): Array<{ value: T; label: string }> => table.map(({ value, key }) => ({ value, label: t(key) }));

/**
 * Group an avatar's list by its own group key, in the engine's heading order.
 *
 * The headings are two-language values straight out of the engine tables, so the
 * locale is resolved here rather than at every heading that comes out.
 */
function byGroup<T extends { group: string }>(
  items: T[],
  headings: Record<string, Localized>,
  tx: Translator['tx'],
): Array<{ key: string; label: string; items: T[] }> {
  return Object.entries(headings)
    .map(([key, label]) => ({
      key,
      label: tx(label),
      items: items.filter((item) => item.group === key),
    }))
    .filter((group) => group.items.length > 0);
}

interface Props {
  snapshot: Snapshot;
  refresh: () => void;
}

export function PerformTab({ snapshot, refresh }: Props) {
  const { vocabulary, state } = snapshot;
  const { t, tx } = useT();
  const [mixing, setMixing] = useState(false);
  const [aim, setAim] = useState<Aim>({
    side: 'R',
    finger: 'index',
    azimuth: 35,
    elevation: 20,
    extent: 0.85,
  });

  /** Send, then re-read: both lists this tab lights up moved. */
  const run = (job: Promise<unknown>): void => void job.then(refresh);

  const emotion: EmotionVector = state.emotion ?? {};
  const moods = pickable(vocabulary.emotions ?? []);
  const performances = byGroup(vocabulary.performances ?? [], PERFORMANCE_GROUPS, tx);
  const gestures = byGroup(vocabulary.gestures ?? [], GESTURE_GROUPS, tx);
  const pointing = vocabulary.pointing;
  const strain = state.strain?.[aim.side] ?? 0;

  const mix = (name: string, value: number): void => {
    const next: EmotionVector = { ...emotion, [name as EmotionName]: value };
    for (const key of Object.keys(next) as EmotionName[]) {
      if (!next[key]) delete next[key];
    }
    run(setEmotion(Object.keys(next).length ? next : { neutral: 1 }));
  };

  /** Point with one field overridden, so changing the hand re-aims with it. */
  const aimAt = (over: Partial<Aim> = {}): void => {
    const next = { ...aim, ...over };
    setAim(next);
    run(point(next));
  };

  return (
    <>
      <Section
        title={t('panel.perform.presets')}
        meta={state.performance ?? ''}
        note={[t('panel.perform.presets.note1'), t('panel.perform.presets.note2')]}
      >
        {performances.map((group) => (
          <Field key={group.key} label={group.label}>
            <ChipRow>
              {group.items.map((item) => (
                <Chip
                  key={item.id}
                  label={item.sustain ? `${tx(item.label)} *` : tx(item.label)}
                  title={`${item.id}  ${[item.gesture, item.hop].filter(Boolean).join(' + ') || t('panel.perform.faceOnly')}`}
                  state={state.performance === item.id ? 'on' : 'off'}
                  onClick={() => run(perform(state.performance === item.id ? null : item.id))}
                />
              ))}
            </ChipRow>
          </Field>
        ))}
        <ChipRow>
          <Chip
            label={t('panel.perform.release')}
            variant="action"
            onClick={() => run(perform(null))}
          />
        </ChipRow>
      </Section>

      <Section
        title={t('panel.perform.emotion')}
        note={[t('panel.perform.emotion.note1'), t('panel.perform.emotion.note2')]}
      >
        <ChipRow>
          {moods.map((mood) => (
            <Chip
              key={mood.id}
              label={tx(mood.label)}
              title={mood.id}
              state={(emotion[mood.id as EmotionName] ?? 0) > 0.5 ? 'auto' : 'off'}
              onClick={() => run(setEmotion({ [mood.id as EmotionName]: 1 }))}
            />
          ))}
          <Chip
            label={t('panel.perform.release')}
            variant="action"
            onClick={() => run(resetFace())}
          />
          <Chip
            label={t('panel.perform.mix')}
            state={mixing ? 'on' : 'off'}
            onClick={() => setMixing((v) => !v)}
          />
        </ChipRow>
        {mixing
          ? moods.map((mood) => (
              <Slider
                key={mood.id}
                label={`${tx(mood.label)}  ${mood.id}`}
                value={emotion[mood.id as EmotionName] ?? 0}
                onChange={(v) => mix(mood.id, v)}
              />
            ))
          : null}
      </Section>

      {vocabulary.expressions?.length ? (
        <Section
          title={t('panel.perform.expressions')}
          meta={`${vocabulary.expressions.length}`}
          note={[t('panel.perform.expressions.note1'), t('panel.perform.expressions.note2')]}
        >
          <ChipRow>
            {vocabulary.expressions.map((preset) => (
              <Chip
                key={preset.id}
                label={tx(preset.label)}
                title={preset.id}
                state={
                  state.pickedExpression === preset.id
                    ? 'on'
                    : state.expression === preset.id
                      ? 'auto'
                      : 'off'
                }
                onClick={() =>
                  run(setExpression(state.pickedExpression === preset.id ? null : preset.id))
                }
              />
            ))}
            <Chip
              label={t('panel.perform.release')}
              variant="action"
              onClick={() => run(resetFace())}
            />
          </ChipRow>
        </Section>
      ) : null}

      {vocabulary.overlays?.length ? (
        <Section
          title={t('panel.perform.overlays')}
          meta={`${vocabulary.overlays.length}`}
          note={[t('panel.perform.overlays.note')]}
        >
          <ChipRow>
            {vocabulary.overlays.map((overlay) => {
              const up = (state.overlays?.[overlay.id] ?? 0) > 0;
              return (
                <Chip
                  key={overlay.id}
                  label={tx(overlay.label)}
                  title={overlay.id}
                  state={up ? 'on' : 'off'}
                  onClick={() => run(setOverlay(overlay.id, up ? 0 : 1))}
                />
              );
            })}
            <Chip
              label={t('panel.perform.releaseAll')}
              variant="action"
              onClick={() => run(resetFace())}
            />
          </ChipRow>
        </Section>
      ) : null}

      <Section
        title={t('panel.perform.gestures')}
        meta={state.gesture ?? ''}
        note={[t('panel.perform.gestures.note1'), t('panel.perform.gestures.note2')]}
      >
        {gestures.map((group) => (
          <Field key={group.key} label={group.label}>
            <ChipRow>
              {group.items.map((item) => (
                <Chip
                  key={item.id}
                  label={tx(item.label)}
                  title={item.id}
                  state={state.gesture === item.id ? 'auto' : 'off'}
                  onClick={() => run(gesture(item.id))}
                />
              ))}
            </ChipRow>
          </Field>
        ))}
        {vocabulary.hops?.length ? (
          <Field label={t('panel.perform.hops')}>
            <ChipRow>
              {vocabulary.hops.map((item) => (
                <Chip
                  key={item.id}
                  label={tx(item.label)}
                  title={item.id}
                  onClick={() => run(hop(item.id))}
                />
              ))}
            </ChipRow>
          </Field>
        ) : null}
        <ChipRow>
          <Chip label={t('panel.perform.stop')} variant="action" onClick={() => run(gesture())} />
        </ChipRow>
      </Section>

      {pointing ? (
        <Section
          title={t('panel.perform.pointing')}
          meta={strain > 0 ? t('panel.perform.strain', { value: strain.toFixed(2) }) : ''}
          note={[tx(pointing.note), t('panel.perform.pointing.note')]}
        >
          <Field label={t('panel.perform.hand')}>
            <Segmented
              ariaLabel={t('panel.perform.hand.aria')}
              options={options(SIDES, t)}
              value={aim.side}
              onChange={(side) => aimAt({ side })}
            />
          </Field>
          <Field label={t('panel.perform.finger')}>
            <Segmented
              ariaLabel={t('panel.perform.finger.aria')}
              options={options(FINGERS, t)}
              value={aim.finger}
              onChange={(finger) => aimAt({ finger })}
            />
          </Field>
          <Slider
            label={t('panel.perform.azimuth')}
            value={aim.azimuth}
            min={pointing.azimuth[0]}
            max={pointing.azimuth[1]}
            step={1}
            precision={0}
            unit="°"
            onChange={(azimuth) => setAim((a) => ({ ...a, azimuth }))}
          />
          <Slider
            label={t('panel.perform.elevation')}
            value={aim.elevation}
            min={pointing.elevation[0]}
            max={pointing.elevation[1]}
            step={1}
            precision={0}
            unit="°"
            onChange={(elevation) => setAim((a) => ({ ...a, elevation }))}
          />
          <Slider
            label={t('panel.perform.extent')}
            value={aim.extent}
            min={pointing.extent[0]}
            max={pointing.extent[1]}
            onChange={(extent) => setAim((a) => ({ ...a, extent }))}
          />
          {/* The two angle faders do not send as they move, unlike everything
              else here: a drag would be sixty solves and sixty requests, and the
              arm would chase the slider rather than being aimed. */}
          <ChipRow>
            <Chip label={t('panel.perform.point')} variant="primary" onClick={() => aimAt()} />
            <Chip
              label={t('panel.perform.release')}
              variant="action"
              onClick={() => run(gesture())}
            />
          </ChipRow>
        </Section>
      ) : null}

      <Section title={t('panel.perform.lookAt')} note={[t('panel.perform.lookAt.note')]}>
        <Slider
          label={t('panel.perform.lookAt')}
          value={state.lookAt ?? 1}
          onChange={(amount) => run(setLook(amount))}
        />
      </Section>
    </>
  );
}
