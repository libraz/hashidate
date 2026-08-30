import { parseLine } from '@/engine/cues';
import { textToVisemes } from '@/engine/face/lipsync';
import { getLocale, type MessageKey, type Params, translate } from '@/i18n';
import type { QueueEntry, TurnRequest, Vocabulary } from '@/protocol';
import { type InlineCueAction, parseInlineCue } from '@/protocol';

/**
 * Reading a line the way the renderer will, before it is said.
 *
 * The whole reason this exists: the caller upstream of the queue is a language
 * model, and everything it writes goes to a mouth. It will invent a performance
 * id, put a bracket in a reading, or write `[笑]` (laugh) meaning an emotion and
 * get silence — all three fail *quietly*, because the engine is built to
 * degrade rather than throw on the render path. A cue naming nothing is dropped,
 * a malformed bracket is stripped, and the line is spoken with a face that never
 * changed. On a live stream nobody finds out until it has already happened.
 *
 * So the checks the engine deliberately does not make are made here instead,
 * where the cost of being wrong is a yellow row rather than a dead performance.
 * Nothing here blocks: a line that fails every check is still queued and still
 * said. The panel is telling the operator what the renderer is going to do with
 * it, not refusing to let them do it.
 *
 * ## It measures against the same clock the cues ride
 *
 * The estimated length comes from `textToVisemes`, which is the function the
 * mouth itself uses — so the number shown beside a line is the number the cue
 * positions were resolved against, not a second guess made from the character
 * count. It is an estimate either way: a synthesised take is a different length,
 * and the cues survive that because they are stored as fractions.
 */

/**
 * Findings are written in the operator's language, resolved as they are built.
 *
 * Not a React module, so the locale is read from the store rather than a hook.
 * The panel re-runs every check on each render, so a language switch reaches
 * these on the next frame like everything else.
 */
const say = (key: MessageKey, params?: Params): string => translate(key, getLocale(), params);

export type Severity = 'warn' | 'note';

export interface Finding {
  severity: Severity;
  message: string;
}

/** One parsed cue as the panel understands it. */
export interface CheckedCue {
  /** The generic action, for typed cues and for the legacy shorthand alike. */
  action: InlineCueAction;
  /** Source order, stable even when adjacent cues share the same mouth time. */
  ordinal: number;
  /** Where it lands, as a fraction of the spoken line. */
  at: number;
  /** Whether the dynamic id exists in the loaded vocabulary. */
  known: boolean;
  /** A short, localized label suitable for a row or a crowding warning. */
  label: string;
  /** Kept for callers that used the old performance-only check shape. */
  perform?: string;
}

/** What the panel needs to know about one line, all of it derived. */
export interface LineCheck {
  /** What will actually be spoken, with the markup taken out. */
  spoken: string;
  /** Every action in the line, in order, with where it lands and its label. */
  cues: CheckedCue[];
  /** Estimated seconds, on the mouth's own clock. */
  seconds: number;
  findings: Finding[];
}

/**
 * How long a line may be before it is worth flagging.
 *
 * Not a limit — the speech model's own ceiling is thirty seconds and the queue
 * will say whatever it is given. This is the length past which a single turn
 * stops being answerable in a stream: nothing can interrupt a line cleanly
 * except `interrupt`, so a forty-second monologue is forty seconds during which
 * a viewer's comment cannot be taken without cutting the character off.
 */
const LONG_SECONDS = 22;

/** Below this, two cues land close enough that the first is not seen. */
const CUE_CROWDING_SECONDS = 0.35;

type ParsedCue = ReturnType<typeof parseLine>['cues'][number];

/** Recover the generic action from either cue representation. */
function cueAction(cue: ParsedCue): InlineCueAction | null {
  if (cue.action !== undefined) return cue.action;
  return cue.perform === undefined ? null : { kind: 'perform', id: cue.perform };
}

/** Resolve a short cue label through the same catalogue as the rest of the panel. */
function cueLabel(action: InlineCueAction): string {
  switch (action.kind) {
    case 'perform':
      return say('panel.lint.cue.performance', { id: action.id });
    case 'expression':
      return say('panel.lint.cue.expression', { id: action.id });
    case 'gesture':
      return say('panel.lint.cue.gesture', { id: action.id });
    case 'hop':
      return say('panel.lint.cue.hop', { id: action.id });
    case 'camera':
      return say('panel.lint.cue.camera', { frame: action.frame });
    case 'slide':
      return say('panel.lint.cue.slide', { page: action.page });
    case 'bgm':
      return action.action === 'play'
        ? action.track
          ? say('panel.lint.cue.bgm.play', { track: action.track })
          : say('panel.lint.cue.bgm.playNoTrack')
        : action.action === 'pause'
          ? say('panel.lint.cue.bgm.pause')
          : say('panel.lint.cue.bgm.stop');
  }
}

/** A missing vocabulary means the avatar has not reported yet, not that every id is wrong. */
function knownDynamicId(entries: Array<{ id: string }> | undefined, id: string): boolean {
  return entries === undefined || entries.some((entry) => entry.id === id);
}

/** Camera, slide and BGM are grammar-validated; only avatar data needs a lookup. */
function isKnownCue(action: InlineCueAction, vocabulary: Partial<Vocabulary>): boolean {
  switch (action.kind) {
    case 'perform':
      return knownDynamicId(vocabulary.performances, action.id);
    case 'expression':
      return knownDynamicId(vocabulary.expressions, action.id);
    case 'gesture':
      return knownDynamicId(vocabulary.gestures, action.id);
    case 'hop':
      return knownDynamicId(vocabulary.hops, action.id);
    case 'camera':
    case 'slide':
    case 'bgm':
      return true;
  }
}

