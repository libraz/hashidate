import * as THREE from 'three';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { type MaterialSet, setupMaterials, Wardrobe } from '@/engine/scene';
import type { AvatarDescriptor, Profile } from '@/engine/types';
import { getLocale } from '@/i18n/locale';
import type { MessageKey } from '@/i18n/messages';
import { translate } from '@/i18n/translate';
import type { LoadedAvatar } from './types';

/**
 * Turning a loaded GLB into a working avatar, and letting one go again.
 *
 * The two halves of a swap, kept together because they have to agree: anything
 * built here has to be released there, and a GPU resource that only one of them
 * knows about is a leak that shows up as a slowly climbing texture count.
 */

/** Everything a mounted avatar is, before it has a session over it. */
export interface Mounted {
  root: THREE.Object3D;
  profile: Profile;
  director: Director;
  wardrobe: Wardrobe;
  materials: MaterialSet;
  /** Everything the profile, wardrobe or sway layer could not resolve. */
  problems: string[];
}

export function mountAvatar(
  root: THREE.Object3D,
  avatar: AvatarDescriptor,
  toon: boolean,
): Mounted {
  // Casts, but does not receive. The shadow the avatar throws on the wall
  // behind it is what puts it in the room rather than in front of a picture of
  // one, and costs a second pass over geometry that is already skinned.
  // Receiving is the other half and is deliberately left off: a skinned mesh
  // self-shadowing at these bone counts stipples the face at exactly the
  // framing the stream spends all its time at.
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });

  const materials = setupMaterials(root, avatar);
  materials.apply(toon);

  const profile = buildProfile(root, avatar);
  const problems: string[] = [];
  // Worded in the language in force when the model came up. These are read
  // off the console beside the model they describe, and a swap is what
  // rebuilds them, so following a later switch would mean carrying every
  // finding as a pair for a line nobody re-reads.
  const say = (key: MessageKey, names: string[], separator: string) =>
    problems.push(translate(key, getLocale(), { names: names.join(separator) }));
  if (profile.missing.length) say('console.problem.profile', profile.missing, ', ');

  const director = new Director(profile, avatar);
  const wardrobe = new Wardrobe(root, profile, avatar.wardrobe);
  if (wardrobe.missing.length) say('console.problem.wardrobe', wardrobe.missing, ' / ');
  if (director.spring.missing.length) {
    say('console.problem.sway', director.spring.missing, ' / ');
  }
  if (director.tail.missing.length) {
    say('console.problem.tail', director.tail.missing, ' / ');
  }

  return { root, profile, director, wardrobe, materials, problems };
}

/** Release a loaded avatar: every GPU resource it brought. */
export function disposeAvatar(cur: LoadedAvatar): void {
  // Materials and their textures belong to the material layer, which holds
  // both the imported set and the toon set; only the geometry is ours.
  cur.materials.dispose();
  // Geometry, and the two GPU resources that hang off a skinned mesh rather
  // than off its material: the skeleton's bone texture and the morph-target
  // array texture. Neither is reachable by walking materials, and neither
  // shows up as anything but a slowly climbing texture count.
  const skeletons = new Set<THREE.Skeleton>();
  cur.root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry?.dispose();
    o.geometry?.morphTexture?.dispose();
    if (o instanceof THREE.SkinnedMesh && o.skeleton) skeletons.add(o.skeleton);
  });
  for (const s of skeletons) s.dispose();
}
