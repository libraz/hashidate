import { performanceDef } from '../engine/performance';
import type { Command, TurnRequest } from '../protocol';
import type { InlineCueAction } from '../protocol/cues';

/**
 * The setup, kept so that a renderer which arrives late can be told about it.
 *
 * ## Why the server has to hold this at all
 *
 * A command is fanned out to whoever is connected when it is sent, and that used
 * to be the whole story: the queue was re-delivered on attach — which is what
 * makes a viewer reload survivable — and nothing else was. That is fine while
 * the renderer is the thing the operator is working in front of, and wrong the
 * moment the panel becomes the place the show is set up and the renderer is
 * opened last, at the top of the broadcast. Everything chosen beforehand — the
 * avatar, the costume, the set, the acoustic, the shot — would land on a
 * renderer that was not there to hear it, and the stream would open on defaults.
 *
 * ## Decisions, not observations
 *
 * What is folded in here is what was *asked for*. The renderer also reports what
 * it is running, in more detail and more accurately, and replaying that instead
 * is tempting for exactly that reason. It is wrong: a report describes the
 * avatar that happened to be loaded in the viewer that happened to be reporting,
 * so a second renderer showing a different avatar would be handed the first
 * one's settings as though an operator had chosen them. Nobody asked for that,
 * and a standing state that invents instructions is worse than one that is
 * merely incomplete.
 *
 * ## What is left out
 *
 * Only the verbs whose effect outlives the moment they arrive. A gesture ends on
 * its own, an expression is released with the line that raised it, an interrupt
 * has already happened — replaying any of those to a renderer joining an hour
 * later would be re-enacting a moment rather than restoring a setup.
 *
 * The emotion is the awkward one and is in: the command set states that a mood
 * persists because it does not end with the sentence, and a standing state that
 * disagreed with the protocol about a lifetime would be a second opinion. So it
 * follows every path a mood is set by — `emotion`, `reset`, a performance's
 * mood, and a started line's — and not the `emotion` command alone.
 *
 * ## A started line is a decision too
 *
 * A line's `stage` and mood stay put after it, like the commands they mirror,
 * and so do the camera, page and performance cues fired inside it. `recordTurn`
 * and `recordCue` turn each into the command it mirrors and fold that through
 * `record`, so a line and a command cannot fold one axis two different ways.
 *
 * ## A relative page turn is resolved here
 *
 * `slide { by: 1 }` says "the page after the one that is showing", which is a
 * decision whose meaning depends on an observation. The optional page-count
 * resolver supplies only the document's fixed upper bound; it never reads a
 * renderer's current page, so a second renderer on a different page cannot turn
 * the first one's.
 *
 * So it is resolved from the commands alone whenever the deck has not been
 * parsed yet. A counter starts at the page a `deck` opened on and moves by every
 * `slide` that passed through, and what is stored is always the absolute
 * `{ cmd: 'slide', page: n }`. When the server knows the deck's page count, it
 * clamps before and after a relative turn; until then the renderer still clamps
 * the replayed number against its document. The floor at 1 is always applied.
 *
 * The tempting simplification is to store the last `slide` command as sent and
 * let the renderer add up the relative ones. It does not work: a renderer that
 * was not connected for the first fifteen turns would apply the sixteenth to
 * page one.
 */

/** A command whose effect is a standing state rather than a moment. */
type Persistent = Extract<
  Command,
  {
    cmd:
      | 'avatar'
      | 'tune'
      | 'wear'
      | 'camera'
      | 'place'
      | 'backdrop'
      | 'deck'
      | 'slide'
      | 'room'
      | 'voice'
      | 'idle'
      | 'look'
      | 'pause'
      | 'emotion';
  }
>;

type Of<K extends Persistent['cmd']> = Extract<Persistent, { cmd: K }>;

/**
 * The order they go out in, which is not the order they came in.
 *
 * `avatar` first because it replaces the scene every later command talks to,
 * `tune` next because its scales and multipliers carry across the replacement,
 * and `wear` after tuning because a costume is meaningless against the wrong
 * body. The rest are independent of each other and are listed
 * roughly as an operator sets them: the character, then the set, then the sound.
 *
 * `deck` before `slide` because a `deck` states the page it opens on and would
 * otherwise undo the page the replay had just turned to. `place` sits with the
 * camera, being the other half of what the frame looks like.
 */
const ORDER = [
  'avatar',
  'tune',
  'wear',
  'camera',
  'place',
  'backdrop',
  'deck',
  'slide',
  'room',
  'voice',
  'idle',
  'look',
  'emotion',
  // Last, because it is the only one here that is not about the scene. It says
  // whether the run of turns this renderer is about to be handed may start.
  'pause',
] as const satisfies readonly Persistent['cmd'][];

/** The page a document opens on, and the floor a page counter is clamped at. */
const FIRST_PAGE = 1;

/** Resolves the current page count for a deck, when the server knows it. */
export type PageCountResolver = (deckId: string) => number | undefined;

