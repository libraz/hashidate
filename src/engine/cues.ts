/**
 * Cue markup — performance changes written into the line itself.
 *
 * An orchestrator that wants the character to brighten halfway through a
 * sentence has, without this, two bad options: split the line into two turns,
 * which puts a gap and a breath in the middle of a clause, or send a separate
 * `perform` command and hope it lands at the right moment — which it cannot,
 * because only the renderer knows how long the first half takes to say.
 *
 * So the cue is written where it happens:
 *
 *     [hello]こんばんは。[explain]今日はこの話をします。
 *
 * ## Nothing in brackets is ever spoken
 *
 * That is what this module is for, and it is a safety property rather than a
 * feature. The caller is a language model, everything it writes is read out
 * loud, and a mouth that says 「かくかっこ ハロー かくかっことじ」 is the exact
 * failure being prevented.
 *
 * It is guaranteed structurally, not by remembering to be careful:
 *
 * - `parseLine` is **total**. Every input produces a spoken string, and that
 *   string contains no bracket, whatever it was handed.
 * - `Session.say` runs it on the way in, so past the queue there is no markup
 *   left anywhere in the engine for a later layer to leak.
 * - There is no flag that turns parsing off and no second field a line can
 *   arrive on. A mode is how this goes wrong once and then keeps going wrong.
 *
 * `isWellFormed` sits in front of all that at the protocol layer, where a
 * command that fails it is dropped: the character stays quiet rather than
 * saying something mangled, and the caller is told. The stripper is what
 * stands behind it for the in-process callers that never touch a schema.
 *
 * ## A bracket is reserved
 *
 * `[` and `]` cannot appear in a spoken line, and there is no escape for them.
 * Dialogue does not need one — Japanese quotes with 「」— and an escape would
 * be a second rule to get wrong for a case that has not come up.
 *
 * The barrel above this file pulls in three.js by way of the drawn-expression
 * presets, and the protocol layer imports this one; reaching straight for
 * `face/lipsync` keeps the CLI and the control server free of the renderer.
 */

import { textToVisemes } from './face/lipsync';
import type { Cue } from './types';

/** A line with its markup taken out: what is said, and what happens during it. */
export interface Line {
  /** The spoken text. Contains no markup, whatever the source contained. */
  text: string;
  /** In the order they occur. */
  cues: Cue[];
}

const OPEN = '[';
const CLOSE = ']';

/**
 * What may sit between the brackets: identifier-shaped, like every other id on
 * the wire. Written once and used both ways round, so the scanner and the
 * well-formedness check cannot come to disagree about what a cue looks like.
 */
const ID = '[A-Za-z][A-Za-z0-9]*';
const CUE = new RegExp(`\\[${ID}\\]`, 'g');
const CUE_ID = new RegExp(`^${ID}$`);

/** Whether the string holds anything this module would take out of it. */
export const hasCueMarkup = (source: string): boolean =>
  source.includes(OPEN) || source.includes(CLOSE);

/**
 * Whether every bracket in the line belongs to a well-formed cue.
 *
 * Stated as "what is left once the cues are removed has no brackets in it"
 * rather than as a grammar, because that is the property actually wanted: not
 * that the line parses, but that the parser will not have to throw anything
 * away to make it parse.
 *
 * It says nothing about whether the ids name real performances. That table is
 * engine data and the wire keeps ids as plain strings — the `perform` field on
 * the same command does too, and a cue is its inline form.
 */
export const isWellFormed = (source: string): boolean => !hasCueMarkup(source.replace(CUE, ''));

/**
 * Split a line into what is spoken and what happens while it is.
 *
 * Total by construction — see the note at the top. Malformed markup is removed
 * rather than rejected here, because this is the last line of defence and not
 * the first: refusing would mean throwing, and a throw on the render path is a
 * worse outcome than a line that lost a bracket.
 */
export function parseLine(source: string): Line {
  const found: Array<{ perform: string; index: number }> = [];
  let text = '';

  for (let i = 0; i < source.length; ) {
    const ch = source[i];
    if (ch === CLOSE) {
      // A close with nothing open. Dropped on its own — it is a bracket, and a
      // bracket is not spoken.
      i += 1;
      continue;
    }
    if (ch !== OPEN) {
      text += ch;
      i += 1;
      continue;
    }
    const close = source.indexOf(CLOSE, i + 1);
    if (close === -1) {
      // An open bracket that never closes takes the rest of the line with it.
      // Unreachable through the control API, which drops the command before it
      // arrives here; from an in-process caller it means the line was built
      // wrong, and a truncated line is a visible failure. Reading the markup
      // out is not.
      break;
    }
    const id = source.slice(i + 1, close);
    // A bracketed run that is not id-shaped — `[hello world]`, `[笑]` — is
    // markup that was meant to be a cue and is not one. It goes the same way a
    // cue does. The alternative is speaking it, which is the whole failure.
    if (CUE_ID.test(id)) found.push({ perform: id, index: text.length });
    i = close + 1;
  }

  // Positions are measured in mouth time rather than in characters. A line is
  // not spoken at a constant rate per glyph — a comma is a pause and a kanji is
  // two beats — so a cue halfway through the *text* is not halfway through the
  // *utterance*, and the utterance is what the caller was placing it in.
  const whole = textToVisemes(text).duration;
  return {
    text,
    cues: found.map(({ perform, index }) => ({
      perform,
      at: whole > 0 ? textToVisemes(text.slice(0, index)).duration / whole : 0,
    })),
  };
}
