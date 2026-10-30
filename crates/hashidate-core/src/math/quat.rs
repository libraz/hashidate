//! `THREE.Quaternion`, without the change callback (Euler sync stays in three).

use super::clamp;
use super::f::{acos, cos, sin, sqrt};
use super::mat4::Mat4;
use super::vec3::Vec3;

/// A quaternion; the default is the identity, as in three.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quat {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub w: f64,
}

impl Default for Quat {
    fn default() -> Self {
        Self::new(0.0, 0.0, 0.0, 1.0)
    }
}

impl Quat {
    /// The quaternion `(x, y, z, w)`.
    pub const fn new(x: f64, y: f64, z: f64, w: f64) -> Self {
        Self { x, y, z, w }
    }

    // three r186 Quaternion.set
    pub fn set(&mut self, x: f64, y: f64, z: f64, w: f64) -> &mut Self {
        self.x = x;
        self.y = y;
        self.z = z;
        self.w = w;
        self
    }

    // three r186 Quaternion.identity
    pub fn identity(&mut self) -> &mut Self {
        self.set(0.0, 0.0, 0.0, 1.0)
    }

    // three r186 Quaternion.copy
    pub fn copy(&mut self, q: &Quat) -> &mut Self {
        self.x = q.x;
        self.y = q.y;
        self.z = q.z;
        self.w = q.w;
        self
    }

    // three r186 Quaternion.multiply
    pub fn multiply(&mut self, q: &Quat) -> &mut Self {
        let a = *self;
        self.multiply_quaternions(&a, q)
    }

    // three r186 Quaternion.premultiply
    pub fn premultiply(&mut self, q: &Quat) -> &mut Self {
        let b = *self;
        self.multiply_quaternions(q, &b)
    }

    // three r186 Quaternion.multiplyQuaternions
    pub fn multiply_quaternions(&mut self, a: &Quat, b: &Quat) -> &mut Self {
        let (qax, qay, qaz, qaw) = (a.x, a.y, a.z, a.w);
        let (qbx, qby, qbz, qbw) = (b.x, b.y, b.z, b.w);
        self.x = qax * qbw + qaw * qbx + qay * qbz - qaz * qby;
        self.y = qay * qbw + qaw * qby + qaz * qbx - qax * qbz;
        self.z = qaz * qbw + qaw * qbz + qax * qby - qay * qbx;
        self.w = qaw * qbw - qax * qbx - qay * qby - qaz * qbz;
        self
    }

    // three r186 Quaternion.invert
    pub fn invert(&mut self) -> &mut Self {
        self.conjugate()
    }

    // three r186 Quaternion.conjugate
    pub fn conjugate(&mut self) -> &mut Self {
        self.x *= -1.0;
        self.y *= -1.0;
        self.z *= -1.0;
        self
    }

    // three r186 Quaternion.length
    pub fn length(&self) -> f64 {
        sqrt(self.x * self.x + self.y * self.y + self.z * self.z + self.w * self.w)
    }

    // three r186 Quaternion.normalize
    pub fn normalize(&mut self) -> &mut Self {
        let mut l = self.length();
        if l == 0.0 {
            self.x = 0.0;
            self.y = 0.0;
            self.z = 0.0;
            self.w = 1.0;
        } else {
            l = 1.0 / l;
            self.x *= l;
            self.y *= l;
            self.z *= l;
            self.w *= l;
        }
        self
    }

    // three r186 Quaternion.dot
    pub fn dot(&self, v: &Quat) -> f64 {
        self.x * v.x + self.y * v.y + self.z * v.z + self.w * v.w
    }

    // three r186 Quaternion.angleTo
    pub fn angle_to(&self, q: &Quat) -> f64 {
        2.0 * acos(clamp(self.dot(q), -1.0, 1.0).abs())
    }

    // three r186 Quaternion.equals
    pub fn equals(&self, q: &Quat) -> bool {
        q.x == self.x && q.y == self.y && q.z == self.z && q.w == self.w
    }

    // three r186 Quaternion.setFromEuler, order 'XYZ'
    pub fn set_from_euler_xyz(&mut self, x: f64, y: f64, z: f64) -> &mut Self {
        let c1 = cos(x / 2.0);
        let c2 = cos(y / 2.0);
        let c3 = cos(z / 2.0);

        let s1 = sin(x / 2.0);
        let s2 = sin(y / 2.0);
        let s3 = sin(z / 2.0);

        self.x = s1 * c2 * c3 + c1 * s2 * s3;
        self.y = c1 * s2 * c3 - s1 * c2 * s3;
        self.z = c1 * c2 * s3 + s1 * s2 * c3;
        self.w = c1 * c2 * c3 - s1 * s2 * s3;
        self
    }

