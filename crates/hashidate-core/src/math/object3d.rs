//! The local-matrix step of `THREE.Object3D`.

use super::mat4::Mat4;
use super::quat::Quat;
use super::vec3::Vec3;

// three r186 Object3D.updateMatrix
pub fn update_matrix(
    matrix: &mut Mat4,
    position: &Vec3,
    quaternion: &Quat,
    scale: &Vec3,
    pivot: Option<&Vec3>,
) {
    matrix.compose(position, quaternion, scale);
    if let Some(pivot) = pivot {
        let (px, py, pz) = (pivot.x, pivot.y, pivot.z);
        let te = &mut matrix.elements;
        te[12] += px - te[0] * px - te[4] * py - te[8] * pz;
        te[13] += py - te[1] * px - te[5] * py - te[9] * pz;
        te[14] += pz - te[2] * px - te[6] * py - te[10] * pz;
    }
}
