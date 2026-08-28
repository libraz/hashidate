import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n';
import type { ScriptSummary, ScriptsResponse, Snapshot } from '@/protocol';
import { Chip, ChipRow } from '@/ui/Chip';
import { Field } from '@/ui/Field';
import { Section } from '@/ui/Section';
import { Segmented } from '@/ui/Segmented';
import { Toggle } from '@/ui/Toggle';
import { isFailure, readScripts, recordStart, recordStop, runScript, setPaused } from '../api';
import { ago } from '../slides/SlidesTab';
import styles from './RecordTab.module.css';

/**
 * Recording a segment: load a script, frame the shot, roll.
 *
 * ## The three controls are one movement
 *
 * They are in one tab because they are used in one order and nowhere else. A
 * script is loaded, and it does not start — the queue fills and the character
 * stands there. That gap is the point of the tab: it is where the shot gets
 * framed, in the preview above and in the Slides tab, with the whole run of
 * lines already loaded and already being synthesised. Then the record button
 * both starts the take and lets the queue go, in that order, and the take opens
 * on the first word rather than on the wait for it.
 *
 * Splitting these across the tabs they each nominally belong to — the script
 * with the queue, the transport with the transport bar, the recorder somewhere
 * of its own — would put a four-step sequence behind three tab switches, two of
 * them while the operator is trying to watch the render.
 *
 * ## Nothing here holds state the server has
 *
 * Which script filled the queue is read back off the queue's own `source`
 * rather than remembered here, so a panel reloaded mid-setup still names the
 * take after the right script. Whether a recording is running, how large it is
 * and what it is called all come from the snapshot, because the server is the
 * process with the open file — see `recordingSchema`.
 *
 * The roster is the one thing read separately, and on demand rather than on the
 * poll: summarising a script means parsing it, and parsing every file in the
 * directory twice a second to feed a picker nobody is looking at would be the
 * most expensive thing the control server does.
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
  const [roster, setRoster] = useState<ScriptsResponse | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [frame, setFrame] = useState<(typeof SIZES)[number]['value']>('1920x1080');
  const [fps, setFps] = useState<(typeof RATES)[number]['value']>('30');
  const [autoStop, setAutoStop] = useState(true);

  const recording = snapshot.recording;
  const paused = snapshot.paused;
  const pending = snapshot.queue.length;

  const rescan = useCallback(async () => {
    const result = await readScripts();
    if (isFailure(result)) {
      setRosterError(result.error);
      return;
    }
    setRosterError(null);
    setRoster(result);
  }, []);

  // Once when the tab is opened, and never on a timer. See the docstring.
  useEffect(() => {
    void rescan();
  }, [rescan]);

  const load = async (script: ScriptSummary): Promise<void> => {
    setBusy(true);
    setNotice(null);
    const result = await runScript(script.id);
    setBusy(false);
    if (isFailure(result)) {
      setNotice(result.error);
      refresh();
      return;
    }
    // The lines are on the server's queue whatever happened; the setup is live
    // commands and is simply refused when nothing is attached. Worth saying,
    // because it is the difference between a script that will play as written
    // and one whose avatar, costume and framing never happened.
    if (result.setup > 0 && result.setupDelivered === 0) {
      setNotice(t('panel.record.script.noRenderer'));
    }
    refresh();
  };

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

  const scripts = roster?.scripts ?? [];
  const broken = roster?.errors ?? [];

  return (
    <>
      <Section
        title={t('panel.record.script')}
        meta={scripts.length === 0 ? '—' : String(scripts.length)}
        note={[
          t('panel.record.script.note1'),
          t('panel.record.script.note2'),
          t('panel.record.script.note3'),
        ]}
      >
        <ChipRow>
          {scripts.map((script) => (
            <Chip
              key={script.id}
              label={script.title ?? script.id}
              tag={`${t('panel.record.script.lines', { count: script.lines })} · ${ago(script.at)}`}
              title={script.id}
              disabled={busy}
              onClick={() => void load(script)}
            />
          ))}
          <Chip
            label={t('panel.record.script.rescan')}
            variant="action"
            title={t('panel.record.script.rescan.title')}
            onClick={() => void rescan()}
          />
        </ChipRow>
        {roster !== null && scripts.length === 0 ? (
          <p className={styles.empty}>{t('panel.record.script.empty')}</p>
        ) : null}
        {rosterError !== null ? <p className={styles.error}>{rosterError}</p> : null}
        {/* Listed rather than dropped: a file the operator saved into the
            directory and that is not a script has to be visible as exactly
            that. A name missing from the list reads as a name typed wrong. */}
        {broken.length > 0 ? (
          <ul className={styles.broken}>
            {broken.map((entry) => (
              <li key={entry.id}>
                <code>{entry.id}</code> {entry.error}
              </li>
            ))}
          </ul>
        ) : null}
        {notice !== null ? <p className={styles.error}>{notice}</p> : null}
      </Section>

      <Section
        title={t('panel.record.play')}
        meta={t(paused ? 'panel.record.play.held' : 'panel.record.play.running')}
        note={[t('panel.record.play.note1'), t('panel.record.play.note2')]}
      >
        <div className={styles.transport}>
          <button
            type="button"
            className={`${styles.go} ${paused ? styles.armed : ''}`}
            onClick={() => void setPaused(!paused).then(refresh)}
            title={t(paused ? 'panel.record.play.start.title' : 'panel.record.play.hold.title')}
          >
            {t(paused ? 'panel.record.play.start' : 'panel.record.play.hold')}
          </button>
          <span className={styles.count}>{t('panel.record.play.pending', { count: pending })}</span>
        </div>
      </Section>

      <Section
        title={t('panel.record.take')}
        meta={recording === null ? '—' : elapsed(Date.now() / 1000 - recording.since)}
        note={[
          t('panel.record.take.note1'),
          t('panel.record.take.note2'),
          t('panel.record.take.note3'),
        ]}
      >
        <Field label={t('panel.record.take.size')}>
          <Segmented
            ariaLabel={t('panel.record.take.size')}
            options={SIZES.map((entry) => ({ value: entry.value, label: entry.label }))}
            value={frame}
            onChange={setFrame}
          />
        </Field>
        <Field label={t('panel.record.take.fps')}>
          <Segmented
            ariaLabel={t('panel.record.take.fps')}
            options={RATES.map((entry) => ({ value: entry.value, label: entry.label }))}
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
        </div>

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
    </>
  );
}
