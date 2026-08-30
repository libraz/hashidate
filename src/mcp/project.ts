import { getLocale, pick } from '../i18n/locale';
import type {
  BgmState,
  QueueEntry,
  QueueResponse,
  SessionEvent,
  SessionState,
  Snapshot,
} from '../protocol';

/**
 * What comes back out of the control API, cut down to what a model branches on.
 *
 * The snapshot is built for a panel: it carries the voice chain, the tuning of
 * the set-once layer, the joint strain from the last solve, the wardrobe and
 * every overlay that is up. All of that is drawn on a screen and none of it
 * changes what the next line should be. Handing it over anyway is not
 * generosity — the reader has a token budget, and a field it will never act on
 * is one it has to skip past on every single call.
 *
 * So the projection is deliberately narrow, and widening it is a decision about
 * what an orchestrator decides with rather than about what happens to be known.
 */

/** Enough of a queued line to recognise it by; the whole script is not the point. */
const TEXT_LIMIT = 60;

/** How far down the queue is worth showing. Past this it is a script, not a status. */
const QUEUE_PREVIEW = 5;

export interface QueuedLine {
  id: string;
  /** Truncated: see `TEXT_LIMIT`. */
  text: string;
  /** Which producer put it there — `mcp` for anything this adapter queued. */
  source?: string;
}

export interface Status {
  /** False both when no renderer is attached and when the attached one went quiet. */
  connected: boolean;
  viewers: number;
  /**
   * Null until a renderer has reported. Everything else is about this avatar.
   *
   * The name is resolved to one language here, unlike the vocabulary resource,
   * which carries both. This is a status readout polled between lines rather
   * than reference material — one name is the answer, and a pair of them in
   * every poll is noise in a context window that is paying for it.
   */
  avatar: { id: string | null; label: string | null } | null;
  speaking: boolean;
  /** The id of the line being said, which is no longer in the queue below. */
  turn: string | null;
  queued: number;
  idle: boolean;
  emotion: SessionState['emotion'];
  /** Feed back as `since` on the next call. */
  seq: number;
  events: SessionEvent[];
  queue: QueuedLine[];
  /**
   * The document layer, or null on a renderer that has none.
   *
   * The one thing here a *line* branches on. A model narrating a document has
   * to know which one is up and how many pages it has before it can write a run
   * of lines with page numbers on them, and it cannot work that out from what it
   * queued: the operator mounts the document, and the operator turns pages too.
   *
   * `ready` and `error` are left out. Both are about the moment — a page still
   * being drawn, a file that would not open — and both are for the operator
   * looking at the panel, who can do something about them.
   */
  slides: { deck: string | null; page: number; pages: number } | null;
  /** The server-owned BGM transport, including its resolved DSP and fallback state. */
  bgm: BgmState | null;
}

export function projectStatus(snapshot: Snapshot, since?: number, depth?: number): Status {
  const state = snapshot.state;
  return {
    connected: snapshot.connected,
    viewers: snapshot.viewers,
    avatar: projectAvatar(snapshot.vocabulary.avatar),
    speaking: state.speaking ?? false,
    turn: state.turn ?? null,
    // The renderer's count when it has reported one, and the server's own queue
    // otherwise: the two are the same list, one of them a moment older.
    queued: state.queued ?? snapshot.queue.length,
    idle: state.idle ?? false,
    emotion: state.emotion ?? {},
    seq: snapshot.seq,
    events: since === undefined ? snapshot.events : snapshot.events.filter(newer(since)),
    queue: projectQueue(snapshot.queue, depth),
    slides:
      snapshot.slides === null
        ? null
        : {
            deck: snapshot.slides.deck,
            page: snapshot.slides.page,
            pages: snapshot.slides.pages,
          },
    // The BGM timeline is server-owned rather than renderer-specific. Keep the
    // resolved DSP and `dspDegraded` marker intact so an orchestrator can see
    // what the broadcast is actually applying without touching voice or room.
    bgm: snapshot.bgm ?? null,
  };
}

/** The loaded avatar, with its name resolved to the locale in force. */
function projectAvatar(avatar: Snapshot['vocabulary']['avatar']): Status['avatar'] {
  if (!avatar) return null;
  return { id: avatar.id, label: avatar.label ? pick(avatar.label, getLocale()) : null };
}

/**
 * The head of a pending queue, as everything here shows it.
 *
 * Shared by `status` and by the answer to an edit, which have to agree: a caller
 * that read a queue, edited a row of it and got a differently shaped list back
 * would have to work out for itself whether the two were the same list.
 *
 * `depth` is how far down to look. The default is a status rather than a script,
 * and a caller asking for more is usually after the id of a line too far down to
 * be shown — which is the one thing an edit cannot be made without.
 */
export function projectQueue(queue: QueueEntry[], depth: number = QUEUE_PREVIEW): QueuedLine[] {
  return queue.slice(0, depth).map((entry) => ({
    id: entry.id,
    text: truncate(entry.text ?? ''),
    source: entry.source,
  }));
}

/**
 * The ids of the turns a `speak` just added.
 *
 * The queue endpoint answers with the whole list rather than with what was
 * inserted, so the new entries are taken from the end the request asked for.
 * Safe because a queue is only ever appended to or prepended to by one request
 * at a time — the control server serialises them.
 */
export function queuedIds(
  response: QueueResponse,
  count: number,
  at: 'push' | 'unshift',
): string[] {
  const entries = at === 'unshift' ? response.queue.slice(0, count) : response.queue.slice(-count);
  return entries.map((entry) => entry.id);
}

const newer = (since: number) => (event: SessionEvent) => (event.seq ?? 0) > since;

/** The mark counts against the budget: `TEXT_LIMIT` is what comes back, not what is kept. */
function truncate(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text;
}
