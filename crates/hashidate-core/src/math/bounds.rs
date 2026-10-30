//! `THREE.Box3`, as far as a box fitted to points and its size.

use super::vec3::Vec3;

/// An axis-aligned box; the default is empty, as in three.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Box3 {
    pub min: Vec3,
    pub max: Vec3,
}

impl Default for Box3 {
    fn default() -> Self {
        let mut b = Self {
            min: Vec3::default(),
            max: Vec3::default(),
        };
        b.make_empty();
        b
    }
}

impl Box3 {
    // three r186 Box3.makeEmpty
    pub fn make_empty(&mut self) -> &mut Self {
        self.min.set(f64::INFINITY, f64::INFINITY, f64::INFINITY);
        self.max
            .set(f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        self
    }

    // three r186 Box3.setFromPoints
    pub fn set_from_points(&mut self, points: &[Vec3]) -> &mut Self {
        self.make_empty();
        for point in points {
            self.expand_by_point(point);
        }
        self
    }

    // three r186 Box3.expandByPoint
    pub fn expand_by_point(&mut self, point: &Vec3) -> &mut Self {
        self.min.min(point);
        self.max.max(point);
        self
    }

    // three r186 Box3.isEmpty
    pub fn is_empty(&self) -> bool {
        self.max.x < self.min.x || self.max.y < self.min.y || self.max.z < self.min.z
    }

    // three r186 Box3.getSize
    pub fn get_size(&self, target: &mut Vec3) {
        if self.is_empty() {
            target.set(0.0, 0.0, 0.0);
        } else {
            target.sub_vectors(&self.max, &self.min);
        }
    }
}
