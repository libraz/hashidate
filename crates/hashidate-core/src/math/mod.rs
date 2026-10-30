//! three.js r186 math, ported operation for operation so results match it bit for bit.
//!
//! Each function keeps three's evaluation order, its reciprocal-then-multiply normalisation and
//! its branch thresholds. Transcendentals go through [`f`], never through `f64` methods, so the
//! same inputs give the same bits natively and in wasm.

pub mod bounds;
pub mod corpus;
pub mod f;
pub mod mat3;
pub mod mat4;
pub mod object3d;
pub mod quat;
pub mod vec3;
pub mod vec4;

pub use bounds::Box3;
pub use mat3::Mat3;
pub use mat4::Mat4;
pub use quat::Quat;
pub use vec3::Vec3;
pub use vec4::Vec4;

// three r186 MathUtils.clamp
pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    f::js_max(min, f::js_min(max, value))
}

// three r186 MathUtils.lerp
pub fn lerp(x: f64, y: f64, t: f64) -> f64 {
    (1.0 - t) * x + t * y
}
