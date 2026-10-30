//! Exports for the math module.
//!
//! The scalar exports are the transcendentals the engine runs on. The batch exports apply one
//! three.js operation to `count` packed items so the parity test can compare them against three;
//! the per-item layouts are tabled in `src/core/abi/math.ts`.

use hashidate_core::math::{Box3, Mat4, Quat, Vec3, Vec4, clamp, corpus, f, object3d};

/// `sin`, fixed across hosts.
#[unsafe(no_mangle)]
pub extern "C" fn hd_math_sin(x: f64) -> f64 {
    f::sin(x)
}

/// `cos`, fixed across hosts.
#[unsafe(no_mangle)]
pub extern "C" fn hd_math_cos(x: f64) -> f64 {
    f::cos(x)
}

/// `acos`, fixed across hosts.
#[unsafe(no_mangle)]
pub extern "C" fn hd_math_acos(x: f64) -> f64 {
    f::acos(x)
}

/// `asin`, fixed across hosts.
#[unsafe(no_mangle)]
pub extern "C" fn hd_math_asin(x: f64) -> f64 {
    f::asin(x)
}

/// `atan2(y, x)`, fixed across hosts.
#[unsafe(no_mangle)]
pub extern "C" fn hd_math_atan2(y: f64, x: f64) -> f64 {
    f::atan2(y, x)
}

/// `Math.hypot(a, b, c)` as V8 computes it.
#[unsafe(no_mangle)]
pub extern "C" fn hd_math_hypot3(a: f64, b: f64, c: f64) -> f64 {
    f::hypot3(a, b, c)
}

/// The math corpus hash; equal to the native build's or one of them is wrong.
#[unsafe(no_mangle)]
pub extern "C" fn hd_math_corpus_hash() -> u64 {
    corpus::corpus_hash()
}

fn v3(s: &[f64]) -> Vec3 {
    Vec3::new(s[0], s[1], s[2])
}

fn v4(s: &[f64]) -> Vec4 {
    Vec4::new(s[0], s[1], s[2], s[3])
}

fn q(s: &[f64]) -> Quat {
    Quat::new(s[0], s[1], s[2], s[3])
}

fn m4(s: &[f64]) -> Mat4 {
    let mut elements = [0.0; 16];
    elements.copy_from_slice(&s[..16]);
    Mat4::from_elements(elements)
}

fn put_v3(o: &mut [f64], v: &Vec3) {
    o[..3].copy_from_slice(&[v.x, v.y, v.z]);
}

fn put_v4(o: &mut [f64], v: &Vec4) {
    o[..4].copy_from_slice(&[v.x, v.y, v.z, v.w]);
}

fn put_q(o: &mut [f64], q: &Quat) {
    o[..4].copy_from_slice(&[q.x, q.y, q.z, q.w]);
}

fn put_m4(o: &mut [f64], m: &Mat4) {
    o[..16].copy_from_slice(&m.elements);
}

/// Declares `count`-item batch exports: `$input` f64 in and `$output` f64 out per item.
macro_rules! batch {
    ($($name:ident: $input:literal => $output:literal, |$i:ident, $o:ident| $body:expr;)*) => {$(
        /// Applies one operation to `count` packed items; layout in `src/core/abi/math.ts`.
        ///
        /// # Safety
        /// `input` must point to `count * IN` readable f64 and `output` to `count * OUT`
        /// writable f64, both 8-aligned, non-null and not overlapping.
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(input: *const f64, count: usize, output: *mut f64) {
            // SAFETY: the caller guarantees `count * IN` readable, aligned f64 at `input`.
            let input = unsafe { std::slice::from_raw_parts(input, count * $input) };
            // SAFETY: the caller guarantees `count * OUT` writable, aligned f64 at `output`
            // that do not overlap `input`.
            let output = unsafe { std::slice::from_raw_parts_mut(output, count * $output) };
            for ($i, $o) in input.chunks_exact($input).zip(output.chunks_exact_mut($output)) {
                $body;
            }
        }
    )*};
}

