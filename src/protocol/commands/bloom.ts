import { z } from 'zod';
import type { BloomPatch, BloomSettings } from '../../engine/types';
import { BLOOM_RANGES } from '../../engine/types';
import type { Equals, Expect } from './guards';
import { correlationId, within } from './primitives';

/** A patch sent to the renderer, with the same limits the controls display. */
export const bloomPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    strength: within(BLOOM_RANGES.strength).optional(),
    radius: within(BLOOM_RANGES.radius).optional(),
    threshold: within(BLOOM_RANGES.threshold).optional(),
  })
  .strict();

type _BloomPatchMatchesEngine = Expect<Equals<z.infer<typeof bloomPatchSchema>, BloomPatch>>;

/** A complete renderer readout, unlike the partial command. */
export const bloomSettingsSchema = z
  .object({
    enabled: z.boolean(),
    strength: within(BLOOM_RANGES.strength),
    radius: within(BLOOM_RANGES.radius),
    threshold: within(BLOOM_RANGES.threshold),
  })
  .strict();

type _BloomSettingsMatchEngine = Expect<Equals<z.infer<typeof bloomSettingsSchema>, BloomSettings>>;

/** Change one or more bloom controls. Empty patches and unknown keys are errors. */
export const bloomCommandSchema = bloomPatchSchema
  .extend({
    cmd: z.literal('bloom'),
    id: correlationId,
  })
  .strict()
  .refine(({ cmd: _cmd, id: _id, ...patch }) => Object.keys(patch).length > 0, {
    error: 'bloom requires at least one setting',
  });

type BloomCommand = z.infer<typeof bloomCommandSchema>;
type _BloomCommandPatchMatchesEngine = Expect<Equals<Omit<BloomCommand, 'cmd' | 'id'>, BloomPatch>>;

export type { BloomCommand, BloomPatch, BloomSettings };
