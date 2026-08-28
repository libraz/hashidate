import { useState } from 'react';
import { useT } from '@/i18n';
import type { QueueEntry, Snapshot, TurnRequest } from '@/protocol';
import {
  queueAdd,
  queueClear,
  queueMove,
  queuePop,
  queueRemove,
  queueShift,
  queueUpdate,
  setPaused,
} from '../api';
import { checkQueue, type LineCheck } from '../lint';
import { ScriptPicker } from '../script/ScriptPicker';
import { History } from './History';
import { LineEditor } from './LineEditor';
import { clock, QueueRow } from './QueueRow';
import styles from './QueueTab.module.css';

/**
 * The pending script, and everything that can be done to it during a broadcast.
 *
 * ## The picker is above the timeline, not part of it
 *
 * A script is loaded here rather than somewhere of its own, because loading one
 * *is* filling this queue and the whole feedback for having pressed it is the
 * list appearing underneath. It sits above the three regions below and is drawn
 * differently, since it is where a segment starts rather than another thing
 * that happened to a line. See `ScriptPicker`.
 *
 * ## Three regions, and the boundaries between them are real
 *
 * *On air* is the line being said. It is out of the queue by the time it starts,
 * it cannot be reordered because it has begun, and it cannot be edited because
 * the audio for it is already playing. Drawing it as row zero of a draggable
 * list would be a lie about all three, so it sits above the list as its own
 * thing, with the one control that does apply to it: stop.
 *
 * *Pending* is the list. Every row here can be moved, rewritten or dropped, and
 * every one of those is a POST that ends with the whole list being pushed to the
 * renderer — see `queue.ts`. A line already synthesised keeps its audio through
 * a reorder, so dragging costs nothing.
 *
 * *The composer* is at the bottom, where a new line is written. It is not a
 * modal: during a stream the operator is writing the next line while reading the
 * queue and watching the render, and a dialog over any of those is a dialog to
 * dismiss before the answer can be typed.
 *
 * ## Interjection is two verbs, not one
 *
 * A viewer's comment that changes the subject wants **割り込み** (interrupt) — go
 * to the front of the queue and be said next. A comment that ends the current
 * topic wants that *and* a stop. They are separate buttons because the second
 * one cuts the character off mid-word, which is sometimes exactly right and is
 * never something to do by accident.
 */

interface Props {
  snapshot: Snapshot;
  refresh: () => void;
}

/** Where the composer files what it queues, so a row can say where it came from. */
const PANEL_SOURCE = 'panel';

export function QueueTab({ snapshot, refresh }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const { t } = useT();

  const entries = snapshot.queue;
  const { checks, seconds, warnings } = checkQueue(entries, snapshot.vocabulary);
  const running = snapshot.state.turn ?? null;

  /** Every mutation ends the same way: apply, then re-read rather than assume. */
  const run = async (work: Promise<unknown>): Promise<void> => {
    await work;
    refresh();
  };

  const drop = (): void => {
    const id = dragId;
    const at = dropAt;
    setDragId(null);
    setDropAt(null);
    if (id === null || at === null) return;
    const from = entries.findIndex((e) => e.id === id);
    // `to` is the index after the row has been lifted out, which is what the
    // server's `move` expects and what a drop position means. Dropping either
    // side of where it already is changes nothing.
    const to = at > from ? at - 1 : at;
    if (from === -1 || to === from) return;
    void run(queueMove(id, to));
  };

  const submitNew = (turn: TurnRequest, at: 'push' | 'unshift'): void => {
    setComposing(false);
    void run(queueAdd([turn], { at, source: PANEL_SOURCE }));
  };

  return (
    <div className={styles.tab}>
      <ScriptPicker entries={entries} refresh={refresh} />

      {/* Past above, present under it, future below: the three regions read as
          one timeline, and a rewind moves a row from the top of it to the
          bottom. */}
      <History refresh={refresh} />

      <OnAir
        running={running}
        speaking={snapshot.state.speaking ?? false}
        paused={snapshot.paused}
        pending={entries.length}
        onToggleHold={() => void run(setPaused(!snapshot.paused))}
      />

      <div className={styles.summary}>
        <span className={styles.count}>
          {t('panel.queue.waiting')} <strong>{entries.length}</strong>
        </span>
        <span className={styles.total}>{t('panel.queue.remaining', { time: clock(seconds) })}</span>
        {warnings > 0 ? (
          <span className={styles.warnings}>{t('panel.queue.warnings', { count: warnings })}</span>
        ) : null}
        <div className={styles.summaryActions}>
          <button
            type="button"
            onClick={() => void run(queueShift())}
            disabled={entries.length === 0}
            title={t('panel.queue.dropFirst.title')}
          >
            {t('panel.queue.dropFirst')}
          </button>
          <button
            type="button"
            onClick={() => void run(queuePop())}
            disabled={entries.length === 0}
            title={t('panel.queue.dropLast.title')}
          >
            {t('panel.queue.dropLast')}
          </button>
          <button
            type="button"
            className={styles.danger}
            onClick={() => void run(queueClear())}
            disabled={entries.length === 0}
            title={t('panel.queue.clear.title')}
          >
            {t('panel.queue.clear')}
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className={styles.empty}>
          {t('panel.queue.empty.before')} <code>POST /api/queue</code>{' '}
          {t('panel.queue.empty.after')}
        </p>
      ) : (
        <ul
          className={styles.list}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            drop();
          }}
        >
          {entries.map((entry, index) => (
            <RowOrEditor
              key={entry.id}
              entry={entry}
              index={index}
              snapshot={snapshot}
              check={checks.get(entry.id)}
              editing={editing === entry.id}
              dropAt={dragId === null ? null : dropAt}
              dragging={dragId === entry.id}
              onDragStart={() => setDragId(entry.id)}
              onDragOver={setDropAt}
              onDragEnd={drop}
              onEdit={() => setEditing(entry.id)}
              onCancelEdit={() => setEditing(null)}
              onSave={(turn) => {
                setEditing(null);
                void run(queueUpdate(entry.id, turn));
              }}
              onRemove={() => void run(queueRemove(entry.id))}
              onPromote={() => void run(queueMove(entry.id, 0))}
            />
          ))}
        </ul>
      )}

      {composing ? (
        <div className={styles.composer}>
          <LineEditor
            initial={{}}
            vocabulary={snapshot.vocabulary}
            submitLabel={t('panel.queue.push')}
            onSubmit={(turn) => submitNew(turn, 'push')}
            secondaryLabel={t('panel.queue.interject')}
            onSecondary={(turn) => submitNew(turn, 'unshift')}
            onCancel={() => setComposing(false)}
          />
        </div>
      ) : (
        <button type="button" className={styles.add} onClick={() => setComposing(true)}>
          {t('panel.queue.addLine')}
        </button>
      )}
    </div>
  );
}

