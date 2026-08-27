import { useT } from '@/i18n';
import type { Snapshot, VoiceDsp } from '@/protocol';
import { Chip, ChipRow } from '@/ui/Chip';
import { Section } from '@/ui/Section';
import { setRoom, setVoice } from '../api';
import { ChainSlider } from './ChainSlider';
import { Meters } from './Meters';
import styles from './VoiceTab.module.css';

/**
 * How the voice is finished before it reaches the stream.
 *
 * ## The controls are the processor's own, on purpose
 *
 * Every slider here maps to one field of libsonare's realtime voice-changer
 * configuration, section for section and name for name. That is a deliberate
 * refusal to invent a friendlier vocabulary: a de-esser threshold is a de-esser
 * threshold, and a second set of names for the same twenty numbers would be a
 * mapping table for the panel and the renderer to drift across — while also
 * being *less* legible to the one person operating this, who already knows what
 * a compressor ratio is.
 *
 * ## Every change is a delta on a base preset
 *
 * The panel never sends a complete configuration, because it does not have one:
 * the processor refuses a partial config, and the only end that holds the preset
 * table is the renderer. So a slider sends the one field it moved, the renderer
 * merges it onto the base, and what comes back in the report is the resolved
 * result — which is what these sliders are drawn from. That round trip is why a
 * preset change moves every slider at once without the panel knowing any of the
 * numbers in it.
 *
 * ## Rooms are here and are not part of the chain
 *
 * A room is a convolution downstream of everything below it, derived from a
 * physical space rather than a decay time. The chain has its own reverb and it
 * is left at zero by every preset that matters — two reverbs is two rooms and
 * sounds like it, so the room picker is first and the chain's reverb is filed
 * under the section it belongs to rather than promoted beside it.
 */

interface Props {
  snapshot: Snapshot;
  refresh: () => void;
}

/** Read one number out of the resolved report, or a stated fallback. */
function read(dsp: Record<string, unknown> | null | undefined, path: string, fallback: number) {
  if (!dsp) return fallback;
  const [head, tail] = path.split('.');
  const section = dsp[head];
  if (tail === undefined) return typeof section === 'number' ? section : fallback;
  if (typeof section !== 'object' || section === null) return fallback;
  const value = (section as Record<string, unknown>)[tail];
  return typeof value === 'number' ? value : fallback;
}

