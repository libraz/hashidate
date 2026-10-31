/**
 * Exports of the scene graph: an avatar root's subtree, owned by the core and viewed in place.
 *
 * `h` is a handle from `hd_scene_new`: an opaque non-zero u32 (slot in the low 16 bits, generation
 * above). Freeing advances the slot's generation, so a stale handle traps in every export. Node
 * indices are three's `traverse` order from the root (node 0); a node's subtree is the run of
 * indices after it. Booleans are u32 0/1. An index out of range, a parent off the traverse path, a
 * count over what `hd_scene_new` sized for, a registration after `hd_scene_build` or an update
 * before it traps. The layout is valid from `hd_scene_new` on, so scratch can be written before
 * the first registration.
 *
 * ## Construction
 *
 * | export               | arguments after `h`                                              | returns |
 * |----------------------|------------------------------------------------------------------|---------|
 * | hd_scene_new         | (no `h`) nodes, meshes, skeletons, bone slots over all skeletons | handle |
 * | hd_scene_layout      | —                                                                | ptr to LAYOUT u32 buffer addresses, valid until free |
 * | hd_scene_node        | parent (`NO_NODE` for node 0 only), FLAG_* bits; reads a NODE record from scratch | node index |
 * | hd_scene_mesh        | node (flagged FLAG_SKINNED); reads a MESH record from scratch     | mesh index |
 * | hd_scene_skeleton    | — (opens the next skeleton)                                      | skeleton index |
 * | hd_scene_bone        | node, `NO_NODE` where `bones[i]` is absent or outside the table; reads a BONE record from scratch | slot within the skeleton |
 * | hd_scene_build       | — (every node, mesh, skeleton and bone sized for registered)      | — |
 * | hd_scene_free        | — ; traps while a dependent handle (spring, triangles, rig) made on it is alive | — |
 * | hd_scene_free_orphan | — ; frees whatever depends on it, for the finaliser                | — |
 *
 * Nodes are registered in order, then each SkinnedMesh once, then each skeleton followed by its
 * bones. Every node flagged FLAG_SKINNED must be registered as a mesh. Values are stored as given,
 * with no update: -0, NaN and ±Inf included.
 *
 * ## Per call
 *
 * | export                       | arguments after `h`                                | does |
 * |------------------------------|----------------------------------------------------|------|
 * | hd_scene_plain_children      | node, on 0/1                                       | sets or clears FLAG_PLAIN_CHILDREN (and resets the node's force byte when clearing) |
 * | hd_scene_ancestors           | count, 0..MAX_ANCESTORS                            | sets how many ancestor records the mirror holds |
 * | hd_scene_update_matrix       | node                                               | three r186 `updateMatrix` |
 * | hd_scene_update_matrix_world | node, force 0/1                                    | `updateMatrixWorld(force)`, with the `SkinnedMesh` override on skinned nodes |
 * | hd_scene_update_world_matrix | node, updateParents 0/1, updateChildren 0/1, force 0/1 | `updateWorldMatrix(updateParents, updateChildren, force)`; climbs into the ancestor mirror past the root |
 * | hd_scene_skeleton_update     | skeleton                                           | `Skeleton.update` into the bone matrices buffer |
 * | hd_scene_take_needs_changed  | —                                                  | reduces the needs-changed list (below); returns the count of nodes to assign |
 *
 * Only `hd_scene_take_needs_changed` returns a value. They allocate nothing.
 *
 * ## Buffers (`hd_scene_layout`, one byte address per slot at `LAYOUT_*`)
 *
 * | buffer              | element                                                        | stride |
 * |---------------------|----------------------------------------------------------------|--------|
 * | position            | f64 xyz per node                                               | 3 |
 * | quaternion          | f64 xyzw per node                                              | 4 |
 * | scale               | f64 xyz per node                                               | 3 |
 * | pivot               | f64 xyz per node, read only with FLAG_PIVOT                    | 3 |
 * | matrix              | f64 `elements` per node                                        | 16 |
 * | matrixWorld         | f64 `elements` per node                                        | 16 |
 * | flags               | u8 FLAG_* bits per node                                        | 1 |
 * | force               | u8 FORCE_* per node, written only for nodes with FLAG_PLAIN_CHILDREN | 1 |
 * | parent              | u32 parent per node, `NO_NODE` for node 0                      | 1 |
 * | child offsets       | u32 start of each node's run in children, then one past the last (nodes + 1) | 1 |
 * | children            | u32 table children of every node in `children` order (nodes - 1); filled by build | 1 |
 * | mesh nodes          | u32 node per mesh                                              | 1 |
 * | bindMatrix          | f64 `elements` per mesh                                        | 16 |
 * | bindMatrixInverse   | f64 `elements` per mesh                                        | 16 |
 * | skeleton offsets    | u32 first bone slot of each skeleton, then the slot count (skeletons + 1) | 1 |
 * | bone nodes          | u32 node per bone slot, `NO_NODE` for a missing bone           | 1 |
 * | boneInverses        | f64 `elements` per bone slot                                   | 16 |
 * | bone matrices       | f32 per bone slot, `matrixWorld × boneInverse` as `boneMatrices` holds it | 16 |
 * | ancestors           | f64 ANCESTOR record per level, the root's parent first, MAX_ANCESTORS levels | ANCESTOR |
 * | ancestor flags      | u8 FLAG_MATRIX_AUTO_UPDATE, _WORLD_AUTO_UPDATE, _WORLD_NEEDS_UPDATE, FLAG_PIVOT per level | 1 |
 * | scratch             | f64, SCRATCH long; the record the next registration reads      | — |
 * | needs changed       | u32 count, then that many node indices (nodes + 1 long)         | 1 |
 *
 * Records: NODE and ANCESTOR are position 3, quaternion 4, scale 3, pivot 3, matrix 16,
 * matrixWorld 16 (offsets `RECORD_*`). MESH is bindMatrix 16 then bindMatrixInverse 16. BONE is
 * boneInverse 16.
 *
 * Flags: FLAG_BONE and FLAG_SKINNED are fixed at registration; FLAG_PLAIN_CHILDREN changes only
 * through `hd_scene_plain_children`. The rest may be written in the flags byte at any time, keeping
 * the other bits.
 *
 * Needs changed: the caller holds each node's matrixWorldNeedsUpdate as it last saw it, starting
 * from the registered flags. Every export that writes a node's FLAG_MATRIX_WORLD_NEEDS_UPDATE to a
 * new value lists the node once, raising the count. When the count is not 0,
 * `hd_scene_take_needs_changed` keeps only the nodes whose bit now differs from what the caller
 * saw, writes them after the count's slot, sets the count to 0 and returns how many it kept; the
 * caller then assigns those nodes' value from the flags byte. A write the caller makes to the
 * flags byte itself is not listed.
 *
 * Ancestors: before any per-call export the caller writes the chain above the root (records,
 * flags, `hd_scene_ancestors` when its length changes); with none the root takes three's
 * `parent === null` branch. Only the climb of `updateWorldMatrix(true, …)` updates the mirror, by
 * three's rule; afterwards the caller writes each level's matrix, matrixWorld and
 * matrixWorldNeedsUpdate back. `updateMatrixWorld` reads level 0's matrixWorld as it stands.
 *
 * bindMatrixInverse is rebuilt only on the `updateMatrixWorld` path, after the node's children,
 * from matrixWorld (attached) or bindMatrix (FLAG_DETACHED), as `SkinnedMesh` does.
 *
 * Force byte: `hd_scene_update_matrix_world` and `hd_scene_update_world_matrix` first set every
 * node with FLAG_PLAIN_CHILDREN to FORCE_UNVISITED, then write FORCE_FALSE or FORCE_TRUE for each
 * such node whose children the pass iterated, by the `force` handed to them. The caller then calls
 * three's `updateMatrixWorld(force)` (or `updateWorldMatrix(false, true, force)` after the second
 * export) on the plain children of every node whose byte is not FORCE_UNVISITED, in `children`
 * order. `hd_scene_update_matrix` and `hd_scene_skeleton_update` leave the bytes alone.
 *
 * `hd_scene_new` allocates every buffer and `hd_scene_build` a scratch table it frees; nothing
 * else allocates, so the addresses stay put. The caller refreshes its views when `memory.buffer`
 * changes.
 */

