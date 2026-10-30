//! `THREE.Vector4`.

use super::mat4::Mat4;

/// A four-component vector; the default is `(0, 0, 0, 1)`, as in three.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vec4 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub w: f64,
}

impl Default for Vec4 {
    fn default() -> Self {
        Self::new(0.0, 0.0, 0.0, 1.0)
    }
}

impl Vec4 {
    /// The vector `(x, y, z, w)`.
    pub const fn new(x: f64, y: f64, z: f64, w: f64) -> Self {
        Self { x, y, z, w }
    }

    // three r186 Vector4.set
    pub fn set(&mut self, x: f64, y: f64, z: f64, w: f64) -> &mut Self {
        self.x = x;
        self.y = y;
        self.z = z;
        self.w = w;
        self
    }

    // three r186 Vector4.copy
    pub fn copy(&mut self, v: &Vec4) -> &mut Self {
        self.x = v.x;
        self.y = v.y;
        self.z = v.z;
        self.w = v.w;
        self
    }

    // three r186 Vector4.getComponent
    pub fn get_component(&self, index: usize) -> f64 {
        match index {
            0 => self.x,
            1 => self.y,
            2 => self.z,
            3 => self.w,
            _ => panic!("Vector4 index is out of range: {index}"),
        }
    }

    // three r186 Vector4.addScaledVector
    pub fn add_scaled_vector(&mut self, v: &Vec4, s: f64) -> &mut Self {
        self.x += v.x * s;
        self.y += v.y * s;
        self.z += v.z * s;
        self.w += v.w * s;
        self
    }

    // three r186 Vector4.applyMatrix4
    pub fn apply_matrix4(&mut self, m: &Mat4) -> &mut Self {
        let (x, y, z, w) = (self.x, self.y, self.z, self.w);
        let e = &m.elements;
        self.x = e[0] * x + e[4] * y + e[8] * z + e[12] * w;
        self.y = e[1] * x + e[5] * y + e[9] * z + e[13] * w;
        self.z = e[2] * x + e[6] * y + e[10] * z + e[14] * w;
        self.w = e[3] * x + e[7] * y + e[11] * z + e[15] * w;
        self
    }
}
