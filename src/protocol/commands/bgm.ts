import { z } from 'zod';
import { bgmControlFieldsSchema } from '../bgm-controls';
import { correlationId } from './primitives';

export {
  BGM_DEFAULT_LOOP,
  BGM_DEFAULT_VOLUME,
  BGM_DEFAULTS,
  BGM_DSP_DEFAULTS,
  BGM_FADE_DEFAULT_IN_SECONDS,
  BGM_FADE_DEFAULT_OUT_SECONDS,
  BGM_FADE_DEFAULTS,
  BGM_FADE_LIMITS,
  type BgmAction,
  type BgmDsp,
  type BgmDspPatch,
  type BgmFade,
  type BgmFadePatch,
  bgmActionSchema,
  bgmControlFieldsSchema,
  bgmDspPatchSchema,
  bgmDspSchema,
  bgmFadePatchSchema,
  bgmFadeSchema,
  bgmLoopSchema,
  bgmTrackIdSchema,
  bgmVolumeSchema,
  hasBgmSetting,
} from '../bgm-controls';

/**
 * Background music: the transport the server owns, the transition policy, and
 * the fixed insert chain the renderer runs it through.
 *
 * The one command family whose timeline is server-generated — see
 * `bgmCommandSchema` for which fields a caller may set and which are stamped on
 * the way out.
 */

/** The transport state that is synchronised to every renderer. */
export const bgmTransportSchema = z.enum(['playing', 'paused', 'stopped', 'ended']);
export type BgmTransport = z.infer<typeof bgmTransportSchema>;

/**
 * Change the server-owned BGM transport.
 *
 * The action, selection, level and DSP fields are caller input. `revision`,
 * `transport`, `position` and `at` may arrive from an older/newer peer, but are
 * server-generated and are overwritten by `BgmCoordinator` before the command
 * is sent to a viewer.
 * Keeping them in the schema lets the wire degrade across release cycles
 * without allowing a caller to forge the timeline.
 *
 * An absent action is a settings-only patch. An absent track leaves the
 * selection alone; `track: null` unloads it. The distinction is deliberate and
 * is resolved by the server rather than by each renderer.
 */
export const bgmCommandSchema = bgmControlFieldsSchema.extend({
  cmd: z.literal('bgm'),
  id: correlationId,
  revision: z.number().int().nonnegative().optional(),
  transport: bgmTransportSchema.optional(),
  position: z.number().finite().min(0).optional(),
  at: z.number().finite().nonnegative().optional(),
});

export type BgmCommand = z.infer<typeof bgmCommandSchema>;