/** Node index meaning "none". */
export const NO_NODE = 0xffff_ffff;

export const FLAG_MATRIX_AUTO_UPDATE = 1;
export const FLAG_MATRIX_WORLD_AUTO_UPDATE = 2;
export const FLAG_MATRIX_WORLD_NEEDS_UPDATE = 4;
export const FLAG_PIVOT = 8;
export const FLAG_BONE = 16;
export const FLAG_SKINNED = 32;
export const FLAG_DETACHED = 64;
export const FLAG_PLAIN_CHILDREN = 128;

export const FORCE_UNVISITED = 0;
export const FORCE_FALSE = 1;
export const FORCE_TRUE = 2;

export const NODE = 45;
export const ANCESTOR = 45;
export const MESH = 32;
export const BONE = 16;
export const SCRATCH = 45;
export const MAX_ANCESTORS = 16;

export const RECORD_POSITION = 0;
export const RECORD_QUATERNION = 3;
export const RECORD_SCALE = 7;
export const RECORD_PIVOT = 10;
export const RECORD_MATRIX = 13;
export const RECORD_MATRIX_WORLD = 29;
export const MESH_BIND = 0;
export const MESH_BIND_INVERSE = 16;

export const LAYOUT_POSITION = 0;
export const LAYOUT_QUATERNION = 1;
export const LAYOUT_SCALE = 2;
export const LAYOUT_PIVOT = 3;
export const LAYOUT_MATRIX = 4;
export const LAYOUT_MATRIX_WORLD = 5;
export const LAYOUT_FLAGS = 6;
export const LAYOUT_FORCE = 7;
export const LAYOUT_PARENT = 8;
export const LAYOUT_CHILD_OFFSETS = 9;
export const LAYOUT_CHILDREN = 10;
export const LAYOUT_MESH_NODES = 11;
export const LAYOUT_BIND_MATRIX = 12;
export const LAYOUT_BIND_MATRIX_INVERSE = 13;
export const LAYOUT_SKELETON_OFFSETS = 14;
export const LAYOUT_BONE_NODES = 15;
export const LAYOUT_BONE_INVERSES = 16;
export const LAYOUT_BONE_MATRICES = 17;
export const LAYOUT_ANCESTORS = 18;
export const LAYOUT_ANCESTOR_FLAGS = 19;
export const LAYOUT_SCRATCH = 20;
export const LAYOUT_NEEDS_CHANGED = 21;
export const LAYOUT = 22;

