/**
 * Exports of the math module.
 *
 * Scalar exports take and return f64, except `hd_math_rig_constant(index: u32)`: 0 `SWIVEL_RATE`,
 * 1 `CBRT_EPSILON`, 2 `EPSILON_2_3`. `hd_math_corpus_hash` returns a u64, which JS receives as a
 * `bigint`.
 *
 * Every batch export is `(input: ptr, count: u32, output: ptr) => void`, where `input` holds
 * `count` items of IN f64 and `output` receives `count` items of OUT f64, both from `hd_alloc`
 * and not overlapping. Each item applies one three r186 operation; `v3` is x y z, `v4` and `q` are
 * x y z w, `m3` and `m4` are the 9 and 16 column-major `elements`, `s` and `t` are scalars. A
 * receiver (`this`) comes first in the input; operations that write a fresh target start from its
 * three default.
 *
 * | export                                    | input (IN)                  | output (OUT)          |
 * |-------------------------------------------|-----------------------------|-----------------------|
 * | hd_math_vector3_add                        | this v3, v v3 (6)           | v3 (3)                |
 * | hd_math_vector3_sub                        | this v3, v v3 (6)           | v3 (3)                |
 * | hd_math_vector3_add_vectors                | a v3, b v3 (6)              | v3 (3)                |
 * | hd_math_vector3_sub_vectors                | a v3, b v3 (6)              | v3 (3)                |
 * | hd_math_vector3_add_scaled_vector          | this v3, v v3, s (7)        | v3 (3)                |
 * | hd_math_vector3_multiply_scalar            | this v3, s (4)              | v3 (3)                |
 * | hd_math_vector3_divide_scalar              | this v3, s (4)              | v3 (3)                |
 * | hd_math_vector3_normalize                  | this v3 (3)                 | v3 (3)                |
 * | hd_math_vector3_negate                     | this v3 (3)                 | v3 (3)                |
 * | hd_math_vector3_length                     | this v3 (3)                 | length (1)            |
 * | hd_math_vector3_length_sq                  | this v3 (3)                 | length squared (1)    |
 * | hd_math_vector3_dot                        | this v3, v v3 (6)           | dot (1)               |
 * | hd_math_vector3_cross_vectors              | a v3, b v3 (6)              | v3 (3)                |
 * | hd_math_vector3_distance_to                | this v3, v v3 (6)           | distance (1)          |
 * | hd_math_vector3_distance_to_squared        | this v3, v v3 (6)           | distance squared (1)  |
 * | hd_math_vector3_lerp_vectors               | v1 v3, v2 v3, t (7)         | v3 (3)                |
 * | hd_math_vector3_apply_quaternion           | this v3, q (7)              | v3 (3)                |
 * | hd_math_vector3_apply_matrix4              | this v3, m4 (19)            | v3 (3)                |
 * | hd_math_vector3_cross                      | this v3, v v3 (6)           | v3 (3)                |
 * | hd_math_vector3_lerp                       | this v3, v v3, alpha (7)    | v3 (3)                |
 * | hd_math_vector3_angle_to                   | this v3, v v3 (6)           | angle (1)             |
 * | hd_math_vector3_equals                     | this v3, v v3 (6)           | 1 if equal else 0 (1) |
 * | hd_math_vector3_apply_axis_angle           | this v3, axis v3, angle (7) | v3 (3)                |
 * | hd_math_vector3_apply_matrix3              | this v3, m3 (12)            | v3 (3)                |
 * | hd_math_vector3_transform_direction        | this v3, m4 (19)            | v3 (3)                |
 * | hd_math_vector3_set_from_matrix_position   | m4 (16)                     | v3 (3)                |
 * | hd_math_vector3_set_from_matrix_column     | m4, column 0-3 (17)         | v3 (3)                |
 * | hd_math_vector3_min                        | this v3, v v3 (6)           | v3 (3)                |
 * | hd_math_vector3_max                        | this v3, v v3 (6)           | v3 (3)                |
 * | hd_math_vector4_get_component              | this v4, index 0-3 (5)      | component (1)         |
 * | hd_math_vector4_add_scaled_vector          | this v4, v v4, s (9)        | v4 (4)                |
 * | hd_math_vector4_apply_matrix4              | this v4, m4 (20)            | v4 (4)                |
 * | hd_math_quaternion_multiply                | this q, q (8)               | q (4)                 |
 * | hd_math_quaternion_premultiply             | this q, q (8)               | q (4)                 |
 * | hd_math_quaternion_multiply_quaternions    | a q, b q (8)                | q (4)                 |
 * | hd_math_quaternion_invert                  | this q (4)                  | q (4)                 |
 * | hd_math_quaternion_normalize               | this q (4)                  | q (4)                 |
 * | hd_math_quaternion_length                  | this q (4)                  | length (1)            |
 * | hd_math_quaternion_dot                     | this q, v q (8)             | dot (1)               |
 * | hd_math_quaternion_angle_to                | this q, q (8)               | angle (1)             |
 * | hd_math_quaternion_equals                  | this q, q (8)               | 1 if equal else 0 (1) |
 * | hd_math_quaternion_set_from_euler          | x y z, order XYZ (3)        | q (4)                 |
 * | hd_math_quaternion_set_from_axis_angle     | axis v3, angle (4)          | q (4)                 |
 * | hd_math_quaternion_set_from_unit_vectors   | from v3, to v3 (6)          | q (4)                 |
 * | hd_math_quaternion_set_from_rotation_matrix| m4 (16)                     | q (4)                 |
 * | hd_math_quaternion_slerp                   | this q, qb q, t (9)         | q (4)                 |
 * | hd_math_quaternion_slerp_quaternions       | qa q, qb q, t (9)           | q (4)                 |
 * | hd_math_matrix4_multiply                   | this m4, m m4 (32)          | m4 (16)               |
 * | hd_math_matrix4_premultiply                | this m4, m m4 (32)          | m4 (16)               |
 * | hd_math_matrix4_multiply_matrices          | a m4, b m4 (32)             | m4 (16)               |
 * | hd_math_matrix4_make_translation           | x y z (3)                   | m4 (16)               |
 * | hd_math_matrix4_make_rotation_y            | theta (1)                   | m4 (16)               |
 * | hd_math_matrix4_extract_rotation           | m m4 (16)                   | m4 (16)               |
 * | hd_math_matrix4_compose                    | position v3, q, scale v3 (10)| m4 (16)              |
 * | hd_math_matrix4_decompose                  | this m4 (16)                | position v3, q, scale v3 (10) |
 * | hd_math_matrix4_determinant                | this m4 (16)                | determinant (1)       |
 * | hd_math_matrix4_determinant_affine         | this m4 (16)                | determinant (1)       |
 * | hd_math_matrix4_invert                     | this m4 (16)                | m4 (16)               |
 * | hd_math_matrix3_set_from_matrix4           | m4 (16)                     | m3 (9)                |
 * | hd_math_matrix3_determinant                | this m3 (9)                 | determinant (1)       |
 * | hd_math_matrix3_invert                     | this m3 (9)                 | m3 (9)                |
 * | hd_math_matrix3_transpose                  | this m3 (9)                 | m3 (9)                |
 * | hd_math_object3d_update_matrix             | position v3, q, scale v3, pivot v3, has pivot 0/1 (14) | matrix m4 (16) |
 * | hd_math_clamp                              | value, min, max (3)         | clamped (1)           |
 * | hd_math_lerp                               | x, y, t (3)                 | lerped (1)            |
 * | hd_math_js_round                           | x (1)                       | rounded (1)           |
 * | hd_math_js_sign                            | x (1)                       | sign (1)              |
 * | hd_math_js_min                             | a, b (2)                    | min (1)               |
 * | hd_math_js_max                             | a, b (2)                    | max (1)               |
 * | hd_math_box3_set_from_points               | 4 points v3 (12)            | getSize v3, min v3, max v3 (9) |
 */

