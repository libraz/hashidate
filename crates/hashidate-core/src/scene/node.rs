//! One `THREE.Object3D` as the solvers see it: its place in the hierarchy, its flags and its
//! transforms.

use crate::math::{Mat4, Quat, Vec3, object3d};

/// Parent index of a node with no parent.
pub const NONE: u32 = u32::MAX;

/// A node's state, mirrored from three by the caller and written back after a solve.
#[derive(Clone, Debug)]
pub struct Node {
    /// Index of the parent at construction, or [`NONE`].
    pub parent: u32,
    /// `instanceof THREE.Bone`.
    pub is_bone: bool,
    pub matrix_auto_update: bool,
    pub matrix_world_auto_update: bool,
    pub matrix_world_needs_update: bool,
    /// Whether the node's current parent is no longer the one it was built with.
    pub reparented: bool,
    pub position: Vec3,
    pub quaternion: Quat,
    pub scale: Vec3,
    pub pivot: Option<Vec3>,
    pub matrix: Mat4,
    pub matrix_world: Mat4,
}

impl Default for Node {
    fn default() -> Self {
        Self {
            parent: NONE,
            is_bone: false,
            matrix_auto_update: true,
            matrix_world_auto_update: true,
            matrix_world_needs_update: false,
            reparented: false,
            position: Vec3::default(),
            quaternion: Quat::default(),
            scale: Vec3::new(1.0, 1.0, 1.0),
            pivot: None,
            matrix: Mat4::default(),
            matrix_world: Mat4::default(),
        }
    }
}

impl Node {
    // three r186 Object3D.updateMatrix
    pub fn update_matrix(&mut self) {
        object3d::update_matrix(
            &mut self.matrix,
            &self.position,
            &self.quaternion,
            &self.scale,
            self.pivot.as_ref(),
        );
        self.matrix_world_needs_update = true;
    }

    /// The parent index, if the node has one.
    pub fn parent(&self) -> Option<u32> {
        (self.parent != NONE).then_some(self.parent)
    }
}