/** Export names of the scene graph. */
export const SCENE_EXPORTS = [
  'hd_scene_new',
  'hd_scene_free',
  'hd_scene_free_orphan',
  'hd_scene_layout',
  'hd_scene_node',
  'hd_scene_mesh',
  'hd_scene_skeleton',
  'hd_scene_bone',
  'hd_scene_build',
  'hd_scene_plain_children',
  'hd_scene_ancestors',
  'hd_scene_update_matrix',
  'hd_scene_update_matrix_world',
  'hd_scene_update_world_matrix',
  'hd_scene_skeleton_update',
  'hd_scene_take_needs_changed',
] as const;

export interface SceneExports {
  hd_scene_new(nodes: number, meshes: number, skeletons: number, bones: number): number;
  hd_scene_free(h: number): void;
  hd_scene_free_orphan(h: number): void;
  hd_scene_layout(h: number): number;
  hd_scene_node(h: number, parent: number, flags: number): number;
  hd_scene_mesh(h: number, node: number): number;
  hd_scene_skeleton(h: number): number;
  hd_scene_bone(h: number, node: number): number;
  hd_scene_build(h: number): void;
  hd_scene_plain_children(h: number, node: number, on: number): void;
  hd_scene_ancestors(h: number, count: number): void;
  hd_scene_update_matrix(h: number, node: number): void;
  hd_scene_update_matrix_world(h: number, node: number, force: number): void;
  hd_scene_update_world_matrix(
    h: number,
    node: number,
    updateParents: number,
    updateChildren: number,
    force: number,
  ): void;
  hd_scene_skeleton_update(h: number, skeleton: number): void;
  hd_scene_take_needs_changed(h: number): number;
}
