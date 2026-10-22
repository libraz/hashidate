import * as THREE from 'three';
import { AVATAR_ANISOTROPY, type TextureSource } from '@/engine/scene';
import type { AvatarDescriptor, ToonSpec } from '@/engine/types';

/**
 * The auxiliary textures an avatar's toon specs name, fetched before mounting.
 *
 * They live beside the GLB under `/models/<id>/`, since glTF has no slot for a
 * matcap or a shade mask. A file that does not arrive is reported rather than
 * left to switch its feature off silently, and the material is handed a
 * neutral white texture in its place so it still compiles and draws.
 */

type Kind = 'color' | 'data';

/** What `loadToonTextures` resolves to. */
export interface ToonTextures {
  /** Every file a spec names; a failed one answers with a neutral texture. */
  textures: TextureSource;
  /** The files that could not be loaded, for the console. */
  failed: string[];
  /** Release every texture this loaded or made. */
  dispose(): void;
}

/** Every file one spec names, with how it is decoded. */
function filesOf(spec: ToonSpec): Array<[string, Kind]> {
  const files: Array<[string, Kind]> = [];
  if (spec.shadow.mask) files.push([spec.shadow.mask, 'data']);
  if (spec.normalMap) files.push([spec.normalMap.file, 'data']);
  if (spec.rim?.colorTex) files.push([spec.rim.colorTex, 'color']);
  if (spec.matcap) files.push([spec.matcap.file, 'color']);
  if (spec.matcap?.mask) files.push([spec.matcap.mask, 'data']);
  if (spec.emission?.map) files.push([spec.emission.map, 'color']);
  if (spec.outline?.mask) files.push([spec.outline.mask, 'data']);
  return files;
}

const keyOf = (file: string, kind: Kind): string => `${kind}:${file}`;

function prepare(texture: THREE.Texture, kind: Kind): void {
  // Same orientation as the GLB's own textures, which share the mesh's UVs.
  texture.flipY = false;
  texture.colorSpace = kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.anisotropy = AVATAR_ANISOTROPY;
  texture.needsUpdate = true;
}

/**
 * Load every file the descriptor's `materials.toon` names, in parallel.
 *
 * Never rejects: a failed file is listed in `failed`. A file asked for as both
 * colour and data gets one texture per decoding over the same image.
 */
export async function loadToonTextures(
  avatar: AvatarDescriptor,
  loader: Pick<THREE.TextureLoader, 'loadAsync'> = new THREE.TextureLoader(),
): Promise<ToonTextures> {
  const kinds = new Map<string, Set<Kind>>();
  for (const spec of Object.values(avatar.materials?.toon ?? {})) {
    for (const [file, kind] of filesOf(spec)) {
      const set = kinds.get(file) ?? new Set<Kind>();
      set.add(kind);
      kinds.set(file, set);
    }
  }

  const dir = avatar.url.replace(/\.[^/.]+$/, '');
  const loaded = new Map<string, THREE.Texture>();
  const outcomes = await Promise.all(
    [...kinds].map(async ([file, wanted]) => {
      let image: THREE.Texture;
      try {
        image = await loader.loadAsync(`${dir}/${file}`);
      } catch {
        return file;
      }
      let first = true;
      for (const kind of wanted) {
        const texture = first ? image : image.clone();
        first = false;
        prepare(texture, kind);
        loaded.set(keyOf(file, kind), texture);
      }
      return null;
    }),
  );
  const failed = outcomes.filter((file): file is string => file !== null);

  const neutral = new Map<Kind, THREE.Texture>();
  const neutralFor = (kind: Kind): THREE.Texture => {
    let texture = neutral.get(kind);
    if (!texture) {
      texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      prepare(texture, kind);
      neutral.set(kind, texture);
    }
    return texture;
  };

  const textures: TextureSource = (file, kind) => {
    const texture = loaded.get(keyOf(file, kind));
    if (texture) return texture;
    if (failed.includes(file)) return neutralFor(kind);
    throw new Error(`Toon texture "${file}" (${kind}) is not named by the descriptor`);
  };

  return {
    textures,
    failed,
    dispose(): void {
      // The materials' own dispose walk frees the textures they took; this
      // also covers any a spec named for a material the GLB lacks.
      for (const texture of loaded.values()) texture.dispose();
      for (const texture of neutral.values()) texture.dispose();
      loaded.clear();
      neutral.clear();
    },
  };
}
