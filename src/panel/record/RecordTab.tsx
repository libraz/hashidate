import { useState } from 'react';
import { useT } from '@/i18n';
import type { Snapshot } from '@/protocol';
import { Field } from '@/ui/Field';
import { Section } from '@/ui/Section';
import { Segmented } from '@/ui/Segmented';
import { Toggle } from '@/ui/Toggle';
import { isFailure, recordStart, recordStop } from '../api';
import styles from './RecordTab.module.css';

/**
 * Writing the composed frame to a file.
 *
 * ## Only the take
 *
 * Loading a script and letting the queue go both live in the Queue tab, where
 * loading one *is* filling that queue and the feedback for having pressed it is
 * the list appearing underneath. What is left here is a take: how large, how
 * fast, when it ends, and what is on disk so far.
 *
 * The two halves stay one movement even so, because the record button releases
 * a held queue — on the first chunk that actually lands, not on the request.
 * So the whole sequence is: load a script in the Queue tab, frame the shot in
 * the preview, come here and press record.
 *
 * ## Nothing here holds state the server has
 *
 * Which script filled the queue is read back off the queue's own `source`
 * rather than remembered here, so a panel reloaded mid-setup still names the
 * take after the right script. Whether a recording is running, how large it is
 * and what it is called all come from the snapshot, because the server is the
 * process with the open file — see `recordingSchema`.
 */

interface Props {
  snapshot: Snapshot;
  refresh: () => void;
}

const SIZES = [
  { value: '1920x1080', label: '1920×1080' },
  { value: '1280x720', label: '1280×720' },
] as const;

const RATES = [
  { value: '30', label: '30 fps' },
  { value: '60', label: '60 fps' },
] as const;

/** `12:34`, which is how long a take reads as. Hours are spelled out past one. */
export function elapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value: number): string => String(value).padStart(2, '0');
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${pad(minutes)}:${pad(whole % 60)}`;
  return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(whole % 60)}`;
}

/**
 * A byte count as an operator reads it.
 *
 * The figure that matters is whether it is *climbing*, so the unit is chosen to
 * keep it moving: a take writes a few megabytes a minute, and a number that sat
 * at `0.0 GB` for the first ten would look exactly like one that had stopped.
 */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The last path segment, which is the only part of a take's path worth the width. */
export function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * Which script filled the queue, from the queue itself.
 *
 * `source` is stamped on every entry a run adds — see `TurnQueue.add` — so this
 * is the script whose lines are actually pending rather than the last one
 * anybody pressed. It is what the take gets named after, which means the name
 * is right even for a panel that was opened after the script was loaded.
 */
export function queuedScript(snapshot: Snapshot): string | undefined {
  return snapshot.queue.find((entry) => entry.source !== undefined)?.source;
}

export function RecordTab({ snapshot, refresh }: Props) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [frame, setFrame] = useState<(typeof SIZES)[number]['value']>('1920x1080');
  const [fps, setFps] = useState<(typeof RATES)[number]['value']>('30');
  const [autoStop, setAutoStop] = useState(true);

  const recording = snapshot.recording;
  const paused = snapshot.paused;

  const roll = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    const [width, height] = frame.split('x').map(Number);
    const result = await recordStart({
      name: queuedScript(snapshot),
      width,
      height,
      fps: Number(fps),
      autoStop,
      // The record button is also the play button, and only when there is
      // something being held for it to release. See `recordStartSchema`.
      release: paused,
    });
    setBusy(false);
    if (isFailure(result)) setNotice(result.error);
    refresh();
  };

  const halt = async (): Promise<void> => {
    setBusy(true);
    const result = await recordStop(recording?.session);
    setBusy(false);
    if (isFailure(result)) setNotice(result.error);
    refresh();
  };

  return (
    <Section
      title={t('panel.record.take')}
      meta={recording === null ? '—' : elapsed(Date.now() / 1000 - recording.since)}
      note={[
        t('panel.record.take.note1'),
        t('panel.record.take.note2'),
        t('panel.record.take.note3'),
      ]}
    >
      {/* The settings first and the button under them, because they are decided
          once and it is pressed every take. Both are disabled while one is
          running: the frame a take was opened at is the frame the server has
          the file open at, and a control that moved under a running recording
          would be saying otherwise. */}
      <Field label={t('panel.record.take.size')}>
        <Segmented
          ariaLabel={t('panel.record.take.size')}
          options={SIZES.map((entry) => ({
            value: entry.value,
            label: entry.label,
            disabled: recording !== null,
          }))}
          value={frame}
          onChange={setFrame}
        />
      </Field>
      <Field label={t('panel.record.take.fps')}>
        <Segmented
          ariaLabel={t('panel.record.take.fps')}
          options={RATES.map((entry) => ({
            value: entry.value,
            label: entry.label,
            disabled: recording !== null,
          }))}
          value={fps}
          onChange={setFps}
        />
      </Field>
      <Toggle
        label={t('panel.record.take.autoStop')}
        checked={autoStop}
        onChange={setAutoStop}
        title={t('panel.record.take.autoStop.title')}
      />

      <div className={styles.transport}>
        <button
          type="button"
          className={`${styles.roll} ${recording !== null ? styles.rolling : ''}`}
          disabled={busy}
          onClick={() => void (recording === null ? roll() : halt())}
          title={t(
            recording === null ? 'panel.record.take.start.title' : 'panel.record.take.stop.title',
          )}
        >
          <span className={styles.dot} aria-hidden="true" />
          {t(recording === null ? 'panel.record.take.start' : 'panel.record.take.stop')}
        </button>
        {/* Said beside the button rather than only in the note behind the `?`:
            it changes what pressing it does, and it is true exactly when the
            recording flow is being used. */}
        {recording === null && paused ? (
          <span className={styles.hint}>{t('panel.record.take.releases')}</span>
        ) : null}
      </div>

      {notice !== null ? <p className={styles.error}>{notice}</p> : null}

      {recording !== null ? (
        <dl className={styles.readout}>
          <dt>{t('panel.record.take.file')}</dt>
          {/* Before the first chunk the file has no extension, because the
              container is whatever the renderer's encoder turned out to
              choose. See `Recordings`. */}
          <dd>{basename(recording.file)}</dd>
          <dt>{t('panel.record.take.written')}</dt>
          <dd>
            {size(recording.bytes)}
            {recording.mime === null ? ` · ${t('panel.record.take.waiting')}` : ''}
          </dd>
          <dt>{t('panel.record.take.format')}</dt>
          <dd>
            {recording.mime ?? '—'}
            {` · ${recording.width}×${recording.height} · ${recording.fps} fps`}
          </dd>
        </dl>
      ) : null}
    </Section>
  );
}
