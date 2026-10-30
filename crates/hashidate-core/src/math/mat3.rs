//! `THREE.Matrix3`, column-major like three's `elements`.

use super::mat4::Mat4;

/// A 3x3 matrix; the default is the identity, as in three.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat3 {
    pub elements: [f64; 9],
}

impl Default for Mat3 {
    fn default() -> Self {
        Self {
            elements: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        }
    }
}

impl Mat3 {
    /// A matrix over the given column-major elements.
    pub const fn from_elements(elements: [f64; 9]) -> Self {
        Self { elements }
    }

    // three r186 Matrix3.set
    #[allow(clippy::too_many_arguments)]
    pub fn set(
        &mut self,
        n11: f64,
        n12: f64,
        n13: f64,
        n21: f64,
        n22: f64,
        n23: f64,
        n31: f64,
        n32: f64,
        n33: f64,
    ) -> &mut Self {
        let te = &mut self.elements;
        te[0] = n11;
        te[1] = n21;
        te[2] = n31;
        te[3] = n12;
        te[4] = n22;
        te[5] = n32;
        te[6] = n13;
        te[7] = n23;
        te[8] = n33;
        self
    }

    // three r186 Matrix3.identity
    pub fn identity(&mut self) -> &mut Self {
        self.set(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
    }

    // three r186 Matrix3.copy
    pub fn copy(&mut self, m: &Mat3) -> &mut Self {
        self.elements = m.elements;
        self
    }

    // three r186 Matrix3.setFromMatrix4
    pub fn set_from_matrix4(&mut self, m: &Mat4) -> &mut Self {
        let me = &m.elements;
        self.set(
            me[0], me[4], me[8], me[1], me[5], me[9], me[2], me[6], me[10],
        )
    }

    // three r186 Matrix3.determinant
    pub fn determinant(&self) -> f64 {
        let te = &self.elements;
        let (a, b, c) = (te[0], te[1], te[2]);
        let (d, e, f) = (te[3], te[4], te[5]);
        let (g, h, i) = (te[6], te[7], te[8]);
        a * e * i - a * f * h - b * d * i + b * f * g + c * d * h - c * e * g
    }

    // three r186 Matrix3.invert
    pub fn invert(&mut self) -> &mut Self {
        let te = self.elements;
        let (n11, n21, n31) = (te[0], te[1], te[2]);
        let (n12, n22, n32) = (te[3], te[4], te[5]);
        let (n13, n23, n33) = (te[6], te[7], te[8]);

        let t11 = n33 * n22 - n32 * n23;
        let t12 = n32 * n13 - n33 * n12;
        let t13 = n23 * n12 - n22 * n13;

        let det = n11 * t11 + n21 * t12 + n31 * t13;
        if det == 0.0 {
            return self.set(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        }
        let det_inv = 1.0 / det;

        let te = &mut self.elements;
        te[0] = t11 * det_inv;
        te[1] = (n31 * n23 - n33 * n21) * det_inv;
        te[2] = (n32 * n21 - n31 * n22) * det_inv;

        te[3] = t12 * det_inv;
        te[4] = (n33 * n11 - n31 * n13) * det_inv;
        te[5] = (n31 * n12 - n32 * n11) * det_inv;

        te[6] = t13 * det_inv;
        te[7] = (n21 * n13 - n23 * n11) * det_inv;
        te[8] = (n22 * n11 - n21 * n12) * det_inv;
        self
    }

    // three r186 Matrix3.transpose
    pub fn transpose(&mut self) -> &mut Self {
        self.elements.swap(1, 3);
        self.elements.swap(2, 6);
        self.elements.swap(5, 7);
        self
    }
}
