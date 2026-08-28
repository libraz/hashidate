import { z } from 'zod';
import type { MotionArm, MotionDef, MotionFrame } from '../engine/motion';
import type { GestureGroup, SpineSlot } from '../engine/types';
import { type Equals, type Expect, fingerNameSchema, sideSchema } from './commands';

/**
 * Motions the operator wrote, on their way from the control server to the
 * renderer.
 *
 * They are a file on one machine and a gesture in a browser, and nothing joins
 * those two but this schema — so it is here with the rest of the wire
 * vocabulary rather than beside the loader that reads the directory. Both ends
 * validate: the server so that a malformed file is reported to the person who
 * wrote it, the renderer on the same rule every command follows, that what
 * arrives over a socket is checked before it is believed.
 *
 * What the format means, and why it is keyframes, is in
 * `src/engine/motion/custom.ts`. This file only says what is well formed.
 */

/** Character space: x outward from the midline, y up, z forward. */
const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

const gestureGroupSchema = z.enum(['reaction', 'greeting', 'explain', 'emote', 'cute', 'pose']);
type _GestureGroupsMatchEngine = Expect<Equals<z.infer<typeof gestureGroupSchema>, GestureGroup>>;

const spineSlotSchema = z.enum(['hips', 'spine', 'chest', 'neck', 'head']);
type _SpineSlotsMatchEngine = Expect<Equals<z.infer<typeof spineSlotSchema>, SpineSlot>>;

export const motionArmSchema = z.object({
  shoulder: vec3.optional(),
  upperArm: vec3.optional(),
  lowerArm: vec3.optional(),
  hand: vec3.optional(),
  palm: vec3.optional(),
  /** Radians, like every other angle in the engine and unlike `point` on the wire. */
  twist: z.number().finite().optional(),
});

type _MotionArmMatchesEngine = Expect<Equals<z.infer<typeof motionArmSchema>, MotionArm>>;

/**
 * Curl per finger, 0 straight and 1 fully closed.
 *
 * Bounded here and only here. The engine reads these into a follower that would
 * happily chase 4.0 and fold the hand through itself; a gesture table entry
 * cannot do that because it is written in TypeScript against a range everything
 * around it respects, and a file typed by hand can.
 */
const fingerCurlSchema = z.partialRecord(fingerNameSchema, z.number().min(0).max(1));

export const motionFrameSchema = z.object({
  /** Seconds from the start. Ascending across the list; see `motionBodySchema`. */
  at: z.number().finite().min(0),
  arms: z.partialRecord(sideSchema, motionArmSchema).optional(),
  fingers: z.partialRecord(sideSchema, fingerCurlSchema).optional(),
  spine: z.partialRecord(spineSlotSchema, vec3).optional(),
});

type _MotionFrameMatchesEngine = Expect<Equals<z.infer<typeof motionFrameSchema>, MotionFrame>>;

/**
 * The longest a single motion may run.
 *
 * Not a taste — the body layer holds a gesture at full weight for `hold`
 * seconds and a mistyped `hold` is the way a character ends up stuck in a pose
 * with nothing on screen saying why. A minute is longer than any gesture and
 * short enough that the mistake ends on its own.
 */
export const MOTION_MAX_SECONDS = 60;

/** How many keyframes one motion may state. Well past what anyone hand-writes. */
export const MOTION_MAX_FRAMES = 240;

/**
 * A motion as the file states it.
 *
 * There is no `id` here: the filename is the id, on the same rule a document's
 * is. Carrying it in the file as well would be two spellings of one name, and
 * the pair disagreeing is a gesture that answers to something other than what
 * the directory listing says.
 */
const motionFields = z.object({
  label: z.object({ en: z.string(), ja: z.string() }),
  group: gestureGroupSchema,
  lead: z.number().finite().min(0).max(MOTION_MAX_SECONDS),
  hold: z.number().finite().min(0).max(MOTION_MAX_SECONDS),
  sustain: z.boolean().optional(),
  loop: z.boolean().optional(),
  frames: z.array(motionFrameSchema).min(1).max(MOTION_MAX_FRAMES),
});

/**
 * The two things about a keyframe list that the field types cannot say.
 *
 * Written once and applied to both schemas below rather than to a shared base:
 * a refined schema is no longer an object and cannot be extended with an id, so
 * the base has to stay plain and the checks have to be added to each end.
 */
const wellFormed = (motion: z.infer<typeof motionFields>, ctx: z.RefinementCtx): void => {
  // A refinement still runs when a field check above it failed, so the empty
  // list `min(1)` has already refused reaches here and would be indexed.
  if (motion.frames.length === 0) return;
  for (let i = 1; i < motion.frames.length; i += 1) {
    if (motion.frames[i].at > motion.frames[i - 1].at) continue;
    ctx.addIssue({
      code: 'custom',
      path: ['frames', i, 'at'],
      message: 'keyframe times must ascend',
    });
  }
  if (motion.frames[motion.frames.length - 1].at > MOTION_MAX_SECONDS) {
    ctx.addIssue({
      code: 'custom',
      path: ['frames'],
      message: `a motion may not run longer than ${MOTION_MAX_SECONDS}s`,
    });
  }
};

export const motionBodySchema = motionFields.superRefine(wellFormed);

export type MotionBody = z.infer<typeof motionBodySchema>;

/** The same thing with its id attached, which is the form that travels. */
export const motionSchema = motionFields.extend({ id: z.string().min(1) }).superRefine(wellFormed);

type _MotionMatchesEngine = Expect<Equals<z.infer<typeof motionSchema>, MotionDef>>;

export type Motion = z.infer<typeof motionSchema>;

/**
 * What `GET /api/motions` answers with. Empty on a server with no directory.
 *
 * The files that did not parse travel beside the ones that did, rather than
 * being left in the server's log. A motion that is simply absent from the list
 * reads as a filename typed wrong, which is the one thing it is not — the same
 * reason a document that will not open is still listed. See `Decks.scan`.
 */
export const motionsResponseSchema = z.object({
  motions: z.array(motionSchema),
  errors: z.array(z.object({ id: z.string(), error: z.string() })),
});

export type MotionsResponse = z.infer<typeof motionsResponseSchema>;

/**
 * Parse one motion file's contents, returning the reason rather than throwing.
 *
 * The caller is either a server reading a file somebody is editing or a
 * renderer reading a socket, and neither wants an exception — the server prints
 * the reason next to the filename, the renderer drops the motion and keeps the
 * ones that parsed.
 */
export function parseMotion(id: string, value: unknown): { motion: Motion } | { error: string } {
  const parsed = motionBodySchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || 'motion'}: ${issue.message}`)
      .join(', ');
    return { error: detail };
  }
  return { motion: { ...parsed.data, id } };
}
