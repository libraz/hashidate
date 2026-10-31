/**
 * Exports of the rig: `Rig`, the members of `rig.anat` and `rig.anat.face` motion uses, the rig's
 * `CharacterFrame`, `ArmTransaction`, and the standalone `reachRef`, `poleAngle`, `solveReach`
 * and `handFrame`. One export per facade method.
 *
 * `h` is a pointer from `hd_rig_new`, `t` one from `hd_rig_new_transaction`. Codes are those of
 * `./profile` (SIDE_*, FINGER order, BONE_* slots, ARM_SLOTS order) plus the ones below; a code
 * out of range traps, as does a face query on a rig without a face (layout FACE 0) and a
 * transaction used with a rig it was not made for. Booleans are u32 0/1, and a tri-state is
 * TRI_FALSE, TRI_TRUE or TRI_UNSET (the TS `undefined`, which defaults as in TS). Every per-call
 * export reads and writes the scene graph the rig was made on, and may climb past the root, so
 * the caller writes the graph's ancestor mirror first, as for `hd_scene_*` updates.
 *
 * ## Construction
 *
 * | export                  | arguments                                   | returns |
 * |-------------------------|---------------------------------------------|---------|
 * | hd_rig_new              | scene graph handle, profile pointer (consumed); registers as the graph's dependent | h |
 * | hd_rig_free             | h; releases the graph unless it was freed first | — |
 * | hd_rig_layout           | h                                           | ptr to LAYOUT u32, valid until free |
 * | hd_rig_scratch          | h                                           | ptr to SCRATCH f64 |
 * | hd_rig_new_transaction  | h, leadFloor; `rig.armTransaction(arm, output, leadFloor)` | t |
 * | hd_rig_free_transaction | t                                           | — |
 * | hd_rig_tx_buffer        | t                                           | ptr to TX_BUFFER f64 |
 *
 * `hd_rig_new` traps on a profile node past the graph's table. Allocating: `hd_rig_new`,
 * `hd_rig_free`, `hd_rig_new_transaction`, `hd_rig_free_transaction`, and
 * `hd_rig_bootstrap_standing_pose` on its first call (once, at Body construction); call them
 * through `allocating`. No other export allocates, so every address below stays put until the free.
 *
 * ## Fields
 *
 * | export                        | arguments after `h` | returns |
 * |-------------------------------|---------------------|---------|
 * | hd_rig_dt                     | —                   | `rig.dt` |
 * | hd_rig_set_dt                 | dt                  | — |
 * | hd_rig_limits_enabled         | —                   | 0/1 |
 * | hd_rig_set_limits_enabled     | on 0/1              | LIMITS_*; LIMITS_NO_FEASIBLE_POSE is the setter's throw, limits left off |
 * | hd_rig_external_arm_revision  | —                   | f64 count |
 *
 * `armSolverOff`, `palmLocal`, `foreRoll`, `upperRoll`, `anat.right/up/fwd/axisO`,
 * `anat.radialSign` and whether `anat.face` exists are in the layout.
 *
 * ## Rig methods
 *
 * Scratch columns name the f64 offset each argument record is read from (in) or written to (out);
 * "in/out" records are read, possibly updated, and written back, so the caller copies its object
 * in before the call and out after it. FingerSpec arguments are 5 f64 in FINGERS order, present
 * where the bits say (bit `i` for finger code `i`).
 *
 * | export                                       | arguments after `h`                         | scratch | returns |
 * |----------------------------------------------|---------------------------------------------|---------|---------|
 * | hd_rig_reset                                 | —                                           | — | — |
 * | hd_rig_add_offset                            | OFFSET_*, x, y, z                           | — | — |
 * | hd_rig_commit_spine                          | —                                           | — | — |
 * | hd_rig_read_head_offset                      | —                                           | out quat in/out 0 | 0/1 |
 * | hd_rig_commit_eyes                           | —                                           | — | — |
 * | hd_rig_plant_legs                            | rise, turn, afterPlant 0/1                  | — | — |
 * | hd_rig_begin_body_arm_frame                  | —                                           | — | 0/1 |
 * | hd_rig_finish_legacy_body_frame              | rise, turn                                  | — | — |
 * | hd_rig_arm_forward_context                   | SIDE_*                                      | CONTEXT out 0 | 0 for null |
 * | hd_rig_arm_forward_context_from_updated_body | SIDE_*                                      | CONTEXT out 0 | 0 for null |
 * | hd_rig_capture_proposed_body_context         | rise, turn                                  | — | — |
 * | hd_rig_apply_body_context                    | alpha, transportProgress, afterPlant 0/1    | — | rise f64 |
 * | hd_rig_stage_arm_forward                     | SIDE_*, curl bits, spread bits              | FORWARD in 0, curls 42, spread 47 | 0/1 |
 * | hd_rig_commit_arm_frame                      | rise, turn, afterPlant 0/1, bits            | SIDE_COMMIT in 0 (L), SIDE_COMMIT (R) | 0/1 |
 * | hd_rig_commit_arm_transport                  | lift, turn, afterPlant 0/1                  | — | 0/1 |
 * | hd_rig_girdle_room                           | SIDE_*, target x, y, z, weight              | dir in 0, turnOut in/out 3 | — |
 * | hd_rig_turn_girdle                           | —                                           | dir in/out 0, turn in 3 | — |
 * | hd_rig_aim_shoulder                          | SIDE_*, has dir 0/1, x, y, z                | — | — |
 * | hd_rig_aim_arm                               | SIDE_*, dir bits, twist, has palm 0/1, palmWeight | dirs in 0 (ARM_SLOTS order, 3 each), palm 12 | 0/1 |
 * | hd_rig_aim_arm_legacy                        | as `hd_rig_aim_arm`                         | as `hd_rig_aim_arm` | — |
 * | hd_rig_measure                               | SIDE_*                                      | — (readings buffer) | 0 for null |
 * | hd_rig_solve_reach_natural                   | SIDE_*, has handDir 0/1, has pole 0/1       | target 0, handDir 3, pole 6, SOLUTION in/out 9 | 0 for null |
 * | hd_rig_solve_point                           | SIDE_*, POINT_* bits, FINGER code or `NO_NODE` | azimuth 0, elevation 1, extent 2, point 3, palm 6, SOLUTION in/out 9 | 0 for null |
 * | hd_rig_solve_reach                           | SIDE_*, elbowAngle, framed TRI_*            | target 0, ReachLinks in/out 3 (upperArm, lowerArm) | 0 for null |
 * | hd_rig_curl_finger                           | FINGER code, SIDE_*, amount                 | — | 0/1 |
 * | hd_rig_curl_hand                             | SIDE_*, spec bits, spread bits              | spec 0, spread 5 | 0/1 |
 * | hd_rig_curl_finger_legacy                    | FINGER code, SIDE_*, amount                 | — | — |
 * | hd_rig_curl_hand_legacy                      | SIDE_*, spec bits, spread bits              | spec 0, spread 5 | — |
 * | hd_rig_finger_clearance                      | SIDE_*                                      | — | f64 |
 * | hd_rig_finger_shape                          | SIDE_*; copies into the side's shape buffer | — | point count |
 * | hd_rig_finger_frame                          | SIDE_*                                      | — | address of a MAT3 |
 * | hd_rig_predict_hand_contact                  | SIDE_*, CONTACT_* kind, region or FINGER code, segment 0/1, SURFACE_*, fraction, curl bits, spread bits | curls 0, spread 5 | 1 when the side's prediction record holds a result, 0 for null |
 * | hd_rig_bootstrap_standing_pose               | bits                                        | STANDING in 0 (L), STANDING (R) | 0/1 |
 * | hd_rig_arm_state_for_body_initialization     | SIDE_*                                      | — | address of the ARM_STATE it returns |
 * | hd_rig_accepted_arm_state                    | SIDE_*                                      | — | address of an ARM_STATE |
 * | hd_rig_arm_driver                            | SIDE_*                                      | — | address of the driver's `acceptedQ` (7 f64), 0 for null |
 * | hd_rig_last_accepted_hand_pose               | SIDE_*                                      | — | address of a HAND_POSE, 0 for null |
 * | hd_rig_finger_axis                           | node                                        | — | address of `fingerAxis.get(node)`, 0 where absent |
 * | hd_rig_finger_splay_axis                     | node                                        | — | address of `fingerSplayAxis.get(node)`, 0 where absent |
 *
 * `bits` for a two-sided record: L's curls in bits 0-4, L's spread in 5-9, R's curls in 10-14, R's
 * spread in 15-19. Dir bits mark the present ARM_SLOTS (bit `i` for slot `i`). Every returned
 * address is the same one on every call for the same side (or node), so a view made from it is the
 * live record; `armStateForBodyInitialization` returns one of two records, the accepted one when
 * the constrained state is authoritative.
 *
 * ## Standalone functions, over the rig's profile, joints and anatomy
 *
 * | export            | arguments                | scratch | returns |
 * |-------------------|--------------------------|---------|---------|
 * | hd_rig_reach_ref  | h, framed TRI_*          | n in 0, perp out 3 | — |
 * | hd_rig_pole_angle | h, SIDE_*                | target in 0, pole in 3, angle out 6 | 0 for null |
 * | hd_rig_hand_frame | ptr to HAND_FRAME f64 (any writable block, e.g. from `hd_alloc`) | point in/out 0, palm in 3, out MAT3 in/out 6 | 0 for null |
 *
 * `solveReach` is `hd_rig_solve_reach`. `solveFingerAxes` is the rig's own table, read through
 * `hd_rig_finger_axis`, `hd_rig_finger_splay_axis` and `palmLocal`.
 *
 * ## Anatomy, face and character frame
 *
 * | export                       | arguments after `h`                           | scratch | returns |
 * |------------------------------|-----------------------------------------------|---------|---------|
 * | hd_rig_anat_update           | —                                             | — | 0/1 |
 * | hd_rig_anat_surface          | —                                             | P in/out 0 | f64 |
 * | hd_rig_face_refresh          | —                                             | — | — |
 * | hd_rig_face_shortfall        | P x, y, z, clear                              | outward in/out 0 | f64 |
 * | hd_rig_face_sample           | P x, y, z                                     | FACE_SAMPLE out 0 | — |
 * | hd_rig_frame_ready           | —                                             | — | 0/1 |
 * | hd_rig_frame_legacy_mirror   | SIDE_*                                        | — | f64 |
 * | hd_rig_frame_axial_mirror    | SIDE_*, frameReady TRI_*                      | — | f64 |
 * | hd_rig_frame_to_world        | SIDE_*, has lateral 0/1, lateral, frameReady TRI_* | value in 0 (a tuple's missing element as 0), out 3 | — |
 * | hd_rig_frame_tuple_to_world  | as `hd_rig_frame_to_world`                    | as `hd_rig_frame_to_world` | — |
 * | hd_rig_frame_to_character    | SIDE_*, frameReady TRI_*                      | value in 0, out 3 | — |
 *
 * ## Arm transaction
 *
 * | export                        | arguments                        | buffer | returns |
 * |-------------------------------|----------------------------------|--------|---------|
 * | hd_rig_tx_begin_frame         | t                                | WORK out | — |
 * | hd_rig_tx_retime              | t, seconds                       | — | — |
 * | hd_rig_tx_reset_route         | t, SIDE_*                        | q in at TX_Q (7 f64) | — |
 * | hd_rig_tx_stage_clasp_leader  | t, h, SIDE_*, dt, frameReady 0/1 | FOLLOWED in, WORK out | — |
 * | hd_rig_tx_commit              | t, h, dt, hipsRise, hipsTurn     | FOLLOWED in, NOTE out ×count at TX_NOTES, WORK out | note count |
 *
 * The caller writes FOLLOWED from Body's followed records before each call that reads it, and
 * replays the notes as `arm.note(side, upperArm, lowerArm, hand)` in order after `commit`.
 *
 * ## Layout (`hd_rig_layout`, one u32 per slot at `LAYOUT_*`)
 *
 * | slot                       | holds |
 * |----------------------------|-------|
 * | SCRATCH                    | address of the scratch |
 * | ANAT_RIGHT/UP/FWD/AXIS_O   | address of a VEC3, refreshed by every call that updates the anatomy |
 * | RADIAL_SIGN                | address of 2 f64, per side |
 * | FORE_ROLL, UPPER_ROLL      | address of 2 f64, per side |
 * | PALM_LOCAL_L/R             | address of a VEC3, 0 for none; fixed at construction |
 * | FINGER_SHAPE_L/R           | address of the shape buffer: VEC3 per point, as `hd_rig_finger_shape` last copied it |
 * | FINGER_SHAPE_CAPACITY_L/R  | points the shape buffer holds |
 * | CONTACT_L/R                | address of the prediction's `contact` VEC3, 0 when the side has no prediction |
 * | BIND_FRAME_L/R             | address of its `bindFrame` MAT3, 0 likewise |
 * | SHAPE_L/R                  | address of its first `shape` point's VEC3, 0 likewise |
 * | SHAPE_COUNT_L/R            | its `shape` point count |
 * | SHAPE_STRIDE               | bytes from one `shape` point's VEC3 to the next |
 * | FACE                       | 1 when `anat.face` exists |
 * | ARM_SOLVER_OFF             | address of SOLVER_OFF u32 records, one per `armSolverOff` line |
 * | ARM_SOLVER_OFF_COUNT       | how many |
 * | READINGS                   | address of READINGS READING records, as `hd_rig_measure` last wrote them |
 *
 * ## Records (f64 unless stated)
 *
 * | record      | length | fields |
 * |-------------|--------|--------|
 * | VEC3        | 3      | x, y, z |
 * | QUAT        | 4      | x, y, z, w |
 * | MAT3        | 9      | `elements` |
 * | ARM_STATE   | 26     | directions (ARM_SLOTS order) 12, palm 3, curls 5, spread 5, forearmRoll |
 * | HAND_POSE   | 15     | knuckle 3, palm 3, forearm 3, index 3, little 3 |
 * | SOLUTION    | 23     | upperArm 3, lowerArm 3, hand 3, palm 3, tip 3, twist, strain present, strain, swivelDir 3, clasp present, clasp 0/1 |
 * | CONTEXT     | 19     | side, shoulder 3, upperLength, lowerLength, up 3, right 3, forward 3, upperParentWorld 4 |
 * | FORWARD     | 42     | u, l, h, palm, elbow, wrist (3 each), upperWorld, lowerWorld, handWorld, upperLocal, lowerLocal, handLocal (4 each) |
 * | SIDE_COMMIT | 78     | output.q 7, output.forward FORWARD, context CONTEXT, curls 5, spread 5 |
 * | STANDING    | 25     | shoulder, upperArm, lowerArm, hand, palm (3 each), curls 5, spread 5 |
 * | READING     | 8      | READING_* id, deg, percent 0/1 (`unit: '%'`), strain, ZONE_*, range lo, range hi, measured 0/1 |
 * | FACE_SAMPLE | 5      | distance, normal 3, valid 0/1 |
 * | HAND_FRAME  | 15     | point 3, palm 3, out 9 |
 * | SOLVER_OFF  | 4 u32  | SIDE_*, OFF_*, REFUSAL_* or `NO_NODE`, CALIBRATION_* or `NO_NODE` |
 * | FOLLOWED    | 54     | armDirs [side][ARM_SLOTS] 24, palmOut [side] 6, palmW.value 2, twist.value 2, fingerSpec [side] 10, fingerSpreadSpec [side] 10 |
 * | NOTE        | 10     | SIDE_*, upperArm 3, lowerArm 3, hand 3 |
 * | WORK        | 8      | plans, validations, repairs, stopTails, holds, solverCalls, solverIterations, environmentBatches |
 *
 * The rig-owned records (VEC3, MAT3, ARM_STATE, HAND_POSE, `acceptedQ`, the roll and sign pairs)
 * are viewed in place and written by the calls that write them in TS, never otherwise; the core
 * asserts their field offsets at compile time. Caller-owned objects cross through the scratch.
 * The caller refreshes its views when `memory.buffer` changes.
 */