/** Per-item f64 counts of every batch export, `[input, output]`. */
export const MATH_BATCHES = {
  hd_math_vector3_add: [6, 3],
  hd_math_vector3_sub: [6, 3],
  hd_math_vector3_add_vectors: [6, 3],
  hd_math_vector3_sub_vectors: [6, 3],
  hd_math_vector3_add_scaled_vector: [7, 3],
  hd_math_vector3_multiply_scalar: [4, 3],
  hd_math_vector3_divide_scalar: [4, 3],
  hd_math_vector3_normalize: [3, 3],
  hd_math_vector3_negate: [3, 3],
  hd_math_vector3_length: [3, 1],
  hd_math_vector3_length_sq: [3, 1],
  hd_math_vector3_dot: [6, 1],
  hd_math_vector3_cross_vectors: [6, 3],
  hd_math_vector3_distance_to: [6, 1],
  hd_math_vector3_distance_to_squared: [6, 1],
  hd_math_vector3_lerp_vectors: [7, 3],
  hd_math_vector3_apply_quaternion: [7, 3],
  hd_math_vector3_apply_matrix4: [19, 3],
  hd_math_vector3_cross: [6, 3],
  hd_math_vector3_lerp: [7, 3],
  hd_math_vector3_angle_to: [6, 1],
  hd_math_vector3_equals: [6, 1],
  hd_math_vector3_apply_axis_angle: [7, 3],
  hd_math_vector3_apply_matrix3: [12, 3],
  hd_math_vector3_transform_direction: [19, 3],
  hd_math_vector3_set_from_matrix_position: [16, 3],
  hd_math_vector3_set_from_matrix_column: [17, 3],
  hd_math_vector3_min: [6, 3],
  hd_math_vector3_max: [6, 3],
  hd_math_vector4_get_component: [5, 1],
  hd_math_vector4_add_scaled_vector: [9, 4],
  hd_math_vector4_apply_matrix4: [20, 4],
  hd_math_quaternion_multiply: [8, 4],
  hd_math_quaternion_premultiply: [8, 4],
  hd_math_quaternion_multiply_quaternions: [8, 4],
  hd_math_quaternion_invert: [4, 4],
  hd_math_quaternion_normalize: [4, 4],
  hd_math_quaternion_length: [4, 1],
  hd_math_quaternion_dot: [8, 1],
  hd_math_quaternion_set_from_axis_angle: [4, 4],
  hd_math_quaternion_set_from_unit_vectors: [6, 4],
  hd_math_quaternion_set_from_rotation_matrix: [16, 4],
  hd_math_quaternion_angle_to: [8, 1],
  hd_math_quaternion_equals: [8, 1],
  hd_math_quaternion_set_from_euler: [3, 4],
  hd_math_quaternion_slerp: [9, 4],
  hd_math_quaternion_slerp_quaternions: [9, 4],
  hd_math_matrix4_multiply: [32, 16],
  hd_math_matrix4_premultiply: [32, 16],
  hd_math_matrix4_multiply_matrices: [32, 16],
  hd_math_matrix4_extract_rotation: [16, 16],
  hd_math_matrix4_compose: [10, 16],
  hd_math_matrix4_decompose: [16, 10],
  hd_math_matrix4_determinant: [16, 1],
  hd_math_matrix4_determinant_affine: [16, 1],
  hd_math_matrix4_invert: [16, 16],
  hd_math_matrix4_make_translation: [3, 16],
  hd_math_matrix4_make_rotation_y: [1, 16],
  hd_math_matrix3_set_from_matrix4: [16, 9],
  hd_math_matrix3_determinant: [9, 1],
  hd_math_matrix3_invert: [9, 9],
  hd_math_matrix3_transpose: [9, 9],
  hd_math_object3d_update_matrix: [14, 16],
  hd_math_clamp: [3, 1],
  hd_math_lerp: [3, 1],
  hd_math_js_round: [1, 1],
  hd_math_js_sign: [1, 1],
  hd_math_js_min: [2, 1],
  hd_math_js_max: [2, 1],
  hd_math_box3_set_from_points: [12, 9],
} as const satisfies Record<string, readonly [number, number]>;

