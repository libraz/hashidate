import { useState } from 'react';
import type { QueueEntry, Snapshot, TurnRequest } from '@/protocol';
import {
  queueAdd,
  queueClear,
  queueMove,
  queuePop,
  queueRemove,
  queueShift,
  queueUpdate,
} from '../api';
import { checkQueue, type LineCheck } from '../lint';
import { History } from './History';
import { LineEditor } from './LineEditor';
import { clock, QueueRow } from './QueueRow';
import styles from './QueueTab.module.css';

/**
 * The pending script, and everything that can be done to it during a broadcast.
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
 * A viewer's comment that changes the subject wants **割り込み** — go to the
 * front of the queue and be said next. A comment that ends the current topic
 * wants that *and* a stop. They are separate buttons because the second one cuts
 * the character off mid-word, which is sometimes exactly right and is never
 * something to do by accident.
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
      {/* Past above, present under it, future below: the three regions read as
          one timeline, and a rewind moves a row from the top of it to the
          bottom. */}
      <History refresh={refresh} />

      <OnAir running={running} speaking={snapshot.state.speaking ?? false} />

      <div className={styles.summary}>
        <span className={styles.count}>
          待ち <strong>{entries.length}</strong>
        </span>
        <span className={styles.total}>残り {clock(seconds)}</span>
        {warnings > 0 ? <span className={styles.warnings}>要確認 {warnings}</span> : null}
        <div className={styles.summaryActions}>
          <button
            type="button"
            onClick={() => void run(queueShift())}
            disabled={entries.length === 0}
            title="先頭を取り出して捨てる"
          >
            先頭を捨てる
          </button>
          <button
            type="button"
            onClick={() => void run(queuePop())}
            disabled={entries.length === 0}
            title="末尾を取り出して捨てる"
          >
            末尾を捨てる
          </button>
          <button
            type="button"
            className={styles.danger}
            onClick={() => void run(queueClear())}
            disabled={entries.length === 0}
            title="待ち行列を空にする。いま言っている行はそのまま終わります"
          >
            全消去
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className={styles.empty}>
          待ち行列は空です。下で書くか、<code>POST /api/queue</code> で投入されます。
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
            submitLabel="末尾に追加"
            onSubmit={(turn) => submitNew(turn, 'push')}
            secondaryLabel="次に割り込む"
            onSecondary={(turn) => submitNew(turn, 'unshift')}
            onCancel={() => setComposing(false)}
          />
        </div>
      ) : (
        <button type="button" className={styles.add} onClick={() => setComposing(true)}>
          + 行を追加
        </button>
      )}
    </div>
  );
}

/**
 * The line on air.
 *
 * Its own region above the list rather than a highlighted first row, because
 * nothing that applies to a pending line applies to it. `live` and not `accent`:
 * the token file reserves that colour for exactly this, and using it anywhere
 * else would cost it its meaning.
 */
function OnAir({ running, speaking }: { running: string | null; speaking: boolean }) {
  return (
    <div className={`${styles.onAir} ${running ? styles.live : ''}`}>
      <span className={styles.airLabel}>{running ? '発話中' : '待機'}</span>
      <span className={styles.airId}>{running ?? '—'}</span>
      {speaking ? <span className={styles.airDot} aria-hidden="true" /> : null}
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
  if (editing) {
    return (
      <li className={styles.editingRow}>
        <LineEditor
          initial={entry}
          vocabulary={snapshot.vocabulary}
          submitLabel="保存"
          onSubmit={onSave}
          onCancel={onCancelEdit}
        />
      </li>
    );
  }
  // A row with no check has only just arrived between the poll and this render.
  // Skipping it for one frame is better than inventing an empty check, which
  // would flash "台詞なし" on a line that has text.
  if (!check) return null;
  return <QueueRow entry={entry} check={check} index={index} {...row} />;
}
