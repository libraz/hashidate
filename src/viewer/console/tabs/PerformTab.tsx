import { useState } from 'react';
import { EMOTION_LABELS, EMOTIONS } from '@/engine/face';
import { GESTURE_GROUPS, GESTURES, GESTURES_BY_GROUP, HOP_IDS, HOPS } from '@/engine/motion';
import {
  holdsUntilReleased,
  PERFORMANCE_GROUPS,
  PERFORMANCE_TABLE,
  PERFORMANCES_BY_GROUP,
} from '@/engine/performance';
import type {
  CameraFrame,
  EmotionName,
  EmotionVector,
  FingerName,
  SessionState,
  Side,
} from '@/engine/types';
import { type MessageKey, useT } from '@/i18n';
import { Chip, ChipRow } from '@/ui/Chip';
import { Field } from '@/ui/Field';
import { Section } from '@/ui/Section';
import { Segmented } from '@/ui/Segmented';
import { Slider } from '@/ui/Slider';
import type { LoadedAvatar } from '../../scene/runtime';

/** Every emotion but neutral — neutral is what "解除" (release) means, not a thing to pick. */
const MOODS = (Object.keys(EMOTIONS) as EmotionName[]).filter((n) => n !== 'neutral');

const FINGERS = [
  { value: 'thumb', message: 'console.perform.finger.thumb' },
  { value: 'index', message: 'console.perform.finger.index' },
  { value: 'middle', message: 'console.perform.finger.middle' },
  { value: 'ring', message: 'console.perform.finger.ring' },
  { value: 'little', message: 'console.perform.finger.little' },
] as const satisfies ReadonlyArray<{ value: FingerName; message: MessageKey }>;

const SIDES = [
  { value: 'R', message: 'console.perform.side.right' },
  { value: 'L', message: 'console.perform.side.left' },
] as const satisfies ReadonlyArray<{ value: Side; message: MessageKey }>;

interface Props {
  loaded: LoadedAvatar;
  state: SessionState | null;
  onCamera: (frame: CameraFrame) => void;
}