export type MathBatchName = keyof typeof MATH_BATCHES;

const SCALAR_EXPORTS = [
  'hd_math_sin',
  'hd_math_cos',
  'hd_math_acos',
  'hd_math_asin',
  'hd_math_atan2',
  'hd_math_tanh',
  'hd_math_expm1',
  'hd_math_exp',
  'hd_math_log',
  'hd_math_cbrt',
  'hd_math_hypot2',
  'hd_math_hypot3',
  'hd_math_rig_constant',
  'hd_math_corpus_hash',
] as const;

/** Export names of the math module. */
export const MATH_EXPORTS = [
  ...SCALAR_EXPORTS,
  ...(Object.keys(MATH_BATCHES) as MathBatchName[]),
] as const;

export type MathExports = {
  hd_math_sin(x: number): number;
  hd_math_cos(x: number): number;
  hd_math_acos(x: number): number;
  hd_math_asin(x: number): number;
  hd_math_atan2(y: number, x: number): number;
  hd_math_tanh(x: number): number;
  hd_math_expm1(x: number): number;
  hd_math_exp(x: number): number;
  hd_math_log(x: number): number;
  hd_math_cbrt(x: number): number;
  hd_math_hypot2(a: number, b: number): number;
  hd_math_hypot3(a: number, b: number, c: number): number;
  hd_math_rig_constant(index: number): number;
  hd_math_corpus_hash(): bigint;
} & {
  [K in MathBatchName]: (input: number, count: number, output: number) => void;
};
