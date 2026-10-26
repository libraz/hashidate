import type { Recording, StreamMessage } from '../protocol';
import type { TurnQueue } from './queue';
import type { AppendResult, OpenOptions, RecordingStore } from './recordings';

/**
 * The take in flight: when it rolls, when it stops, and what closes it.
 *
 * Owns the watchdog timers (end-of-script tail, flush, orphan) and the latches
 * that decide them. Reaches the rest of the hub only through the functions it
 * is constructed with, so it never imports the hub.
 */

/**
 * How long a stopped recording waits for the renderer's last chunk.
 *
 * `stop` goes down the same one-way channel every command does, so the file
 * cannot be closed on the send: the encoder still has a second of frames in it
 * and posts them after it has wound down. Normally the flush arrives flagged as
 * the last one and closes the file immediately; this is the answer for the case
 * where it never arrives at all, because the renderer was closed or reloaded
 * between the stop and the flush. A file left open forever would be worse than
 * one missing its final second.
 */
export const RECORD_FLUSH_SECONDS = 6.0;

/** How long an owner-less live renderer may be absent before its take is closed. */
export const RECORD_ORPHAN_SECONDS = 6.0;

export class TakeControl {
  /**
   * The stop scheduled for the end of the script, if one is counting down.
   * The take's own `tail`; see `RECORD_DEFAULTS`.
   */
  private tailTimer: ReturnType<typeof setTimeout> | null = null;

  /** The release counting down the take's `lead` after its first chunk. */
  private leadTimer: ReturnType<typeof setTimeout> | null = null;

  /** The watchdog on a stopped recording's last chunk. See `RECORD_FLUSH_SECONDS`. */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** The bounded safety net for a renderer that disappears mid-take. */
  private orphanTimer: ReturnType<typeof setTimeout> | null = null;
  private orphanOwner: string | null = null;

  /** True after this take has observed at least one pending/on-air line. */
  private recordingQueueSeen = false;
  /** Mirrors the store's synchronous first-owner pin for the watchdog. */
  private recordingOwner: string | null = null;

  /**
   * A hold waiting on proof that the recording is rolling.
   *
   * Set by a `start` that asked for it and spent by the first chunk that
   * arrives. Releasing on a timer instead would be releasing on a guess about
   * how long an encoder takes to produce its first second — and a guess that is
   * short by anything at all clips the front of the first line, which is
   * exactly the frame the take opens on. A `lead` is counted from that chunk,
   * never from the request, for the same reason.
   */
  private releaseOn: string | null = null;

  /** Last queue state observed at a hub boundary, for edits outside reports. */
  private queueWorkObserved = false;

  constructor(
    private readonly recordings: RecordingStore | null,
    private readonly queue: TurnQueue,
    private readonly send: (message: StreamMessage) => number,
    private readonly connections: (owner: string) => number,
    private readonly speaking: () => boolean,
  ) {}

  /**
   * Observe the queue at a server boundary.
   *
   * `TurnQueue.list()` intentionally exposes pending lines only, while a take
   * must stay alive for a line that has already started. The recording latch is
   * per take: an empty take has never had work and therefore cannot be stopped
   * merely because it remains empty for a few heartbeats.
   */
  observeQueue(previousWork = this.queueWorkObserved): void {
    const currentWork = this.queue.hasWork;
    // `previousWork` is also an observation: a report may be the first
    // boundary after a pending line was drained, so looking only at the state
    // after its events would miss the non-empty half of the transition.
    if (this.recordings !== null && (currentWork || previousWork)) {
      this.recordingQueueSeen = true;
    }
    this.queueWorkObserved = currentWork;
    if (!currentWork) {
      // A stopped take remains live while its encoder flushes. A record-off
      // command itself passes through send(), so never arm the queue tail again
      // during that bounded flush window.
      if (this.flushTimer === null) this.considerTail();
      else this.clearTail();
    } else this.clearTail();
  }

