/**
 * Yonagi Neru.
 *
 * The main-dress profile from `original01.ts` (tiered skirt with the Mid-band
 * frill, sheer overskirt, cuffs and the rear bow's connector) under the
 * character's own name and model file.
 */

import type { AvatarDescriptor } from '../engine/types';
import { createOriginal01MainCuffLaceGravity } from './original01';

export default {
  ...createOriginal01MainCuffLaceGravity('/models/neru.glb'),
  id: 'neru',
  label: { en: 'Yonagi Neru', ja: '夜凪ねる' },
} satisfies AvatarDescriptor;
