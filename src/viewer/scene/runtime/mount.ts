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

type DisposableResource = { dispose: () => void };

const disposable = (value: unknown): value is DisposableResource =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as DisposableResource).dispose === 'function';

const texture = (value: unknown): value is THREE.Texture =>
  !!value && typeof value === 'object' && (value as THREE.Texture).isTexture === true;

/**
 * Release a GLTF that never reached `mountAvatar`.
 *
 * GLTFLoader owns the object graph, but it does not own the lifetime of the
 * GPU resources it put in it. A load can finish after a runtime was disposed,
 * so this path has to walk the raw graph without relying on a mounted
 * `MaterialSet`. Every collection is a Set because GLTF routinely shares a
 * material, texture or skeleton between meshes.
 */
export function disposeRawAvatar(root: THREE.Object3D): void {
  const geometries = new Set<DisposableResource>();
  const skeletons = new Set<DisposableResource>();
  const materials = new Set<DisposableResource>();
  const textures = new Set<DisposableResource>();
  const images = new Set<object>();
  const visited = new Set<object>();
  const visitedImages = new Set<object>();

  const collectImage = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const image of value) collectImage(image);
      return;
    }
    const image = value as object;
    if (visitedImages.has(image)) return;
    visitedImages.add(image);
    // ImageBitmap has `close`; test and host image wrappers sometimes expose
    // `dispose` instead. Plain HTMLImageElement/canvas instances need no call:
    // once the texture and graph references are gone they are collectible.
    if (
      typeof (image as { close?: unknown }).close === 'function' ||
      typeof (image as { dispose?: unknown }).dispose === 'function'
    ) {
      images.add(image);
    }
  };

  const collectTexture = (value: unknown): void => {
    if (!texture(value)) return;
    if (disposable(value)) textures.add(value);
    const source = (value as THREE.Texture & { source?: { data?: unknown } }).source?.data;
    collectImage(source);
    collectImage((value as THREE.Texture & { image?: unknown }).image);
  };

  const collectMaterial = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (texture(value)) {
      collectTexture(value);
      return;
    }
    if (visited.has(value)) return;
    visited.add(value);
    if (disposable(value)) materials.add(value);
    for (const child of Object.values(value)) collectTextures(child);
  };

  function collectTextures(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (texture(value)) {
      collectTexture(value);
      return;
    }
    if (visited.has(value)) return;
    visited.add(value);
    for (const child of Object.values(value)) collectTextures(child);
  }

  root.traverse((object) => {
    const renderable = object as THREE.Object3D & {
      geometry?: unknown;
      material?: unknown;
    };
    if (disposable(renderable.geometry)) {
      geometries.add(renderable.geometry);
      const morphTexture = (renderable.geometry as { morphTexture?: unknown }).morphTexture;
      if (disposable(morphTexture)) textures.add(morphTexture);
    }
    const rawMaterials = Array.isArray(renderable.material)
      ? renderable.material
      : [renderable.material];
    for (const material of rawMaterials) collectMaterial(material);
    if (object instanceof THREE.SkinnedMesh && disposable(object.skeleton)) {
      // Skeleton.dispose() also releases its bone texture, so that resource is
      // intentionally owned by this Set rather than collected as a texture.
      skeletons.add(object.skeleton);
    }
  });

  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
  for (const material of materials) material.dispose();
  for (const resource of textures) resource.dispose();
  for (const image of images) {
    const close = (image as { close?: unknown }).close;
    if (typeof close === 'function') close.call(image);
    else {
      const dispose = (image as { dispose?: unknown }).dispose;
      if (typeof dispose === 'function') dispose.call(image);
    }
  }
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