import { NO_NODE } from './scene';

export { NO_NODE };

export const SCRATCH = 156;
export const TX_BUFFER = 89;

export const VEC3 = 3;
export const QUAT = 4;
export const MAT3 = 9;
export const ARM_STATE = 26;
export const HAND_POSE = 15;
export const SOLUTION = 23;
export const CONTEXT = 19;
export const FORWARD = 42;
export const SIDE_COMMIT = 78;
export const STANDING = 25;
export const READING = 8;
export const READINGS = 9;
export const FACE_SAMPLE = 5;
export const HAND_FRAME = 15;
export const SOLVER_OFF = 4;
export const FOLLOWED = 54;
export const NOTE = 10;
export const WORK = 8;

/** Offsets within ARM_STATE. */
export const ARM_STATE_DIRECTIONS = 0;
export const ARM_STATE_PALM = 12;
export const ARM_STATE_CURLS = 15;
export const ARM_STATE_SPREAD = 20;
export const ARM_STATE_FOREARM_ROLL = 25;

/** Offsets within the transaction buffer. */
export const TX_FOLLOWED = 0;
export const TX_Q = 54;
export const TX_NOTES = 61;
export const TX_WORK = 81;

/** Offsets within FOLLOWED; per-side runs are L then R. */
export const FOLLOWED_ARM_DIRS = 0;
export const FOLLOWED_PALM_OUT = 24;
export const FOLLOWED_PALM_W = 30;
export const FOLLOWED_TWIST = 32;
export const FOLLOWED_FINGER_SPEC = 34;
export const FOLLOWED_FINGER_SPREAD_SPEC = 44;

