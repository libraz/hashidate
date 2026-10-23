import * as THREE from 'three';
import type { GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { Director } from '@/engine/director';
import { buildProfile, loadedNodeNames, readVrmHumanoid, type VrmHumanoid } from '@/engine/profile';
import {
  type MaterialSet,
  missingTextureSource,
  releaseTextureImages,
  setupMaterials,
  Wardrobe,
} from '@/engine/scene';
import type { AvatarDescriptor, BoneOverrides, FingerOverrides, Profile } from '@/engine/types';
import { getLocale } from '@/i18n/locale';
import type { MessageKey } from '@/i18n/messages';
import { translate } from '@/i18n/translate';
import type { ToonTextures } from './toon-textures';
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

/**
 * Add a VRM file's own humanoid map to a descriptor.
 *
 * The descriptor stays authoritative: its bone names are tried first and the
 * VRM's follow, per slot. A finger is one chain rather than a list of
 * alternatives, so a stated chain is kept whole and the VRM supplies only the
 * keys it leaves out.
 */
export function withVrmHumanoid(
  avatar: AvatarDescriptor,
  vrm: Pick<VrmHumanoid, 'bones' | 'fingers'>,
): AvatarDescriptor {
  const bones: BoneOverrides = { ...avatar.bones };
  for (const [slot, names] of Object.entries(vrm.bones) as Array<[keyof BoneOverrides, string[]]>) {
    bones[slot] = [...new Set([...(bones[slot] ?? []), ...names])];
  }
  const fingers: FingerOverrides = { ...vrm.fingers, ...avatar.fingers };
  return { ...avatar, bones, fingers };
}

/**
 * `parser` is the loader's, read for a VRM humanoid map: its JSON for the map,
 * its associations for the node each entry became. A VRM 0.x model faces -Z,
 * so it is turned to face +Z before anything measures it.
 *
 * `toonTextures` is what `loadToonTextures` fetched for the descriptor. The
 * returned material set owns it from here: its `dispose` releases both.
 */
export function mountAvatar(
  root: THREE.Object3D,
  descriptor: AvatarDescriptor,
  toon: boolean,
  environment: () => THREE.Texture | null,
  parser?: Pick<GLTFParser, 'json' | 'associations'>,
  toonTextures?: ToonTextures,
): Mounted {
  const vrm = parser ? readVrmHumanoid(parser.json, loadedNodeNames(parser.associations)) : null;
  const avatar = vrm ? withVrmHumanoid(descriptor, vrm) : descriptor;
  if (vrm?.legacy) {
    root.rotateY(Math.PI);
    root.updateMatrixWorld(true);
  }

  // Every mesh casts. The shadow the avatar throws on the wall behind it is
  // what puts it in the room rather than in front of a picture of one, and
  // costs a second pass over geometry that is already skinned. Receiving is the
  // material set's call: three's own darkening on a skinned mesh at these bone
  // counts stipples the face at exactly the framing the stream spends all its
  // time at, so only an authored lilToon border is moved by a shadow.
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });

  const set = setupMaterials(
    root,
    avatar,
    environment,
    toonTextures?.textures ?? missingTextureSource,
  );
  const materials: MaterialSet = {
    ...set,
    dispose: () => {
      set.dispose();
      toonTextures?.dispose();
    },
  };
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
  if (toonTextures?.failed.length) say('console.problem.toonTexture', toonTextures.failed, ', ');

  const director = new Director(profile, avatar);
  const wardrobe = new Wardrobe(root, profile, avatar.wardrobe);
  // After everything that walks the meshes, so a hull is never measured as body
  // or routed as a garment of its own.
  materials.installOutlines();
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
  const owners = new Set<THREE.Texture>();
  const visited = new Set<object>();

  const collectTexture = (value: unknown): void => {
    if (!texture(value)) return;
    if (disposable(value)) textures.add(value);
    owners.add(value);
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
  releaseTextureImages(owners);
}

/** Release a loaded avatar: every GPU resource it brought. */
export function disposeAvatar(cur: LoadedAvatar): void {
  // Materials and their textures belong to the material layer, which holds
  // both the imported set and the toon set; only the geometry is ours.
  cur.materials.dispose();
  // Geometry, and the skeleton's bone texture, which hangs off a skinned mesh
  // rather than its material and shows up only as a climbing texture count.
  // Morph textures are freed by the geometry's dispose event.
  const skeletons = new Set<THREE.Skeleton>();
  cur.root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry?.dispose();
    if (o instanceof THREE.SkinnedMesh && o.skeleton) skeletons.add(o.skeleton);
  });
  for (const s of skeletons) s.dispose();
}