  /** Arm the orphan safety net when the last connection for an owner leaves. */
  armOrphan(rendererId: string): void {
    const live = this.recordings?.current ?? null;
    if (live === null || this.recordingOwner !== rendererId) return;
    this.clearOrphan();
    this.orphanOwner = rendererId;
    this.orphanTimer = setTimeout(() => {
      this.orphanTimer = null;
      this.orphanOwner = null;
      const still = this.recordings?.current ?? null;
      if (still === null || this.recordingOwner !== rendererId) return;
      if (this.connections(rendererId) > 0) return;
      // No renderer remains to deliver the encoder's terminal chunk. Send the
      // normal stop command for observers, then close the sink immediately
      // rather than waiting for the ordinary renderer-flush watchdog; this is
      // the bounded orphan path itself.
      this.stopRecording(still.session);
      this.clearFlush();
      void this.finishRecording(still.session);
    }, RECORD_ORPHAN_SECONDS * 1000);
    this.orphanTimer.unref?.();
  }

  /** Reconnection of the same renderer makes the orphan timer unnecessary. */
  cancelOrphan(rendererId: string): void {
    if (this.orphanOwner !== rendererId) return;
    this.clearOrphan();
  }

  private clearOrphan(): void {
    if (this.orphanTimer !== null) clearTimeout(this.orphanTimer);
    this.orphanTimer = null;
    this.orphanOwner = null;
  }

  /**
   * Open a take and tell the renderers to roll.
   *
   * Null when one is already running, or when this server was built without a
   * recordings directory. Both are refusals rather than errors and the caller
   * says which; see `Recordings.open`.
   *
   * `release` is the recording flow's whole point. A script is loaded into a
   * held queue so the shot can be framed, and the hold has to come off at the
   * moment the take is genuinely rolling — not when the command was sent. See
   * `releaseOn`.
   */
  startRecording(options: OpenOptions & { release?: boolean }): Recording | null {
    if (this.recordings === null) return null;
    const opened = this.recordings.open(options);
    if (opened === null) return null;
    this.clearTimers();
    this.clearOrphan();
    this.recordingOwner = null;
    this.recordingQueueSeen = this.queue.hasWork;
    this.queueWorkObserved = this.queue.hasWork;
    this.releaseOn = options.release ? opened.session : null;
    this.send({
      type: 'command',
      commands: [
        {
          cmd: 'record',
          on: true,
          session: opened.session,
          width: opened.width,
          height: opened.height,
          fps: opened.fps,
        },
      ],
    });
    return opened;
  }

