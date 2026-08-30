import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import {
  BGM_DEFAULT_LOOP,
  BGM_DEFAULT_VOLUME,
  BGM_DSP_DEFAULTS,
  BGM_FADE_DEFAULTS,
  BGM_FADE_LIMITS,
  type BgmCommand,
  type BgmDsp,
  type BgmDspPatch,
  type BgmFade,
  type BgmFadePatch,
  type BgmTrack,
  type BgmTransport,
  type Snapshot,
} from '@/protocol';
import { Chip, ChipRow } from '@/ui/Chip';
import { Section } from '@/ui/Section';
import { Toggle } from '@/ui/Toggle';
import { isFailure, readBgm, setBgm } from '../api';
import { ChainSlider } from '../voice/ChainSlider';
import styles from './BgmTab.module.css';

interface Props {
  snapshot: Snapshot;
  refresh: () => void;
}

/** The six independent leaves exposed by the BGM insert chain. */
export type BgmDspControl =
  | 'toneDb'
  | 'compression'
  | 'width'
  | 'reverb.mix'
  | 'reverb.decay'
  | 'reverb.damping';

/**
 * Format a timeline value as the stable `m:ss` readout used by the panel.
 * Invalid or unavailable duration is intentionally visible as a dash.
 */
export function formatTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value: number): string => String(value).padStart(2, '0');
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}:${pad(whole % 60)}`;
  return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(whole % 60)}`;
}

/** Format a track size without allowing a large file to collapse to zero. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Map one display control to one leaf patch in the protocol's wire units. */
export function toBgmDspPatch(control: BgmDspControl, displayValue: number): BgmDspPatch {
  const fraction = displayValue / 100;
  switch (control) {
    case 'toneDb':
      return { toneDb: displayValue };
    case 'compression':
      return { compression: fraction };
    case 'width':
      return { width: fraction };
    case 'reverb.mix':
      return { reverb: { mix: fraction } };
    case 'reverb.decay':
      return { reverb: { decay: fraction } };
    case 'reverb.damping':
      return { reverb: { damping: fraction } };
  }
}

/** Convert the normalized state readout to the percentages shown by sliders. */
export function fromBgmDspValue(dsp: BgmDsp, control: BgmDspControl): number {
  switch (control) {
    case 'toneDb':
      return dsp.toneDb;
    case 'compression':
      return dsp.compression * 100;
    case 'width':
      return dsp.width * 100;
    case 'reverb.mix':
      return dsp.reverb.mix * 100;
    case 'reverb.decay':
      return dsp.reverb.decay * 100;
    case 'reverb.damping':
      return dsp.reverb.damping * 100;
  }
}

/** The two transition durations shown in seconds, matching the wire fields. */
export type BgmFadeControl = 'inSeconds' | 'outSeconds';

/** Map one display control to one transition-duration patch. */
export function toBgmFadePatch(control: BgmFadeControl, displayValue: number): BgmFadePatch {
  return control === 'inSeconds' ? { inSeconds: displayValue } : { outSeconds: displayValue };
}

/** Read one transition duration back into the seconds shown by the sliders. */
export function fromBgmFadeValue(fade: BgmFade, control: BgmFadeControl): number {
  return fade[control];
}

/** Select a track without accidentally restarting the one already selected. */
export function trackSelectionIntent(
  currentTrack: string | null,
  requestedTrack: string,
  transport: BgmTransport,
): Pick<BgmCommand, 'track' | 'action'> | null {
  if (currentTrack === requestedTrack) return null;
  return transport === 'playing'
    ? { track: requestedTrack, action: 'play' }
    : { track: requestedTrack };
}

function rosterKey(tracks: readonly BgmTrack[]): string {
  return tracks.map((track) => `${track.id}\u0000${track.bytes}\u0000${track.at}`).join('\u0001');
}