/**
 * The line on air, and whether the queue is moving.
 *
 * Its own region above the list rather than a highlighted first row, because
 * nothing that applies to a pending line applies to it. `live` and not `accent`:
 * the token file reserves that colour for exactly this, and using it anywhere
 * else would cost it its meaning.
 *
 * The hold lives here rather than in a transport of its own, because this is
 * already the answer to "is anything happening" — and a held queue with twenty
 * lines in it is a different answer from an idle one with none, which the old
 * "standing by" could not tell apart. The button is on the right, away from the
 * drop and clear controls under the list: those destroy lines and this one does
 * not.
 */
function OnAir({
  running,
  speaking,
  paused,
  pending,
  onToggleHold,
}: {
  running: string | null;
  speaking: boolean;
  paused: boolean;
  pending: number;
  onToggleHold: () => void;
}) {
  const { t } = useT();
  // No colour of its own for the held state. `--live` is the only tint this
  // block is allowed, per the token file, and a second one beside it would cost
  // the first the thing it is for. What says "held" is the label and the armed
  // button, which is what an operator is going to press anyway.
  return (
    <div className={`${styles.onAir} ${running ? styles.live : ''}`}>
      <span className={styles.airLabel}>
        {running
          ? t('panel.queue.onAir')
          : paused
            ? t('panel.queue.held')
            : t('panel.queue.standingBy')}
      </span>
      <span className={styles.airId}>{running ?? '—'}</span>
      {speaking ? <span className={styles.airDot} aria-hidden="true" /> : null}
      {/* Disabled with nothing to release rather than hidden: a control that
          appears when a queue fills is one an operator has to find again every
          time, and where it is matters more than whether it can be pressed. */}
      <button
        type="button"
        className={`${styles.hold} ${paused ? styles.armed : ''}`}
        disabled={paused && pending === 0}
        onClick={onToggleHold}
        title={t(paused ? 'panel.queue.play.title' : 'panel.queue.hold.title')}
      >
        {t(paused ? 'panel.queue.play' : 'panel.queue.hold')}
      </button>
    </div>
  );
}

/**
 * A row, or the editor that has replaced it.
 *
 * Swapped in place rather than opened beside the row, so the list does not grow
 * a second copy of the same line — which during a reorder is the one thing that
 * makes a queue unreadable.
 */
function RowOrEditor({
  entry,
  index,
  snapshot,
  check,
  editing,
  onCancelEdit,
  onSave,
  ...row
}: {
  entry: QueueEntry;
  index: number;
  snapshot: Snapshot;
  /** Absent for a row that arrived between the poll and this render. */
  check: LineCheck | undefined;
  editing: boolean;
  dropAt: number | null;
  dragging: boolean;
  onDragStart: () => void;
  onDragOver: (at: number) => void;
  onDragEnd: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (turn: TurnRequest) => void;
  onRemove: () => void;
  onPromote: () => void;
}) {
  const { t } = useT();
  if (editing) {
    return (
      <li className={styles.editingRow}>
        <LineEditor
          initial={entry}
          vocabulary={snapshot.vocabulary}
          submitLabel={t('panel.queue.save')}
          onSubmit={onSave}
          onCancel={onCancelEdit}
        />
      </li>
    );
  }
  // A row with no check has only just arrived between the poll and this render.
  // Skipping it for one frame is better than inventing an empty check, which
  // would flash "台詞なし" (no dialogue) on a line that has text.
  if (!check) return null;
  return <QueueRow entry={entry} check={check} index={index} {...row} />;
}