export function VoiceTab({ snapshot, refresh }: Props) {
  const { t, tx } = useT();
  const voice = snapshot.voice;
  const dsp = voice?.dsp ?? null;
  const bypassed = voice?.preset === null;

  /** Send one field and re-read. Building the nested shape from a dotted path. */
  const set = (path: string, value: number): void => {
    const [head, tail] = path.split('.');
    const patch: VoiceDsp =
      tail === undefined
        ? ({ [head]: value } as VoiceDsp)
        : ({ [head]: { [tail]: value } } as VoiceDsp);
    void setVoice(undefined, patch).then(refresh);
  };

  const knob = (
    label: string,
    path: string,
    fallback: number,
    opts: { min: number; max: number; step?: number; precision?: number; unit?: string },
  ) => (
    <ChainSlider
      key={path}
      label={label}
      reported={read(dsp, path, fallback)}
      onCommit={(v) => set(path, v)}
      min={opts.min}
      max={opts.max}
      step={opts.step ?? 0.01}
      precision={opts.precision ?? 2}
      unit={opts.unit ?? ''}
      title={path}
    />
  );

  return (
    <div className={styles.tab}>
      <Meters voice={voice} />

      <Section
        title={t('panel.voice.room')}
        meta={voice?.room ?? t('panel.voice.dry')}
        note={[t('panel.voice.room.note1'), t('panel.voice.room.note2')]}
      >
        <ChipRow>
          <Chip
            label={t('panel.voice.dry')}
            state={voice?.room ? 'off' : 'on'}
            onClick={() => void setRoom(null).then(refresh)}
          />
          {(snapshot.vocabulary.rooms ?? []).map((room) => (
            <Chip
              key={room.id}
              label={tx(room.label)}
              tag={room.id}
              state={voice?.room === room.id ? 'on' : 'off'}
              onClick={() => void setRoom(room.id).then(refresh)}
            />
          ))}
        </ChipRow>
      </Section>

      <Section
        title={t('panel.voice.changer')}
        meta={bypassed ? t('panel.voice.bypass') : (voice?.preset ?? '—')}
        note={[
          t('panel.voice.changer.note1'),
          t('panel.voice.changer.note2'),
          t('panel.voice.changer.note3'),
        ]}
      >
        <ChipRow>
          <Chip
            label={t('panel.voice.bypass')}
            state={bypassed ? 'on' : 'off'}
            onClick={() => void setVoice(null).then(refresh)}
          />
          {(snapshot.vocabulary.voicePresets ?? []).map((preset) => (
            <Chip
              key={preset.id}
              label={tx(preset.label)}
              tag={preset.id}
              state={voice?.preset === preset.id ? 'on' : 'off'}
              onClick={() => void setVoice(preset.id).then(refresh)}
            />
          ))}
        </ChipRow>
      </Section>

      {bypassed ? (
        <p className={styles.bypassed}>{t('panel.voice.bypassed')}</p>
      ) : (
        <>
          <Section title={t('panel.voice.tone')} meta="pitch / formant">
            {knob(t('panel.voice.pitch'), 'retune.semitones', 0, {
              min: -12,
              max: 12,
              step: 0.5,
              precision: 1,
              unit: t('panel.voice.semitones'),
            })}
            {knob(t('panel.voice.pitchAmount'), 'retune.mix', 1, { min: 0, max: 1 })}
            {knob(t('panel.voice.formant'), 'formant.factor', 1, { min: 0.5, max: 2, step: 0.01 })}
            {knob(t('panel.voice.formantAmount'), 'formant.amount', 1, { min: 0, max: 1 })}
            {knob(t('panel.voice.thickness'), 'formant.body', 0, { min: -1, max: 1 })}
            {knob(t('panel.voice.brightness'), 'formant.brightness', 0, { min: -1, max: 1 })}
            {knob(t('panel.voice.nasal'), 'formant.nasal', 0, { min: -1, max: 1 })}
          </Section>

          <Section title={t('panel.voice.eq')} meta="4 band">
            {knob(t('panel.voice.highpass'), 'eq.highpassHz', 120, {
              min: 20,
              max: 400,
              step: 5,
              precision: 0,
              unit: 'Hz',
            })}
            {knob(t('panel.voice.eqBody'), 'eq.bodyDb', 0, {
              min: -12,
              max: 12,
              step: 0.5,
              precision: 1,
              unit: 'dB',
            })}
            {knob(t('panel.voice.presence'), 'eq.presenceDb', 0, {
              min: -12,
              max: 12,
              step: 0.5,
              precision: 1,
              unit: 'dB',
            })}
            {knob(t('panel.voice.air'), 'eq.airDb', 0, {
              min: -12,
              max: 12,
              step: 0.5,
              precision: 1,
              unit: 'dB',
            })}
          </Section>

          <Section title={t('panel.voice.gate')} meta="noise" note={[t('panel.voice.gate.note')]}>
            {knob(t('panel.voice.threshold'), 'gate.thresholdDb', -50, {
              min: -80,
              max: -10,
              step: 1,
              precision: 0,
              unit: 'dB',
            })}
            {knob(t('panel.voice.release'), 'gate.releaseMs', 80, {
              min: 10,
              max: 500,
              step: 5,
              precision: 0,
              unit: 'ms',
            })}
            {knob(t('panel.voice.range'), 'gate.rangeDb', 22, {
              min: 0,
              max: 60,
              step: 1,
              precision: 0,
              unit: 'dB',
            })}
          </Section>

          <Section
            title={t('panel.voice.compressor')}
            meta="dynamics"
            note={[t('panel.voice.compressor.note')]}
          >
            {knob(t('panel.voice.threshold'), 'compressor.thresholdDb', -23, {
              min: -50,
              max: 0,
              step: 0.5,
              precision: 1,
              unit: 'dB',
            })}
            {knob(t('panel.voice.ratio'), 'compressor.ratio', 3, {
              min: 1,
              max: 12,
              step: 0.1,
              precision: 1,
            })}
            {knob(t('panel.voice.attack'), 'compressor.attackMs', 4.5, {
              min: 0.5,
              max: 50,
              step: 0.5,
              precision: 1,
              unit: 'ms',
            })}
            {knob(t('panel.voice.release'), 'compressor.releaseMs', 75, {
              min: 10,
              max: 500,
              step: 5,
              precision: 0,
              unit: 'ms',
            })}
            {knob(t('panel.voice.makeup'), 'compressor.makeupGainDb', 0, {
              min: -6,
              max: 12,
              step: 0.5,
              precision: 1,
              unit: 'dB',
            })}
          </Section>

          <Section title={t('panel.voice.deesser')} meta="sibilance">
            {knob(t('panel.voice.frequency'), 'deesser.frequencyHz', 7000, {
              min: 3000,
              max: 12000,
              step: 100,
              precision: 0,
              unit: 'Hz',
            })}
            {knob(t('panel.voice.threshold'), 'deesser.thresholdDb', -30, {
              min: -60,
              max: 0,
              step: 1,
              precision: 0,
              unit: 'dB',
            })}
            {knob(t('panel.voice.range'), 'deesser.rangeDb', 6, {
              min: 0,
              max: 24,
              step: 0.5,
              precision: 1,
              unit: 'dB',
            })}
          </Section>

          <Section
            title={t('panel.voice.reverb')}
            meta={t('panel.voice.reverb.meta')}
            note={[t('panel.voice.reverb.note')]}
          >
            {knob(t('panel.voice.reverbMix'), 'reverb.mix', 0, { min: 0, max: 1 })}
            {knob(t('panel.voice.reverbTime'), 'reverb.timeMs', 320, {
              min: 50,
              max: 3000,
              step: 10,
              precision: 0,
              unit: 'ms',
            })}
            {knob(t('panel.voice.damping'), 'reverb.damping', 0.5, { min: 0, max: 1 })}
          </Section>

          <Section
            title={t('panel.voice.output')}
            meta="loudness"
            note={[t('panel.voice.output.note')]}
          >
            {knob(t('panel.voice.outputGain'), 'outputGainDb', 0, {
              min: -12,
              max: 12,
              step: 0.5,
              precision: 1,
              unit: 'dB',
            })}
            {knob(t('panel.voice.wet'), 'wetMix', 1, { min: 0, max: 1 })}
            {knob(t('panel.voice.ceiling'), 'limiter.ceilingDb', -1, {
              min: -6,
              max: 0,
              step: 0.1,
              precision: 1,
              unit: 'dB',
            })}
          </Section>
        </>
      )}
    </div>
  );
}
