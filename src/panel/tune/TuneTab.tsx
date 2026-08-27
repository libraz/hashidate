import { useEffect, useRef, useState } from 'react';
import { TUNING_RANGES, type Tuning, type TuningPatch } from '@/engine/tuning';
import { useT } from '@/i18n';
import type { Snapshot } from '@/protocol';
import { Chip, ChipRow } from '@/ui/Chip';
import { Section } from '@/ui/Section';
import { Slider } from '@/ui/Slider';
import { Toggle } from '@/ui/Toggle';
import { tune } from '../api';

/**
 * Everything that is set once and left.
 *
 * ## Why these are reachable from here at all
 *
 * They used to be reachable only from the console, by writing onto the live
 * engine objects — which is fine while the renderer is the screen being worked
 * in front of, and useless once the renderer is a browser source opened at the
 * top of the broadcast. Naming the layer on the wire is what lets it be moved
 * from the other side of the control API, and the preview above is what makes
 * moving it there worth doing: the numbers are judged by watching a render, and
 * there is one on this page.
 *
 * ## The faders are held locally once they are touched
 *
 * The value comes from the renderer's report, which arrives twice a second. A
 * fader bound straight to that would jump back under the pointer between the
 * drag and the next poll, so the reported figures seed a local copy and the
 * local copy wins from then on. It is re-seeded when the avatar changes, because
 * every default below belongs to the model that is loaded.
 *
 * That is the same trade the console makes and it has the same cost: a value
 * moved by something other than this panel is not followed. Nothing else moves
 * them during a broadcast — which is exactly what makes them the set-once layer.
 */

interface Props {
  snapshot: Snapshot;
}

