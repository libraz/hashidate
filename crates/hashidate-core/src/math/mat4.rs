//! `THREE.Matrix4`, column-major like three's `elements`.

use super::f::{cos, sin};
use super::quat::Quat;
use super::vec3::Vec3;

/// A 4x4 matrix; the default is the identity, as in three.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat4 {
    pub elements: [f64; 16],
}

impl Default for Mat4 {
    fn default() -> Self {
        let mut m = Self {
            elements: [0.0; 16],
        };
        m.identity();
        m
    }
}

impl Mat4 {
    /// A matrix over the given column-major elements.
    pub const fn from_elements(elements: [f64; 16]) -> Self {
        Self { elements }
    }

    // three r186 Matrix4.set
    #[allow(clippy::too_many_arguments)]
    pub fn set(
        &mut self,
        n11: f64,
        n12: f64,
        n13: f64,
        n14: f64,
        n21: f64,
        n22: f64,
        n23: f64,
        n24: f64,
        n31: f64,
        n32: f64,
        n33: f64,
        n34: f64,
        n41: f64,
        n42: f64,
        n43: f64,
        n44: f64,
    ) -> &mut Self {
        let te = &mut self.elements;
        te[0] = n11;
        te[4] = n12;
        te[8] = n13;
        te[12] = n14;
        te[1] = n21;
        te[5] = n22;
        te[9] = n23;
        te[13] = n24;
        te[2] = n31;
        te[6] = n32;
        te[10] = n33;
        te[14] = n34;
        te[3] = n41;
        te[7] = n42;
        te[11] = n43;
        te[15] = n44;
        self
    }

    // three r186 Matrix4.identity
    pub fn identity(&mut self) -> &mut Self {
        self.set(
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        )
    }

    // three r186 Matrix4.makeTranslation
    pub fn make_translation(&mut self, x: f64, y: f64, z: f64) -> &mut Self {
        self.set(
            1.0, 0.0, 0.0, x, 0.0, 1.0, 0.0, y, 0.0, 0.0, 1.0, z, 0.0, 0.0, 0.0, 1.0,
        )
    }

    // three r186 Matrix4.makeRotationY
    pub fn make_rotation_y(&mut self, theta: f64) -> &mut Self {
        let (c, s) = (cos(theta), sin(theta));
        self.set(
            c, 0.0, s, 0.0, 0.0, 1.0, 0.0, 0.0, -s, 0.0, c, 0.0, 0.0, 0.0, 0.0, 1.0,
        )
    }

    // three r186 Matrix4.copy
    pub fn copy(&mut self, m: &Mat4) -> &mut Self {
        self.elements = m.elements;
        self
    }

    // three r186 Matrix4.multiply
    pub fn multiply(&mut self, m: &Mat4) -> &mut Self {
        let a = *self;
        self.multiply_matrices(&a, m)
    }

    // three r186 Matrix4.premultiply
    pub fn premultiply(&mut self, m: &Mat4) -> &mut Self {
        let b = *self;
        self.multiply_matrices(m, &b)
    }

    // three r186 Matrix4.multiplyMatrices
    pub fn multiply_matrices(&mut self, a: &Mat4, b: &Mat4) -> &mut Self {
        let ae = &a.elements;
        let be = &b.elements;

        let (a11, a12, a13, a14) = (ae[0], ae[4], ae[8], ae[12]);
        let (a21, a22, a23, a24) = (ae[1], ae[5], ae[9], ae[13]);
        let (a31, a32, a33, a34) = (ae[2], ae[6], ae[10], ae[14]);
        let (a41, a42, a43, a44) = (ae[3], ae[7], ae[11], ae[15]);

        let (b11, b12, b13, b14) = (be[0], be[4], be[8], be[12]);
        let (b21, b22, b23, b24) = (be[1], be[5], be[9], be[13]);
        let (b31, b32, b33, b34) = (be[2], be[6], be[10], be[14]);
        let (b41, b42, b43, b44) = (be[3], be[7], be[11], be[15]);

        let te = &mut self.elements;
        te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
        te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
        te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
        te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;

        te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
        te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
        te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
        te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;

        te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
        te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
        te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
        te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;

        te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
        te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
        te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
        te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
        self
    }

