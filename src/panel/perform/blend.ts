import type { EmotionName, EmotionVector } from '@/protocol';
import { shouldAdopt } from '../voice/ChainSlider';

/** Weights the mixer has sent that the renderer has not yet reported back, per mood. */
export type HeldBlend = Partial<Record<EmotionName, number[]>>;

const STEP = 0.01;

/**
 * Forget the weights the report has caught up with, or contradicted.
 *
 * A report equal to the newest weight sent has settled; one matching nothing
 * sent is a preset or a clamp. Either way the report is the truth again. One
 * matching an older weight is the poll lagging a drag, and the held value stays.
 */
export function settleBlend(held: HeldBlend, reported: EmotionVector): void {
  for (const name of Object.keys(held) as EmotionName[]) {
    const sent = held[name] ?? [];
    const now = reported[name] ?? 0;
    const latest = sent[sent.length - 1];
    if (latest === undefined || shouldAdopt(now, sent, STEP) || Math.abs(now - latest) < STEP / 2) {
      delete held[name];
    }
  }
}

/**
 * The vector to send when one mood moves, built over what the operator last
 * set rather than over a report that may still be a poll behind.
 */
export function blend(
  reported: EmotionVector,
  held: HeldBlend,
  name: EmotionName,
  value: number,
): EmotionVector {
  const next: EmotionVector = { ...reported };
  for (const [key, sent] of Object.entries(held) as Array<[EmotionName, number[] | undefined]>) {
    const latest = sent?.[sent.length - 1];
    if (latest !== undefined) next[key] = latest;
  }
  next[name] = value;
  held[name] = [...(held[name] ?? []), value];
  for (const key of Object.keys(next) as EmotionName[]) {
    if (!next[key]) delete next[key];
  }
  return Object.keys(next).length ? next : { neutral: 1 };
}