/** Check one turn against what the avatar can actually do. */
export function checkLine(turn: TurnRequest, vocabulary: Partial<Vocabulary>): LineCheck {
  const source = turn.text ?? '';
  const line = parseLine(source);
  const seconds = textToVisemes(turn.reading || line.text).duration;
  const findings: Finding[] = [];

  const cues = line.cues.flatMap((cue, ordinal): CheckedCue[] => {
    const action = cueAction(cue);
    if (action === null) return [];
    return [
      {
        action,
        ordinal: cue.ordinal ?? ordinal,
        at: cue.at,
        known: isKnownCue(action, vocabulary),
        label: cueLabel(action),
        ...(action.kind === 'perform' ? { perform: action.id } : {}),
      },
    ];
  });

  for (const [index, cue] of cues.entries()) {
    if (cue.known) continue;
    // Dropped by the session rather than played, and silently: an unknown
    // dynamic id would release or fail to start the current action mid-sentence.
    // Typed cues need a kind-aware message; legacy `[id]` keeps its old wording.
    const legacyPerform = line.cues[index]?.action === undefined && cue.action.kind === 'perform';
    const message =
      legacyPerform && cue.action.kind === 'perform'
        ? say('panel.lint.unknownCue', { id: cue.action.id })
        : say('panel.lint.unknownTypedCue', { label: cue.label });
    findings.push({
      severity: 'warn',
      message,
    });
  }

  // A bracket that survived the parse was not a cue. It came out of the spoken
  // line either way — that is guaranteed — but it means the author wrote
  // something they expected to happen, and nothing did.
  const stray = strayBrackets(source, line.text);
  if (stray > 0) {
    findings.push({
      severity: 'warn',
      message: say('panel.lint.strayBrackets', { count: stray }),
    });
  }

  if (turn.reading?.includes('[') || turn.reading?.includes(']')) {
    // The wire refuses this outright, so it can only arrive from a caller that
    // bypassed the schema — but the panel is where a line is *written*, and
    // catching it here means the operator fixes it instead of the POST failing.
    findings.push({ severity: 'warn', message: say('panel.lint.readingBrackets') });
  }

  if (turn.perform && !knownDynamicId(vocabulary.performances, turn.perform)) {
    findings.push({
      severity: 'warn',
      message: say('panel.lint.unknownPerform', { id: turn.perform }),
    });
  }
  if (turn.gesture && (vocabulary.gestures ?? []).length > 0) {
    if (!(vocabulary.gestures ?? []).some((g) => g.id === turn.gesture)) {
      findings.push({
        severity: 'warn',
        message: say('panel.lint.unknownGesture', { id: turn.gesture }),
      });
    }
  }
  if (turn.expression && (vocabulary.expressions ?? []).length > 0) {
    if (!(vocabulary.expressions ?? []).some((e) => e.id === turn.expression)) {
      findings.push({
        severity: 'warn',
        message: say('panel.lint.unknownExpression', { id: turn.expression }),
      });
    }
  }

  if (
    line.text.trim() === '' &&
    cues.length === 0 &&
    !turn.perform &&
    !turn.gesture &&
    !turn.expression
  ) {
    findings.push({ severity: 'note', message: say('panel.lint.emptyTurn') });
  }
  if (seconds > LONG_SECONDS) {
    findings.push({
      severity: 'note',
      message: say('panel.lint.tooLong', { seconds: seconds.toFixed(0) }),
    });
  }

  // Two cues inside a third of a second: the first face is replaced before it
  // has finished arriving, so only the second is ever seen.
  for (let i = 1; i < cues.length; i++) {
    if ((cues[i].at - cues[i - 1].at) * seconds >= CUE_CROWDING_SECONDS) continue;
    findings.push({
      severity: 'note',
      message: say('panel.lint.cuesCrowded', {
        first: cues[i - 1].label,
        second: cues[i].label,
      }),
    });
  }

  return { spoken: line.text, cues, seconds, findings };
}

/**
 * How many brackets the parse had to throw away.
 *
 * Counted rather than located, because the position in the source is not where
 * the operator is looking — they are looking at the row, and the message tells
 * them there is something in it to fix.
 */
function strayBrackets(source: string, spoken: string): number {
  const inSource = (source.match(/[[\]]/g) ?? []).length;
  // Every well-formed cue accounts for exactly two, including typed cues. Use
  // the protocol parser here so the panel does not grow a second cue grammar.
  let accounted = 0;
  for (let i = 0; i < source.length; ) {
    if (source[i] !== '[') {
      i += 1;
      continue;
    }
    const close = source.indexOf(']', i + 1);
    if (close === -1) break;
    if (parseInlineCue(source.slice(i + 1, close)) !== null) accounted += 2;
    i = close + 1;
  }
  return Math.max(0, inSource - accounted - (spoken.match(/[[\]]/g) ?? []).length);
}

/** The queue's own summary: how long it will take, and what needs attention. */
export function checkQueue(
  entries: QueueEntry[],
  vocabulary: Partial<Vocabulary>,
): { checks: Map<string, LineCheck>; seconds: number; warnings: number } {
  const checks = new Map<string, LineCheck>();
  let seconds = 0;
  let warnings = 0;
  for (const entry of entries) {
    const check = checkLine(entry, vocabulary);
    checks.set(entry.id, check);
    seconds += check.seconds;
    warnings += check.findings.filter((f) => f.severity === 'warn').length;
  }
  return { checks, seconds, warnings };
}
