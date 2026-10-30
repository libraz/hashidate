//! `THREE.Vector3`.

use super::f::{js_max, js_min, sqrt};
use super::mat4::Mat4;
use super::quat::Quat;

/// A three-component vector; the default is the origin, as in three.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    /// The vector `(x, y, z)`.
    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    // three r186 Vector3.set
    pub fn set(&mut self, x: f64, y: f64, z: f64) -> &mut Self {
        self.x = x;
        self.y = y;
        self.z = z;
        self
    }

    // three r186 Vector3.copy
    pub fn copy(&mut self, v: &Vec3) -> &mut Self {
        self.x = v.x;
        self.y = v.y;
        self.z = v.z;
        self
    }

    // three r186 Vector3.fromArray
    pub fn from_array(&mut self, array: &[f64], offset: usize) -> &mut Self {
        self.x = array[offset];
        self.y = array[offset + 1];
        self.z = array[offset + 2];
        self
    }

    // three r186 Vector3.add
    pub fn add(&mut self, v: &Vec3) -> &mut Self {
        self.x += v.x;
        self.y += v.y;
        self.z += v.z;
        self
    }

    // three r186 Vector3.sub
    pub fn sub(&mut self, v: &Vec3) -> &mut Self {
        self.x -= v.x;
        self.y -= v.y;
        self.z -= v.z;
        self
    }

    // three r186 Vector3.addVectors
    pub fn add_vectors(&mut self, a: &Vec3, b: &Vec3) -> &mut Self {
        self.x = a.x + b.x;
        self.y = a.y + b.y;
        self.z = a.z + b.z;
        self
    }

    // three r186 Vector3.subVectors
    pub fn sub_vectors(&mut self, a: &Vec3, b: &Vec3) -> &mut Self {
        self.x = a.x - b.x;
        self.y = a.y - b.y;
        self.z = a.z - b.z;
        self
    }

    // three r186 Vector3.addScaledVector
    pub fn add_scaled_vector(&mut self, v: &Vec3, s: f64) -> &mut Self {
        self.x += v.x * s;
        self.y += v.y * s;
        self.z += v.z * s;
        self
    }

    // three r186 Vector3.multiplyScalar
    pub fn multiply_scalar(&mut self, scalar: f64) -> &mut Self {
        self.x *= scalar;
        self.y *= scalar;
        self.z *= scalar;
        self
    }

    // three r186 Vector3.divideScalar
    pub fn divide_scalar(&mut self, scalar: f64) -> &mut Self {
        self.multiply_scalar(1.0 / scalar)
    }

    // three r186 Vector3.normalize
    pub fn normalize(&mut self) -> &mut Self {
        let length = self.length();
        // `length || 1`: zero and NaN are both falsy.
        self.divide_scalar(if length == 0.0 || length.is_nan() {
            1.0
        } else {
            length
        })
    }

    // three r186 Vector3.negate
    pub fn negate(&mut self) -> &mut Self {
        self.x = -self.x;
        self.y = -self.y;
        self.z = -self.z;
        self
    }

    // three r186 Vector3.length
    pub fn length(&self) -> f64 {
        sqrt(self.x * self.x + self.y * self.y + self.z * self.z)
    }

    // three r186 Vector3.lengthSq
    pub fn length_sq(&self) -> f64 {
        self.x * self.x + self.y * self.y + self.z * self.z
    }

    // three r186 Vector3.dot
    pub fn dot(&self, v: &Vec3) -> f64 {
        self.x * v.x + self.y * v.y + self.z * v.z
    }

    // three r186 Vector3.crossVectors
    pub fn cross_vectors(&mut self, a: &Vec3, b: &Vec3) -> &mut Self {
        let (ax, ay, az) = (a.x, a.y, a.z);
        let (bx, by, bz) = (b.x, b.y, b.z);
        self.x = ay * bz - az * by;
        self.y = az * bx - ax * bz;
        self.z = ax * by - ay * bx;
        self
    }

    // three r186 Vector3.distanceTo
    pub fn distance_to(&self, v: &Vec3) -> f64 {
        sqrt(self.distance_to_squared(v))
    }

    // three r186 Vector3.distanceToSquared
    pub fn distance_to_squared(&self, v: &Vec3) -> f64 {
        let (dx, dy, dz) = (self.x - v.x, self.y - v.y, self.z - v.z);
        dx * dx + dy * dy + dz * dz
    }

    // three r186 Vector3.lerpVectors
    pub fn lerp_vectors(&mut self, v1: &Vec3, v2: &Vec3, alpha: f64) -> &mut Self {
        self.x = v1.x + (v2.x - v1.x) * alpha;
        self.y = v1.y + (v2.y - v1.y) * alpha;
        self.z = v1.z + (v2.z - v1.z) * alpha;
        self
    }

    // three r186 Vector3.applyQuaternion
    pub fn apply_quaternion(&mut self, q: &Quat) -> &mut Self {
        let (vx, vy, vz) = (self.x, self.y, self.z);
        let (qx, qy, qz, qw) = (q.x, q.y, q.z, q.w);
        let tx = 2.0 * (qy * vz - qz * vy);
        let ty = 2.0 * (qz * vx - qx * vz);
        let tz = 2.0 * (qx * vy - qy * vx);
        self.x = vx + qw * tx + qy * tz - qz * ty;
        self.y = vy + qw * ty + qz * tx - qx * tz;
        self.z = vz + qw * tz + qx * ty - qy * tx;
        self
    }

    // three r186 Vector3.applyMatrix4
    pub fn apply_matrix4(&mut self, m: &Mat4) -> &mut Self {
        let (x, y, z) = (self.x, self.y, self.z);
        let e = &m.elements;
        let w = 1.0 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
        self.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
        self.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
        self.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
        self
    }

    // three r186 Vector3.setFromMatrixPosition
    pub fn set_from_matrix_position(&mut self, m: &Mat4) -> &mut Self {
        let e = &m.elements;
        self.x = e[12];
        self.y = e[13];
        self.z = e[14];
        self
    }

    // three r186 Vector3.setFromMatrixColumn
    pub fn set_from_matrix_column(&mut self, m: &Mat4, index: usize) -> &mut Self {
        self.from_array(&m.elements, index * 4)
    }

    // three r186 Vector3.min
    pub fn min(&mut self, v: &Vec3) -> &mut Self {
        self.x = js_min(self.x, v.x);
        self.y = js_min(self.y, v.y);
        self.z = js_min(self.z, v.z);
        self
    }

    // three r186 Vector3.max
    pub fn max(&mut self, v: &Vec3) -> &mut Self {
        self.x = js_max(self.x, v.x);
        self.y = js_max(self.y, v.y);
        self.z = js_max(self.z, v.z);
        self
    }
}
