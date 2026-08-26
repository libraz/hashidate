/**
 * Avatar registry.
 *
 * The engine holds no avatar data. Everything that is a property of one
 * particular model — what its author named things, how its garments are built,
 * how far its eyes turn, which of its shapes are drawn effects — lives in one
 * descriptor per avatar, and the runtime reads it through the profile.
 *
 * Adding an avatar is adding a file here. Nothing in the director, the rig or
 * the motion layer changes.
 *
 * The field reference is `AvatarDescriptor` in `src/engine/types.ts`: every
 * field except `id`, `label` and `url` is optional, an avatar that states none
 * of them still loads, and whatever cannot be resolved is reported through
 * `Profile.missing` rather than failing.
 *
 * Selection — which avatar to load on this visit — is browser policy rather
 * than avatar data, so it lives in the viewer and not here.
 */

import type { AvatarDescriptor } from '../engine/types';
import manuka from './manuka';
import yoka from './yoka';

export const AVATARS: AvatarDescriptor[] = [yoka, manuka];

const byId = new Map(AVATARS.map((a) => [a.id, a]));

export const DEFAULT_AVATAR_ID: string = AVATARS[0].id;

export function getAvatar(id: string): AvatarDescriptor | null {
  return byId.get(id) ?? null;
}
