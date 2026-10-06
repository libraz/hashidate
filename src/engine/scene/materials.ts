import * as THREE from 'three';
import type { AvatarDescriptor, MaterialRules, PbrScalarOverride } from '../types';
import { installTransparentShadowMaterials } from './shadows';

/**
 * Material fixup for a VRChat-authored avatar rendered outside Unity.
 *
 * Two things are lost on the way out of Unity and have to be restored here:
 *
 * 1. Cull mode. lilToon materials declare their own culling, none of which
 *    survives FBX, so the exporter marks everything double-sided. The result is
 *    that back faces of the head render and the eyes are visible from inside
 *    the skull. A closed avatar wants FrontSide everywhere except genuinely
 *    flat pieces (hair cards, the doubleS coat).
 *
 * 2. Alpha mode. Anime textures are hard-edged cutouts but arrive as alphaMode
 *    BLEND, which puts the face in the transparent queue where three.js sorts
 *    per object and the depth order flips with the camera — the symptom being
 *    an eye that floats near the middle of the head from three-quarter angles.
 *    Alpha-tested opaque geometry restores correct depth.
 *
 * Face decals (lashes, brows) are coplanar with the face, genuinely need
 * blending, and draw last.
 *
 * ---------------------------------------------------------------------------
 * Known limitation: off-axis irises
 *
 * Measured on the first avatar: the iris is a forward-facing plane sitting ~10 mm
 * *behind* the face surface, seen through an alpha-cut hole in `mt_Face`. The
 * sclera is painted on the face surface itself. Past roughly 40° off axis the
 * face and hair occlude the iris while the sclera remains, and the eye reads as
 * blank white. A ray cast at the eye bone from 55° never reaches the iris at
 * all.
 *
 * lilToon hides this with a stencil pass. Reproducing that here does not work:
 * `mt_Face` is alpha-cut exactly at the eye opening, so it writes no stencil
 * where the iris needs to test against it, and the iris is discarded wholesale.
 * Making it work would mean authoring a separate mask, which is a Unity-side
 * asset decision, not something the runtime can derive.
 *
 * This is out of scope rather than unsolved: the runtime streams a front-facing
 * bust. What does matter at that framing is not letting the *gaze* rotate the
 * iris out of the sclera, which is handled by the gaze limits each avatar
 * states in its descriptor.
 */

/**
 * Which materials get which treatment is avatar data — the names are the
 * author's — so the patterns come from the descriptor. These are the fallbacks
 * for an avatar that has not stated any: match nothing, i.e. treat every
 * material as a solid single-sided surface, which is the safe reading. A flat
 * piece wrongly culled is visible as a missing face; a solid piece wrongly
 * double-sided merely costs fill rate.
 */
const MATCH_NONE = /(?!)/;

/**
 * Alpha-one values within this window are Blender float32 roundoff of legacy
 * opaque sleeve materials. Keep this boundary equal to the exporter’s
 * `SLEEVE_ALPHA_TOLERANCE` so only materially fractional sleeves blend.
 */
const SLEEVE_ALPHA_TOLERANCE = 1e-6;

/** The descriptor's rules with the fallbacks filled in. */
type ResolvedRules = Omit<Required<MaterialRules>, 'preservedPbrOverrides'> & {
  preservedPbrOverrides: Record<string, PbrScalarOverride>;
};

/**
 * The slots the toon variant copies. `THREE.Material` itself declares neither,
 * because which of them a material carries depends on its concrete type.
 */
type SourceMaterial = THREE.Material & {
  map?: THREE.Texture | null;
  alphaMap?: THREE.Texture | null;
  color?: THREE.Color;
};

/** The restore handle `setupMaterials` returns. */
export interface MaterialSet {
  /** Apply the descriptor-defined toon presentation, or restore imported originals. */
  apply(useToon: boolean): void;
  /** Every material name the avatar brought, for the readout. */
  names: string[];
  dispose(): void;
}

