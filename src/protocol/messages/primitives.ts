import { z } from 'zod';
import type { LabelledId as EngineLabelledId } from '../../engine/types';
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