    // three r186 Matrix4.extractRotation
    pub fn extract_rotation(&mut self, m: &Mat4) -> &mut Self {
        if m.determinant_affine() == 0.0 {
            return self.identity();
        }
        let me = m.elements;
        let mut v = Vec3::default();
        let scale_x = 1.0 / v.set_from_matrix_column(m, 0).length();
        let scale_y = 1.0 / v.set_from_matrix_column(m, 1).length();
        let scale_z = 1.0 / v.set_from_matrix_column(m, 2).length();
        let te = &mut self.elements;
        te[0] = me[0] * scale_x;
        te[1] = me[1] * scale_x;
        te[2] = me[2] * scale_x;
        te[3] = 0.0;
        te[4] = me[4] * scale_y;
        te[5] = me[5] * scale_y;
        te[6] = me[6] * scale_y;
        te[7] = 0.0;
        te[8] = me[8] * scale_z;
        te[9] = me[9] * scale_z;
        te[10] = me[10] * scale_z;
        te[11] = 0.0;
        te[12] = 0.0;
        te[13] = 0.0;
        te[14] = 0.0;
        te[15] = 1.0;
        self
    }

    // three r186 Matrix4.compose
    pub fn compose(&mut self, position: &Vec3, quaternion: &Quat, scale: &Vec3) -> &mut Self {
        let (x, y, z, w) = (quaternion.x, quaternion.y, quaternion.z, quaternion.w);
        let (x2, y2, z2) = (x + x, y + y, z + z);
        let (xx, xy, xz) = (x * x2, x * y2, x * z2);
        let (yy, yz, zz) = (y * y2, y * z2, z * z2);
        let (wx, wy, wz) = (w * x2, w * y2, w * z2);
        let (sx, sy, sz) = (scale.x, scale.y, scale.z);
        let te = &mut self.elements;
        te[0] = (1.0 - (yy + zz)) * sx;
        te[1] = (xy + wz) * sx;
        te[2] = (xz - wy) * sx;
        te[3] = 0.0;
        te[4] = (xy - wz) * sy;
        te[5] = (1.0 - (xx + zz)) * sy;
        te[6] = (yz + wx) * sy;
        te[7] = 0.0;
        te[8] = (xz + wy) * sz;
        te[9] = (yz - wx) * sz;
        te[10] = (1.0 - (xx + yy)) * sz;
        te[11] = 0.0;
        te[12] = position.x;
        te[13] = position.y;
        te[14] = position.z;
        te[15] = 1.0;
        self
    }

    // three r186 Matrix4.decompose
    pub fn decompose(&self, position: &mut Vec3, quaternion: &mut Quat, scale: &mut Vec3) {
        let te = &self.elements;
        position.x = te[12];
        position.y = te[13];
        position.z = te[14];
        let det = self.determinant_affine();
        if det == 0.0 {
            scale.set(1.0, 1.0, 1.0);
            quaternion.identity();
            return;
        }
        let mut v = Vec3::default();
        let mut sx = v.set(te[0], te[1], te[2]).length();
        let sy = v.set(te[4], te[5], te[6]).length();
        let sz = v.set(te[8], te[9], te[10]).length();
        if det < 0.0 {
            sx = -sx;
        }
        let mut m1 = *self;
        let inv_sx = 1.0 / sx;
        let inv_sy = 1.0 / sy;
        let inv_sz = 1.0 / sz;
        m1.elements[0] *= inv_sx;
        m1.elements[1] *= inv_sx;
        m1.elements[2] *= inv_sx;
        m1.elements[4] *= inv_sy;
        m1.elements[5] *= inv_sy;
        m1.elements[6] *= inv_sy;
        m1.elements[8] *= inv_sz;
        m1.elements[9] *= inv_sz;
        m1.elements[10] *= inv_sz;
        quaternion.set_from_rotation_matrix(&m1);
        scale.x = sx;
        scale.y = sy;
        scale.z = sz;
    }

