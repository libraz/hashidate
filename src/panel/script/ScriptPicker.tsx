import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n';
import type { QueueEntry, ScriptSummary, ScriptsResponse } from '@/protocol';
import { Chip, ChipRow } from '@/ui/Chip';
import { Toggle } from '@/ui/Toggle';
import { isFailure, readScripts, runScript } from '../api';
import { ago } from '../slides/SlidesTab';
import styles from './ScriptPicker.module.css';

/**
 * Where a run of turns comes from: the scripts on disk, as a picker.
 *
 * ## It sits above the queue because it is what fills it
 *
 * The three regions below this — what was said, what is being said, what is
 * pending — are one timeline. This is not part of it. It is where a segment
 * *starts*, and what it produces is the timeline; so it is above, and it is
 * drawn as a source rather than as a fourth region of the same thing.
 *
 * Being here at all is the point. Pressing a script and then having to change
 * tabs to see whether twenty-two lines arrived is a picker that gives no
 * feedback but a chip lighting up.
 *
 * ## Read on demand, never on the poll
 *
 * Summarising a script means parsing it. Doing that to every file in the
 * directory twice a second, to feed a picker nobody is looking at, would be the
 * most expensive thing the control server does — so the roster is read when this
 * is mounted and when the operator asks, and the rescan is what a file saved
 * mid-session is picked up by.
 *
 * ## Holding is the default and is a control, not a mode
 *
 * A script loaded to be recorded must not start on arrival: the shot is framed
 * after the lines are loaded and before the first one is said, which is the
 * whole reason the recording flow works. Turned off, the picker is what it reads
 * like — press a script and it plays — which is what `yarn ctl play` does from a
 * prompt and what running a segment live wants.
 */

interface Props {
  /** The pending queue, so the picker can say which script it came from. */
  entries: QueueEntry[];
  refresh: () => void;
}

export function ScriptPicker({ entries, refresh }: Props) {
  const { t } = useT();
  const [roster, setRoster] = useState<ScriptsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hold, setHold] = useState(true);

  const rescan = useCallback(async () => {
    const result = await readScripts();
    if (isFailure(result)) {
      setError(result.error);
      return;
    }
    setError(null);
    setRoster(result);
  }, []);

  useEffect(() => {
    void rescan();
  }, [rescan]);

  const load = async (script: ScriptSummary): Promise<void> => {
    setBusy(true);
    setNotice(null);
    const result = await runScript(script.id, { pause: hold });
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
      setNotice(t('panel.script.noRenderer'));
    }
    refresh();
  };

  const scripts = roster?.scripts ?? [];
  const broken = roster?.errors ?? [];
  const known = new Set(scripts.map((script) => script.id));

  /**
   * Which script the pending lines came from, so the chip that is up is lit.
   *
   * Read off the queue's own `source` rather than remembered here — see
   * `TurnQueue.add` — so a panel opened after the script was loaded still marks
   * the right one, which is the same rule the document picker follows.
   */
  const loaded = entries.find(
    (entry) => entry.source !== undefined && known.has(entry.source),
  )?.source;

  /**
   * Pending lines that did not come from a script, which are the ones a load
   * would actually lose.
   *
   * The whole queue is not the right figure and saying so was worse than saying
   * nothing: right after loading a script, "26 lines will be dropped" names the
   * 26 lines that were just loaded, and re-running an edited script replaces
   * them with themselves. What is not recoverable by pressing a chip again is a
   * line somebody typed or an orchestrator queued, so that is what is counted.
   */
  const handmade = entries.filter(
    (entry) => entry.source === undefined || !known.has(entry.source),
  ).length;

  return (
    <section className={styles.picker} aria-label={t('panel.script.aria')}>
      <div className={styles.head}>
        <span className={styles.title}>{t('panel.script.title')}</span>
        <Toggle
          label={t('panel.script.hold')}
          checked={hold}
          onChange={setHold}
          title={t('panel.script.hold.title')}
        />
      </div>

      <ChipRow>
        {scripts.map((script) => (
          <Chip
            key={script.id}
            label={script.title ?? script.id}
            tag={`${t('panel.script.lines', { count: script.lines })} · ${ago(script.at)}`}
            title={script.id}
            // Lit for the script whose lines are actually pending, on the same
            // rule the document picker marks the deck that is up.
            state={script.id === loaded ? 'on' : 'off'}
            disabled={busy}
            onClick={() => void load(script)}
          />
        ))}
        <Chip
          label={t('panel.script.rescan')}
          variant="action"
          title={t('panel.script.rescan.title')}
          onClick={() => void rescan()}
        />
      </ChipRow>

      {/* Only for what a load would actually lose — see `handmade`. A chip does
          not look like the destructive control it becomes when there is
          somebody's typing in the queue, and this is said here rather than
          behind a dialog on the rule the rest of the panel follows: state the
          consequence and trust the person reading it. */}
      {handmade > 0 ? (
        <p className={styles.warn}>{t('panel.script.replaces', { count: handmade })}</p>
      ) : null}

      {roster !== null && scripts.length === 0 ? (
        <p className={styles.empty}>{t('panel.script.empty')}</p>
      ) : null}
      {error !== null ? <p className={styles.error}>{error}</p> : null}
      {notice !== null ? <p className={styles.error}>{notice}</p> : null}

      {/* Listed rather than dropped: a file the operator saved into the
          directory and that is not a script has to be visible as exactly that.
          A name missing from a list reads as a name typed wrong. */}
      {broken.length > 0 ? (
        <ul className={styles.broken}>
          {broken.map((entry) => (
            <li key={entry.id}>
              <code>{entry.id}</code> {entry.error}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
