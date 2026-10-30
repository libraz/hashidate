//! A fixed corpus over the math module, reduced to one hash.
//!
//! The native test and the wasm export compare this hash against the same constant, which is what
//! shows the two builds produce identical bits. Inputs come from splitmix64; each output is fed to
//! FNV-1a 64 as little-endian `to_bits()` with every NaN canonicalised.

use super::f::{
    acos, asin, atan2, cbrt, cos, exp, expm1, hypot, hypot3, js_round, js_sign, log, sin, tanh,
};
use super::{Mat3, Mat4, Quat, Vec3, Vec4, lerp};

const SEED: u64 = 0x6861_7368_6964_6174;
const COUNT: usize = 20_000;
const CANONICAL_NAN: u64 = 0x7ff8_0000_0000_0000;

fn specials() -> [f64; 12] {
    let near = 0.9995f64.to_bits();
    [
        0.0,
        -0.0,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NAN,
        f64::from_bits(1),
        1.0,
        -1.0,
        std::f64::consts::PI,
        f64::from_bits(near - 1),
        0.9995,
        f64::from_bits(near + 1),
    ]
}

struct SplitMix64(u64);

impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// Uniform in `[0, 1)`.
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    /// Uniform in `[-8, 8)`.
    fn wide(&mut self) -> f64 {
        self.unit() * 16.0 - 8.0
    }

    /// Uniform in `[-1, 1)`.
    fn narrow(&mut self) -> f64 {
        self.unit() * 2.0 - 1.0
    }

    fn array<const N: usize>(&mut self) -> [f64; N] {
        std::array::from_fn(|_| self.wide())
    }

    fn vec3(&mut self) -> Vec3 {
        let [x, y, z] = self.array();
        Vec3::new(x, y, z)
    }

    fn quat(&mut self) -> Quat {
        let [x, y, z, w] = self.array();
        Quat::new(x, y, z, w)
    }

    fn mat4(&mut self) -> Mat4 {
        Mat4::from_elements(self.array())
    }
}

struct Fnv(u64);