/** Offsets in the scratch for the per-call records. */
export const SCRATCH_SOLUTION = 9;
export const SCRATCH_SPREAD = 5;
export const SCRATCH_STAGE_CURLS = 42;
export const SCRATCH_STAGE_SPREAD = 47;

export const LAYOUT_SCRATCH = 0;
export const LAYOUT_ANAT_RIGHT = 1;
export const LAYOUT_ANAT_UP = 2;
export const LAYOUT_ANAT_FWD = 3;
export const LAYOUT_ANAT_AXIS_O = 4;
export const LAYOUT_RADIAL_SIGN = 5;
export const LAYOUT_FORE_ROLL = 6;
export const LAYOUT_UPPER_ROLL = 7;
export const LAYOUT_PALM_LOCAL_L = 8;
export const LAYOUT_PALM_LOCAL_R = 9;
export const LAYOUT_FINGER_SHAPE_L = 10;
export const LAYOUT_FINGER_SHAPE_R = 11;
export const LAYOUT_FINGER_SHAPE_CAPACITY_L = 12;
export const LAYOUT_FINGER_SHAPE_CAPACITY_R = 13;
export const LAYOUT_CONTACT_L = 14;
export const LAYOUT_CONTACT_R = 15;
export const LAYOUT_BIND_FRAME_L = 16;
export const LAYOUT_BIND_FRAME_R = 17;
export const LAYOUT_SHAPE_L = 18;
export const LAYOUT_SHAPE_R = 19;
export const LAYOUT_SHAPE_COUNT_L = 20;
export const LAYOUT_SHAPE_COUNT_R = 21;
export const LAYOUT_SHAPE_STRIDE = 22;
export const LAYOUT_FACE = 23;
export const LAYOUT_ARM_SOLVER_OFF = 24;
export const LAYOUT_ARM_SOLVER_OFF_COUNT = 25;
export const LAYOUT_READINGS = 26;
export const LAYOUT = 27;

