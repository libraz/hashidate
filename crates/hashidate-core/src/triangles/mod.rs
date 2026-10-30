//! Transparent triangle depth sorting.
//!
//! The numeric half of `src/engine/scene/transparent-triangles.ts`: pose every referenced vertex
//! as three's `Mesh.getVertexPosition` does (morphs, then `SkinnedMesh.applyBoneTransform`), take
//! each face's centroid and camera depth, and order the faces far to near. Matching targets,
//! caching and writing the index buffer stay with the caller.
//!
//! Vertices are compact: the caller uploads only the vertices the index references, and faces
//! name them by their slot. Every buffer is allocated by [`Kernel::new`] and never resized.

pub mod pose;
pub mod sort;

use crate::math::{Mat4, Vec3};

/// f64 per bone in [`Kernel::bones`]: `matrixWorld`, then the matching `boneInverse`.
pub const BONE: usize = 32;
/// f64 in [`Kernel::frame`]: `bindMatrix`, `bindMatrixInverse`, mesh `matrixWorld`, camera
/// `matrixWorldInverse`, 16 each.
pub const FRAME: usize = 64;
pub const FRAME_BIND: usize = 0;
pub const FRAME_BIND_INVERSE: usize = 16;
pub const FRAME_MESH_WORLD: usize = 32;
pub const FRAME_VIEW: usize = 48;

/// Sizes and modes of one mesh.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Shape {
    /// Referenced vertices.
    pub vertices: usize,
    pub faces: usize,
    /// Morph position targets.
    pub morphs: usize,
    pub bones: usize,
    /// A `SkinnedMesh`: apply the bone transform after the morphs.
    pub skinned: bool,
    /// three's `morphPosition && morphInfluences` held: add the morph sum, even with no targets.
    pub morphed: bool,
    /// `geometry.morphTargetsRelative`.
    pub relative: bool,
}

/// How an update ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Outcome {
    /// The order was sorted from this update's depths.
    Sorted = 0,
    /// A depth was NaN; the order is the previous one.
    NonFiniteDepth = 1,
}

/// One mesh's pose and face order.
pub struct Kernel {
    shape: Shape,
    /// Three vertex slots per face.
    pub faces: Box<[u32]>,
    /// Base `position` per vertex, xyz.
    pub base: Box<[f64]>,
    /// Morph position per target per vertex, xyz, target-major.
    pub morphs: Box<[f64]>,
    /// `skinIndex` per vertex, four; read only where the weight is not 0.
    pub skin_index: Box<[u32]>,
    /// `skinWeight` per vertex, four, as three reads them.
    pub skin_weight: Box<[f64]>,
    /// [`BONE`] f64 per bone, refreshed every frame.
    pub bones: Box<[f64]>,
    /// [`FRAME`] f64, refreshed every frame.
    pub frame: Box<[f64]>,
    /// `morphTargetInfluences` per target, refreshed every frame.
    pub influences: Box<[f64]>,
    bone_matrices: Box<[Mat4]>,
    positions: Box<[f64]>,
    centroids: Box<[f64]>,
    depths: Box<[f64]>,
    order: Box<[u32]>,
}

fn mat(values: &[f64]) -> Mat4 {
    let mut elements = [0.0; 16];
    elements.copy_from_slice(&values[..16]);
    Mat4::from_elements(elements)
}

impl Kernel {
    /// A kernel with zeroed inputs and the identity order.
    pub fn new(shape: Shape) -> Self {
        let Shape {
            vertices,
            faces,
            morphs,
            bones,
            ..
        } = shape;
        Self {
            shape,
            faces: vec![0; 3 * faces].into(),
            base: vec![0.0; 3 * vertices].into(),
            morphs: vec![0.0; 3 * vertices * morphs].into(),
            skin_index: vec![0; 4 * vertices].into(),
            skin_weight: vec![0.0; 4 * vertices].into(),
            bones: vec![0.0; BONE * bones].into(),
            frame: vec![0.0; FRAME].into(),
            influences: vec![0.0; morphs].into(),
            bone_matrices: vec![Mat4::default(); bones].into(),
            positions: vec![0.0; 3 * vertices].into(),
            centroids: vec![0.0; 3 * faces].into(),
            depths: vec![0.0; faces].into(),
            order: (0..faces as u32).collect(),
        }
    }

    pub fn shape(&self) -> Shape {
        self.shape
    }

    /// Posed position per vertex, xyz, mesh space.
    pub fn positions(&self) -> &[f64] {
        &self.positions
    }

    /// Centroid per face, xyz, mesh space.
    pub fn centroids(&self) -> &[f64] {
        &self.centroids
    }

    /// View-space z of each centroid.
    pub fn depths(&self) -> &[f64] {
        &self.depths
    }

    /// Face indices, nearest-last.
    pub fn order(&self) -> &[u32] {
        &self.order
    }

    /// Mutable order, for a caller that has to seed it.
    pub fn order_mut(&mut self) -> &mut [u32] {
        &mut self.order
    }

    /// Poses, measures and sorts from the current inputs. Allocates nothing.
    pub fn update(&mut self) -> Outcome {
        let shape = self.shape;
        if shape.skinned {
            for (b, m) in self.bone_matrices.iter_mut().enumerate() {
                let at = BONE * b;
                m.multiply_matrices(&mat(&self.bones[at..]), &mat(&self.bones[at + 16..]));
            }
        }
        let bind = mat(&self.frame[FRAME_BIND..]);
        let bind_inverse = mat(&self.frame[FRAME_BIND_INVERSE..]);
        let morphs = pose::Morphs {
            targets: &self.morphs,
            influences: &self.influences,
            vertices: shape.vertices,
            relative: shape.relative,
        };
        let mut target = Vec3::default();
        for v in 0..shape.vertices {
            target.from_array(&self.base, 3 * v);
            if shape.morphed {
                pose::apply_morphs(&mut target, v, &morphs);
            }
            if shape.skinned {
                pose::apply_bone_transform(
                    &mut target,
                    &self.skin_index[4 * v..4 * v + 4],
                    &self.skin_weight[4 * v..4 * v + 4],
                    &bind,
                    &bind_inverse,
                    &self.bone_matrices,
                );
            }
            self.positions[3 * v] = target.x;
            self.positions[3 * v + 1] = target.y;
            self.positions[3 * v + 2] = target.z;
        }
        pose::centroids(&self.faces, &self.positions, &mut self.centroids);
        pose::camera_depths(
            &self.centroids,
            &self.frame[FRAME_MESH_WORLD..FRAME_MESH_WORLD + 16],
            &self.frame[FRAME_VIEW..FRAME_VIEW + 16],
            &mut self.depths,
        );
        if sort::has_nan(&self.depths) {
            return Outcome::NonFiniteDepth;
        }
        sort::sort_faces(&mut self.order, &self.depths);
        Outcome::Sorted
    }
}