impl Fnv {
    fn feed(&mut self, value: f64) {
        let bits = if value.is_nan() {
            CANONICAL_NAN
        } else {
            value.to_bits()
        };
        for byte in bits.to_le_bytes() {
            self.0 ^= u64::from(byte);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }

    fn feed_all(&mut self, values: &[f64]) {
        for &value in values {
            self.feed(value);
        }
    }

    fn vec3(&mut self, v: &Vec3) {
        self.feed_all(&[v.x, v.y, v.z]);
    }

    fn quat(&mut self, q: &Quat) {
        self.feed_all(&[q.x, q.y, q.z, q.w]);
    }
}

/// Every special value broadcast to all components, then `COUNT` items from `draw`.
fn cases<T>(
    rng: &mut SplitMix64,
    broadcast: impl Fn(f64) -> T,
    mut draw: impl FnMut(&mut SplitMix64, usize) -> T,
) -> Vec<T> {
    let mut out: Vec<T> = specials().into_iter().map(broadcast).collect();
    out.extend((0..COUNT).map(|i| draw(rng, i)));
    out
}

fn unit_quat(rng: &mut SplitMix64) -> Quat {
    *rng.quat().normalize()
}

/// The corpus hash. Identical natively and in wasm, or one of the builds is wrong.
pub fn corpus_hash() -> u64 {
    let mut rng = SplitMix64(SEED);
    let mut h = Fnv(0xcbf2_9ce4_8422_2325);
    let s = specials();

    for f in [sin, cos] {
        h.feed_all(&s.map(f));
        for _ in 0..COUNT {
            h.feed(f(rng.wide()));
        }
    }
    for f in [acos, asin] {
        h.feed_all(&s.map(f));
        for _ in 0..COUNT {
            h.feed(f(rng.narrow()));
        }
    }

    for &y in &s {
        for &x in &s {
            h.feed(atan2(y, x));
        }
    }
    for _ in 0..COUNT {
        let [y, x] = rng.array();
        h.feed(atan2(y, x));
    }

    for &a in &s {
        for &b in &s {
            for &c in &s {
                h.feed(hypot3(a, b, c));
            }
        }
    }
    for _ in 0..COUNT {
        let [a, b, c] = rng.array();
        h.feed(hypot3(a, b, c));
    }

    for (a, b) in cases(
        &mut rng,
        |v| (Mat4::from_elements([v; 16]), Mat4::from_elements([v; 16])),
        |r, _| (r.mat4(), r.mat4()),
    ) {
        h.feed_all(&Mat4::default().multiply_matrices(&a, &b).elements);
    }

    for (p, q, sc) in cases(
        &mut rng,
        |v| {
            (
                Vec3::new(v, v, v),
                Quat::new(v, v, v, v),
                Vec3::new(v, v, v),
            )
        },
        |r, i| {
            let q = if i % 2 == 0 { r.quat() } else { unit_quat(r) };
            (r.vec3(), q, r.vec3())
        },
    ) {
        h.feed_all(&Mat4::default().compose(&p, &q, &sc).elements);
    }

    for m in cases(
        &mut rng,
        |v| Mat4::from_elements([v; 16]),
        |r, i| {
            if i % 2 == 0 {
                r.mat4()
            } else {
                let (p, q, sc) = (r.vec3(), unit_quat(r), r.vec3());
                *Mat4::default().compose(&p, &q, &sc)
            }
        },
    ) {
        let (mut p, mut q, mut sc) = (Vec3::default(), Quat::default(), Vec3::default());
        m.decompose(&mut p, &mut q, &mut sc);
        h.vec3(&p);
        h.quat(&q);
        h.vec3(&sc);
    }

    for (mut v, m) in cases(
        &mut rng,
        |v| (Vec3::new(v, v, v), Mat4::from_elements([v; 16])),
        |r, _| (r.vec3(), r.mat4()),
    ) {
        h.vec3(v.apply_matrix4(&m));
    }

    for (mut v, m) in cases(
        &mut rng,
        |v| (Vec4::new(v, v, v, v), Mat4::from_elements([v; 16])),
        |r, _| {
            let [x, y, z, w] = r.array();
            (Vec4::new(x, y, z, w), r.mat4())
        },
    ) {
        let out = *v.apply_matrix4(&m);
        h.feed_all(&[out.x, out.y, out.z, out.w]);
    }

    for (mut v, q) in cases(
        &mut rng,
        |v| (Vec3::new(v, v, v), Quat::new(v, v, v, v)),
        |r, _| (r.vec3(), unit_quat(r)),
    ) {
        h.vec3(v.apply_quaternion(&q));
    }

    for (a, b, t) in cases(
        &mut rng,
        |v| (Quat::new(v, v, v, v), Quat::new(v, v, v, v), v),
        |r, i| {
            let a = unit_quat(r);
            let b = if i % 2 == 0 {
                unit_quat(r)
            } else {
                let d = r.quat();
                *Quat::new(
                    a.x + d.x * 1e-3,
                    a.y + d.y * 1e-3,
                    a.z + d.z * 1e-3,
                    a.w + d.w * 1e-3,
                )
                .normalize()
            };
            (a, b, r.unit())
        },
    ) {
        h.quat(Quat::default().slerp_quaternions(&a, &b, t));
    }

    for (from, to) in cases(
        &mut rng,
        |v| (Vec3::new(v, v, v), Vec3::new(v, v, v)),
        |r, i| {
            let from = *r.vec3().normalize();
            let to = if i % 2 == 0 {
                *r.vec3().normalize()
            } else {
                let d = r.vec3();
                *Vec3::new(
                    -from.x + d.x * 1e-9,
                    -from.y + d.y * 1e-9,
                    -from.z + d.z * 1e-9,
                )
                .normalize()
            };
            (from, to)
        },
    ) {
        h.quat(Quat::default().set_from_unit_vectors(&from, &to));
    }

    for m in cases(
        &mut rng,
        |v| Mat4::from_elements([v; 16]),
        |r, i| {
            if i % 2 == 0 {
                r.mat4()
            } else {
                let q = unit_quat(r);
                *Mat4::default().compose(&Vec3::default(), &q, &Vec3::new(1.0, 1.0, 1.0))
            }
        },
    ) {
        h.quat(Quat::default().set_from_rotation_matrix(&m));
    }

    for f in [tanh, expm1, exp, log, cbrt] {
        h.feed_all(&s.map(f));
        for _ in 0..COUNT {
            h.feed(f(rng.wide()));
        }
    }

    for &a in &s {
        for &b in &s {
            h.feed(hypot(&[a, b]));
        }
    }
    for _ in 0..COUNT {
        let [a, b] = rng.array();
        h.feed(hypot(&[a, b]));
    }

    // Halves and quarters put the rounding ties in the draw.
    for f in [js_round, js_sign] {
        h.feed_all(&s.map(f));
        for k in 0..COUNT {
            let x = rng.wide();
            h.feed(f(x));
            if k % 4 == 0 {
                h.feed(f((x * 4.0).floor() / 4.0));
                h.feed(f(-0.5 + (k % 3) as f64));
            }
        }
    }

    for (a, b, t) in cases(
        &mut rng,
        |v| (v, v, v),
        |r, _| (r.wide(), r.wide(), r.unit()),
    ) {
        h.feed(lerp(a, b, t));
    }

    for m in cases(
        &mut rng,
        |v| Mat4::from_elements([v; 16]),
        |r, i| {
            if i % 2 == 0 {
                r.mat4()
            } else {
                let (p, q, sc) = (r.vec3(), unit_quat(r), r.vec3());
                *Mat4::default().compose(&p, &q, &sc)
            }
        },
    ) {
        let mut linear = Mat3::default();
        linear.set_from_matrix4(&m);
        h.feed(linear.determinant());
        let mut inverse = linear;
        inverse.invert();
        h.feed_all(&inverse.elements);
        h.feed_all(&inverse.transpose().elements);
    }

    for (mut v, m) in cases(
        &mut rng,
        |v| (Vec3::new(v, v, v), Mat3::from_elements([v; 9])),
        |r, _| (r.vec3(), Mat3::from_elements(r.array())),
    ) {
        h.vec3(v.apply_matrix3(&m));
    }

    for (mut v, m) in cases(
        &mut rng,
        |v| (Vec3::new(v, v, v), Mat4::from_elements([v; 16])),
        |r, _| (r.vec3(), r.mat4()),
    ) {
        h.vec3(v.transform_direction(&m));
    }

    for (mut v, axis, angle) in cases(
        &mut rng,
        |v| (Vec3::new(v, v, v), Vec3::new(v, v, v), v),
        |r, _| (r.vec3(), *r.vec3().normalize(), r.wide()),
    ) {
        h.vec3(v.apply_axis_angle(&axis, angle));
    }

    for (a, b) in cases(
        &mut rng,
        |v| (Vec3::new(v, v, v), Vec3::new(v, v, v)),
        |r, i| {
            let a = r.vec3();
            // Parallel and opposite pairs reach the clamp in angleTo.
            let b = match i % 4 {
                1 => a,
                2 => *Vec3::new(-a.x, -a.y, -a.z).multiply_scalar(2.0),
                _ => r.vec3(),
            };
            (a, b)
        },
    ) {
        h.vec3(Vec3::default().cross_vectors(&a, &b));
        h.vec3(Vec3::default().copy(&a).lerp(&b, 0.375));
        h.feed(a.angle_to(&b));
    }

    for (a, b) in cases(
        &mut rng,
        |v| (Quat::new(v, v, v, v), Quat::new(v, v, v, v)),
        |r, i| {
            let a = unit_quat(r);
            (a, if i % 3 == 0 { a } else { unit_quat(r) })
        },
    ) {
        h.feed(a.angle_to(&b));
    }

    for (x, y, z) in cases(
        &mut rng,
        |v| (v, v, v),
        |r, _| (r.wide(), r.wide(), r.wide()),
    ) {
        h.quat(Quat::default().set_from_euler_xyz(x, y, z));
    }

    for theta in cases(&mut rng, |v| v, |r, _| r.wide()) {
        h.feed_all(&Mat4::default().make_rotation_y(theta).elements);
    }
    for (x, y, z) in cases(
        &mut rng,
        |v| (v, v, v),
        |r, _| (r.wide(), r.wide(), r.wide()),
    ) {
        h.feed_all(&Mat4::default().make_translation(x, y, z).elements);
    }

    h.0
}