/** Whether `value` is an object literal, for the merge below. Arrays are not. */
function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fold one patch onto another, two levels down.
 *
 * `tune` and `voice` are both stated as partials that land on top of what the
 * renderer is already running, so keeping only the last one sent would throw
 * away every earlier knob: a panel that sends `{eq:{airDb:2}}` after
 * `{retune:{semitones:3}}` means both, and a replay of only the second would
 * quietly undo the first. Two levels is exactly as deep as either of those
 * shapes goes.
 */
function fold<T extends object>(base: T | undefined, next: T | undefined): T | undefined {
  if (!base) return next;
  if (!next) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(next)) {
    const prev = out[key];
    out[key] = isPlain(prev) && isPlain(value) ? { ...prev, ...value } : value;
  }
  return out as T;
}

export class Standing {
  constructor(private readonly pageCount?: PageCountResolver) {}

  /** One per verb, already folded. `wear` is not here; see below. */
  private readonly last = new Map<Persistent['cmd'], Persistent>();
  /**
   * The wardrobe, which is a list rather than a value.
   *
   * Every other verb here says one thing and the newest statement of it wins.
   * A `wear` says one *slot*, so two of them are usually not the same
   * instruction at all — a hat and a jacket are both still on. They are kept in
   * the order they were sent, with a repeat of a slot replacing the earlier one
   * and a whole-outfit preset starting the list over.
   */
  private wardrobe: Of<'wear'>[] = [];

  /**
   * Which page of the document is up, counted rather than observed.
   *
   * See the module docstring: this is what makes a relative turn replayable, and
   * it is fed by the commands that went out. A page-count resolver can add the
   * current deck's upper bound without making that lookup part of the state.
   */
  private page = FIRST_PAGE;
  /** The document the page counter currently belongs to, or none. */
  private deckId: string | null = null;

  /**
   * Fold one command in. Answers whether it was one of the standing kind, which
   * is only of interest to a test.
   */
  record(command: Command): boolean {
    switch (command.cmd) {
      case 'wear':
        this.dress(command);
        return true;
      // Both are partials that merge in the renderer, so they merge here too.
      // The correlation id is dropped: it belongs to the request that carried
      // the command, not to the state it left behind, and replaying it would
      // hand a renderer an id a caller is no longer listening for.
      case 'tune': {
        const base = this.last.get('tune') as Of<'tune'> | undefined;
        const { cmd: _cmd, id: _id, settle: _settle, ...next } = command;
        // `settle` is a verb — it snaps the springs to rest — so it has no place
        // in a state that is replayed. There is nothing standing about it.
        this.last.set('tune', { cmd: 'tune', ...fold(stripped(base), next) });
        return true;
      }
      case 'voice': {
        const base = this.last.get('voice') as Of<'voice'> | undefined;
        const { cmd: _cmd, id: _id, ...next } = command;
        this.last.set('voice', { cmd: 'voice', ...fold(stripped(base), next) });
        return true;
      }
      // The framing and the offsets off it are set from different places — a
      // script names a shot, a drag on the preview moves it — and neither may
      // wipe the other. See `cameraCommandSchema`.
      case 'camera': {
        const base = this.last.get('camera') as Of<'camera'> | undefined;
        const { cmd: _cmd, id: _id, ...next } = command;
        this.last.set('camera', { cmd: 'camera', ...fold(stripped(base), next) });
        return true;
      }
      // Two halves of one layout, and a panel moves one slider at a time. Folded
      // rather than replaced for exactly the reason `tune` is: keeping only the
      // last one sent would undo the width while the margin was being dragged.
      case 'place': {
        const base = this.last.get('place') as Of<'place'> | undefined;
        const { cmd: _cmd, id: _id, ...next } = command;
        this.last.set('place', { cmd: 'place', ...fold(stripped(base), next) });
        return true;
      }
      // A page counter belongs to the document it is counting through. `deck`
      // states where it opens, so the page the one before it had reached is not
      // a page of this one — and the stored `slide` goes with it rather than
      // being replayed against a document it was never about.
      case 'deck':
        this.deckId = command.id ?? null;
        this.page = this.clampPage(command.page ?? FIRST_PAGE);
        this.last.delete('slide');
        this.last.set('deck', command);
        return true;
      // Normalised to an absolute page here and never stored as a relative one.
      // See the module docstring — this is the whole reason the counter exists.
      case 'slide': {
        // A document may have become known, or may have been replaced on disk,
        // since the previous command. Clamp the old value before applying a
        // relative turn so a stale page count cannot skip past the new end.
        const base = command.page === undefined ? this.clampPage(this.page) : this.page;
        this.page = this.clampPage(command.page ?? base + (command.by ?? 1));
        this.last.set('slide', { cmd: 'slide', page: this.page });
        return true;
      }
      // A different body: the slot names and the garments both belonged to the
      // avatar that is being replaced, so the outfit does not carry over. The
      // tuning does — it is scales and multipliers rather than model data.
      case 'avatar':
        this.wardrobe = [];
        this.last.set('avatar', command);
        return true;
      // Spelled out rather than caught by a default, so that a verb added to
      // `ORDER` without a decision about how it folds is a compile error here
      // instead of a last-one-wins guess.
      case 'backdrop':
      case 'room':
      case 'idle':
      case 'look':
      case 'pause':
      case 'emotion':
        this.last.set(command.cmd, command);
        return true;
      // A reset puts the mood back to neutral, which a renderer would otherwise
      // be handed the old one of.
      case 'reset':
        this.last.set('emotion', { cmd: 'emotion', vec: { neutral: 1 } });
        return true;
      // The act is a moment and is not kept, but the mood it sets outlives it.
      // Answers false: what a renderer attaching later gets is not the act.
      case 'perform': {
        const mood = command.id ? performanceDef(command.id)?.emotion : undefined;
        if (mood) this.last.set('emotion', { cmd: 'emotion', vec: mood });
        return false;
      }
      default:
        return false;
    }
  }

