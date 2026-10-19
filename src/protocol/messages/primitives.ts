import { z } from 'zod';
import type {
  ArmSlot,
  LabelledId as EngineLabelledId,
  Vec3Tuple,
  VisemeName,
} from '../../engine/types';
import type { Localized } from '../../i18n/locale';
import type { Equals, Expect } from '../commands';

/**
 * The two shapes every roster on this side of the wire is made of.
 */

/**
 * A display string in both languages at once.
 *
 * The wire carries the pair and the client picks one. The alternative — resolving
 * at the source — would mean the server choosing a language on behalf of whoever
 * happens to be reading the panel, and there is nothing in a control request that
 * says who that is.
 */
export const localizedSchema = z.object({
  en: z.string(),
  ja: z.string(),
});

type _LocalizedMatchesEngine = Expect<Equals<z.infer<typeof localizedSchema>, Localized>>;

export const labelledIdSchema = z.object({
  id: z.string(),
  label: localizedSchema,
});

export type LabelledId = z.infer<typeof labelledIdSchema>;
type _LabelledIdMatchesEngine = Expect<Equals<LabelledId, EngineLabelledId>>;

/**
 * An opaque identity for one renderer process.
 *
 * The server may use this value to bind renderer-owned work to the connection
 * that started it. It is deliberately not a UUID schema: browser-generated
 * ids are normally UUIDs, but an embedding can choose another stable string
 * without creating a second wire dialect. Empty ids and control characters
 * are the only values that cannot identify a process safely.
 */
export const rendererIdSchema = z
  .string()
  .min(1)
  .refine((value) => !/\p{Cc}/u.test(value), 'renderer id may not contain control characters');

export type RendererId = z.infer<typeof rendererIdSchema>;

/** Character space: x outward from the midline, y up, z forward. */
export const vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

type _Vec3MatchesEngine = Expect<Equals<z.infer<typeof vec3Schema>, Vec3Tuple>>;

/** Mouth shapes, as the profile routes them. */
export const visemeNameSchema = z.enum(['a', 'i', 'u', 'e', 'o', 'n', 'sil']);

type _VisemeNameMatchesEngine = Expect<Equals<z.infer<typeof visemeNameSchema>, VisemeName>>;

/** The links an arm pose names, shoulder to hand. */
export const armSlotSchema = z.enum(['shoulder', 'upperArm', 'lowerArm', 'hand']);

type _ArmSlotMatchesEngine = Expect<Equals<z.infer<typeof armSlotSchema>, ArmSlot>>;
