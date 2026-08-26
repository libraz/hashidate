import * as THREE from 'three';
import type { AvatarDescriptor, MaterialRules } from '../types';

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

/** The descriptor's rules with the fallbacks filled in. */
type ResolvedRules = Required<MaterialRules>;

/**
 * The slots the toon variant copies. `THREE.Material` itself declares neither,
 * because which of them a material carries depends on its concrete type.
 */
type SourceMaterial = THREE.Material & {
  map?: THREE.Texture | null;
  color?: THREE.Color;
};

/** The restore handle `setupMaterials` returns. */
export interface MaterialSet {
  /** Swap every mesh to the toon variants, or back to the imported originals. */
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
    color: src.color,
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

/**
 * Convert every mesh to toon materials and return a restore handle.
 * Keeps the originals so the UI can toggle back to the imported look.
 */
export function setupMaterials(root: THREE.Object3D, avatar?: AvatarDescriptor): MaterialSet {
  const rules: ResolvedRules = {
    doubleSided: avatar?.materials?.doubleSided ?? MATCH_NONE,
    faceDecal: avatar?.materials?.faceDecal ?? MATCH_NONE,
  };
  const original = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  const toon = new Map<THREE.Mesh, THREE.Material[]>();

  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.frustumCulled = false;
    const src: SourceMaterial[] = Array.isArray(o.material) ? o.material : [o.material];
    original.set(o, o.material);
    toon.set(
      o,
      src.map((m) => toToon(m, rules)),
    );

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
   * copies the base colour and nothing else. Disposing only what is currently
   * assigned leaks exactly those, which is invisible per swap and unbounded
   * over a session.
   *
   * Texture slots are found by walking the material rather than by listing
   * `map`, `normalMap`, … : the list depends on which glTF extensions the
   * exporter happened to write, and one missed slot is a leak that nothing
   * reports.
   */
  const dispose = (): void => {
    const seen = new Set<THREE.Material>();
    const release = (m: THREE.Material | null | undefined): void => {
      if (!m || seen.has(m)) return;
      seen.add(m);
      const props: unknown[] = Object.values(m);
      for (const v of props) if (isTexture(v)) v.dispose();
      m.dispose();
    };
    for (const mats of toon.values()) for (const m of mats) release(m);
    for (const orig of original.values()) {
      for (const m of Array.isArray(orig) ? orig : [orig]) release(m);
    }
    toon.clear();
    original.clear();
  };

  return { apply, names, dispose };
}