export function PerformTab({ loaded, state, onCamera }: Props) {
  const { t, tx } = useT();
  const { director, session, avatar, profile } = loaded;
  const [mixing, setMixing] = useState(false);
  const [side, setSide] = useState<Side>('R');
  const [finger, setFinger] = useState<FingerName>('index');
  const [azimuth, setAzimuth] = useState(35);
  const [elevation, setElevation] = useState(20);
  const [extent, setExtent] = useState(0.85);

  const emotion: EmotionVector = state?.emotion ?? {};

  /**
   * What every 解除 (release) in this tab does, including the one under the presets.
   *
   * Not `perform(null)`, which is the *turn's* release and puts back only what a
   * performance is holding — a pose, closed lids, a dropped gaze. Three quarters
   * of the table hold none of those: their gesture has already ended by the time
   * anyone reaches for the button and the mood is kept on purpose, so releasing
   * one used to clear an internal flag and change nothing on screen. A control
   * labelled 解除 that leaves the face it was pressed on is broken however
   * correct the release underneath it is.
   */
  const rest = () => session.resetExpression();

  const setMood = (name: EmotionName) => session.setEmotion({ [name]: 1 });
  const mix = (name: EmotionName, value: number) => {
    const next: EmotionVector = { ...emotion, [name]: value };
    for (const k of Object.keys(next) as EmotionName[]) {
      if (!next[k]) delete next[k];
    }
    session.setEmotion(Object.keys(next).length ? next : { neutral: 1 });
  };

  const aim = (over: Partial<{ side: Side; finger: FingerName }> = {}) =>
    session.point({
      side: over.side ?? side,
      finger: over.finger ?? finger,
      azimuth,
      elevation,
      extent,
    });

  const composition = profile.arkit.supported
    ? t('console.perform.channel.arkit')
    : avatar.emotionShapes
      ? t('console.perform.channel.custom')
      : t('console.perform.channel.vrm');

  const strain = state?.strain?.[side] ?? 0;

  return (
    <>
      <Section
        title={t('console.perform.presets')}
        meta={state?.performance ?? ''}
        note={[
          t('console.perform.presets.note.parts'),
          t('console.perform.presets.note.line'),
          t('console.perform.presets.note.held'),
          t('console.perform.presets.note.auto'),
        ]}
      >
        {PERFORMANCES_BY_GROUP.map((g) => (
          <Field key={g.key} label={tx(PERFORMANCE_GROUPS[g.key] ?? g.label)}>
            <ChipRow>
              {g.ids.map((id) => {
                const def = PERFORMANCE_TABLE[id];
                const held = holdsUntilReleased(def);
                return (
                  <Chip
                    key={id}
                    label={held ? `${tx(def.label)} *` : tx(def.label)}
                    title={`${id}  ${
                      [def.gesture, def.hop].filter(Boolean).join(' + ') ||
                      t('console.perform.faceOnly')
                    }`}
                    state={state?.performance === id ? 'on' : 'off'}
                    onClick={() => (state?.performance === id ? rest() : session.perform(id))}
                  />
                );
              })}
            </ChipRow>
          </Field>
        ))}
        <ChipRow>
          <Chip label={t('console.release')} variant="action" onClick={rest} />
        </ChipRow>
      </Section>

      <Section
        title={t('console.perform.emotion')}
        meta={composition}
        note={[
          t('console.perform.emotion.note.mix'),
          profile.arkit.supported
            ? t('console.perform.emotion.note.arkit')
            : avatar.emotionShapes
              ? t('console.perform.emotion.note.custom')
              : t('console.perform.emotion.note.vrm'),
        ]}
      >
        <ChipRow>
          {MOODS.map((name) => (
            <Chip
              key={name}
              label={tx(EMOTION_LABELS[name])}
              title={name}
              state={(emotion[name] ?? 0) > 0.5 ? 'auto' : 'off'}
              onClick={() => setMood(name)}
            />
          ))}
        </ChipRow>
        {/* An action is never a member of the list it acts on: appended to the
            wrap above it lands wherever the last mood left room and reads as
            one more mood. Its own row, which is what the section above and the
            gestures below already do. The blend switch is out for the same
            reason — it changes how the section works rather than naming a
            mood. The panel's own performance tab follows the same rule. */}
        <ChipRow>
          <Chip label={t('console.release')} variant="action" onClick={rest} />
          <Chip
            label={t('console.perform.emotion.blend')}
            state={mixing ? 'on' : 'off'}
            onClick={() => setMixing((v) => !v)}
          />
        </ChipRow>
        {mixing
          ? MOODS.map((name) => (
              <Slider
                key={name}
                label={`${tx(EMOTION_LABELS[name])}  ${name}`}
                value={emotion[name] ?? 0}
                onChange={(v) => mix(name, v)}
              />
            ))
          : null}
      </Section>

      {director.presets.length ? (
        <Section
          title={t('console.perform.expressions')}
          meta={`${director.presets.length}`}
          note={[
            t('console.perform.expressions.note.source'),
            t('console.perform.expressions.note.state'),
          ]}
        >
          <ChipRow>
            {director.presets.map((p) => (
              <Chip
                key={p.id}
                label={tx(p.label)}
                title={p.id}
                state={
                  state?.pickedExpression === p.id
                    ? 'on'
                    : state?.expression === p.id
                      ? 'auto'
                      : 'off'
                }
                onClick={() =>
                  session.setExpression(state?.pickedExpression === p.id ? null : p.id)
                }
              />
            ))}
          </ChipRow>
          <ChipRow>
            <Chip label={t('console.release')} variant="action" onClick={rest} />
          </ChipRow>
        </Section>
      ) : null}

      {director.overlays.length ? (
        <Section
          title={t('console.perform.overlays')}
          meta={`${director.overlays.length}`}
          note={[t('console.perform.overlays.note')]}
        >
          <ChipRow>
            {director.overlays.map((o) => (
              <Chip
                key={o.id}
                label={tx(o.label)}
                title={o.id}
                state={(state?.overlays?.[o.id] ?? 0) > 0 ? 'on' : 'off'}
                onClick={() => session.setOverlay(o.id, (state?.overlays?.[o.id] ?? 0) > 0 ? 0 : 1)}
              />
            ))}
          </ChipRow>
          <ChipRow>
            <Chip label={t('console.releaseAll')} variant="action" onClick={rest} />
          </ChipRow>
        </Section>
      ) : null}

      <Section
        title={t('console.perform.gestures')}
        meta={state?.gesture ?? ''}
        note={[
          t('console.perform.gestures.note.body'),
          t('console.perform.gestures.note.variation'),
          t('console.perform.gestures.note.hold'),
          t('console.perform.gestures.note.hop'),
        ]}
      >
        {GESTURES_BY_GROUP.map((g) => (
          <Field key={g.key} label={tx(GESTURE_GROUPS[g.key] ?? g.label)}>
            <ChipRow>
              {g.ids.map((id) => (
                <Chip
                  key={id}
                  label={tx(GESTURES[id].label)}
                  title={id}
                  state={state?.gesture === id ? 'auto' : 'off'}
                  onClick={() => session.gesture(id)}
                />
              ))}
            </ChipRow>
          </Field>
        ))}
        <Field label={t('console.perform.hops')}>
          <ChipRow>
            {HOP_IDS.map((id) => (
              <Chip
                key={id}
                label={tx(HOPS[id].label)}
                title={id}
                onClick={() => session.hop(id)}
              />
            ))}
          </ChipRow>
        </Field>
        <ChipRow>
          <Chip label={t('console.stop')} variant="action" onClick={() => session.stopGesture()} />
        </ChipRow>
      </Section>

      <Section
        title={t('console.perform.point')}
        meta={strain > 0 ? t('console.perform.strain', { value: strain.toFixed(2) }) : ''}
        note={[t('console.perform.point.note.solve'), t('console.perform.point.note.limits')]}
      >
        <Field label={t('console.perform.point.hand')}>
          <Segmented
            ariaLabel={t('console.perform.point.hand.aria')}
            options={SIDES.map((s) => ({ value: s.value, label: t(s.message) }))}
            value={side}
            onChange={(v) => {
              setSide(v);
              aim({ side: v });
            }}
          />
        </Field>
        <Field label={t('console.perform.point.finger')}>
          <Segmented
            ariaLabel={t('console.perform.point.finger.aria')}
            options={FINGERS.map((f) => ({ value: f.value, label: t(f.message) }))}
            value={finger}
            onChange={(v) => {
              setFinger(v);
              aim({ finger: v });
            }}
          />
        </Field>
        <Slider
          label={t('console.perform.point.azimuth')}
          value={azimuth}
          min={-120}
          max={120}
          step={1}
          precision={0}
          unit="°"
          onChange={setAzimuth}
        />
        <Slider
          label={t('console.perform.point.elevation')}
          value={elevation}
          min={-70}
          max={110}
          step={1}
          precision={0}
          unit="°"
          onChange={setElevation}
        />
        <Slider
          label={t('console.perform.point.extent')}
          value={extent}
          min={0.2}
          max={1}
          onChange={setExtent}
        />
        <ChipRow>
          <Chip label={t('console.perform.point.aim')} variant="primary" onClick={() => aim()} />
          <Chip
            label={t('console.release')}
            variant="action"
            onClick={() => session.stopGesture()}
          />
        </ChipRow>
      </Section>

      <Section
        title={t('console.perform.script')}
        meta={
          avatar.script?.length
            ? t('console.perform.script.turns', { count: avatar.script.length })
            : t('console.none')
        }
        note={[t('console.perform.script.note')]}
      >
        <ChipRow>
          <Chip
            label={t('console.perform.script.play')}
            variant="primary"
            disabled={!avatar.script?.length}
            onClick={() => {
              session.interrupt();
              onCamera('bust');
              for (const step of avatar.script ?? []) session.say(step);
            }}
          />
          <Chip label={t('console.stop')} variant="action" onClick={() => session.interrupt()} />
        </ChipRow>
      </Section>
    </>
  );
}
