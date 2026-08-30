import { z } from 'zod';
import type { CameraFrame, EmotionName, FingerName, Side } from '../../engine/types';
import type { cameraFrameSchema } from '../cues';
import type { Equals, Expect } from './guards';

/**
 * The scalars every command is spelled in, plus the two field builders the rest
 * of this directory shares.
 *
 * Nothing here is a command. Each schema is pinned to the engine's own list by
 * a guard, so the wire cannot grow an emotion the runtime has never heard of.
 */

/** Canonical emotion names, pinned to the engine's own list. */
export const emotionNameSchema = z.enum([
  'neutral',
  'joy',
  'anger',
  'sadness',
  'surprise',
  'relaxed',
  'thinking',
  'shy',
]);
type _EmotionNamesMatchEngine = Expect<Equals<z.infer<typeof emotionNameSchema>, EmotionName>>;

/**
 * A blend, not a choice. Weights need not sum to one and are not bounded here:
 * the layers that consume the vector normalise where normalising is meaningful.
 *
 * A name outside the canonical list fails the command it arrived on rather than
 * being quietly dropped from the blend: the vocabulary advertises exactly which
 * names exist, so an unknown one means the caller is working from a list that no
 * longer matches the avatar, and half-applying that blend hides it.
 */
export const emotionVectorSchema = z.partialRecord(emotionNameSchema, z.number());

/** Which arm, in the character's own terms. Never a world direction. */
export const sideSchema = z.enum(['L', 'R']);
type _SidesMatchEngine = Expect<Equals<z.infer<typeof sideSchema>, Side>>;

export const fingerNameSchema = z.enum(['thumb', 'index', 'middle', 'ring', 'little']);
type _FingersMatchEngine = Expect<Equals<z.infer<typeof fingerNameSchema>, FingerName>>;

type _CameraFramesMatchEngine = Expect<Equals<z.infer<typeof cameraFrameSchema>, CameraFrame>>;

/** Re-exported for the same reason as `TurnRequest`: the guard above makes it
 *  the same type, so a caller building a command need not reach into the engine
 *  to name one. */
export type { CameraFrame };

/**
 * Correlation id, carried by every command.
 *
 * The server stamps one on arrival if the caller did not supply it, so the turn
 * events that come back can be matched to the command that caused them. Three
 * commands — `expression`, `overlay`, `gesture` — spend the same field on their
 * own payload id instead; those are noted where they are defined, because a
 * server that stamps an id onto one of them changes what the command means.
 */
export const correlationId = z.string().optional();

/** A number no further than the thing it moves may travel. */
export const within = (range: { min: number; max: number }) =>
  z.number().min(range.min).max(range.max);
