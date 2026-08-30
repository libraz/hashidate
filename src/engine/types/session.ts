import type { Localized } from '../../i18n/locale';
import type { InlineCueAction } from '../../protocol/cues';
import type { GestureGroup, PerformanceGroup } from './pose';
import type { CameraFrame, EmotionVector, FingerName, LabelledId, Side } from './primitives';

/**
 * What the session tells the outside world: what just happened, what is
 * happening now, and what this avatar can be asked to do.
 */

export type SessionEventType =
  | 'turn.queued'
  | 'turn.start'
  | 'turn.end'
  | 'turn.interrupted'
  | 'queue.dropped'
  | 'queue.replaced'
  | 'queue.empty'
  | 'cue.fire';

export interface SessionEvent {
  type: SessionEventType;
  turn?: string;
  turns?: string[];
  queued?: number;
  seconds?: number;
  /** Stable `${turn}:cue:${ordinal}` id for a server-routed inline BGM cue. */
  cueId?: string;
  /** The BGM action requested by the cue. */
  cue?: InlineCueAction;
  /** Stamped by the server, not by the engine. */
  seq?: number;
  at?: number;
}

/** Everything an orchestrator might branch on, cheap enough to poll. */
export interface SessionState {
  speaking: boolean;
  turn: string | null;
  queued: number;
  busy: boolean;
  idle: boolean;
  idleEnabled: boolean;
  emotion: EmotionVector;
  expression: string | null;
  pickedExpression: string | null;
  overlays: Record<string, number>;
  /** The performance showing, or null. Cleared as soon as one is released. */
  performance: string | null;
  gesture: string | null;
  /** Whether a run of hops is in flight. */
  hopping: boolean;
  /** Joint strain from the last fingertip solve, per arm. */
  strain: Record<Side, number>;
  lookAt: number;
  wardrobe: Record<string, string | null> | null;
}

/**
 * What this avatar can be asked to do.
 *
 * Discovered, not declared: the expression list comes from the avatar's own
 * shape groups and the wardrobe from its meshes, so swapping the avatar changes
 * what the orchestrator is offered.
 */
export interface Vocabulary {
  avatar: { id: string | null; label: Localized | null };
  emotions: LabelledId[];
  expressions: LabelledId[];
  overlays: LabelledId[];
  /**
   * Faces and movements named together, and the list to reach for first: the
   * two below are the parts a performance is assembled from, and are here for a
   * caller that wants something the table has no name for.
   *
   * `emotion` is echoed so a caller can see what a performance will do to the
   * mood without having to play it — the mood is the one thing that persists
   * after the performance ends.
   */
  performances: Array<
    LabelledId & {
      group: PerformanceGroup;
      emotion: EmotionVector;
      gesture: string | null;
      hop: string | null;
      /** Held until something replaces it, rather than running out on its own. */
      sustain: boolean;
    }
  >;
  gestures: Array<LabelledId & { group: GestureGroup; sustain: boolean }>;
  hops: LabelledId[];
  /**
   * How to put a performance inside a line rather than at the start of one.
   *
   * Stated rather than discovered, like `pointing.note` below — but it belongs
   * here for the same reason everything else does: this object is what gets
   * pasted into a system prompt, and a syntax the caller is never told about is
   * a syntax nobody uses.
   */
  cue: { syntax: string; note: Localized };
  cameras: CameraFrame[];
  /**
   * Continuous, so it is stated as ranges rather than as a list of ids.
   *
   * **These bounds are DEGREES**, like the control API and the CLI — unlike
   * `PointSpec` in `pose.ts`, which is the engine-internal radian form. The
   * conversion happens once, in the motion layer's `point()`.
   */
  pointing: {
    side: Side[];
    azimuth: [number, number];
    elevation: [number, number];
    extent: [number, number];
    finger: FingerName[];
    note: Localized;
  };
  wardrobe: Record<string, { label: Localized; items: LabelledId[] }>;
  wardrobePresets: LabelledId[];
  /**
   * Where the voice is heard. Empty on a renderer with no voice at all, which
   * is also the case where `room` does nothing — so a caller can tell the two
   * apart from the vocabulary rather than by sending one and watching.
   */
  rooms: LabelledId[];
  /**
   * Where the character is seen. Empty on a renderer that has no backdrops,
   * which is also the case where `backdrop` does nothing — the same tell the
   * rooms above give.
   *
   * Separate from `rooms` because they are separate axes: one is the set, the
   * other is the acoustic, and a stream changes them at different moments and
   * for different reasons.
   */
  backdrops: LabelledId[];
  /**
   * The named voice chains, on the same footing as the rooms above: what a
   * chain *does* is renderer data, and the wire carries only what it is called.
   */
  voicePresets: LabelledId[];
}