export const TRI_FALSE = 0;
export const TRI_TRUE = 1;
export const TRI_UNSET = 2;

/** `OffsetSlot` codes. */
export const OFFSET_HIPS = 0;
export const OFFSET_SPINE = 1;
export const OFFSET_CHEST = 2;
export const OFFSET_NECK = 3;
export const OFFSET_HEAD = 4;
export const OFFSET_EYE_L = 5;
export const OFFSET_EYE_R = 6;
/** The `OffsetSlot` of each offset code. */
export const OFFSET_SLOTS = ['hips', 'spine', 'chest', 'neck', 'head', 'eye.L', 'eye.R'] as const;

/** `PointRequest` fields present, as bits. */
export const POINT_AZIMUTH = 1;
export const POINT_ELEVATION = 2;
export const POINT_EXTENT = 4;
export const POINT_POINT = 8;
export const POINT_PALM = 16;

/** `HandContact` selector codes. */
export const CONTACT_PALM = 0;
export const CONTACT_FINGER = 1;
export const REGION_HEEL = 0;
export const REGION_CENTER = 1;
export const SURFACE_CENTER = 0;
export const SURFACE_PAD = 1;
export const SURFACE_BACK = 2;
export const SURFACE_NONE = 3;

export const LIMITS_OK = 0;
export const LIMITS_NO_FEASIBLE_POSE = 1;

