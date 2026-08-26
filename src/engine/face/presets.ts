/**
 * Authored expression channels.
 *
 * Two channels feed the face. The emotion composition — ARKit in
 * `emotions.ts`, or the avatar's own vocabulary when it has no ARKit — is
 * part-level and blends. This file handles the other kind: shapes the author
 * drew as finished artwork, which cannot be synthesised from parts at all. An
 * authored face swaps the iris for a spiral, replaces the pupil with a dot,
 * puts the mouth in a shape no combination of muscle-level weights reaches.
 *
 * There are two forms of it, and the difference matters:
 *
 * - **presets** are whole faces. They replace the composed expression, because
 *   layering muscle weights over a finished drawing muddies it — the artist
 *   already placed the brows, the lids and the mouth.
 * - **overlays** are effects drawn *over* a face: a heart pupil, a blush, a
 *   sweat drop, tears. They add, and the expression underneath survives.
 *
 * Which an avatar ships is a property of how its author works. One avatar draws
 * complete faces and folds the effects into them; another composes everything
 * from parts and keeps the effects as a separate group. Neither is a variant of
 * the other, so both channels exist and an avatar declares whichever it has.
 *
 * What the engine cannot do is *know* the ids. They are avatar-specific and
 * carry no convention, so the group names and the emotion mapping live in the
 * avatar descriptor. All the runtime knows generically is that shape groups
 * exist — `profile.groups` is the discovery, the descriptor is the meaning.
 */

import type * as THREE from 'three';
import type { AvatarDescriptor, DrawnShapeSpec, LabelledId, MorphTarget, Profile } from '../types';

/** A morph's vertex deltas, however the geometry happens to store them. */
type MorphAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

/** How much of "close this eye" something already holds, per eye, 0..1. */
export interface LidClosure {
  L: number;
  R: number;
}

/** One authored whole face, with the lid travel it already supplies measured out. */
export interface ExpressionPreset {
  id: string;
  label: string;
  lid: LidClosure;
}

/**
 * How much of "close this eye" a preset already contains, per eye, 0..1.
 *
 * Measured rather than tabulated. Both the preset and the blink are vertex
 * deltas on the same mesh, so projecting one onto the other answers the question
 * directly: `F_SUYASUYA` comes out at 1.0 and 0.93, `F_DOYA` at 0.17, and a wink
 * comes out asymmetric without anyone having to say it is a wink.
 *
 * Hand-listing this is a trap. Half of these faces are drawn with the lids at
 * some intermediate position, and a preset that merely *looks* shut in a
 * thumbnail (`F_GUTTARI`, `F_MUMUMU`) can turn out to hold the lids wide open
 * and get its droop entirely from the brows.
 *
 * The blink shapes are taken from the profile rather than named here, because
 * the avatar that needs this measured is not necessarily the one that calls
 * them `eyeBlinkLeft`.
 */
function lidClosure(profile: Profile, id: string): LidClosure {
  const blinkL = profile.blink.L ? profile.morphTargets.get(profile.blink.L) : undefined;
  const blinkR = profile.blink.R ? profile.morphTargets.get(profile.blink.R) : undefined;
  const own = profile.morphTargets.get(id);
  if (!(blinkL && blinkR && own)) return { L: 0, R: 0 };

  // All three have to live on the same mesh for the deltas to be comparable.
  const mesh = blinkL[0].mesh;
  const on = (list: MorphTarget[]): MorphTarget | undefined => list.find((t) => t.mesh === mesh);
  const [a, l, r] = [on(own), on(blinkL), on(blinkR)];
  const attrs: MorphAttribute[] | undefined = mesh.geometry?.morphAttributes?.position;
  if (!(a && l && r && attrs)) return { L: 0, R: 0 };

  const project = (target: MorphAttribute, onto: MorphAttribute): number => {
    let dot = 0;
    let len = 0;
    for (let i = 0; i < onto.count; i++) {
      const bx = onto.getX(i);
      const by = onto.getY(i);
      const bz = onto.getZ(i);
      dot += target.getX(i) * bx + target.getY(i) * by + target.getZ(i) * bz;
      len += bx * bx + by * by + bz * bz;
    }
    return len > 1e-12 ? Math.min(1, Math.max(0, dot / len)) : 0;
  };
  return {
    L: project(attrs[a.index], attrs[l.index]),
    R: project(attrs[a.index], attrs[r.index]),
  };
}

/** Shape ids in a declared group that actually exist on this GLB. */
function idsInGroup(profile: Profile, spec: DrawnShapeSpec | null | undefined): string[] {
  if (!spec?.group) return [];
  const exclude = new Set(spec.exclude ?? []);
  return (profile.groups?.get(spec.group) ?? []).filter(
    (id) => !exclude.has(id) && profile.morphTargets.has(id),
  );
}

/**
 * Resolve the preset list against a loaded profile.
 * Returns [] when the avatar ships no finished faces, which is a normal case
 * and not an error — the emotion composition covers it.
 */
export function buildPresets(profile: Profile, avatar?: AvatarDescriptor): ExpressionPreset[] {
  const spec = avatar?.presets;
  const label = spec?.label ?? ((id: string) => id);
  return idsInGroup(profile, spec).map((id) => ({
    id,
    label: label(id),
    lid: lidClosure(profile, id),
  }));
}

/**
 * Resolve the overlay list. Same discovery, no lid measurement: an overlay is
 * drawn on top of whatever the lids are doing and never claims them.
 */
export function buildOverlays(profile: Profile, avatar?: AvatarDescriptor): LabelledId[] {
  const spec = avatar?.overlays;
  const label = spec?.label ?? ((id: string) => id);
  return idsInGroup(profile, spec).map((id) => ({ id, label: label(id) }));
}
