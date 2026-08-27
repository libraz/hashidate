import type { TurnRequest } from '../engine/types';
import type { Command, HistoryEntry, QueueEntry } from '../protocol';

/**
 * The queue of turns waiting to be said, and the only copy that counts.
 *
 * The renderer has a queue too — `Session.queue`, which is what actually plays —
 * but it is downstream of this one and is replaced wholesale whenever this one
 * changes. Two reasons the authority is here and not there:
 *
 * - **A stream outlives a browser tab.** Reloading the viewer, swapping the
 *   avatar or losing the renderer to a GPU reset must not lose the script. The
 *   queue is re-delivered on the next connect and the show continues.
 * - **A queue that cannot be seen cannot be edited.** The panel reorders lines,
 *   rewrites one that reads badly, and drops the two that a viewer's comment
 *   just made irrelevant. All of that is an edit against a list, and a list that
 *   only exists inside a render loop has nowhere to be edited from.
 *
 * ## What is here and what is not
 *
 * Only what is *pending*. The turn being said is out of the queue by then and is
 * reported through `SessionState.turn`; it cannot be reordered, because it has
 * already started, and it cannot be edited, because the audio for it is already
 * playing. Stopping it is `interrupt`.
 *
 * That distinction is why the panel shows the running line separately rather
 * than as row zero. A row that looks draggable and is not is worse than one that
 * is drawn as what it is.
 *
 * ## Ordering is by position, not by priority
 *
 * There is no priority field and there deliberately is not one. During a stream
 * lines arrive from three directions at once — a script, a viewer's comment,
 * something typed by hand — and every scheme for merging them automatically has
 * to guess. A position in a list does not guess: `unshift` puts a comment next,
 * `move` puts it third, and both are decisions somebody made and can see.
 *
 * ## What was said is kept, and can be sent round again
 *
 * A finished turn moves into the history rather than being dropped. That is what
 * makes the past addressable: a line that came out wrong, or one that was cut
 * off, can be put back at the front of the queue and said again — and so can
 * everything after it, which is the difference between repeating a line and
 * rewinding a script. See `rewind`.
 *
 * The history is bounded and in memory, like everything else here. It is a
 * broadcast aid, not a record: the point of it is the last few minutes, and a
 * stream that ends takes it with it.
 */

/** Where a new entry goes. */
export type Placement = 'push' | 'unshift';

/** What `rewind` was asked to bring back. See `queueRewindSchema`. */
export type RewindMode = 'from' | 'one';

/**
 * How many spoken turns are kept.
 *
 * Enough to cover the stretch anybody would want back — at the pace a line is
 * said, a hundred is most of an hour — and small enough that a stream left
 * running overnight does not grow the process. Past it the oldest go, because
 * the end of the list is the end nobody reaches for.
 */
export const HISTORY_MAX = 100;

/** How the queue tells its owner that the renderer needs the new list. */
export type Deliver = (turns: TurnRequest[]) => number;

/**
 * Epoch seconds, matching the unit the event log stamps `at` in.
 *
 * Its own function rather than an inline `Date.now()` so that the whole module
 * has one notion of what time it is, which is what a test needs to be able to
 * replace.
 */
const now = (): number => Date.now() / 1000;

export class TurnQueue {
  private entries: QueueEntry[] = [];
  /** What has been said, oldest first. Capped at `HISTORY_MAX`. */
  private spoken: HistoryEntry[] = [];
  private seq = 0;

  /**
   * Ids are minted here rather than accepted from the caller.
   *
   * The id is what `turn.start` and `turn.end` come back under and what every
   * edit addresses, so two entries sharing one would make both unaddressable.
   * A caller that wants its own correlation has `source` and `note` to put it
   * in — neither of which is ever spoken.
   *
   * The counter and not the clock alone: a script posted as one batch mints
   * several ids inside the same millisecond, which is exactly the collision the
   * renderer's own `nextId` exists to avoid.
   */
  private mint(): string {
    this.seq += 1;
    return `q${Date.now().toString(36)}-${this.seq.toString(36)}`;
  }

  /** The pending turns, oldest first. A copy: callers serialise it. */
  list(): QueueEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  get length(): number {
    return this.entries.length;
  }

  /**
   * Add turns, at the end or at the front.
   *
   * `unshift` keeps a batch in its own order rather than reversing it, which is
   * what a caller inserting a two-line interjection means by it: the pair goes
   * next, first line first.
   */
  add(
    turns: TurnRequest[],
    { at = 'push', source, note }: { at?: Placement; source?: string; note?: string } = {},
  ): QueueEntry[] {
    const stamp = now();
    const added = turns.map((turn) => ({
      ...turn,
      id: this.mint(),
      ...(source === undefined ? {} : { source }),
      ...(note === undefined ? {} : { note }),
      at: stamp,
    }));
    if (at === 'unshift') this.entries.unshift(...added);
    else this.entries.push(...added);
    return added;
  }