/** Joint reading ids, in the order `report` returns them. */
export const READING_IDS = [
  'elevation',
  'plane',
  'rotation',
  'elbow',
  'forearm',
  'wristFlex',
  'wristDev',
  'torso',
  'inboard',
] as const;
/** `StrainZone` of each zone code. */
export const ZONES = ['natural', 'strained', 'limit'] as const;

/** Why a side's constrained solver is off (`armSolverOff`). */
export const OFF_NO_PALM_FRAME = 0;
export const OFF_REFUSED = 1;
export const OFF_REST_POSE_UNREADABLE = 2;
export const OFF_REST_POSE_OUTSIDE_MODEL = 3;
/** The driver's refusal, with OFF_REFUSED. */
export const REFUSAL_UNRESOLVED = 0;
export const REFUSAL_NOT_CONFORMAL = 1;
export const REFUSAL_NO_PARENT = 2;
export const REFUSAL_CALIBRATION = 3;
export const REFUSAL_HAND_LENGTH = 4;
export const REFUSAL_SWEEP_RESOLUTION = 5;
/** The calibration's refusal, with REFUSAL_CALIBRATION. */
export const CALIBRATION_ZERO_AXIS = 0;
export const CALIBRATION_FRONT_ALONG_AXIS = 1;
export const CALIBRATION_PALM_ALONG_AXIS = 2;
export const CALIBRATION_WRIST_BEYOND_INVERSE = 3;

