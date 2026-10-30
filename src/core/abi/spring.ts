/**
 * Exports of the spring module: the secondary-motion solver over a node table.
 *
 * `h` is a handle from `hd_spring_new`; every other export takes it first. Indices are u32. A node
 * index is the node's position in the order it was registered: the avatar root's ancestors top
 * down, then the root's subtree in `traverse` order. A group index counts the groups that survived
 * `hd_spring_build`, in order; a group key counts the groups `hd_spring_group_end` kept, in
 * registration order, and is what statuses name. A joint index runs over every group's joints in
 * group order. Out-of-range indices trap.
 *
 * ## Construction
 *
 * | export                            | arguments after `h`                                  | returns |
 * |-----------------------------------|------------------------------------------------------|---------|
 * | hd_spring_new                     | (no `h`) root node index                             | handle |
 * | hd_spring_free                    | —                                                    | — |
 * | hd_spring_scratch                 | —                                                    | ptr to SCRATCH f64 |
 * | hd_spring_node                    | parent (`NO_NODE` for none), FLAG_* bits; reads a NODE_IN record from scratch | — |
 * | hd_spring_collider                | bone, offset xyz, has tail 0/1, tail xyz, radius, inside 0/1 | collider pool index |
 * | hd_spring_group_begin             | stiffness, drag, gravity, gravityDir xyz, radius     | — |
 * | hd_spring_group_root              | node                                                 | — |
 * | hd_spring_group_anchor            | anchor root node                                     | — |
 * | hd_spring_anchor_influence        | bone, weight, position xyz                           | — |
 * | hd_spring_group_end               | —                                                    | joint count; 0 drops the group |
 * | hd_spring_group_collider          | collider pool index (adds to the last kept group)    | — |
 * | hd_spring_build                   | —                                                    | status count |
 * | hd_spring_layout                  | —                                                    | ptr to LAYOUT u32, valid until free |
 * | hd_spring_group_info              | group; writes GROUP_INFO f64 to scratch               | — |
 * | hd_spring_joint_info              | group, joint in group; writes JOINT_INFO f64 to scratch | — |
 * | hd_spring_joint_limits            | group, joint in group                                | ptr to one f32 per collider of the group |
 * | hd_spring_joint_spans             | group, joint in group                                | ptr to one f32 per collider of the group |
 * | hd_spring_enable_drive            | group                                                | DRIVE_* |
 * | hd_spring_drive_pose              | quaternion xyzw (queued for the next calibration)    | — |
 * | hd_spring_calibrate_drive         | group; reads and writes the frame buffers as update does | DRIVE_* |
 *
 * ## Per frame
 *
 * | export                            | arguments after `h`                                  | returns |
 * |-----------------------------------|------------------------------------------------------|---------|
 * | hd_spring_update                  | dt; reads the read records, control and drives, writes every output buffer | status count |
 * | hd_spring_reset                   | —                                                    | — |
 * | hd_spring_acc                     | —                                                    | step accumulator f64 |
 * | hd_spring_collider_place          | collider pool index; places it on its bone's world matrix as last written | — |
 * | hd_spring_collider_nearest        | collider pool index, point xyz                       | distance f64 |
 * | hd_spring_collider_link_distance  | collider pool index, p0 xyz, p1 xyz                  | distance f64 |
 *
 * ## Buffers (`hd_spring_layout`, one u32 per slot at `LAYOUT_*`)
 *
 * | buffer         | element                                                              | stride |
 * |----------------|----------------------------------------------------------------------|--------|
 * | read nodes     | u32 node index, ascending                                            | 1 |
 * | read records   | f64 position 3, quaternion 4, scale 3, pivot 3, matrix 16, matrixWorld 16 | NODE_IN |
 * | read flags     | u32 FLAG_* bits, FLAG_REPARENTED when the parent differs from the registered one | 1 |
 * | write nodes    | u32 node index, u32 WRITE_* mask                                     | 2 |
 * | write records  | f64 position 3, quaternion 4, matrix 16, matrixWorld 16              | NODE_OUT |
 * | write flags    | u32, FLAG_MATRIX_WORLD_NEEDS_UPDATE                                  | 1 |
 * | control        | f64 enabled 0/1, stiffnessScale, inertiaScale, gravityScale, then per group enabled 0/1 | CONTROL_HEAD + groups |
 * | drives         | f64 quaternion xyzw per joint, read for driven joints only           | 4 |
 * | joint states   | f64 cur 3, prev 3, solvedQ 4, prevSolvedQ 4, swing 3                 | JOINT_OUT |
 * | group states   | u32 enabled 0/1, anchor alive 0/1                                    | 2 |
 * | diagnostics    | f64 targetWorld 3, rootWorld 3, error, per group with a live anchor  | DIAGNOSTICS |
 * | collider states| f64 a 3, b 3 per pooled collider, as last placed                     | COLLIDER_OUT |
 * | statuses       | u32 STATUS_* kind, group key, node (`NO_NODE`), other group key (`NO_NODE`) | STATUS |
 *
 * `GROUP_INFO` is key, joint count, clamped drag, normalised gravityDir xyz. `JOINT_INFO` is bone,
 * parent, is root 0/1, length, axis xyz, rest quaternion xyzw.
 *
 * Construction allocates; after `hd_spring_build` nothing does, so the layout's pointers stay put
 * and the memory does not grow. The caller refreshes its views when `memory.buffer` changes.
 */

