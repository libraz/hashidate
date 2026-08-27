import type { Command } from '../protocol';

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
 * disagreed with the protocol about a lifetime would be a second opinion.
 *
 * ## A relative page turn is resolved here, not looked up
 *
 * `slide { by: 1 }` says "the page after the one that is showing", which is a
 * decision whose meaning depends on an observation — and observations are
 * exactly what this file refuses to keep. Reading the page out of the renderer's
 * report to resolve it would import the whole problem the section above rejects:
 * a second renderer on a different page would turn the first one's.
 *
 * So it is resolved from the commands alone. A counter starts at the page a
 * `deck` opened on and moves by every `slide` that passed through, and what is
 * stored is always the absolute `{ cmd: 'slide', page: n }`. The counter never
 * sees the document, so it does not know where the end is — but it does not need
 * to: the renderer clamps a page past the end and a renderer joining late clamps
 * the same replayed number against the same document, so the two land on the
 * same page. Clamping is the only non-linearity between a run of turns and the
 * page they arrive at, and it is applied by both ends rather than by one. The
 * floor at 1 is here for the same reason, on the same argument.
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
      | 'emotion';
  }
>;

type Of<K extends Persistent['cmd']> = Extract<Persistent, { cmd: K }>;

/**
 * The order they go out in, which is not the order they came in.
 *
 * `avatar` first because it replaces the scene every later command talks to, and
 * `wear` straight after it because a costume is the one thing that is meaningless
 * against the wrong body. The rest are independent of each other and are listed
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
] as const satisfies readonly Persistent['cmd'][];

/** The page a document opens on, and the floor a page counter is clamped at. */
const FIRST_PAGE = 1;

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
   * it is fed only by the commands that went out. It is meaningless with no
   * `deck` set and is not consulted then.
   */
  private page = FIRST_PAGE;

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
        this.page = command.page ?? FIRST_PAGE;
        this.last.delete('slide');
        this.last.set('deck', command);
        return true;
      // Normalised to an absolute page here and never stored as a relative one.
      // See the module docstring — this is the whole reason the counter exists.
      case 'slide':
        this.page = Math.max(FIRST_PAGE, command.page ?? this.page + (command.by ?? 1));
        this.last.set('slide', { cmd: 'slide', page: this.page });
        return true;
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
      case 'emotion':
        this.last.set(command.cmd, command);
        return true;
      default:
        return false;
    }
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
}

/** A folded command without its verb, which is what `fold` works on. */
function stripped<T extends { cmd: string }>(command: T | undefined): Omit<T, 'cmd'> | undefined {
  if (!command) return undefined;
  const { cmd: _cmd, ...rest } = command;
  return rest;
}