batch! {
    hd_math_vector3_add: 6 => 3, |i, o| put_v3(o, v3(i).add(&v3(&i[3..])));
    hd_math_vector3_sub: 6 => 3, |i, o| put_v3(o, v3(i).sub(&v3(&i[3..])));
    hd_math_vector3_add_vectors: 6 => 3,
        |i, o| put_v3(o, Vec3::default().add_vectors(&v3(i), &v3(&i[3..])));
    hd_math_vector3_sub_vectors: 6 => 3,
        |i, o| put_v3(o, Vec3::default().sub_vectors(&v3(i), &v3(&i[3..])));
    hd_math_vector3_add_scaled_vector: 7 => 3,
        |i, o| put_v3(o, v3(i).add_scaled_vector(&v3(&i[3..]), i[6]));
    hd_math_vector3_multiply_scalar: 4 => 3, |i, o| put_v3(o, v3(i).multiply_scalar(i[3]));
    hd_math_vector3_divide_scalar: 4 => 3, |i, o| put_v3(o, v3(i).divide_scalar(i[3]));
    hd_math_vector3_normalize: 3 => 3, |i, o| put_v3(o, v3(i).normalize());
    hd_math_vector3_negate: 3 => 3, |i, o| put_v3(o, v3(i).negate());
    hd_math_vector3_length: 3 => 1, |i, o| o[0] = v3(i).length();
    hd_math_vector3_length_sq: 3 => 1, |i, o| o[0] = v3(i).length_sq();
    hd_math_vector3_dot: 6 => 1, |i, o| o[0] = v3(i).dot(&v3(&i[3..]));
    hd_math_vector3_cross_vectors: 6 => 3,
        |i, o| put_v3(o, Vec3::default().cross_vectors(&v3(i), &v3(&i[3..])));
    hd_math_vector3_distance_to: 6 => 1, |i, o| o[0] = v3(i).distance_to(&v3(&i[3..]));
    hd_math_vector3_distance_to_squared: 6 => 1,
        |i, o| o[0] = v3(i).distance_to_squared(&v3(&i[3..]));
    hd_math_vector3_lerp_vectors: 7 => 3,
        |i, o| put_v3(o, Vec3::default().lerp_vectors(&v3(i), &v3(&i[3..]), i[6]));
    hd_math_vector3_apply_quaternion: 7 => 3, |i, o| put_v3(o, v3(i).apply_quaternion(&q(&i[3..])));
    hd_math_vector3_apply_matrix4: 19 => 3, |i, o| put_v3(o, v3(i).apply_matrix4(&m4(&i[3..])));
    hd_math_vector3_set_from_matrix_position: 16 => 3,
        |i, o| put_v3(o, Vec3::default().set_from_matrix_position(&m4(i)));
    hd_math_vector3_set_from_matrix_column: 17 => 3,
        |i, o| put_v3(o, Vec3::default().set_from_matrix_column(&m4(i), i[16] as usize));
    hd_math_vector3_min: 6 => 3, |i, o| put_v3(o, v3(i).min(&v3(&i[3..])));
    hd_math_vector3_max: 6 => 3, |i, o| put_v3(o, v3(i).max(&v3(&i[3..])));

    hd_math_vector4_get_component: 5 => 1, |i, o| o[0] = v4(i).get_component(i[4] as usize);
    hd_math_vector4_add_scaled_vector: 9 => 4,
        |i, o| put_v4(o, v4(i).add_scaled_vector(&v4(&i[4..]), i[8]));
    hd_math_vector4_apply_matrix4: 20 => 4, |i, o| put_v4(o, v4(i).apply_matrix4(&m4(&i[4..])));

    hd_math_quaternion_multiply: 8 => 4, |i, o| put_q(o, q(i).multiply(&q(&i[4..])));
    hd_math_quaternion_premultiply: 8 => 4, |i, o| put_q(o, q(i).premultiply(&q(&i[4..])));
    hd_math_quaternion_multiply_quaternions: 8 => 4,
        |i, o| put_q(o, Quat::default().multiply_quaternions(&q(i), &q(&i[4..])));
    hd_math_quaternion_invert: 4 => 4, |i, o| put_q(o, q(i).invert());
    hd_math_quaternion_normalize: 4 => 4, |i, o| put_q(o, q(i).normalize());
    hd_math_quaternion_length: 4 => 1, |i, o| o[0] = q(i).length();
    hd_math_quaternion_dot: 8 => 1, |i, o| o[0] = q(i).dot(&q(&i[4..]));
    hd_math_quaternion_set_from_axis_angle: 4 => 4,
        |i, o| put_q(o, Quat::default().set_from_axis_angle(&v3(i), i[3]));
    hd_math_quaternion_set_from_unit_vectors: 6 => 4,
        |i, o| put_q(o, Quat::default().set_from_unit_vectors(&v3(i), &v3(&i[3..])));
    hd_math_quaternion_set_from_rotation_matrix: 16 => 4,
        |i, o| put_q(o, Quat::default().set_from_rotation_matrix(&m4(i)));
    hd_math_quaternion_slerp: 9 => 4, |i, o| put_q(o, q(i).slerp(&q(&i[4..]), i[8]));
    hd_math_quaternion_slerp_quaternions: 9 => 4,
        |i, o| put_q(o, Quat::default().slerp_quaternions(&q(i), &q(&i[4..]), i[8]));

    hd_math_matrix4_multiply: 32 => 16, |i, o| put_m4(o, m4(i).multiply(&m4(&i[16..])));
    hd_math_matrix4_premultiply: 32 => 16, |i, o| put_m4(o, m4(i).premultiply(&m4(&i[16..])));
    hd_math_matrix4_multiply_matrices: 32 => 16,
        |i, o| put_m4(o, Mat4::default().multiply_matrices(&m4(i), &m4(&i[16..])));
    hd_math_matrix4_extract_rotation: 16 => 16,
        |i, o| put_m4(o, Mat4::default().extract_rotation(&m4(i)));
    hd_math_matrix4_compose: 10 => 16,
        |i, o| put_m4(o, Mat4::default().compose(&v3(i), &q(&i[3..]), &v3(&i[7..])));
    hd_math_matrix4_decompose: 16 => 10, |i, o| {
        let (mut p, mut r, mut s) = (Vec3::default(), Quat::default(), Vec3::default());
        m4(i).decompose(&mut p, &mut r, &mut s);
        put_v3(o, &p);
        put_q(&mut o[3..], &r);
        put_v3(&mut o[7..], &s);
    };
    hd_math_matrix4_determinant: 16 => 1, |i, o| o[0] = m4(i).determinant();
    hd_math_matrix4_determinant_affine: 16 => 1, |i, o| o[0] = m4(i).determinant_affine();
    hd_math_matrix4_invert: 16 => 16, |i, o| put_m4(o, m4(i).invert());

    hd_math_object3d_update_matrix: 14 => 16, |i, o| {
        let mut m = Mat4::default();
        let pivot = v3(&i[10..]);
        let pivot = if i[13] != 0.0 { Some(&pivot) } else { None };
        object3d::update_matrix(&mut m, &v3(i), &q(&i[3..]), &v3(&i[7..]), pivot);
        put_m4(o, &m);
    };
    hd_math_clamp: 3 => 1, |i, o| o[0] = clamp(i[0], i[1], i[2]);
    hd_math_box3_set_from_points: 12 => 9, |i, o| {
        let points = [v3(i), v3(&i[3..]), v3(&i[6..]), v3(&i[9..])];
        let mut b = Box3::default();
        b.set_from_points(&points);
        let mut size = Vec3::default();
        b.get_size(&mut size);
        put_v3(o, &size);
        put_v3(&mut o[3..], &b.min);
        put_v3(&mut o[6..], &b.max);
    };
}