/** Build a toon variant of a source material with cull/alpha rules applied. */
function toToon(src: SourceMaterial, rules: ResolvedRules): THREE.MeshToonMaterial {
  const name = src.name || '';
  const m = new THREE.MeshToonMaterial({
    map: src.map,
    alphaMap: src.alphaMap,
    color: src.color,
    ...(rules.blendTransparent.test(name) ? { opacity: src.opacity } : {}),
    side: rules.doubleSided.test(name) ? THREE.DoubleSide : THREE.FrontSide,
  });
  m.name = name;
  applyAlphaRules(m, name, src.transparent || src.alphaTest > 0, rules);
  return m;
}

function applyAlphaRules(
  m: THREE.Material,
  name: string,
  wasTransparent: boolean,
  rules: ResolvedRules,
): void {
  if (rules.faceDecal.test(name)) {
    // Blended, but still depth-tested and depth-writing: the eye is a stack of
    // coplanar layers whose order only comes out right if they are left as
    // authored. Forcing them into a depth-less overlay pass scrambles the stack.
    m.transparent = true;
    m.alphaTest = 0.35;
    m.depthWrite = true;
  } else if (rules.blendTransparent.test(name) && m.opacity < 1 - SLEEVE_ALPHA_TOLERANCE) {
    // Fractional sleeve fabric retains authored blending. Alpha-one legacy
    // material imports continue through the generic cutout path below.
    m.transparent = true;
    m.alphaTest = 0;
    m.depthWrite = false;
  } else if (wasTransparent) {
    // Cutout, not blend. 0.25 keeps soft-edged pieces such as the sleep mask
    // intact; higher values eat their semi-transparent fabric.
    m.transparent = false;
    m.alphaTest = 0.25;
    m.depthWrite = true;
  }
}

/**
 * A texture, whatever slot it was found in.
 *
 * The walk below reads properties the material's type does not declare, so the
 * values arrive untyped and are recognised by the same flag three.js itself
 * uses.
 */
const isTexture = (v: unknown): v is THREE.Texture =>
  !!v && (v as THREE.Texture).isTexture === true;

/** Reject malformed descriptor data before touching the imported object graph. */
function validatePbrOverrides(overrides: Record<string, PbrScalarOverride> | undefined): void {
  if (!overrides) return;
  for (const name of Object.getOwnPropertyNames(overrides)) {
    const override = overrides[name];
    for (const field of ['metalness', 'roughness'] as const) {
      const value = override?.[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new RangeError(
          `Invalid preserved PBR override for material "${name}" field "${field}": expected a finite number in [0, 1], got ${String(value)}`,
        );
      }
    }
    const reflection = override?.reflection;
    if (reflection !== undefined && (!Number.isFinite(reflection) || reflection < 0)) {
      throw new RangeError(
        `Invalid preserved PBR override for material "${name}" field "reflection": expected a finite number >= 0, got ${String(reflection)}`,
      );
    }
  }
}

/** Clone supported preserved PBR materials once per original material identity. */
function overriddenPbr(
  src: THREE.Material,
  override: PbrScalarOverride,
  clones: Map<THREE.Material, THREE.Material>,
  environment: THREE.Texture | null,
): THREE.Material {
  if (!(src instanceof THREE.MeshStandardMaterial)) return src;
  const cached = clones.get(src);
  if (cached) return cached;

  const clone = src.clone();
  clone.metalness = override.metalness;
  clone.roughness = override.roughness;
  if (override.reflection !== undefined && environment) {
    clone.envMap = environment;
    clone.envMapIntensity = override.reflection;
  }
  clone.needsUpdate = true;
  clones.set(src, clone);
  return clone;
}

/**
 * Build the descriptor-defined toon presentation and return a restore handle.
 * Preserved imported slots remain original materials in toon mode.
 * `environment` is the runtime's shared reflection map; the handle never disposes it.
 */
