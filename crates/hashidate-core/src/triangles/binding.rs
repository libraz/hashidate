//! Where a kernel's matrices live in the scene graph.
//!
//! The kernel's `bones` and the bind and mesh-world parts of its `frame` are copied from the
//! graph before each update, so between updates they hold what the last pose read. That copy is
//! what [`Binding::skin_changed`] compares the graph against.

use super::{BONE, FRAME_BIND, FRAME_BIND_INVERSE, FRAME_MESH_WORLD, Kernel, Shape};
use crate::scene::graph::{Graph, NO_NODE};

/// One mesh's node, SkinnedMesh slot and skeleton run in a graph.
#[derive(Clone, Copy, Debug)]
pub struct Binding {
    mesh: usize,
    /// SkinnedMesh slot, read only for a skinned shape.
    slot: usize,
    /// First bone slot of the mesh's skeleton.
    bones: usize,
}

impl Binding {
    /// Binds node `mesh` and its skeleton, graph skeleton `skeleton` (any value for a shape with
    /// no bones). Panics if the graph does not hold them as the shape says.
    pub fn new(graph: &Graph, shape: Shape, mesh: u32, skeleton: u32) -> Self {
        assert!(
            (mesh as usize) < graph.len(),
            "mesh node {mesh} is not in the graph"
        );
        let mut slot = 0;
        if shape.skinned {
            slot = graph
                .mesh_nodes
                .iter()
                .position(|&n| n == mesh)
                .unwrap_or_else(|| panic!("mesh node {mesh} is not a SkinnedMesh of the graph"));
        }
        let mut bones = 0;
        if shape.bones > 0 {
            let s = skeleton as usize;
            let offsets = &graph.skeleton_offsets;
            assert!(
                s + 1 < offsets.len(),
                "skeleton {skeleton} is not in the graph"
            );
            bones = offsets[s] as usize;
            let slots = offsets[s + 1] as usize - bones;
            assert_eq!(
                slots, shape.bones,
                "skeleton {skeleton} has {slots} bone slots, not {}",
                shape.bones
            );
        }
        Self {
            mesh: mesh as usize,
            slot,
            bones,
        }
    }

    fn bone_node(&self, graph: &Graph, b: usize) -> u32 {
        graph.bone_nodes[self.bones + b]
    }

    /// Copies what the next update reads from the graph: each bone's `matrixWorld` and
    /// `boneInverse`, the bind matrices and the mesh's `matrixWorld`. A bone outside the graph
    /// keeps whatever it held; the caller refuses a mesh that weights one.
    pub fn read(&self, graph: &Graph, kernel: &mut Kernel) {
        let shape = kernel.shape();
        if shape.skinned {
            for b in 0..shape.bones {
                let at = BONE * b;
                let node = self.bone_node(graph, b);
                if node != NO_NODE {
                    let n = node as usize;
                    kernel.bones[at..at + 16].copy_from_slice(&graph.matrix_world[16 * n..][..16]);
                }
                let s = self.bones + b;
                kernel.bones[at + 16..at + 32]
                    .copy_from_slice(&graph.bone_inverses[16 * s..][..16]);
            }
            let m = self.slot;
            kernel.frame[FRAME_BIND..FRAME_BIND + 16]
                .copy_from_slice(&graph.bind_matrix[16 * m..][..16]);
            kernel.frame[FRAME_BIND_INVERSE..FRAME_BIND_INVERSE + 16]
                .copy_from_slice(&graph.bind_matrix_inverse[16 * m..][..16]);
        }
        let n = self.mesh;
        kernel.frame[FRAME_MESH_WORLD..FRAME_MESH_WORLD + 16]
            .copy_from_slice(&graph.matrix_world[16 * n..][..16]);
    }