  /**
   * Rewrite one entry in place.
   *
   * The id, the timestamp and the source survive: this is an edit to a line, not
   * a replacement of it, and an edit that reset the id would make the panel's
   * own selection jump and would strand anything waiting on that turn's events.
   * Returns false for an id the queue does not have, which is the ordinary
   * outcome of editing a row that started playing while the form was open.
   */
  update(id: string, patch: TurnRequest & { source?: string; note?: string }): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    const { id: _ignored, ...fields } = patch;
    this.entries[index] = { ...this.entries[index], ...fields, id };
    return true;
  }

  /** Drop one entry. False for an id that is not here. */
  remove(id: string): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    this.entries.splice(index, 1);
    return true;
  }

  /**
   * Move one entry to a position.
   *
   * `to` is the index in the list *after* the entry has been lifted out, which
   * is what a drag and drop means by where it was dropped and is the one
   * convention that makes dragging a row one place down do something. Out of
   * range clamps rather than failing: a drop past the end of the list means the
   * end of the list.
   */
  move(id: string, to: number): boolean {
    const from = this.entries.findIndex((entry) => entry.id === id);
    if (from === -1) return false;
    const [entry] = this.entries.splice(from, 1);
    const target = Math.max(0, Math.min(this.entries.length, Math.trunc(to)));
    this.entries.splice(target, 0, entry);
    return true;
  }

  /** Take the first entry off, or null when there is none. */
  shift(): QueueEntry | null {
    return this.entries.shift() ?? null;
  }

  /** Take the last entry off. What an operator reaches for after over-queueing. */
  pop(): QueueEntry | null {
    return this.entries.pop() ?? null;
  }

  /** Empty it. */
  clear(): void {
    this.entries.length = 0;
  }

  /**
   * Move an entry the renderer has finished with into the history.
   *
   * The renderer reports `turn.end` under the entry's own id, which is how this
   * queue learns that a line it dispatched is done. Out of the pending list it
   * must go — otherwise the panel would show a hundred lines that were said an
   * hour ago as though they were still to come — but not out of existence: it
   * goes onto the end of the history, where it can be brought back.
   *
   * `interrupted` marks a line that was cut off rather than finished. It is kept
   * on the same footing as a finished one, and is in practice the one most
   * likely to be wanted back.
   */
  complete(id: string, { interrupted = false }: { interrupted?: boolean } = {}): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    const [entry] = this.entries.splice(index, 1);
    this.spoken.push({ ...entry, saidAt: now(), ...(interrupted ? { interrupted } : {}) });
    if (this.spoken.length > HISTORY_MAX) {
      this.spoken.splice(0, this.spoken.length - HISTORY_MAX);
    }
    return true;
  }

  /** What has been said, oldest first. A copy, on the same footing as `list`. */
  history(): HistoryEntry[] {
    return this.spoken.map((entry) => ({ ...entry }));
  }

  /** Forget everything that has been said. The pending list is untouched. */
  forget(): void {
    this.spoken.length = 0;
  }

  /**
   * Put something already said back at the front of the queue.
   *
   * `from` moves the named line and everything said after it out of the history
   * and into the front of the queue, in the order they were said: the script
   * resumes from that point, and the history ends where the rewind began,
   * because those lines are about to be said again and will be filed again when
   * they are. `one` copies the named line alone and leaves the history whole —
   * repeating a line is not rewinding past it.
   *
   * New ids either way. An entry that goes round again is a new pending turn:
   * reusing the id would put a second `turn.end` under one that has already
   * ended, and nothing correlating against the event log could tell the two
   * apart. `source` and `note` survive, so a row still says where it came from.
   *
   * Returns the new entries, front of the queue first, or null for an id the
   * history does not have — which is the ordinary outcome of clicking a row that
   * aged off the end while the panel was open.
   */
  rewind(id: string, mode: RewindMode = 'from'): QueueEntry[] | null {
    const index = this.spoken.findIndex((entry) => entry.id === id);
    if (index === -1) return null;
    const taken = mode === 'one' ? [this.spoken[index]] : this.spoken.splice(index);
    const added = taken.map((entry) => this.requeue(entry));
    this.entries.unshift(...added);
    return added;
  }

  /** One spoken entry, as a pending one again. See `rewind`. */
  private requeue(entry: HistoryEntry): QueueEntry {
    const { id: _id, at: _at, saidAt: _saidAt, interrupted: _interrupted, ...turn } = entry;
    return { ...turn, id: this.mint(), at: now() };
  }

  /**
   * The command that puts this list into a renderer.
   *
   * The server-only fields are stripped rather than left to be dropped by the
   * command schema. Relying on the schema's field stripping would work today and
   * would quietly start shipping the operator's private notes to the renderer
   * the day someone loosened it.
   */
  command(): Command {
    return {
      cmd: 'queue',
      turns: this.entries.map(({ source: _s, note: _n, at: _a, ...turn }) => turn),
    };
  }
}