/** Export names of the rig. */
export const RIG_EXPORTS = [
  'hd_rig_new',
  'hd_rig_free',
  'hd_rig_layout',
  'hd_rig_scratch',
  'hd_rig_new_transaction',
  'hd_rig_free_transaction',
  'hd_rig_tx_buffer',
  'hd_rig_dt',
  'hd_rig_set_dt',
  'hd_rig_limits_enabled',
  'hd_rig_set_limits_enabled',
  'hd_rig_external_arm_revision',
  'hd_rig_reset',
  'hd_rig_add_offset',
  'hd_rig_commit_spine',
  'hd_rig_read_head_offset',
  'hd_rig_commit_eyes',
  'hd_rig_plant_legs',
  'hd_rig_begin_body_arm_frame',
  'hd_rig_finish_legacy_body_frame',
  'hd_rig_arm_forward_context',
  'hd_rig_arm_forward_context_from_updated_body',
  'hd_rig_capture_proposed_body_context',
  'hd_rig_apply_body_context',
  'hd_rig_stage_arm_forward',
  'hd_rig_commit_arm_frame',
  'hd_rig_commit_arm_transport',
  'hd_rig_girdle_room',
  'hd_rig_turn_girdle',
  'hd_rig_aim_shoulder',
  'hd_rig_aim_arm',
  'hd_rig_aim_arm_legacy',
  'hd_rig_measure',
  'hd_rig_solve_reach_natural',
  'hd_rig_solve_point',
  'hd_rig_solve_reach',
  'hd_rig_curl_finger',
  'hd_rig_curl_hand',
  'hd_rig_curl_finger_legacy',
  'hd_rig_curl_hand_legacy',
  'hd_rig_finger_clearance',
  'hd_rig_finger_shape',
  'hd_rig_finger_frame',
  'hd_rig_predict_hand_contact',
  'hd_rig_bootstrap_standing_pose',
  'hd_rig_arm_state_for_body_initialization',
  'hd_rig_accepted_arm_state',
  'hd_rig_arm_driver',
  'hd_rig_last_accepted_hand_pose',
  'hd_rig_finger_axis',
  'hd_rig_finger_splay_axis',
  'hd_rig_reach_ref',
  'hd_rig_pole_angle',
  'hd_rig_hand_frame',
  'hd_rig_anat_update',
  'hd_rig_anat_surface',
  'hd_rig_face_refresh',
  'hd_rig_face_shortfall',
  'hd_rig_face_sample',
  'hd_rig_frame_ready',
  'hd_rig_frame_legacy_mirror',
  'hd_rig_frame_axial_mirror',
  'hd_rig_frame_to_world',
  'hd_rig_frame_tuple_to_world',
  'hd_rig_frame_to_character',
  'hd_rig_tx_begin_frame',
  'hd_rig_tx_retime',
  'hd_rig_tx_reset_route',
  'hd_rig_tx_stage_clasp_leader',
  'hd_rig_tx_commit',
] as const;

