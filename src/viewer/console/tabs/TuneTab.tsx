import { type Dispatch, type SetStateAction, useRef, useState } from 'react';
import { HOP_IDS, HOPS } from '@/engine/motion';
import { TUNING_RANGES as R } from '@/engine/tuning';
import type { GazeLimits } from '@/engine/types';
import { useT } from '@/i18n';
import { Chip, ChipRow } from '@/ui/Chip';
import { Section } from '@/ui/Section';
import { Slider } from '@/ui/Slider';
import { Toggle } from '@/ui/Toggle';
import type { AvatarRuntime, LoadedAvatar } from '../../scene/runtime';

/**
 * Everything that is set once and left.
 *
 * These write straight onto the engine objects, which hold the authoritative
 * value; the component mirrors them in local state only so the fader has
 * something to render. Nothing here is polled, because nothing else writes
 * them — unlike the emotion vector on the performance tab, which the autopilot
 * also moves.
 *
 * How far each fader travels comes from `TUNING_RANGES` rather than from the
 * numbers that used to sit here. The same layer is reachable over the control
 * API, and the panel that drives it that way sweeps the same faders — two copies
 * of fourteen bounds would come to disagree without either one looking wrong.
 * The *defaults* still belong to the engine objects; nothing here restates one.
 */
export function TuneTab({
  loaded,
  runtime,
}: {
  loaded: LoadedAvatar;
  runtime: AvatarRuntime | null;
}) {
  const { t, tx } = useT();
  const { director, profile } = loaded;
  const { body, spring, tail } = director;

  // The gaze limits are profile data and are scaled rather than replaced, so
  // the multiplier needs the avatar's own measured figures to scale *from*.
  // Captured per avatar, since a swap rebuilds the profile under us.
  const baseGaze = useRef<{ id: string; limits: GazeLimits }>({
    id: loaded.avatar.id,
    limits: { ...profile.gaze },
  });
  if (baseGaze.current.id !== loaded.avatar.id) {
    baseGaze.current = { id: loaded.avatar.id, limits: { ...profile.gaze } };
  }

  const [breathDepth, setBreathDepth] = useState(body.breathDepth);
  const [breathPeriod, setBreathPeriod] = useState(body.breathPeriod);
  const [idleAmount, setIdleAmount] = useState(body.idleAmount);
  const [weightShift, setWeightShift] = useState(body.weightShift);
  const [lookAt, setLookAt] = useState(body.lookAt);
  const [gazeAmount, setGazeAmount] = useState(body.gazeAmount);
  const [eyeLimit, setEyeLimit] = useState(1);
  const [blinkEnabled, setBlinkEnabled] = useState(director.blinkEnabled);

  const [swayEnabled, setSwayEnabled] = useState(spring.enabled);
  const [stiffness, setStiffness] = useState(spring.stiffnessScale);
  const [inertia, setInertia] = useState(spring.inertiaScale);
  const [swayGravity, setSwayGravity] = useState(spring.gravityScale);

  const [jumpHeight, setJumpHeight] = useState(body.jumpHeight * 100);
  const [gravity, setGravity] = useState(body.gravity);
  const [tailAmount, setTailAmount] = useState(tail.amount);

  const [toon, setToon] = useState(runtime?.toonEnabled ?? true);
  const [useArkit, setUseArkit] = useState(director.useArkit);

  /**
   * Mirror into local state and write through to the engine in one step.
   *
   * The engine object is the authoritative value; the local copy exists only so
   * the fader has something to render between repaints.
   */
  const set =
    <T,>(mirror: Dispatch<SetStateAction<T>>, apply: (v: T) => void) =>
    (v: T) => {
      mirror(v);
      apply(v);
    };

  return (
    <>
      <Section
        title={t('console.tune.idle')}
        note={[t('console.tune.idle.note.breath'), t('console.tune.idle.note.blink')]}
      >
        <Slider
          label={t('console.tune.breathDepth')}
          value={breathDepth}
          {...R.idle.breathDepth}
          onChange={set(setBreathDepth, (v) => {
            body.breathDepth = v;
          })}
        />
        <Slider
          label={t('console.tune.breathPeriod')}
          value={breathPeriod}
          {...R.idle.breathPeriod}
          onChange={set(setBreathPeriod, (v) => {
            body.breathPeriod = v;
          })}
        />
        <Slider
          label={t('console.tune.headMicro')}
          value={idleAmount}
          {...R.idle.idleAmount}
          onChange={set(setIdleAmount, (v) => {
            body.idleAmount = v;
          })}
        />
        <Slider
          label={t('console.tune.weightShift')}
          value={weightShift}
          {...R.idle.weightShift}
          onChange={set(setWeightShift, (v) => {
            body.weightShift = v;
          })}
        />
        <Slider
          label={t('console.tune.lookAt')}
          value={lookAt}
          onChange={set(setLookAt, (v) => {
            body.lookAt = v;
          })}
        />
        <Slider
          label={t('console.tune.gazeDrift')}
          value={gazeAmount}
          {...R.idle.gazeAmount}
          onChange={set(setGazeAmount, (v) => {
            body.gazeAmount = v;
          })}
        />
        <Slider
          label={t('console.tune.eyeLimit')}
          value={eyeLimit}
          {...R.idle.eyeLimit}
          onChange={set(setEyeLimit, (v) => {
            profile.gaze.eyeYaw = baseGaze.current.limits.eyeYaw * v;
            profile.gaze.eyePitch = baseGaze.current.limits.eyePitch * v;
          })}
        />
        <Toggle
          label={t('console.tune.blink')}
          checked={blinkEnabled}
          onChange={set(setBlinkEnabled, (v) => {
            director.blinkEnabled = v;
          })}
        />
      </Section>

      {spring.active ? (
        <Section
          title={t('console.tune.sway')}
          meta={t('console.tune.sway.meta', {
            groups: spring.groups.length,
            joints: spring.count,
          })}
          note={[
            t('console.tune.sway.note.solver'),
            t('console.tune.sway.note.scale', {
              chains: spring.groups.map((g) => `${tx(g.label)} ${g.joints.length}`).join(' · '),
            }),
            ...(spring.missing.length
              ? [t('console.tune.sway.note.missing', { names: spring.missing.join(' / ') })]
              : []),
          ]}
        >
          <Toggle
            label={t('console.tune.sway.enabled')}
            checked={swayEnabled}
            onChange={set(setSwayEnabled, (v) => {
              spring.enabled = v;
            })}
          />
          <Slider
            label={t('console.tune.sway.stiffness')}
            value={stiffness}
            {...R.sway.stiffness}
            onChange={set(setStiffness, (v) => {
              spring.stiffnessScale = v;
            })}
          />
          <Slider
            label={t('console.tune.sway.inertia')}
            value={inertia}
            {...R.sway.inertia}
            onChange={set(setInertia, (v) => {
              spring.inertiaScale = v;
            })}
          />
          <Slider
            label={t('console.tune.sway.gravity')}
            value={swayGravity}
            {...R.sway.gravity}
            onChange={set(setSwayGravity, (v) => {
              spring.gravityScale = v;
            })}
          />
          <ChipRow>
            <Chip
              label={t('console.tune.sway.settle')}
              variant="action"
              onClick={() => spring.reset()}
            />
          </ChipRow>
        </Section>
      ) : null}

      <Section
        title={t('console.tune.hop')}
        note={[
          t('console.tune.hop.note.why'),
          t('console.tune.hop.note.arc'),
          t('console.tune.hop.note.repeat'),
          t('console.tune.hop.note.legs'),
        ]}
      >
        <Slider
          label={t('console.tune.hop.height')}
          value={jumpHeight}
          min={R.hop.height.min * 100}
          max={R.hop.height.max * 100}
          step={1}
          precision={0}
          unit="cm"
          onChange={set(setJumpHeight, (v) => {
            body.jumpHeight = v / 100;
          })}
        />
        <Slider
          label={t('console.tune.hop.gravity')}
          value={gravity}
          {...R.hop.gravity}
          onChange={set(setGravity, (v) => {
            body.gravity = v;
          })}
        />
        <ChipRow>
          {HOP_IDS.map((id) => (
            <Chip key={id} label={tx(HOPS[id].label)} title={id} onClick={() => director.hop(id)} />
          ))}
          <Chip
            label={t('console.tune.hop.once')}
            variant="primary"
            onClick={() => director.body.hop()}
            title={t('console.tune.hop.once.title')}
          />
        </ChipRow>
      </Section>

      {tail.active ? (
        <Section
          title={t('console.tune.tail')}
          note={[t('console.tune.tail.note.drive'), t('console.tune.tail.note.mood')]}
        >
          <Slider
            label={t('console.tune.tail.amount')}
            value={tailAmount}
            {...R.tail.amount}
            onChange={set(setTailAmount, (v) => {
              tail.amount = v;
            })}
          />
        </Section>
      ) : null}

      <Section
        title={t('console.tune.render')}
        note={[
          t('console.tune.render.note.toon'),
          ...(profile.arkit.supported ? [t('console.tune.render.note.arkit')] : []),
        ]}
      >
        <Toggle
          label={t('console.tune.toon')}
          checked={toon}
          onChange={set(setToon, (v) => runtime?.setToon(v))}
        />
        {/* Only offered where there is something to switch between. On an avatar
            with no ARKit the toggle has no effect, and a dead control reads as
            a bug. */}
        {profile.arkit.supported ? (
          <Toggle
            label={t('console.tune.arkit')}
            checked={useArkit}
            onChange={set(setUseArkit, (v) => {
              director.useArkit = v;
            })}
          />
        ) : null}
      </Section>
    </>
  );
}
