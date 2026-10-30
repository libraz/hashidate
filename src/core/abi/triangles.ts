/**
 * Exports of the triangles module: one transparent mesh's vertex pose, face depths and face order.
 *
 * `h` is a handle from `hd_tri_new`. Vertices are compact: the caller uploads only the vertices
 * the index references, in any fixed order, and a face names its three by that slot. A face index
 * is the face's position in the source index (`offset / 3`). A slot, bone or face out of range
 * traps.
 *
 * | export              | arguments                                              | returns |
 * |---------------------|--------------------------------------------------------|---------|
 * | hd_tri_new          | scene, mesh node, skeleton, vertices, faces, morph targets, bones, FLAG_* bits | handle |
 * | hd_tri_free         | h                                                      | — |
 * | hd_tri_layout       | h                                                      | ptr to LAYOUT u32 buffer addresses, valid until free |
 * | hd_tri_update       | h; reads the graph and every input buffer, writes every output buffer | OUTCOME_* |
 * | hd_tri_skin_changed | h                                                      | 1 if a skin matrix in the graph differs from what the last update read, else 0 |
 *
 * ## The scene graph (`hd_scene_*`)
 *
 * `scene` is a scene graph handle; `hd_tri_new` registers the kernel as its dependent and
 * `hd_tri_free` releases it, doing nothing once the graph is gone. `mesh` is the mesh's node. A
 * skinned mesh's node is a SkinnedMesh of the graph, and `skeleton` is its skeleton's index in the
 * graph (`NO_NODE` for a rigid mesh), which must have exactly `bones` slots; with no bones it is
 * ignored. Anything else traps.
 *
 * `hd_tri_update` reads each bone's `matrixWorld` from its node and its `boneInverse` from the
 * skeleton, the mesh's `bindMatrix` and `bindMatrixInverse`, and the mesh's `matrixWorld`, all as
 * the graph holds them at the call. `hd_tri_skin_changed` compares the bone, bone-inverse and bind
 * matrices with those values by `!==` (a NaN always differs, −0 equals +0); a bone outside the
 * graph is not compared, and the caller must not weight one.
 *
 * ## Buffers (`hd_tri_layout`, one byte address per slot at `LAYOUT_*`)
 *
 * | buffer      | written           | element                                                   | stride |
 * |-------------|-------------------|-----------------------------------------------------------|--------|
 * | faces       | on upload         | u32 vertex slot ×3 per face                               | 3 |
 * | base        | on upload         | f64 `position` xyz per slot, as three reads it            | 3 |
 * | morphs      | on upload         | f64 morph `position` xyz per slot, target-major (target t, slot s at `3 * (t * vertices + s)`) | 3 |
 * | skin index  | on upload         | u32 `skinIndex` ×4 per slot; any value where the weight is 0 | 4 |
 * | skin weight | on upload         | f64 `skinWeight` ×4 per slot, as three reads it           | 4 |
 * | frame       | per frame         | f64 camera `matrixWorldInverse` 16 at FRAME_VIEW; the rest is the update's copy from the graph | — |
 * | influences  | per frame         | f64 `morphTargetInfluences[t]` per target, NaN where three's is `undefined` | 1 |
 * | positions   | by update         | f64 posed xyz per slot, mesh space                        | 3 |
 * | centroids   | by update         | f64 centroid xyz per face, mesh space                     | 3 |
 * | depths      | by update         | f64 view-space z per face                                 | 1 |
 * | order       | by update         | u32 face index, ascending depth, ties by face index; the identity until the first sort | 1 |
 *
 * Every element is three's own value read with `fromBufferAttribute` (so normalized integer
 * attributes arrive denormalised) or a matrix's `elements`. Bind matrices and bones are read only
 * with FLAG_SKINNED; morphs and influences only with FLAG_MORPHED, which mirrors three's
 * `morphAttributes.position && morphTargetInfluences` and adds the morph sum even with no target.
 *
 * `OUTCOME_NON_FINITE_DEPTH` means a depth was NaN: the order is left as the last sort wrote it.
 *
 * `hd_tri_new` allocates every buffer; `hd_tri_update` and `hd_tri_skin_changed` allocate nothing,
 * so the addresses stay put and the memory does not grow. The caller refreshes its views when
 * `memory.buffer` changes.
 */

export const FLAG_SKINNED = 1;
export const FLAG_MORPHED = 2;
export const FLAG_MORPH_RELATIVE = 4;

export const FRAME_VIEW = 48;

export const LAYOUT_FACES = 0;
export const LAYOUT_BASE = 1;
export const LAYOUT_MORPHS = 2;
export const LAYOUT_SKIN_INDEX = 3;
export const LAYOUT_SKIN_WEIGHT = 4;
export const LAYOUT_FRAME = 5;
export const LAYOUT_INFLUENCES = 6;
export const LAYOUT_POSITIONS = 7;
export const LAYOUT_CENTROIDS = 8;
export const LAYOUT_DEPTHS = 9;
export const LAYOUT_ORDER = 10;
export const LAYOUT = 11;

export const OUTCOME_SORTED = 0;
export const OUTCOME_NON_FINITE_DEPTH = 1;

/** Export names of the triangles module. */
export const TRIANGLES_EXPORTS = [
  'hd_tri_new',
  'hd_tri_free',
  'hd_tri_layout',
  'hd_tri_update',
  'hd_tri_skin_changed',
] as const;

export interface TrianglesExports {
  hd_tri_new(
    scene: number,
    mesh: number,
    skeleton: number,
    vertices: number,
    faces: number,
    morphs: number,
    bones: number,
    flags: number,
  ): number;
  hd_tri_free(h: number): void;
  hd_tri_layout(h: number): number;
  hd_tri_update(h: number): number;
  hd_tri_skin_changed(h: number): number;
}