export interface RigExports {
  hd_rig_new(scene: number, profile: number): number;
  hd_rig_free(h: number): void;
  hd_rig_layout(h: number): number;
  hd_rig_scratch(h: number): number;
  hd_rig_new_transaction(h: number, leadFloor: number): number;
  hd_rig_free_transaction(t: number): void;
  hd_rig_tx_buffer(t: number): number;
  hd_rig_dt(h: number): number;
  hd_rig_set_dt(h: number, dt: number): void;
  hd_rig_limits_enabled(h: number): number;
  hd_rig_set_limits_enabled(h: number, on: number): number;
  hd_rig_external_arm_revision(h: number): number;
  hd_rig_reset(h: number): void;
  hd_rig_add_offset(h: number, slot: number, x: number, y: number, z: number): void;
  hd_rig_commit_spine(h: number): void;
  hd_rig_read_head_offset(h: number): number;
  hd_rig_commit_eyes(h: number): void;
  hd_rig_plant_legs(h: number, rise: number, turn: number, afterPlant: number): void;
  hd_rig_begin_body_arm_frame(h: number): number;
  hd_rig_finish_legacy_body_frame(h: number, rise: number, turn: number): void;
  hd_rig_arm_forward_context(h: number, side: number): number;
  hd_rig_arm_forward_context_from_updated_body(h: number, side: number): number;
  hd_rig_capture_proposed_body_context(h: number, rise: number, turn: number): void;
  hd_rig_apply_body_context(
    h: number,
    alpha: number,
    transportProgress: number,
    afterPlant: number,
  ): number;
  hd_rig_stage_arm_forward(h: number, side: number, curlBits: number, spreadBits: number): number;
  hd_rig_commit_arm_frame(
    h: number,
    rise: number,
    turn: number,
    afterPlant: number,
    bits: number,
  ): number;
  hd_rig_commit_arm_transport(h: number, lift: number, turn: number, afterPlant: number): number;
  hd_rig_girdle_room(
    h: number,
    side: number,
    x: number,
    y: number,
    z: number,
    weight: number,
  ): void;
  hd_rig_turn_girdle(h: number): void;
  hd_rig_aim_shoulder(
    h: number,
    side: number,
    hasDir: number,
    x: number,
    y: number,
    z: number,
  ): void;
  hd_rig_aim_arm(
    h: number,
    side: number,
    dirBits: number,
    twist: number,
    hasPalm: number,
    palmWeight: number,
  ): number;
  hd_rig_aim_arm_legacy(
    h: number,
    side: number,
    dirBits: number,
    twist: number,
    hasPalm: number,
    palmWeight: number,
  ): void;
  hd_rig_measure(h: number, side: number): number;
  hd_rig_solve_reach_natural(h: number, side: number, hasHandDir: number, hasPole: number): number;
  hd_rig_solve_point(h: number, side: number, bits: number, finger: number): number;
  hd_rig_solve_reach(h: number, side: number, elbowAngle: number, framed: number): number;
  hd_rig_curl_finger(h: number, finger: number, side: number, amount: number): number;
  hd_rig_curl_hand(h: number, side: number, specBits: number, spreadBits: number): number;
  hd_rig_curl_finger_legacy(h: number, finger: number, side: number, amount: number): void;
  hd_rig_curl_hand_legacy(h: number, side: number, specBits: number, spreadBits: number): void;
  hd_rig_finger_clearance(h: number, side: number): number;
  hd_rig_finger_shape(h: number, side: number): number;
  hd_rig_finger_frame(h: number, side: number): number;
  hd_rig_predict_hand_contact(
    h: number,
    side: number,
    kind: number,
    which: number,
    segment: number,
    surface: number,
    fraction: number,
    curlBits: number,
    spreadBits: number,
  ): number;
  hd_rig_bootstrap_standing_pose(h: number, bits: number): number;
  hd_rig_arm_state_for_body_initialization(h: number, side: number): number;
  hd_rig_accepted_arm_state(h: number, side: number): number;
  hd_rig_arm_driver(h: number, side: number): number;
  hd_rig_last_accepted_hand_pose(h: number, side: number): number;
  hd_rig_finger_axis(h: number, node: number): number;
  hd_rig_finger_splay_axis(h: number, node: number): number;
  hd_rig_reach_ref(h: number, framed: number): void;
  hd_rig_pole_angle(h: number, side: number): number;
  hd_rig_hand_frame(buf: number): number;
  hd_rig_anat_update(h: number): number;
  hd_rig_anat_surface(h: number): number;
  hd_rig_face_refresh(h: number): void;
  hd_rig_face_shortfall(h: number, x: number, y: number, z: number, clear: number): number;
  hd_rig_face_sample(h: number, x: number, y: number, z: number): void;
  hd_rig_frame_ready(h: number): number;
  hd_rig_frame_legacy_mirror(h: number, side: number): number;
  hd_rig_frame_axial_mirror(h: number, side: number, ready: number): number;
  hd_rig_frame_to_world(
    h: number,
    side: number,
    hasLateral: number,
    lateral: number,
    ready: number,
  ): void;
  hd_rig_frame_tuple_to_world(
    h: number,
    side: number,
    hasLateral: number,
    lateral: number,
    ready: number,
  ): void;
  hd_rig_frame_to_character(h: number, side: number, ready: number): void;
  hd_rig_tx_begin_frame(t: number): void;
  hd_rig_tx_retime(t: number, seconds: number): void;
  hd_rig_tx_reset_route(t: number, side: number): void;
  hd_rig_tx_stage_clasp_leader(
    t: number,
    h: number,
    side: number,
    dt: number,
    frameReady: number,
  ): void;
  hd_rig_tx_commit(t: number, h: number, dt: number, hipsRise: number, hipsTurn: number): number;
}