    // three r186 Matrix4.determinant
    pub fn determinant(&self) -> f64 {
        let te = &self.elements;
        let (n11, n12, n13, n14) = (te[0], te[4], te[8], te[12]);
        let (n21, n22, n23, n24) = (te[1], te[5], te[9], te[13]);
        let (n31, n32, n33, n34) = (te[2], te[6], te[10], te[14]);
        let (n41, n42, n43, n44) = (te[3], te[7], te[11], te[15]);

        let t11 = n23 * n34 - n24 * n33;
        let t12 = n22 * n34 - n24 * n32;
        let t13 = n22 * n33 - n23 * n32;

        let t21 = n21 * n34 - n24 * n31;
        let t22 = n21 * n33 - n23 * n31;
        let t23 = n21 * n32 - n22 * n31;

        n11 * (n42 * t11 - n43 * t12 + n44 * t13) - n12 * (n41 * t11 - n43 * t21 + n44 * t22)
            + n13 * (n41 * t12 - n42 * t21 + n44 * t23)
            - n14 * (n41 * t13 - n42 * t22 + n43 * t23)
    }

    // three r186 Matrix4.determinantAffine
    pub fn determinant_affine(&self) -> f64 {
        let te = &self.elements;
        let (n11, n12, n13) = (te[0], te[4], te[8]);
        let (n21, n22, n23) = (te[1], te[5], te[9]);
        let (n31, n32, n33) = (te[2], te[6], te[10]);
        n11 * (n22 * n33 - n23 * n32) - n12 * (n21 * n33 - n23 * n31)
            + n13 * (n21 * n32 - n22 * n31)
    }

    // three r186 Matrix4.invert
    pub fn invert(&mut self) -> &mut Self {
        let te = self.elements;
        let (n11, n21, n31, n41) = (te[0], te[1], te[2], te[3]);
        let (n12, n22, n32, n42) = (te[4], te[5], te[6], te[7]);
        let (n13, n23, n33, n43) = (te[8], te[9], te[10], te[11]);
        let (n14, n24, n34, n44) = (te[12], te[13], te[14], te[15]);

        let t1 = n11 * n22 - n21 * n12;
        let t2 = n11 * n32 - n31 * n12;
        let t3 = n11 * n42 - n41 * n12;
        let t4 = n21 * n32 - n31 * n22;
        let t5 = n21 * n42 - n41 * n22;
        let t6 = n31 * n42 - n41 * n32;
        let t7 = n13 * n24 - n23 * n14;
        let t8 = n13 * n34 - n33 * n14;
        let t9 = n13 * n44 - n43 * n14;
        let t10 = n23 * n34 - n33 * n24;
        let t11 = n23 * n44 - n43 * n24;
        let t12 = n33 * n44 - n43 * n34;

        let det = t1 * t12 - t2 * t11 + t3 * t10 + t4 * t9 - t5 * t8 + t6 * t7;
        if det == 0.0 {
            self.elements = [0.0; 16];
            return self;
        }
        let det_inv = 1.0 / det;

        let te = &mut self.elements;
        te[0] = (n22 * t12 - n32 * t11 + n42 * t10) * det_inv;
        te[1] = (n31 * t11 - n21 * t12 - n41 * t10) * det_inv;
        te[2] = (n24 * t6 - n34 * t5 + n44 * t4) * det_inv;
        te[3] = (n33 * t5 - n23 * t6 - n43 * t4) * det_inv;

        te[4] = (n32 * t9 - n12 * t12 - n42 * t8) * det_inv;
        te[5] = (n11 * t12 - n31 * t9 + n41 * t8) * det_inv;
        te[6] = (n34 * t3 - n14 * t6 - n44 * t2) * det_inv;
        te[7] = (n13 * t6 - n33 * t3 + n43 * t2) * det_inv;

        te[8] = (n12 * t11 - n22 * t9 + n42 * t7) * det_inv;
        te[9] = (n21 * t9 - n11 * t11 - n41 * t7) * det_inv;
        te[10] = (n14 * t5 - n24 * t3 + n44 * t1) * det_inv;
        te[11] = (n23 * t3 - n13 * t5 - n43 * t1) * det_inv;

        te[12] = (n22 * t8 - n12 * t10 - n32 * t7) * det_inv;
        te[13] = (n11 * t10 - n21 * t8 + n31 * t7) * det_inv;
        te[14] = (n24 * t2 - n14 * t4 - n34 * t1) * det_inv;
        te[15] = (n13 * t4 - n23 * t2 + n33 * t1) * det_inv;
        self
    }
}