/** Node index meaning "none". */
export const NO_NODE = 0xffff_ffff;

export const NODE_IN = 45;
export const NODE_OUT = 39;
export const JOINT_OUT = 17;
export const DIAGNOSTICS = 7;
export const COLLIDER_OUT = 6;
export const STATUS = 4;
export const CONTROL_HEAD = 4;
export const SCRATCH = 45;

export const FLAG_BONE = 1;
export const FLAG_MATRIX_AUTO_UPDATE = 2;
export const FLAG_MATRIX_WORLD_AUTO_UPDATE = 4;
export const FLAG_PIVOT = 8;
export const FLAG_MATRIX_WORLD_NEEDS_UPDATE = 16;
export const FLAG_REPARENTED = 32;

export const WRITE_QUATERNION = 1;
export const WRITE_POSITION = 2;

export const LAYOUT_READ_COUNT = 0;
export const LAYOUT_READ_NODES = 1;
export const LAYOUT_READ_RECORDS = 2;
export const LAYOUT_READ_FLAGS = 3;
export const LAYOUT_WRITE_COUNT = 4;
export const LAYOUT_WRITE_NODES = 5;
export const LAYOUT_WRITE_RECORDS = 6;
export const LAYOUT_WRITE_FLAGS = 7;
export const LAYOUT_CONTROL = 8;
export const LAYOUT_DRIVES = 9;
export const LAYOUT_JOINT_STATES = 10;
export const LAYOUT_GROUP_STATES = 11;
export const LAYOUT_DIAGNOSTICS = 12;
export const LAYOUT_COLLIDER_STATES = 13;
export const LAYOUT_STATUSES = 14;
export const LAYOUT_JOINT_COUNT = 15;
export const LAYOUT_GROUP_COUNT = 16;
export const LAYOUT_COLLIDER_COUNT = 17;
export const LAYOUT = 18;

export const DRIVE_NONE = 0;
export const DRIVE_ANCHORED = 1;
export const DRIVE_DONE = 2;