  /** Fold what a line leaves behind once it has started. See the module docstring. */
  recordTurn(turn: TurnRequest): void {
    for (const command of turnCommands(turn)) this.record(command);
  }

  /** Fold one inline cue that has fired, when its effect outlives the line. */
  recordCue(action: InlineCueAction): void {
    const command = cueCommand(action);
    if (command !== null) this.record(command);
  }

  /** The setup as a batch, in the order a renderer should be given it. */
  commands(): Command[] {
    const out: Command[] = [];
    for (const kind of ORDER) {
      if (kind === 'wear') {
        out.push(...this.wardrobe);
        continue;
      }
      const command = this.last.get(kind);
      if (command) out.push(command);
    }
    return out;
  }

  /** Whether anything has been set at all. Nothing to say is not a frame to send. */
  get empty(): boolean {
    return this.last.size === 0 && this.wardrobe.length === 0;
  }

  /**
   * Whether the queue is held, read back rather than tracked separately.
   *
   * This is already the authority — it is what a renderer attaching is handed,
   * so it is what the hold *is* — and a second copy beside it would be the one
   * the panel drew while the renderers ran on this one.
   */
  get paused(): boolean {
    const command = this.last.get('pause') as Of<'pause'> | undefined;
    if (command === undefined) return false;
    // Absent `on` means hold, as the schema states.
    return command.on ?? true;
  }

  private dress(command: Of<'wear'>): void {
    // A whole outfit is a fresh start: it sets every slot it names and is the
    // only thing here that can undo an earlier one.
    if (command.preset) {
      this.wardrobe = [command];
      return;
    }
    if (!command.slot) return;
    this.wardrobe = this.wardrobe.filter((worn) => worn.slot !== command.slot);
    this.wardrobe.push(command);
  }

  /** Clamp to the first page and, when known, to the current deck's last page. */
  private clampPage(value: number): number {
    const lower = Number.isFinite(value) ? Math.max(FIRST_PAGE, Math.trunc(value)) : FIRST_PAGE;
    if (this.deckId === null || this.pageCount === undefined) return lower;
    const count = this.pageCount(this.deckId);
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return lower;
    const upper = Math.max(FIRST_PAGE, Math.trunc(count));
    return Math.min(lower, upper);
  }
}

/**
 * The commands a started line amounts to, in the order the renderer applies them:
 * the stage axes as `Stage.apply` takes them, then the performance's mood, then
 * the line's own emotion over it.
 */
function turnCommands({ stage, perform, emotion }: TurnRequest): Command[] {
  const out: Command[] = [];
  if (stage?.camera !== undefined) out.push({ cmd: 'camera', frame: stage.camera });
  if (stage?.backdrop !== undefined) out.push({ cmd: 'backdrop', id: stage.backdrop });
  if (stage?.room !== undefined) out.push({ cmd: 'room', id: stage.room });
  if (stage?.deck !== undefined) {
    out.push({
      cmd: 'deck',
      id: stage.deck,
      ...(stage.slide === undefined ? {} : { page: stage.slide }),
    });
  } else if (stage?.slide !== undefined) {
    out.push({ cmd: 'slide', page: stage.slide });
  }
  if (stage?.place !== undefined) out.push({ cmd: 'place', ...stage.place });
  if (perform) out.push({ cmd: 'perform', id: perform });
  if (emotion) out.push({ cmd: 'emotion', vec: emotion });
  return out;
}

/** The command an inline cue mirrors, or null for one whose effect ends with the line. */
function cueCommand(action: InlineCueAction): Command | null {
  switch (action.kind) {
    case 'camera':
      return { cmd: 'camera', frame: action.frame };
    case 'slide':
      return { cmd: 'slide', page: action.page };
    case 'perform':
      return { cmd: 'perform', id: action.id };
    default:
      return null;
  }
}

/** A folded command without its verb, which is what `fold` works on. */
function stripped<T extends { cmd: string }>(command: T | undefined): Omit<T, 'cmd'> | undefined {
  if (!command) return undefined;
  const { cmd: _cmd, ...rest } = command;
  return rest;
}
