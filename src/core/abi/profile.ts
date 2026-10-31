/**
 * Exports that assemble the numeric profile a rig is made from: `Profile` without its three
 * objects, labels and routing, plus what construction measured off the mesh.
 *
 * `p` is a pointer from `hd_profile_new`. Every node is the bone's index in the scene graph the
 * rig will be made on (`SceneGraph.indexOf`), `NO_NODE` where the slot is unresolved or the bone is
 * outside the table. Codes are tabled below; a code out of range, a finger bone index past the
 * chain `hd_profile_finger` sized, or a call that needs an earlier one (FACE before
 * `hd_profile_face`, a joint before `hd_profile_anatomy`) traps. Values are stored as given: -0,
 * NaN and ±Inf included. Booleans are u32 0/1. Nothing is validated against the graph until
 * `hd_rig_new`, which traps on a node past the table and consumes the profile.
 *
 * | export                  | arguments after `p`                                        | returns |
 * |-------------------------|------------------------------------------------------------|---------|
 * | hd_profile_new          | (no `p`)                                                   | pointer; every slot `NO_NODE`, `sideSign` 1 |
 * | hd_profile_free         | — ; only for a profile never handed to `hd_rig_new`        | — |
 * | hd_profile_scratch      | —                                                          | ptr to SCRATCH f64 |
 * | hd_profile_bone         | BONE_* slot, node                                          | — |
 * | hd_profile_rest_dir     | BONE_* slot, x, y, z (`restDir[slot]`)                     | — |
 * | hd_profile_finger       | SIDE_*, FINGER_*, chain length; sizes the chain to `NO_NODE`s | — |
 * | hd_profile_finger_bone  | SIDE_*, FINGER_*, i, node, rest x, y, z (`fingerBones[f.s][i]`, `restDir[f.s.i]`) | — |
 * | hd_profile_side_sign    | value                                                      | — |
 * | hd_profile_limb         | SIDE_*, LIMB_* key, value (absent keys are never set)      | — |
 * | hd_profile_face         | has mouth 0/1; reads FACE from scratch                     | — |
 * | hd_profile_body         | has span 0/1; reads BODY from scratch                      | — |
 * | hd_profile_anatomy      | elevation row count; opens the override as the human table with no rows | — |
 * | hd_profile_joint        | JOINT_* dof, present 0/1, free lo, free hi, max lo, max hi (radians) | — |
 * | hd_profile_elevation    | plane, free, max (degrees); appends a row, at most the count opened | — |
 * | hd_profile_arm_twist    | ARM_TWIST_* slot, primary, next, helper nodes              | — |
 * | hd_profile_arm_rest     | ARM_* slot, x, y, z (`avatar.armRest`)                     | — |
 * | hd_profile_volume       | PART_*, measured 0/1, cells, bands, sectors, top, bottom, radius | ptr to `cells` f32 (`r`, band-major) to fill; null unmeasured |
 * | hd_profile_face_skin    | vertex count                                               | ptr to 3 f32 per vertex (`pos`) to fill |
 * | hd_profile_face_normals | — ; after `hd_profile_face_skin`                           | ptr to 3 f32 per vertex (`nrm`) to fill |
 *
 * Absent values are simply not set: a slot never given a node stays `NO_NODE`, a bone with no
 * `restDir` stays without one, `face`, `body`, `anatomy`, a twist, an `armRest` link and a
 * volume stay absent. `hd_profile_joint` with present 0 leaves a finger or thumb segment out of the
 * override and traps on any other dof; every dof of the override starts at the human table, so
 * the caller sets each one the avatar's table gives. A volume or the skin set twice replaces the
 * first. The pointers `hd_profile_volume`, `hd_profile_face_skin` and `hd_profile_face_normals`
 * return stay valid until the rig made from the profile is freed; fill them before `hd_rig_new`.
 *
 * Allocating: `hd_profile_new`, `hd_profile_finger`, `hd_profile_anatomy`, `hd_profile_volume`,
 * `hd_profile_face_skin`, `hd_profile_free`. Call them through `allocating`.
 *
 * ## Scratch records
 *
 * | record | f64 | fields |
 * |--------|-----|--------|
 * | FACE   | 16  | origin 3, right 3, up 3, forward 3, ipd, mouth 3 (head-local) |
 * | BODY   | 10  | right 3, up 3, forward 3, span (chest-local) |
 */

export const SCRATCH = 16;
export const FACE = 16;
export const BODY = 10;

/** Bone slots, in `BoneSlot` order. */
export const BONE_HIPS = 0;
export const BONE_SPINE = 1;
export const BONE_CHEST = 2;
export const BONE_NECK = 3;
export const BONE_HEAD = 4;
export const BONE_EYE_L = 5;
export const BONE_EYE_R = 6;
export const BONE_SHOULDER_L = 7;
export const BONE_SHOULDER_R = 8;
export const BONE_UPPER_ARM_L = 9;
export const BONE_UPPER_ARM_R = 10;
export const BONE_LOWER_ARM_L = 11;
export const BONE_LOWER_ARM_R = 12;
export const BONE_HAND_L = 13;
export const BONE_HAND_R = 14;
export const BONE_UPPER_LEG_L = 15;
export const BONE_UPPER_LEG_R = 16;
export const BONE_LOWER_LEG_L = 17;
export const BONE_LOWER_LEG_R = 18;
export const BONE_FOOT_L = 19;
export const BONE_FOOT_R = 20;
export const BONE_TOE_L = 21;
export const BONE_TOE_R = 22;