function modified(at: number, locale: 'en' | 'ja'): string {
  if (!Number.isFinite(at) || at <= 0) return '—';
  return new Date(at * 1000).toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function format(track: BgmTrack): string {
  return track.mime === 'audio/mpeg' ? 'MP3' : 'FLAC';
}

const DEFAULT_DSP: BgmDsp = {
  ...BGM_DSP_DEFAULTS,
  reverb: { ...BGM_DSP_DEFAULTS.reverb },
};

const DEFAULT_FADE: BgmFade = { ...BGM_FADE_DEFAULTS };

const RESET_DSP: BgmDspPatch = {
  toneDb: BGM_DSP_DEFAULTS.toneDb,
  compression: BGM_DSP_DEFAULTS.compression,
  width: BGM_DSP_DEFAULTS.width,
  reverb: { ...BGM_DSP_DEFAULTS.reverb },
};

const STATUS_KEYS = {
  playing: 'panel.bgm.status.playing',
  paused: 'panel.bgm.status.paused',
  stopped: 'panel.bgm.status.stopped',
  ended: 'panel.bgm.status.ended',
} as const;

export function BgmTab({ snapshot, refresh }: Props) {
  const { t, locale } = useT();
  const state = snapshot.bgm;
  const trackId = state?.track ?? null;
  const tracksFromSnapshot = snapshot.bgmTracks ?? [];
  const [tracks, setTracks] = useState<BgmTrack[]>(tracksFromSnapshot);
  const lastSnapshotRoster = useRef(rosterKey(tracksFromSnapshot));
  const overriddenRoster = useRef<string | null>(null);
  const [rescanBusy, setRescanBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /** Keep a fresh GET visible even if the next 500 ms snapshot still has the old roster. */
  useEffect(() => {
    const key = rosterKey(tracksFromSnapshot);
    if (overriddenRoster.current !== null) {
      if (key !== overriddenRoster.current) return;
      overriddenRoster.current = null;
      lastSnapshotRoster.current = key;
      setTracks(tracksFromSnapshot);
      return;
    }
    if (key === lastSnapshotRoster.current) return;
    lastSnapshotRoster.current = key;
    setTracks(tracksFromSnapshot);
  }, [tracksFromSnapshot]);

  const bgm = state ?? {
    track: null,
    volume: BGM_DEFAULT_VOLUME,
    loop: BGM_DEFAULT_LOOP,
    dsp: DEFAULT_DSP,
    fade: { ...DEFAULT_FADE },
    transport: 'stopped' as const,
    position: 0,
    revision: 0,
    at: 0,
    duration: null,
    blocked: false,
    error: null,
    dspDegraded: false,
  };
  const selected = tracks.find((track) => track.id === trackId);
  const selectedKnown = trackId !== null && selected !== undefined;
  const statusKey = STATUS_KEYS[bgm.transport];
  const position = formatTime(bgm.position);
  const duration = formatTime(bgm.duration);

  const command = async (intent: Parameters<typeof setBgm>[0]): Promise<void> => {
    setBusy(true);
    setNotice(null);
    const result = await setBgm(intent);
    setBusy(false);
    if (isFailure(result)) setNotice(result.error);
    refresh();
  };

  const dspCommand = (patch: BgmDspPatch): void => {
    setNotice(null);
    void setBgm({ dsp: patch }).then((result) => {
      if (isFailure(result)) setNotice(result.error);
      refresh();
    });
  };

  const rescan = async (): Promise<void> => {
    setRescanBusy(true);
    setNotice(null);
    const result = await readBgm();
    setRescanBusy(false);
    if (isFailure(result)) {
      setNotice(result.error);
      return;
    }
    const key = rosterKey(result.tracks);
    overriddenRoster.current = key;
    lastSnapshotRoster.current = key;
    setTracks(result.tracks);
    refresh();
  };

  return (
    <div className={styles.tab}>
      <Section
        title={t('panel.bgm.title')}
        meta={t(statusKey)}
        note={[t('panel.bgm.note1'), t('panel.bgm.note2')]}
      >
        <ChipRow>
          {tracks.map((track) => (
            <Chip
              key={track.id}
              label={track.label}
              tag={`${format(track)} · ${formatBytes(track.bytes)}`}
              title={`${track.id} · ${modified(track.at, locale)}`}
              state={track.id === trackId ? 'on' : 'off'}
              disabled={busy}
              onClick={() => {
                const intent = trackSelectionIntent(trackId, track.id, bgm.transport);
                if (intent !== null) void command(intent);
              }}
            />
          ))}
          <Chip
            label={t('panel.bgm.rescan')}
            variant="action"
            title={t('panel.bgm.rescan.title')}
            disabled={rescanBusy}
            onClick={() => void rescan()}
          />
        </ChipRow>
        {tracks.length === 0 ? <p className={styles.empty}>{t('panel.bgm.empty')}</p> : null}
        {trackId !== null && selected === undefined ? (
          <p className={styles.error}>{t('panel.bgm.missing')}</p>
        ) : null}
        {notice !== null ? <p className={styles.error}>{notice}</p> : null}
      </Section>

      <Section title={t('panel.bgm.selected')} meta={`${position} / ${duration}`}>
        <div className={styles.selected}>
          <div className={styles.selectedName}>
            <strong>{selected?.label ?? (trackId === null ? t('panel.bgm.none') : trackId)}</strong>
            {selected ? (
              <span>
                {format(selected)} · {formatBytes(selected.bytes)} · {modified(selected.at, locale)}
              </span>
            ) : null}
          </div>
          <div className={styles.timeline}>
            <span>{position}</span>
            <span aria-hidden="true">/</span>
            <span>{duration}</span>
          </div>
        </div>
        <div className={styles.transport}>
          <button
            type="button"
            className={`${styles.action} ${styles.primary}`}
            disabled={busy || !selectedKnown}
            title={t('panel.bgm.play.title')}
            onClick={() => {
              if (selected === undefined) return;
              void command({ action: 'play', track: selected.id });
            }}
          >
            {t('panel.bgm.play')}
          </button>
          <button
            type="button"
            className={styles.action}
            disabled={busy || trackId === null || !['playing', 'paused'].includes(bgm.transport)}
            title={t(
              bgm.transport === 'paused' ? 'panel.bgm.resume.title' : 'panel.bgm.pause.title',
            )}
            onClick={() => void command({ action: bgm.transport === 'paused' ? 'play' : 'pause' })}
          >
            {t(bgm.transport === 'paused' ? 'panel.bgm.resume' : 'panel.bgm.pause')}
          </button>
          <button
            type="button"
            className={styles.action}
            disabled={busy || trackId === null || !['playing', 'paused'].includes(bgm.transport)}
            title={t('panel.bgm.stop.title')}
            onClick={() => void command({ action: 'stop' })}
          >
            {t('panel.bgm.stop')}
          </button>
          <button
            type="button"
            className={styles.action}
            disabled={busy || trackId === null}
            title={t('panel.bgm.unload.title')}
            onClick={() => void command({ track: null })}
          >
            {t('panel.bgm.unload')}
          </button>
        </div>
        <ChainSlider
          label={t('panel.bgm.volume')}
          reported={bgm.volume * 100}
          min={0}
          max={100}
          step={1}
          precision={0}
          unit="%"
          onCommit={(value) => {
            void command({ volume: value / 100 });
          }}
        />
        <Toggle
          label={t('panel.bgm.loop')}
          checked={bgm.loop}
          title={t('panel.bgm.loop.title')}
          onChange={(loop) => void command({ loop })}
        />
      </Section>

      <Section
        title={t('panel.bgm.fade')}
        note={[t('panel.bgm.fade.note1'), t('panel.bgm.fade.note2')]}
      >
        <ChainSlider
          label={t('panel.bgm.fadeIn')}
          reported={fromBgmFadeValue(bgm.fade, 'inSeconds')}
          min={BGM_FADE_LIMITS.inSeconds.min}
          max={BGM_FADE_LIMITS.inSeconds.max}
          step={0.1}
          precision={1}
          unit=" s"
          title={t('panel.bgm.fadeIn.title')}
          onCommit={(value) => {
            void command({ fade: toBgmFadePatch('inSeconds', value) });
          }}
        />
        <ChainSlider
          label={t('panel.bgm.fadeOut')}
          reported={fromBgmFadeValue(bgm.fade, 'outSeconds')}
          min={BGM_FADE_LIMITS.outSeconds.min}
          max={BGM_FADE_LIMITS.outSeconds.max}
          step={0.1}
          precision={1}
          unit=" s"
          title={t('panel.bgm.fadeOut.title')}
          onCommit={(value) => {
            void command({ fade: toBgmFadePatch('outSeconds', value) });
          }}
        />
      </Section>

      <Section title={t('panel.bgm.effects')} note={[t('panel.bgm.effects.note')]}>
        <ChainSlider
          label={t('panel.bgm.tone')}
          reported={fromBgmDspValue(bgm.dsp, 'toneDb')}
          min={-6}
          max={6}
          step={0.5}
          precision={1}
          unit=" dB"
          title="toneDb"
          onCommit={(value) => dspCommand(toBgmDspPatch('toneDb', value))}
        />
        <ChainSlider
          label={t('panel.bgm.compression')}
          reported={fromBgmDspValue(bgm.dsp, 'compression')}
          min={0}
          max={100}
          step={5}
          precision={0}
          unit="%"
          title="compression"
          onCommit={(value) => dspCommand(toBgmDspPatch('compression', value))}
        />
        <ChainSlider
          label={t('panel.bgm.width')}
          reported={fromBgmDspValue(bgm.dsp, 'width')}
          min={0}
          max={200}
          step={5}
          precision={0}
          unit="%"
          title="width"
          onCommit={(value) => dspCommand(toBgmDspPatch('width', value))}
        />
        <ChainSlider
          label={t('panel.bgm.reverbMix')}
          reported={fromBgmDspValue(bgm.dsp, 'reverb.mix')}
          min={0}
          max={50}
          step={1}
          precision={0}
          unit="%"
          title="reverb.mix"
          onCommit={(value) => dspCommand(toBgmDspPatch('reverb.mix', value))}
        />
        <ChainSlider
          label={t('panel.bgm.reverbDecay')}
          reported={fromBgmDspValue(bgm.dsp, 'reverb.decay')}
          min={0}
          max={90}
          step={1}
          precision={0}
          unit="%"
          title="reverb.decay"
          onCommit={(value) => dspCommand(toBgmDspPatch('reverb.decay', value))}
        />
        <ChainSlider
          label={t('panel.bgm.damping')}
          reported={fromBgmDspValue(bgm.dsp, 'reverb.damping')}
          min={0}
          max={100}
          step={1}
          precision={0}
          unit="%"
          title="reverb.damping"
          onCommit={(value) => dspCommand(toBgmDspPatch('reverb.damping', value))}
        />
        <button
          type="button"
          className={styles.reset}
          disabled={busy}
          title={t('panel.bgm.resetEffects.title')}
          onClick={() => void command({ dsp: RESET_DSP })}
        >
          {t('panel.bgm.resetEffects')}
        </button>
      </Section>

      {bgm.blocked ? <p className={styles.warning}>{t('panel.bgm.blocked')}</p> : null}
      {bgm.error !== null ? (
        <p className={styles.error}>
          {t('panel.bgm.error')}: {bgm.error}
        </p>
      ) : null}
      {bgm.dspDegraded ? <p className={styles.warning}>{t('panel.bgm.degraded')}</p> : null}
    </div>
  );
}
