//! Vertex pose, centroids and camera depths, in three's evaluation order.

use crate::math::{Mat4, Vec3, Vec4};

/// One mesh's morph position targets.
pub struct Morphs<'a> {
    /// Per target per vertex, xyz, target-major.
    pub targets: &'a [f64],
    /// One per target; `undefined` in three arrives as NaN and is applied, as three applies it.
    pub influences: &'a [f64],
    pub vertices: usize,
    pub relative: bool,
}

// three r186 Mesh.getVertexPosition, the morph block; `target` holds the base position.
pub fn apply_morphs(target: &mut Vec3, vertex: usize, morphs: &Morphs) {
    let mut morph = Vec3::new(0.0, 0.0, 0.0);
    let mut temp = Vec3::default();
    for (i, &influence) in morphs.influences.iter().enumerate() {
        if influence == 0.0 {
            continue;
        }
        temp.from_array(morphs.targets, 3 * (i * morphs.vertices + vertex));
        if morphs.relative {
            morph.add_scaled_vector(&temp, influence);
        } else {
            temp.sub(target);
            morph.add_scaled_vector(&temp, influence);
        }
    }
    target.add(&morph);
}

// three r186 SkinnedMesh.applyBoneTransform, Vector3 target. `bones[i]` is
// `multiplyMatrices(bones[i].matrixWorld, boneInverses[i])`, the matrix three forms per influence.
pub fn apply_bone_transform(
    target: &mut Vec3,
    index: &[u32],
    weight: &[f64],
    bind: &Mat4,
    bind_inverse: &Mat4,
    bones: &[Mat4],
) {
    let mut base = Vec4::new(target.x, target.y, target.z, 1.0);
    target.set(0.0, 0.0, 0.0);
    base.apply_matrix4(bind);
    for i in 0..4 {
        let w = weight[i];
        if w != 0.0 {
            let mut v = base;
            v.apply_matrix4(&bones[index[i] as usize]);
            target.add_scaled_vector(&Vec3::new(v.x, v.y, v.z), w);
        }
    }
    target.apply_matrix4(bind_inverse);
}

/// `evaluatePose`'s centroid loop: `(a + b + c) / 3` per axis.
pub fn centroids(faces: &[u32], positions: &[f64], out: &mut [f64]) {
    for (face, c) in out.as_chunks_mut::<3>().0.iter_mut().enumerate() {
        let v0 = 3 * faces[3 * face] as usize;
        let v1 = 3 * faces[3 * face + 1] as usize;
        let v2 = 3 * faces[3 * face + 2] as usize;
        for axis in 0..3 {
            c[axis] = (positions[v0 + axis] + positions[v1 + axis] + positions[v2 + axis]) / 3.0;
        }
    }
}

/// `calculateCameraDepths`: each centroid through the mesh world, then the view's z row.
pub fn camera_depths(centroids: &[f64], world: &[f64], view: &[f64], out: &mut [f64]) {
    for (depth, &[x, y, z]) in out.iter_mut().zip(centroids.as_chunks::<3>().0) {
        let world_x = world[0] * x + world[4] * y + world[8] * z + world[12];
        let world_y = world[1] * x + world[5] * y + world[9] * z + world[13];
        let world_z = world[2] * x + world[6] * y + world[10] * z + world[14];
        *depth = view[2] * world_x + view[6] * world_y + view[10] * world_z + view[14];
    }
}