/** Status kinds; the comment is the message, `<node>` a node name, `<other>` a group id. */
export const STATUS_ANCHOR_NOT_AFFINE = 1; // anchor:<node> requires a finite affine local transform
export const STATUS_ANCHOR_SINGULAR = 2; // anchor:<node> has a singular local transform
export const STATUS_ANCHOR_NONUNIFORM = 3; // anchor:<node> does not support nonuniform scale
export const STATUS_ANCHOR_SHEAR = 4; // anchor:<node> does not support shear
export const STATUS_ANCHOR_MODE_CHANGED = 5; // anchor:<node> transform mode changed after resolution
export const STATUS_ANCHOR_SCALE_CHANGED = 6; // anchor:<node> scale changed after resolution
export const STATUS_ANCHOR_PATH_REPARENTED = 7; // anchor path was reparented at <node>
export const STATUS_ANCHOR_PATH_ROOT_REPARENTED = 8; // anchor path root was reparented at <node>
export const STATUS_ANCHOR_WORLD_OVERRIDE = 9; // anchor:<node> has a manual matrixWorld override
export const STATUS_ANCHOR_ROOT_REPARENTED = 10; // anchor root was reparented at <node>
export const STATUS_ANCHOR_SUBTREE_REPARENTED = 11; // anchor subtree was reparented at <node>
export const STATUS_ANCHOR_PARENT_SINGULAR = 12; // anchor parent world is singular
export const STATUS_ANCESTOR_SIMULATED = 20; // root ancestor is simulated by another group: <node>
export const STATUS_SUBTREE_SIMULATED = 21; // root subtree is simulated by another group: <node>
export const STATUS_SOURCE_DEPENDS = 22; // source <node> depends on group <other> at or after this group

/** Export names of the spring module. */
export const SPRING_EXPORTS = [
  'hd_spring_new',
  'hd_spring_free',
  'hd_spring_scratch',
  'hd_spring_node',
  'hd_spring_collider',
  'hd_spring_group_begin',
  'hd_spring_group_root',
  'hd_spring_group_anchor',
  'hd_spring_anchor_influence',
  'hd_spring_group_end',
  'hd_spring_group_collider',
  'hd_spring_build',
  'hd_spring_layout',
  'hd_spring_group_info',
  'hd_spring_joint_info',
  'hd_spring_joint_limits',
  'hd_spring_joint_spans',
  'hd_spring_enable_drive',
  'hd_spring_drive_pose',
  'hd_spring_calibrate_drive',
  'hd_spring_update',
  'hd_spring_reset',
  'hd_spring_acc',
  'hd_spring_collider_place',
  'hd_spring_collider_nearest',
  'hd_spring_collider_link_distance',
] as const;

export interface SpringExports {
  hd_spring_new(root: number): number;
  hd_spring_free(h: number): void;
  hd_spring_scratch(h: number): number;
  hd_spring_node(h: number, parent: number, flags: number): void;
  hd_spring_collider(
    h: number,
    bone: number,
    ox: number,
    oy: number,
    oz: number,
    hasTail: number,
    tx: number,
    ty: number,
    tz: number,
    radius: number,
    inside: number,
  ): number;
  hd_spring_group_begin(
    h: number,
    stiffness: number,
    drag: number,
    gravity: number,
    gx: number,
    gy: number,
    gz: number,
    radius: number,
  ): void;
  hd_spring_group_root(h: number, node: number): void;
  hd_spring_group_anchor(h: number, root: number): void;
  hd_spring_anchor_influence(
    h: number,
    bone: number,
    weight: number,
    px: number,
    py: number,
    pz: number,
  ): void;
  hd_spring_group_end(h: number): number;
  hd_spring_group_collider(h: number, collider: number): void;
  hd_spring_build(h: number): number;
  hd_spring_layout(h: number): number;
  hd_spring_group_info(h: number, group: number): void;
  hd_spring_joint_info(h: number, group: number, joint: number): void;
  hd_spring_joint_limits(h: number, group: number, joint: number): number;
  hd_spring_joint_spans(h: number, group: number, joint: number): number;
  hd_spring_enable_drive(h: number, group: number): number;
  hd_spring_drive_pose(h: number, x: number, y: number, z: number, w: number): void;
  hd_spring_calibrate_drive(h: number, group: number): number;
  hd_spring_update(h: number, dt: number): number;
  hd_spring_reset(h: number): void;
  hd_spring_acc(h: number): number;
  hd_spring_collider_place(h: number, collider: number): void;
  hd_spring_collider_nearest(h: number, collider: number, x: number, y: number, z: number): number;
  hd_spring_collider_link_distance(
    h: number,
    collider: number,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
  ): number;
}
