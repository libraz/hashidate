//! A fixed corpus over the math module, reduced to one hash.
//!
//! The native test and the wasm export compare this hash against the same constant, which is what
//! shows the two builds produce identical bits. Inputs come from splitmix64; each output is fed to
//! FNV-1a 64 as little-endian `to_bits()` with every NaN canonicalised.

use super::f::{acos, asin, atan2, cos, hypot3, sin};
use super::{Mat4, Quat, Vec3, Vec4};

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

    h.0
}