export function TuneTab({ snapshot }: Props) {
  const { t } = useT();
  const reported = snapshot.tuning;
  const avatar = snapshot.vocabulary.avatar?.id ?? null;

  const [draft, setDraft] = useState<Tuning | null>(reported);
  /** Which avatar the draft describes, so a swap re-seeds it. */
  const seededFor = useRef<string | null>(avatar);

  useEffect(() => {
    if (!reported) return;
    if (draft && seededFor.current === avatar) return;
    seededFor.current = avatar;
    setDraft(reported);
  }, [reported, draft, avatar]);

  if (!draft) {
    return (
      <Section title={t('panel.tune.title')}>
        <p>{t('panel.tune.empty')}</p>
      </Section>
    );
  }

  /** Move one fader: locally first so it tracks the pointer, then on the wire. */
  const set = (patch: TuningPatch): void => {
    setDraft((prev) => (prev ? merge(prev, patch) : prev));
    void tune(patch);
  };

  const R = TUNING_RANGES;

  return (
    <>
      <Section
        title={t('panel.tune.idle')}
        note={[t('panel.tune.idle.note1'), t('panel.tune.idle.note2')]}
      >
        <Fader
          label={t('panel.tune.breathDepth')}
          range={R.idle.breathDepth}
          value={draft.idle.breathDepth}
          onChange={(breathDepth) => set({ idle: { breathDepth } })}
        />
        <Fader
          label={t('panel.tune.breathPeriod')}
          range={R.idle.breathPeriod}
          value={draft.idle.breathPeriod}
          onChange={(breathPeriod) => set({ idle: { breathPeriod } })}
        />
        <Fader
          label={t('panel.tune.idleAmount')}
          range={R.idle.idleAmount}
          value={draft.idle.idleAmount}
          onChange={(idleAmount) => set({ idle: { idleAmount } })}
        />
        <Fader
          label={t('panel.tune.weightShift')}
          range={R.idle.weightShift}
          value={draft.idle.weightShift}
          onChange={(weightShift) => set({ idle: { weightShift } })}
        />
        <Fader
          label={t('panel.tune.gazeAmount')}
          range={R.idle.gazeAmount}
          value={draft.idle.gazeAmount}
          onChange={(gazeAmount) => set({ idle: { gazeAmount } })}
        />
        <Fader
          label={t('panel.tune.eyeLimit')}
          range={R.idle.eyeLimit}
          value={draft.idle.eyeLimit}
          onChange={(eyeLimit) => set({ idle: { eyeLimit } })}
        />
        <Toggle
          label={t('panel.tune.blink')}
          checked={draft.idle.blink}
          onChange={(blink) => set({ idle: { blink } })}
        />
      </Section>

      {draft.has.sway ? (
        <Section
          title={t('panel.tune.sway')}
          note={[t('panel.tune.sway.note1'), t('panel.tune.sway.note2')]}
        >
          <Toggle
            label={t('panel.tune.swayEnabled')}
            checked={draft.sway.enabled}
            onChange={(enabled) => set({ sway: { enabled } })}
          />
          <Fader
            label={t('panel.tune.stiffness')}
            range={R.sway.stiffness}
            value={draft.sway.stiffness}
            onChange={(stiffness) => set({ sway: { stiffness } })}
          />
          <Fader
            label={t('panel.tune.inertia')}
            range={R.sway.inertia}
            value={draft.sway.inertia}
            onChange={(inertia) => set({ sway: { inertia } })}
          />
          <Fader
            label={t('panel.tune.gravity')}
            range={R.sway.gravity}
            value={draft.sway.gravity}
            onChange={(gravity) => set({ sway: { gravity } })}
          />
          {/* Not a value and so not part of the readout: it snaps the chains to
              rest so that two settings can be compared from the same standstill. */}
          <ChipRow>
            <Chip
              label={t('panel.tune.settle')}
              variant="action"
              onClick={() => void tune({ settle: true })}
            />
          </ChipRow>
        </Section>
      ) : null}

      <Section
        title={t('panel.tune.hop')}
        note={[t('panel.tune.hop.note1'), t('panel.tune.hop.note2'), t('panel.tune.hop.note3')]}
      >
        <Fader
          // Centimetres here and metres on the wire. A jump is stated in the one
          // and stored in the other; see `TUNING_RANGES`.
          label={t('panel.tune.hopHeight')}
          range={{ ...R.hop.height, min: R.hop.height.min * 100, max: R.hop.height.max * 100 }}
          value={draft.hop.height * 100}
          step={1}
          precision={0}
          unit="cm"
          onChange={(cm) => set({ hop: { height: cm / 100 } })}
        />
        <Fader
          label={t('panel.tune.gravity')}
          range={R.hop.gravity}
          value={draft.hop.gravity}
          onChange={(gravity) => set({ hop: { gravity } })}
        />
      </Section>

      {draft.has.tail ? (
        <Section title={t('panel.tune.tail')} note={[t('panel.tune.tail.note')]}>
          <Fader
            label={t('panel.tune.tailAmount')}
            range={R.tail.amount}
            value={draft.tail.amount}
            onChange={(amount) => set({ tail: { amount } })}
          />
        </Section>
      ) : null}

      <Section
        title={t('panel.tune.render')}
        note={[
          t('panel.tune.render.note1'),
          ...(draft.has.arkit ? [t('panel.tune.render.note2')] : []),
        ]}
      >
        <Toggle
          label={t('panel.tune.toon')}
          checked={draft.render.toon}
          onChange={(toon) => set({ render: { toon } })}
        />
        {/* Only offered where there is something to switch between: on an avatar
            with no ARKit shapes the toggle has no effect, and a dead control
            reads as a bug. */}
        {draft.has.arkit ? (
          <Toggle
            label={t('panel.tune.arkit')}
            checked={draft.render.arkit}
            onChange={(arkit) => set({ render: { arkit } })}
          />
        ) : null}
      </Section>
    </>
  );
}

/** A fader stated by the range table, so the panel cannot sweep past the wire. */
function Fader({
  label,
  range,
  value,
  onChange,
  step,
  precision,
  unit,
}: {
  label: string;
  range: { min: number; max: number; step: number; precision: number; unit: string };
  value: number;
  onChange: (value: number) => void;
  step?: number;
  precision?: number;
  unit?: string;
}) {
  return (
    <Slider
      label={label}
      value={value}
      min={range.min}
      max={range.max}
      step={step ?? range.step}
      precision={precision ?? range.precision}
      unit={unit ?? range.unit}
      onChange={onChange}
    />
  );
}

/**
 * Fold a patch onto the held copy, one group at a time.
 *
 * Only the groups the patch names are rebuilt; `has` and everything untouched
 * come through as they were. `settle` never reaches here — it moves nothing.
 */
function merge(base: Tuning, patch: TuningPatch): Tuning {
  return {
    idle: { ...base.idle, ...patch.idle },
    sway: { ...base.sway, ...patch.sway },
    hop: { ...base.hop, ...patch.hop },
    tail: { ...base.tail, ...patch.tail },
    render: { ...base.render, ...patch.render },
    has: base.has,
  };
}
