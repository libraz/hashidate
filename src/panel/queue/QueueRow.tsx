import { useT } from '@/i18n';
import type { QueueEntry } from '@/protocol';
import type { LineCheck } from '../lint';
import styles from './QueueRow.module.css';

/**
 * One pending line, as a row that can be dragged, read and acted on.
 *
 * ## Everything visible here is derived, not stored
 *
 * The spoken text, the cues and the estimate all come from `checkLine`, which
 * runs the *engine's own* parser over the line. That is the point: a row shows
 * what the renderer will do with the line, not what was typed. A cue that will
 * be dropped is drawn as dropped, and a bracket that will be swallowed is
 * counted, before the character says any of it.
 *
 * ## Drag and drop with no library and no ghost element
 *
 * Native HTML drag events, and the drop target is decided by which half of a row
 * the pointer is over — an insertion line above or below it. A list of at most a
 * few dozen short rows does not need a virtualised reorder library, and the one
 * behaviour a library would buy (an animated gap opening) is exactly the one
 * worth not having here: the operator is reordering a script during a broadcast
 * and wants the row to land, not to be shown a transition.
 */

interface Props {
  entry: QueueEntry;
  check: LineCheck;
  index: number;
  /** Where an in-flight drag would insert, so the row can draw the line. */
  dropAt: number | null;
  dragging: boolean;
  onDragStart: () => void;
  onDragOver: (at: number) => void;
  onDragEnd: () => void;
  onEdit: () => void;
  onRemove: () => void;
  /** Move to the front. What a comment that has to be answered now needs. */
  onPromote: () => void;
}

/**
 * One stroke on a 12 px square, in whatever colour its button is.
 *
 * `aria-label` on the `svg` and not on the button, because the button already
 * carries the same string as its `title`: what a screen reader needs is for the
 * drawing to be a name rather than an unlabelled graphic.
 */
function Mark({ d, label }: { d: string; label: string }) {
  return (
    <svg
      className={styles.mark}
      viewBox="0 0 12 12"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={label}
    >
      <path d={d} />
    </svg>
  );
}

/** Seconds as `1:04`, because a queue is read as a running time. */
export const clock = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

export function QueueRow({
  entry,
  check,
  index,
  dropAt,
  dragging,
  onDragStart,
  onDragOver,
  onDragEnd,
  onEdit,
  onRemove,
  onPromote,
}: Props) {
  const { t } = useT();
  const warnings = check.findings.filter((f) => f.severity === 'warn');
  const notes = check.findings.filter((f) => f.severity === 'note');

  const classes = [
    styles.row,
    dragging ? styles.dragging : '',
    warnings.length ? styles.warned : '',
    dropAt === index ? styles.dropBefore : '',
    dropAt === index + 1 ? styles.dropAfter : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li
      className={classes}
      draggable
      onDragStart={(e) => {
        // Firefox refuses to start a drag without payload, and the payload is
        // never read: the dragged row is held in the list's own state, because
        // the drop has to know which entry moved and not which text was carried.
        e.dataTransfer.setData('text/plain', entry.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // Which half of the row the pointer is over decides whether the line
        // goes above or below it. Measured per event rather than from the
        // element's cached box, since the list scrolls while dragging.
        const box = e.currentTarget.getBoundingClientRect();
        onDragOver(e.clientY < box.top + box.height / 2 ? index : index + 1);
      }}
      onDragEnd={onDragEnd}
      onDrop={(e) => {
        e.preventDefault();
        onDragEnd();
      }}
    >
      <div className={styles.grip} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <div className={styles.body}>
        <div className={styles.meta}>
          <span className={styles.index}>{index + 1}</span>
          {entry.source ? <span className={styles.source}>{entry.source}</span> : null}
          <span className={styles.seconds}>{clock(check.seconds)}</span>
          {entry.reading ? (
            <span
              className={styles.tag}
              title={t('panel.row.reading.title', { reading: entry.reading })}
            >
              {t('panel.row.reading')}
            </span>
          ) : null}
          {entry.hold ? (
            <span className={styles.tag} title={t('panel.row.hold.title')}>
              hold
            </span>
          ) : null}
        </div>

        {/* The spoken line, with the cues drawn where they fall in it. A cue the
            avatar does not have is struck through rather than hidden: it is
            about to do nothing, and the row has to say so. */}
        <p className={styles.line}>
          {check.spoken || <span className={styles.silent}>{t('panel.row.silent')}</span>}
        </p>

        {check.cues.length || entry.perform || entry.gesture || entry.expression ? (
          <div className={styles.cues}>
            {entry.perform ? (
              <span className={styles.field} title={t('panel.row.perform.title')}>
                {entry.perform}
              </span>
            ) : null}
            {entry.gesture ? (
              <span className={styles.field} title={t('panel.row.gesture.title')}>
                {entry.gesture}
              </span>
            ) : null}
            {entry.expression ? (
              <span className={styles.field} title={t('panel.row.expression.title')}>
                {entry.expression}
              </span>
            ) : null}
            {check.cues.map((cue) => (
              <span
                // Adjacent cues share a mouth-clock position, and the same
                // action may legitimately be repeated. Source order therefore
                // completes the key while the generic label keeps the row
                // useful for camera, slide and BGM as well as performances.
                key={`${cue.ordinal}-${cue.label}`}
                className={`${styles.cue} ${cue.known ? '' : styles.unknown}`}
                title={t('panel.row.cue.title', { percent: Math.round(cue.at * 100) })}
              >
                {cue.label}
              </span>
            ))}
          </div>
        ) : null}

        {entry.note ? <p className={styles.note}>{entry.note}</p> : null}

        {warnings.length || notes.length ? (
          <ul className={styles.findings}>
            {warnings.map((f) => (
              <li key={f.message} className={styles.warn}>
                {f.message}
              </li>
            ))}
            {notes.map((f) => (
              <li key={f.message} className={styles.noteFinding}>
                {f.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/*
        Three marks rather than two glyphs and a word.

        The column used to read `↑↑`, 編集 (edit), `✕` — an arrow borrowed from
        the arrow block, a label, and a multiplication sign, at three different
        optical weights, in a stack twenty pixels wide. Drawn instead, on the
        same hairline the rest of the panel is ruled with, so the three read as
        one control column and none of them depends on which font the stack
        happened to fall through to. What each does is on its `title` and its
        `aria-label`, which is where it was already.
      */}
      <div className={styles.actions}>
        <button type="button" onClick={onPromote} title={t('panel.row.promote')}>
          <Mark d="M3 2.5h6M6 10.5V5M3.5 7.5 6 5l2.5 2.5" label={t('panel.row.promote')} />
        </button>
        <button type="button" onClick={onEdit} title={t('panel.row.edit')}>
          <Mark d="M8.5 1.5l2 2-6.5 6.5-2.5.5.5-2.5z" label={t('panel.row.edit')} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          title={t('panel.row.remove')}
          className={styles.remove}
        >
          <Mark d="M3 3l6 6M9 3l-6 6" label={t('panel.row.remove')} />
        </button>
      </div>
    </li>
  );
}