  /**
   * Tell the renderers to stop, and start the watchdog on the flush.
   *
   * The file is not closed here. What is still to come is the second or so the
   * encoder is holding, and closing on the send would truncate every take by
   * exactly that much. See `RECORD_FLUSH_SECONDS`.
   */
  stopRecording(session?: string): Recording | null {
    const live = this.recordings?.current ?? null;
    if (live === null) return null;
    if (session !== undefined && session !== live.session) return null;
    this.clearTail();
    this.clearLead();
    this.releaseOn = null;
    this.clearOrphan();
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.finishRecording(live.session);
      }, RECORD_FLUSH_SECONDS * 1000);
      this.flushTimer.unref?.();
    }
    this.send({
      type: 'command',
      commands: [{ cmd: 'record', on: false, session: live.session }],
    });
    return live;
  }

  /**
   * Take one chunk from the renderer. Answers whether it was ours.
   *
   * The first chunk is the proof the take is rolling, and is what releases a
   * hold that was waiting for it. The last one closes the file, because the
   * renderer is the only thing that knows its encoder has finished.
   */
  async recordChunk(
    session: string,
    owner: string,
    mime: string,
    chunk: Buffer,
    { final = false }: { final?: boolean } = {},
  ): Promise<AppendResult> {
    if (this.recordings === null) {
      return { status: 'stale', first: false, recording: null };
    }
    const current = this.recordings.current;
    if (current === null || current.session !== session) {
      return { status: 'stale', first: false, recording: current };
    }
    // Keep this synchronous with the store's owner pin. A second renderer can
    // reach this method before the first write callback, but it must still see
    // a conflict rather than interleave bytes into the same take.
    if (this.recordingOwner === null) this.recordingOwner = owner;
    // A renderer can disappear after the take starts but before its first
    // chunk arrives. In that case detach() had no owner to arm against; once
    // this synchronous pin identifies the owner, arm the same bounded orphan
    // watchdog if no connection for it remains.
    if (this.connections(owner) === 0) this.armOrphan(owner);
    const result = await this.recordings.append(session, owner, mime, chunk);
    if (result.status === 'failed') {
      // A sink that failed takes no more bytes, so the take ends here: the
      // renderers stop encoding, the file is closed, and a hold that was waiting
      // for this take to roll comes off rather than holding the queue for a
      // recording that is not happening. Stale and conflict responses must never
      // close a live take they do not own.
      const held = this.releaseOn === session;
      this.clearLead();
      if (!final) this.stopRecording(session);
      this.releaseOn = null;
      this.clearFlush();
      await this.recordings.close(session);
      this.clearFinishedRecording(session);
      if (held) this.send({ type: 'command', commands: [{ cmd: 'pause', on: false }] });
      return result;
    }
    if (result.status !== 'accepted') return result;
    if (result.first && this.releaseOn === session) this.release(session, current.lead);
    if (final) {
      this.clearFlush();
      await this.recordings.close(session);
      this.clearFinishedRecording(session);
    }
    return result;
  }

  /**
   * Let the held queue go, now or `lead` seconds from now.
   *
   * `releaseOn` stays set while the lead counts down, so a stop or a failed
   * sink inside it is handled exactly as one before the first chunk.
   */
  private release(session: string, lead: number): void {
    const go = (): void => {
      this.leadTimer = null;
      if (this.releaseOn !== session) return;
      this.releaseOn = null;
      this.send({ type: 'command', commands: [{ cmd: 'pause', on: false }] });
    };
    if (lead <= 0) {
      go();
      return;
    }
    this.clearLead();
    this.leadTimer = setTimeout(go, lead * 1000);
    this.leadTimer.unref?.();
  }

  /** The take in flight, as the snapshot reports it. */
  get recording(): Recording | null {
    return this.recordings?.current ?? null;
  }

  /**
   * Wind everything down. For a server shutting down with a take still open,
   * which would otherwise leave a truncated file with no moov box in it.
   */
  async closeRecording(): Promise<void> {
    this.clearTimers();
    this.clearOrphan();
    this.recordingOwner = null;
    this.recordingQueueSeen = false;
    await this.recordings?.close();
  }

  private async finishRecording(session: string): Promise<void> {
    await this.recordings?.close(session);
    this.clearFinishedRecording(session);
  }

  /** Clear take-local state unless a newer take won the close race. */
  private clearFinishedRecording(session: string): void {
    const current = this.recordings?.current ?? null;
    if (current !== null && current.session !== session) return;
    this.clearOrphan();
    this.recordingOwner = null;
    this.recordingQueueSeen = false;
  }

  /**
   * Arm the end-of-script stop, or stand it down.
   *
   * Called from `report` whenever the queue has just changed length. The stop
   * is scheduled rather than immediate — the take's `tail`, see
   * `RECORD_DEFAULTS` — and the schedule is dropped the moment there is another
   * line to say, which is what makes a comment queued during the tail extend
   * the take instead of ending it early.
   */
  private considerTail(): void {
    const live = this.recordings?.current ?? null;
    if (live === null || !live.autoStop || !this.recordingQueueSeen || this.queue.hasWork) {
      this.clearTail();
      return;
    }
    if (this.tailTimer !== null) return;
    this.tailTimer = setTimeout(() => {
      this.tailTimer = null;
      // Re-read rather than trusting the schedule: the queue may have been
      // refilled and drained again inside the tail, and a turn may have been
      // started by a `say` that never touched the queue length this saw.
      const still = this.recordings?.current ?? null;
      if (still === null || !still.autoStop) return;
      if (this.queue.hasWork || this.speaking() || !this.recordingQueueSeen) return;
      this.stopRecording(still.session);
    }, live.tail * 1000);
    this.tailTimer.unref?.();
  }

  private clearTail(): void {
    if (this.tailTimer === null) return;
    clearTimeout(this.tailTimer);
    this.tailTimer = null;
  }

  private clearLead(): void {
    if (this.leadTimer === null) return;
    clearTimeout(this.leadTimer);
    this.leadTimer = null;
  }

  private clearFlush(): void {
    if (this.flushTimer === null) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private clearTimers(): void {
    this.clearTail();
    this.clearLead();
    this.clearFlush();
  }

  /** Stop every timer the take owns, for when the control server is torn down. */
  dispose(): void {
    this.clearTimers();
    this.clearOrphan();
  }
}
