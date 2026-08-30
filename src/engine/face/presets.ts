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
import { type Localized, same } from '../../i18n/locale';
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
  label: Localized;
  lid: LidClosure;
  /** How much of the author's own "park this out of view" travel it carries, 0..1. */
  swap: number;
  /** How much of the authored mouth opening the canonical close shape reverses, 0..1. */
  mouthClose: number;
}

/** Deltas accumulated against another shape's, before the ratio is taken. */
interface Projection {
  dot: number;
  len: number;
}

/** Add one mesh's worth of `target` projected onto `onto`. */
function accumulate(target: MorphAttribute, onto: MorphAttribute, into: Projection): void {
  for (let i = 0; i < onto.count; i++) {
    const bx = onto.getX(i);
    const by = onto.getY(i);
    const bz = onto.getZ(i);
    into.dot += target.getX(i) * bx + target.getY(i) * by + target.getZ(i) * bz;
    into.len += bx * bx + by * by + bz * bz;
  }
}

/** How much of `onto` the accumulated deltas amount to, 0..1. */
const ratio = ({ dot, len }: Projection): number =>
  len > 1e-12 ? Math.min(1, Math.max(0, dot / len)) : 0;

/** The reverse projection used when an authored drawing opens the mouth. */
const reverseRatio = ({ dot, len }: Projection): number =>
  len > 1e-12 ? Math.min(1, Math.max(0, -dot / len)) : 0;

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
    const p: Projection = { dot: 0, len: 0 };
    accumulate(target, onto, p);
    return ratio(p);
  };
  return {
    L: project(attrs[a.index], attrs[l.index]),
    R: project(attrs[a.index], attrs[r.index]),
  };
}

/** Every mesh this shape writes on, with the deltas it writes there. */
function attributesOf(list: MorphTarget[] | undefined): Map<THREE.Mesh, MorphAttribute> {
  const out = new Map<THREE.Mesh, MorphAttribute>();
  for (const t of list ?? []) {
    const attr = t.mesh.geometry?.morphAttributes?.position?.[t.index];
    if (attr) out.set(t.mesh, attr);
  }
  return out;
}

/**
 * How much of an authored parking shape a drawn face already contains, 0..1.
 *
 * Some finished faces do not deform the eye, they replace it. The author draws
 * the new one and folds in the `*Hide` that takes the default iris, lashes and
 * highlights out of their opening, so the two ship as a single shape. That fold
 * is what makes the drawing correct at full weight and *only* at full weight:
 * the hide is a translation, not a collapse, so at 0.4 the iris has travelled
 * four tenths of the way out of its window and stops there, half in the opening
 * and half over the new eye. It reads as a broken eyeball, and it is reached by
 * nothing more exotic than an emotion that is felt at 0.4.
 *
 * Measured for the same reason the lid travel above is: which faces do it is a
 * property of how each one was drawn, nothing in the naming marks them, and a
 * face that visibly swaps the iris in a thumbnail may be reshaping it instead.
 * The answer comes out at the ends of the range rather than across it — on the
 * validation avatar, 1.0 for every face that swaps the eye and under 0.09 for
 * every face that does not — so a threshold between them has an order of
 * magnitude of room on either side.
 *
 * Which group holds the parking shapes is avatar data: a `*Hide` family is a
 * convention of the author's, and the runtime has no way to recognise one.
 */
function artSwap(profile: Profile, id: string, hideIds: string[]): number {
  const own = attributesOf(profile.morphTargets.get(id));
  if (!own.size) return 0;

  let best = 0;
  for (const hideId of hideIds) {
    // Summed over every mesh the two share rather than measured on one of them.
    // A face arrives split across several meshes and a hide is doing its work on
    // only some of them; adding the parts up weights each mesh by how much shape
    // it actually carries, so one where the hide is a rounding error cannot
    // decide the answer.
    const p: Projection = { dot: 0, len: 0 };
    for (const [mesh, onto] of attributesOf(profile.morphTargets.get(hideId))) {
      const target = own.get(mesh);
      if (target) accumulate(target, onto, p);
    }
    best = Math.max(best, ratio(p));
  }
  return best;
}

/**
 * How much of an authored mouth opening is cancelled by `mouthClose` while
 * speaking, 0..1.
 *
 * Both shapes are deltas on the same mesh. The close shape points opposite to
 * an authored open mouth, so its useful amount is the clamped negative
 * projection. Avatars without the canonical shape, or with a preset on another
 * mesh, simply measure zero and keep their old behaviour.
 */
function mouthClosure(profile: Profile, id: string): number {
  const own = attributesOf(profile.morphTargets.get(id));
  const close = attributesOf(profile.morphTargets.get('mouthClose'));
  if (!(own.size && close.size)) return 0;

  const p: Projection = { dot: 0, len: 0 };
  for (const [mesh, onto] of close) {
    const target = own.get(mesh);
    if (target) accumulate(target, onto, p);
  }
  return reverseRatio(p);
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
  const hideIds = (spec?.hideGroup ? profile.groups?.get(spec.hideGroup) : null) ?? [];
  return idsInGroup(profile, spec).map((id) => ({
    id,
    // `same`, because what comes back is the avatar author's own name for a
    // drawing. There is nothing to translate: a shape key is whatever was typed
    // into Blender, and it reads identically in either language.
    label: same(label(id)),
    lid: lidClosure(profile, id),
    swap: artSwap(profile, id, hideIds),
    mouthClose: mouthClosure(profile, id),
  }));
}

/**
 * The faces the idle autopilot may reach for on its own.
 *
 * Two subtractions from the resolved list, and they are subtracted for opposite
 * reasons. A face some canonical emotion maps to already arrives through the
 * emotion vector, so putting it here as well would have the autopilot pick a
 * drawing the mood underneath is not in — the character would look delighted
 * while feeling nothing in particular. What is left is the bulk of the set: the
 * drawings no emotion names, which nothing else in the runtime can reach.
 *
 * `idleExclude` then removes the ones that are reachable but must not arrive
 * unasked — a face is a wardrobe item the character puts on for a moment, and
 * some of them say something the idle should never say by accident.
 */
export function buildIdleFaces(presets: ExpressionPreset[], avatar?: AvatarDescriptor): string[] {
  const spec = avatar?.presets;
  const mapped = new Set(Object.values(spec?.emotion ?? {}));
  const barred = new Set(spec?.idleExclude ?? []);
  return presets.map((x) => x.id).filter((id) => !(mapped.has(id) || barred.has(id)));
}

/**
 * Resolve the overlay list. Same discovery, no lid measurement: an overlay is
 * drawn on top of whatever the lids are doing and never claims them.
 */
export function buildOverlays(profile: Profile, avatar?: AvatarDescriptor): LabelledId[] {
  const spec = avatar?.overlays;
  const label = spec?.label ?? ((id: string) => id);
  return idsInGroup(profile, spec).map((id) => ({ id, label: same(label(id)) }));
}
