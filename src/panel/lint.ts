import { parseLine } from '@/engine/cues';
import { textToVisemes } from '@/engine/face/lipsync';
import { getLocale, type MessageKey, type Params, translate } from '@/i18n';
import type { QueueEntry, TurnRequest, Vocabulary } from '@/protocol';

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

/** What the panel needs to know about one line, all of it derived. */
export interface LineCheck {
  /** What will actually be spoken, with the markup taken out. */
  spoken: string;
  /** The performances the line starts, in order, with where they land. */
  cues: Array<{ perform: string; at: number; known: boolean }>;
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

/** Check one turn against what the avatar can actually do. */
export function checkLine(turn: TurnRequest, vocabulary: Partial<Vocabulary>): LineCheck {
  const source = turn.text ?? '';
  const line = parseLine(source);
  const seconds = textToVisemes(turn.reading || line.text).duration;
  const findings: Finding[] = [];

  // The performance table is avatar data and arrives in the vocabulary, so an
  // id can only be judged against the avatar that is actually loaded. With no
  // vocabulary yet every id is unknown, which would paint the whole queue
  // yellow — so the check is skipped rather than failed.
  const known = new Set((vocabulary.performances ?? []).map((p) => p.id));
  const canJudge = known.size > 0;

  const cues = line.cues.map((cue) => ({
    perform: cue.perform,
    at: cue.at,
    known: !canJudge || known.has(cue.perform),
  }));

  for (const cue of cues) {
    if (cue.known) continue;
    // Dropped by the session rather than played, and silently: `perform()` on an
    // unknown id would release whatever face is up, which mid-sentence is worse
    // than doing nothing. So this is the only place it can be seen.
    findings.push({ severity: 'warn', message: say('panel.lint.unknownCue', { id: cue.perform }) });
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

  if (turn.perform && canJudge && !known.has(turn.perform)) {
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

  if (line.text.trim() === '' && !turn.perform && !turn.gesture && !turn.expression) {
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
        first: cues[i - 1].perform,
        second: cues[i].perform,
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
  // Every well-formed cue accounts for exactly two, and the spoken line is
  // guaranteed to contain none.
  const accounted = (source.match(/\[[A-Za-z][A-Za-z0-9]*\]/g) ?? []).length * 2;
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