/** The `profile.bones` key of each bone slot code. */
export const BONE_SLOTS = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'eye.L',
  'eye.R',
  'shoulder.L',
  'shoulder.R',
  'upperArm.L',
  'upperArm.R',
  'lowerArm.L',
  'lowerArm.R',
  'hand.L',
  'hand.R',
  'upperLeg.L',
  'upperLeg.R',
  'lowerLeg.L',
  'lowerLeg.R',
  'foot.L',
  'foot.R',
  'toe.L',
  'toe.R',
] as const;

export const SIDE_L = 0;
export const SIDE_R = 1;
/** The `Side` of each side code. */
export const SIDES = ['L', 'R'] as const;

/** The `FingerName` of each finger code, thumb first. */
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'] as const;

/** Arm links, in `ArmSlot` order: `armRest` and the dirs of `aimArm`. */
export const ARM_SLOTS = ['shoulder', 'upperArm', 'lowerArm', 'hand'] as const;

/** Arm twist slots: the `profile.armTwists` key of each code. */
export const ARM_TWIST_SLOTS = ['upperArm.L', 'upperArm.R', 'lowerArm.L', 'lowerArm.R'] as const;

/** `limb` keys per side; `LIMB_TIP + finger code` is `tip.<side>.<finger>`. */
export const LIMB_UPPER = 0;
export const LIMB_LOWER = 1;
export const LIMB_THIGH = 2;
export const LIMB_SHIN = 3;
export const LIMB_PITCH = 4;
export const LIMB_PROXIMAL = 5;
export const LIMB_TIP = 6;

/** Degrees of freedom of the joint-table override; the segments 5-10 may be absent. */
export const JOINT_SHOULDER_ROTATION = 0;
export const JOINT_ELBOW_FLEXION = 1;
export const JOINT_ELBOW_ROTATION = 2;
export const JOINT_WRIST_FLEXION = 3;
export const JOINT_WRIST_DEVIATION = 4;
export const JOINT_FINGER_PROXIMAL = 5;
export const JOINT_FINGER_INTERMEDIATE = 6;
export const JOINT_FINGER_DISTAL = 7;
export const JOINT_THUMB_PROXIMAL = 8;
export const JOINT_THUMB_INTERMEDIATE = 9;
export const JOINT_THUMB_DISTAL = 10;
export const JOINT_NECK_PITCH = 11;
export const JOINT_NECK_YAW = 12;
export const JOINT_NECK_ROLL = 13;
export const JOINT_SPINE_PITCH = 14;
export const JOINT_SPINE_YAW = 15;
export const JOINT_SPINE_ROLL = 16;

/** `[joint, dof]` of each joint code, as `JointTable` names them. */
export const JOINT_DOFS = [
  ['shoulder', 'rotation'],
  ['elbow', 'flexion'],
  ['elbow', 'rotation'],
  ['wrist', 'flexion'],
  ['wrist', 'deviation'],
  ['finger', 'proximal'],
  ['finger', 'intermediate'],
  ['finger', 'distal'],
  ['thumb', 'proximal'],
  ['thumb', 'intermediate'],
  ['thumb', 'distal'],
  ['neck', 'pitch'],
  ['neck', 'yaw'],
  ['neck', 'roll'],
  ['spine', 'pitch'],
  ['spine', 'yaw'],
  ['spine', 'roll'],
] as const;

/** Measured volumes. */
export const PART_TORSO = 0;
export const PART_HEAD = 1;

/** Export names of the profile builder. */
export const PROFILE_EXPORTS = [
  'hd_profile_new',
  'hd_profile_free',
  'hd_profile_scratch',
  'hd_profile_bone',
  'hd_profile_rest_dir',
  'hd_profile_finger',
  'hd_profile_finger_bone',
  'hd_profile_side_sign',
  'hd_profile_limb',
  'hd_profile_face',
  'hd_profile_body',
  'hd_profile_anatomy',
  'hd_profile_joint',
  'hd_profile_elevation',
  'hd_profile_arm_twist',
  'hd_profile_arm_rest',
  'hd_profile_volume',
  'hd_profile_face_skin',
  'hd_profile_face_normals',
] as const;

export interface ProfileExports {
  hd_profile_new(): number;
  hd_profile_free(p: number): void;
  hd_profile_scratch(p: number): number;
  hd_profile_bone(p: number, slot: number, node: number): void;
  hd_profile_rest_dir(p: number, slot: number, x: number, y: number, z: number): void;
  hd_profile_finger(p: number, side: number, finger: number, len: number): void;
  hd_profile_finger_bone(
    p: number,
    side: number,
    finger: number,
    i: number,
    node: number,
    x: number,
    y: number,
    z: number,
  ): void;
  hd_profile_side_sign(p: number, value: number): void;
  hd_profile_limb(p: number, side: number, key: number, value: number): void;
  hd_profile_face(p: number, hasMouth: number): void;
  hd_profile_body(p: number, hasSpan: number): void;
  hd_profile_anatomy(p: number, rows: number): void;
  hd_profile_joint(
    p: number,
    dof: number,
    present: number,
    freeLo: number,
    freeHi: number,
    maxLo: number,
    maxHi: number,
  ): void;
  hd_profile_elevation(p: number, plane: number, free: number, max: number): void;
  hd_profile_arm_twist(
    p: number,
    slot: number,
    primary: number,
    next: number,
    helper: number,
  ): void;
  hd_profile_arm_rest(p: number, slot: number, x: number, y: number, z: number): void;
  hd_profile_volume(
    p: number,
    part: number,
    measured: number,
    cells: number,
    bands: number,
    sectors: number,
    top: number,
    bottom: number,
    radius: number,
  ): number;
  hd_profile_face_skin(p: number, vertices: number): number;
  hd_profile_face_normals(p: number): number;
}
