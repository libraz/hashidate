import { parseLine } from '@/engine/cues';
import { type Localized, useT } from '@/i18n';
import type { Snapshot } from '@/protocol';
import styles from './SpeakingLine.module.css';

/**
 * The words being said, under the picture saying them.
 *
 * ## Here rather than in the queue tab
 *
 * The queue tab already has an on-air strip, and it is the right place for
 * everything *about* the running turn — its id, and the hold that decides
 * whether another follows it. But it is only on screen while that tab is up,
 * and during a broadcast the operator spends whole segments in the slides tab
 * turning pages. This is inside the preview block instead, which is sticky and
 * shared by every tab, so the answer to "what is it saying right now" is in the
 * same place all evening.
 *
 * ## A fixed height, and the reason is the row underneath
 *
 * The staging controls sit directly below this, and they are pressed by feel
 * while the operator is looking at the picture. A readout that grew with the
 * length of the line would move them on every turn, so the block is two lines
 * tall whatever is in it and a longer line scrolls inside it.
 *
 * ## Only what went through the queue
 *
 * The text comes from the control server's own record of the line it dispatched
 * — see `airing` on the snapshot. A `say` posted straight to `/api/command`
 * never enters that list, so the strip stands by through one, exactly as the
 * history does. The orchestrator's path is the queue; the direct command is a
 * developer's.
 */

/**
 * What is being said, with the cue markup taken out, or null when nothing is.
 *
 * Matched on `state.turn` rather than taking the head of the list: the server
 * files a start per turn id, and an end that never arrives — a renderer lost
 * mid-line — would otherwise leave a stale entry standing in for the live one.
 * A stale state carries no turn at all, which is how this goes quiet when the
 * renderer does.
 */
export function lineOnAir(snapshot: Snapshot): string | null {
  const id = snapshot.state.turn ?? null;
  if (id === null) return null;
  // A server old enough not to report the set at all says nothing about the
  // line rather than nothing about the turn; the strip stands by.
  const entry = (snapshot.airing ?? []).find((candidate) => candidate.id === id);
  if (entry === undefined) return null;
  // The engine's own parser, as the queue rows use: brackets are cues and are
  // never spoken, so a readout that printed them would be showing the operator
  // something nobody is going to hear.
  return parseLine(entry.text ?? '').text;
}

/**
 * The performance the idle autopilot has up, or null when it is not driving.
 *
 * Only between turns: the renderer reports the idle's pick as `performance`
 * while its idle is engaged, and a running turn outranks it in the strip. The
 * label is the avatar's own vocabulary entry, so an id the renderer does not
 * offer reads as nothing rather than as a raw id.
 */
export function idleActOnAir(snapshot: Snapshot): Localized | null {
  const { state, vocabulary } = snapshot;
  if ((state.turn ?? null) !== null || !(state.idle ?? false)) return null;
  const id = state.performance ?? null;
  if (id === null) return null;
  return vocabulary.performances?.find((performance) => performance.id === id)?.label ?? null;
}

export function SpeakingLine({ snapshot }: { snapshot: Snapshot }) {
  const { t, tx } = useT();
  const line = lineOnAir(snapshot);
  const act = line === null ? idleActOnAir(snapshot) : null;
  const speaking = snapshot.state.speaking ?? false;

  return (
    <div
      className={[styles.strip, line === null ? '' : styles.live, speaking ? styles.voiced : '']
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.head}>
        {/* The dot is the voice and the tint is the turn: a line that has
            started but is waiting on its audio is on air without a sound
            coming out, and the strip says both. Always drawn and only ever
            lit, rather than appearing — a mark that comes and goes moves the
            label beside it on every turn. `--live` is the only colour allowed
            here, per the token file. */}
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.label}>
          {t(
            line !== null
              ? 'panel.preview.speaking'
              : act !== null
                ? 'panel.preview.speaking.idle'
                : 'panel.preview.speaking.standingBy',
          )}
        </span>
      </div>
      <p key={line ?? (act === null ? '' : `act:${act.en}`)} className={styles.line}>
        {line === null ? (
          act === null ? null : (
            <span className={styles.act}>{tx(act)}</span>
          )
        ) : (
          line || <span className={styles.silent}>{t('panel.row.silent')}</span>
        )}
      </p>
    </div>
  );
}