export function setupMaterials(
  root: THREE.Object3D,
  avatar?: AvatarDescriptor,
  environment: THREE.Texture | null = null,
): MaterialSet {
  const preservedPbrOverrides = avatar?.materials?.preservedPbrOverrides;
  validatePbrOverrides(preservedPbrOverrides);

  const rules: ResolvedRules = {
    doubleSided: avatar?.materials?.doubleSided ?? MATCH_NONE,
    faceDecal: avatar?.materials?.faceDecal ?? MATCH_NONE,
    blendTransparent: avatar?.materials?.blendTransparent ?? MATCH_NONE,
    preserveImported: avatar?.materials?.preserveImported ?? MATCH_NONE,
    preservedPbrOverrides: preservedPbrOverrides ?? {},
  };
  const original = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  const toon = new Map<THREE.Mesh, THREE.Material[]>();
  const preservedClones = new Map<THREE.Material, THREE.Material>();

  // First collect the exact imported references and retain the existing mesh
  // flags. These source materials are fixed before any variants are cloned.
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.frustumCulled = false;
    const src: SourceMaterial[] = Array.isArray(o.material) ? o.material : [o.material];
    original.set(o, o.material);

    // Decals composite over the opaque head, so they draw after it.
    if (src.some((m) => rules.faceDecal.test(m.name || ''))) o.renderOrder = 1;
  });

  // The imported materials carry the same defects, so fix them in place too.
  for (const [, orig] of original) {
    for (const m of Array.isArray(orig) ? orig : [orig]) {
      const name = m.name || '';
      m.side = rules.doubleSided.test(name) ? THREE.DoubleSide : THREE.FrontSide;
      applyAlphaRules(m, name, m.transparent || m.alphaTest > 0, rules);
      m.needsUpdate = true;
    }
  }

  // Build variants only after source fixups so preserved PBR clones inherit
  // the same cull and alpha behavior as the imported material.
  for (const [mesh, orig] of original) {
    const src: SourceMaterial[] = Array.isArray(orig) ? orig : [orig];
    toon.set(
      mesh,
      src.map((m) => {
        const name = m.name || '';
        if (!rules.preserveImported.test(name)) return toToon(m, rules);
        if (!Object.hasOwn(rules.preservedPbrOverrides, name)) return m;
        return overriddenPbr(m, rules.preservedPbrOverrides[name], preservedClones, environment);
      }),
    );
  }

  const shadows = installTransparentShadowMaterials(root, rules.blendTransparent);

  const apply = (useToon: boolean): void => {
    for (const [mesh, mats] of toon) {
      const orig = original.get(mesh);
      if (!orig) continue;
      mesh.material = useToon ? (Array.isArray(orig) ? mats : mats[0]) : orig;
    }
  };

  const names = [...original.values()]
    .flatMap((m) => (Array.isArray(m) ? m : [m]))
    .map((m) => m.name || '(no name)');

  /**
   * Release every material this avatar brought, and every texture on them.
   *
   * Both sets have to be walked. The toon variants are on screen and the
   * imported originals are held for the toggle, and only the originals carry
   * the secondary maps — normal, emissive, occlusion — because the toon variant
   * copies the base colour and alpha mask but not those shading maps. Disposing
   * only what is currently assigned leaks exactly those, which is invisible per
   * swap and unbounded over a session.
   *
   * Texture slots are found by walking the material rather than by listing
   * `map`, `normalMap`, … : the list depends on which glTF extensions the
   * exporter happened to write, and one missed slot is a leak that nothing
   * reports.
   */
  const dispose = (): void => {
    shadows.dispose();
    const seen = new Set<THREE.Material>();
    const seenTextures = new Set<THREE.Texture>();
    const release = (m: THREE.Material | null | undefined): void => {
      if (!m || seen.has(m)) return;
      seen.add(m);
      const props: unknown[] = Object.values(m);
      for (const v of props) {
        if (!isTexture(v) || v === environment || seenTextures.has(v)) continue;
        seenTextures.add(v);
        v.dispose();
      }
      m.dispose();
    };
    for (const mats of toon.values()) for (const m of mats) release(m);
    for (const orig of original.values()) {
      for (const m of Array.isArray(orig) ? orig : [orig]) release(m);
    }
    toon.clear();
    original.clear();
    preservedClones.clear();
  };

  return { apply, names, dispose };
}