    /// Whether any bone's `matrixWorld` or `boneInverse`, or either bind matrix, differs in the
    /// graph from what the last [`Binding::read`] copied. Compared with `!=`, as JS's `!==`: a NaN
    /// always differs and −0 equals +0.
    pub fn skin_changed(&self, graph: &Graph, kernel: &Kernel) -> bool {
        let shape = kernel.shape();
        if !shape.skinned {
            return false;
        }
        for b in 0..shape.bones {
            let at = BONE * b;
            let node = self.bone_node(graph, b);
            if node != NO_NODE {
                let n = node as usize;
                if kernel.bones[at..at + 16] != graph.matrix_world[16 * n..][..16] {
                    return true;
                }
            }
            let s = self.bones + b;
            if kernel.bones[at + 16..at + 32] != graph.bone_inverses[16 * s..][..16] {
                return true;
            }
        }
        let m = self.slot;
        kernel.frame[FRAME_BIND..FRAME_BIND + 16] != graph.bind_matrix[16 * m..][..16]
            || kernel.frame[FRAME_BIND_INVERSE..FRAME_BIND_INVERSE + 16]
                != graph.bind_matrix_inverse[16 * m..][..16]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Mat4;
    use crate::scene::graph::{RECORD, Shape as GraphShape, flag};

    const AUTO: u8 = flag::MATRIX_AUTO_UPDATE | flag::MATRIX_WORLD_AUTO_UPDATE;

    fn translation(x: f64, y: f64, z: f64) -> Mat4 {
        let mut m = Mat4::default();
        m.make_translation(x, y, z);
        m
    }

    /// A root with one bone and one skinned mesh under it, the bone in a one-slot skeleton.
    fn graph() -> Graph {
        let mut g = Graph::new(GraphShape {
            nodes: 3,
            meshes: 1,
            skeletons: 1,
            bones: 1,
        });
        let mut record = [0.0; RECORD];
        record[13..29].copy_from_slice(&Mat4::default().elements);
        record[29..45].copy_from_slice(&Mat4::default().elements);
        g.push_node(NO_NODE, AUTO, &record);
        g.push_node(0, AUTO | flag::BONE, &record);
        g.push_node(0, AUTO | flag::SKINNED, &record);
        g.push_mesh(2, &translation(1.0, 0.0, 0.0), &translation(-1.0, 0.0, 0.0));
        g.push_skeleton();
        g.push_bone(1, &translation(0.0, -2.0, 0.0));
        g.build();
        g
    }

    fn skinned() -> Shape {
        Shape {
            vertices: 1,
            faces: 1,
            bones: 1,
            skinned: true,
            ..Shape::default()
        }
    }

    #[test]
    fn reads_the_graph_matrices_into_the_kernel() {
        let mut g = graph();
        g.matrix_world[16..32].copy_from_slice(&translation(0.0, 3.0, 0.0).elements);
        g.matrix_world[32..48].copy_from_slice(&translation(0.0, 0.0, 5.0).elements);
        let binding = Binding::new(&g, skinned(), 2, 0);
        let mut k = Kernel::new(skinned());
        binding.read(&g, &mut k);
        assert_eq!(k.bones[..16], translation(0.0, 3.0, 0.0).elements);
        assert_eq!(k.bones[16..32], translation(0.0, -2.0, 0.0).elements);
        assert_eq!(
            k.frame[FRAME_BIND..FRAME_BIND + 16],
            translation(1.0, 0.0, 0.0).elements
        );
        assert_eq!(
            k.frame[FRAME_BIND_INVERSE..FRAME_BIND_INVERSE + 16],
            translation(-1.0, 0.0, 0.0).elements
        );
        assert_eq!(
            k.frame[FRAME_MESH_WORLD..FRAME_MESH_WORLD + 16],
            translation(0.0, 0.0, 5.0).elements
        );
    }

    #[test]
    fn skin_changes_compare_as_js_strict_inequality() {
        let mut g = graph();
        let binding = Binding::new(&g, skinned(), 2, 0);
        let mut k = Kernel::new(skinned());
        binding.read(&g, &mut k);
        assert!(!binding.skin_changed(&g, &k));

        // The mesh's own matrixWorld is not a skin input.
        g.matrix_world[32 + 12] = 4.0;
        assert!(!binding.skin_changed(&g, &k));

        g.matrix_world[16 + 13] = -0.0;
        assert!(!binding.skin_changed(&g, &k), "−0 equals +0");
        g.matrix_world[16 + 13] = 0.5;
        assert!(binding.skin_changed(&g, &k), "bone matrixWorld");
        binding.read(&g, &mut k);
        assert!(!binding.skin_changed(&g, &k));

        g.bone_inverses[12] = 1.0;
        assert!(binding.skin_changed(&g, &k), "boneInverse");
        binding.read(&g, &mut k);
        g.bind_matrix_inverse[0] = f64::NAN;
        binding.read(&g, &mut k);
        assert!(binding.skin_changed(&g, &k), "a NaN always differs");
    }

    #[test]
    fn a_rigid_mesh_has_no_skin_to_change() {
        let mut g = graph();
        let shape = Shape {
            vertices: 1,
            faces: 1,
            ..Shape::default()
        };
        let binding = Binding::new(&g, shape, 0, NO_NODE);
        let mut k = Kernel::new(shape);
        binding.read(&g, &mut k);
        g.matrix_world[16] = 7.0;
        assert!(!binding.skin_changed(&g, &k));
    }

    #[test]
    #[should_panic(expected = "has 1 bone slots, not 2")]
    fn refuses_a_skeleton_of_another_size() {
        let g = graph();
        let shape = Shape {
            bones: 2,
            ..skinned()
        };
        Binding::new(&g, shape, 2, 0);
    }

    #[test]
    #[should_panic(expected = "skeleton 1 is not in the graph")]
    fn refuses_a_skeleton_outside_the_graph() {
        Binding::new(&graph(), skinned(), 2, 1);
    }

    #[test]
    #[should_panic(expected = "not a SkinnedMesh")]
    fn refuses_a_skinned_shape_on_a_plain_node() {
        Binding::new(&graph(), skinned(), 1, 0);
    }
}