    // three r186 Quaternion.setFromAxisAngle
    pub fn set_from_axis_angle(&mut self, axis: &Vec3, angle: f64) -> &mut Self {
        let half_angle = angle / 2.0;
        let s = sin(half_angle);
        self.x = axis.x * s;
        self.y = axis.y * s;
        self.z = axis.z * s;
        self.w = cos(half_angle);
        self
    }

    // three r186 Quaternion.setFromUnitVectors
    pub fn set_from_unit_vectors(&mut self, v_from: &Vec3, v_to: &Vec3) -> &mut Self {
        let mut r = v_from.dot(v_to) + 1.0;
        if r < 1e-8 {
            r = 0.0;
            if v_from.x.abs() > v_from.z.abs() {
                self.x = -v_from.y;
                self.y = v_from.x;
                self.z = 0.0;
                self.w = r;
            } else {
                self.x = 0.0;
                self.y = -v_from.z;
                self.z = v_from.y;
                self.w = r;
            }
        } else {
            self.x = v_from.y * v_to.z - v_from.z * v_to.y;
            self.y = v_from.z * v_to.x - v_from.x * v_to.z;
            self.z = v_from.x * v_to.y - v_from.y * v_to.x;
            self.w = r;
        }
        self.normalize()
    }

    // three r186 Quaternion.setFromRotationMatrix
    pub fn set_from_rotation_matrix(&mut self, m: &Mat4) -> &mut Self {
        let te = &m.elements;
        let (m11, m12, m13) = (te[0], te[4], te[8]);
        let (m21, m22, m23) = (te[1], te[5], te[9]);
        let (m31, m32, m33) = (te[2], te[6], te[10]);
        let trace = m11 + m22 + m33;
        if trace > 0.0 {
            let s = 0.5 / sqrt(trace + 1.0);
            self.w = 0.25 / s;
            self.x = (m32 - m23) * s;
            self.y = (m13 - m31) * s;
            self.z = (m21 - m12) * s;
        } else if m11 > m22 && m11 > m33 {
            let s = 2.0 * sqrt(1.0 + m11 - m22 - m33);
            self.w = (m32 - m23) / s;
            self.x = 0.25 * s;
            self.y = (m12 + m21) / s;
            self.z = (m13 + m31) / s;
        } else if m22 > m33 {
            let s = 2.0 * sqrt(1.0 + m22 - m11 - m33);
            self.w = (m13 - m31) / s;
            self.x = (m12 + m21) / s;
            self.y = 0.25 * s;
            self.z = (m23 + m32) / s;
        } else {
            let s = 2.0 * sqrt(1.0 + m33 - m11 - m22);
            self.w = (m21 - m12) / s;
            self.x = (m13 + m31) / s;
            self.y = (m23 + m32) / s;
            self.z = 0.25 * s;
        }
        self
    }

    // three r186 Quaternion.slerp
    pub fn slerp(&mut self, qb: &Quat, t: f64) -> &mut Self {
        let (mut x, mut y, mut z, mut w) = (qb.x, qb.y, qb.z, qb.w);
        let mut dot = self.dot(qb);
        if dot < 0.0 {
            x = -x;
            y = -y;
            z = -z;
            w = -w;
            dot = -dot;
        }
        let mut s = 1.0 - t;
        let mut t = t;
        if dot < 0.9995 {
            let theta = acos(dot);
            let sin_theta = sin(theta);
            s = sin(s * theta) / sin_theta;
            t = sin(t * theta) / sin_theta;
            self.x = self.x * s + x * t;
            self.y = self.y * s + y * t;
            self.z = self.z * s + z * t;
            self.w = self.w * s + w * t;
        } else {
            self.x = self.x * s + x * t;
            self.y = self.y * s + y * t;
            self.z = self.z * s + z * t;
            self.w = self.w * s + w * t;
            self.normalize();
        }
        self
    }

    // three r186 Quaternion.slerpQuaternions
    pub fn slerp_quaternions(&mut self, qa: &Quat, qb: &Quat, t: f64) -> &mut Self {
        self.copy(qa).slerp(qb, t)
    }
}
