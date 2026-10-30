//! `rig/skeleton.ts`: `root.updateMatrixWorld(true)` without the subtrees that hold no bone.

use crate::scene::graph::{Graph, flag};

/// `root.updateMatrixWorld(true)` without the subtrees that hold no bone.
///
/// Every bone, everything parented under one and every ancestor of one up to
/// `root` comes out exactly as the full pass would leave it: ancestors are
/// recomputed node by node top-down, then each topmost bone's subtree in full.
/// The skipped subtrees are, on a heavy avatar, mostly skinned meshes, each of
/// which also inverts a matrix per pass. Skipping them is exact only when nothing
/// has moved since the last full pass but bones, which is the caller's to know.
///
/// The topology is captured once: nothing adds a bone after the profile is built.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkeletonRefresh {
    pub(crate) path: Vec<u32>,
    pub(crate) subtrees: Vec<u32>,
}

impl SkeletonRefresh {
    // skeleton.ts SkeletonRefresh.constructor
    pub fn new(graph: &Graph, root: u32) -> SkeletonRefresh {
        let mut refresh = SkeletonRefresh {
            path: vec![root],
            subtrees: Vec::new(),
        };
        let r = root as usize;
        for k in graph.child_offsets[r]..graph.child_offsets[r + 1] {
            refresh.collect(graph, graph.children[k as usize]);
        }
        refresh
    }

    // skeleton.ts SkeletonRefresh.run
    pub fn run(&self, graph: &mut Graph) {
        for &node in &self.path {
            graph.update_world_matrix(node, false, false, true);
        }
        for &node in &self.subtrees {
            graph.update_matrix_world(node, true);
        }
    }

    // skeleton.ts SkeletonRefresh.collect
    //
    // Whether `node` holds a bone; ancestors land in `path` before their descendants.
    fn collect(&mut self, graph: &Graph, node: u32) -> bool {
        // A node with its own matrix-world step (a skinned mesh, a camera) is taken
        // whole, so its extra state is refreshed exactly as the full pass does it.
        // The class decides, not the instance: a core-backed node replaces both methods.
        //
        // The graph admits no class with its own step but SkinnedMesh, so its kind flag is
        // the whole test.
        let n = node as usize;
        if graph.flags[n] & (flag::BONE | flag::SKINNED) != 0 {
            if !Self::holds_bone(graph, node) {
                return false;
            }
            self.subtrees.push(node);
            return true;
        }
        let at = self.path.len();
        self.path.push(node);
        let mut holds = false;
        for k in graph.child_offsets[n]..graph.child_offsets[n + 1] {
            if self.collect(graph, graph.children[k as usize]) {
                holds = true;
            }
        }
        if !holds {
            self.path.truncate(at);
        }
        holds
    }

    // skeleton.ts SkeletonRefresh.holdsBone
    fn holds_bone(graph: &Graph, node: u32) -> bool {
        let n = node as usize;
        if graph.flags[n] & flag::BONE != 0 {
            return true;
        }
        (graph.child_offsets[n]..graph.child_offsets[n + 1])
            .any(|k| Self::holds_bone(graph, graph.children[k as usize]))
    }
}

#[cfg(test)]
mod tests {
    //! `tests/rig/skeleton.test.ts`, on a graph with every kind of node the refresh treats
    //! differently.
    use super::*;
    use crate::math::{Mat4, Quat};
    use crate::scene::graph::{NO_NODE, RECORD, Shape};

    const AUTO: u8 = flag::MATRIX_AUTO_UPDATE | flag::MATRIX_WORLD_AUTO_UPDATE;
    const ROOT: u32 = 0;
    const ARMATURE: u32 = 1;
    const HIPS: u32 = 2;
    const SPINE: u32 = 3;
    const ACCESSORY: u32 = 4;
    const BESIDE: u32 = 5;
    const LAYER: u32 = 6;
    const CARRIER: u32 = 7;
    const CARRIED: u32 = 8;

    fn record(position: [f64; 3], q: Quat, scale: f64) -> [f64; RECORD] {
        let mut r = [0.0; RECORD];
        r[0..3].copy_from_slice(&position);
        r[3..7].copy_from_slice(&[q.x, q.y, q.z, q.w]);
        r[7..10].copy_from_slice(&[scale; 3]);
        r[13..29].copy_from_slice(&Mat4::default().elements);
        r[29..45].copy_from_slice(&Mat4::default().elements);
        r
    }

    fn euler(x: f64, y: f64, z: f64) -> Quat {
        *Quat::default().set_from_euler_xyz(x, y, z)
    }

    /// The tree of the TS test: an outer ancestor, a scaled root, an armature with a two-bone
    /// spine and an accessory under it, a skinned mesh beside the skeleton with a plain layer
    /// under it, and a skinned mesh carrying a bone.
    fn scene() -> Graph {
        let mut g = Graph::new(Shape {
            nodes: 9,
            meshes: 2,
            skeletons: 1,
            bones: 2,
        });
        let id = Quat::default();
        g.push_node(
            NO_NODE,
            AUTO,
            &record([0.0; 3], euler(0.1, 0.5, -0.2), 0.01),
        );
        g.push_node(ROOT, AUTO, &record([3.0, 1.0, -2.0], id, 1.0));
        g.push_node(
            ARMATURE,
            AUTO | flag::BONE,
            &record([0.0, 90.0, 0.0], id, 1.0),
        );
        g.push_node(HIPS, AUTO | flag::BONE, &record([0.0, 12.0, 1.0], id, 1.0));
        g.push_node(SPINE, AUTO, &record([2.0, 3.0, 4.0], id, 1.0));
        g.push_node(
            ARMATURE,
            AUTO | flag::SKINNED,
            &record([-1.0, 0.0, 2.0], id, 1.0),
        );
        g.push_node(BESIDE, AUTO, &record([0.0; 3], id, 1.0));
        g.push_node(
            ROOT,
            AUTO | flag::SKINNED,
            &record([0.5, 0.5, 0.0], id, 1.0),
        );
        g.push_node(
            CARRIER,
            AUTO | flag::BONE,
            &record([1.0, 1.0, 1.0], id, 1.0),
        );
        let identity = Mat4::default();
        g.push_mesh(BESIDE, &identity, &identity);
        g.push_mesh(CARRIER, &identity, &identity);
        g.push_skeleton();
        g.push_bone(HIPS, &identity);
        g.push_bone(SPINE, &identity);
        g.build();
        g.set_ancestors(1);
        let mut outer = Mat4::default();
        outer.make_translation(0.4, -0.2, 0.1);
        let a = &mut g.ancestors;
        a[0..3].copy_from_slice(&[0.4, -0.2, 0.1]);
        a[3..7].copy_from_slice(&[0.0, 0.0, 0.0, 1.0]);
        a[7..10].copy_from_slice(&[1.0; 3]);
        a[13..29].copy_from_slice(&outer.elements);
        a[29..45].copy_from_slice(&outer.elements);
        g.ancestor_flags[0] = AUTO;
        g.update_matrix_world(ROOT, true);
        g
    }

    fn state(g: &Graph, nodes: &[u32]) -> Vec<u64> {
        let mut out = Vec::new();
        for &i in nodes {
            let n = i as usize;
            out.extend(g.matrix[16 * n..16 * n + 16].iter().map(|v| v.to_bits()));
            out.extend(
                g.matrix_world[16 * n..16 * n + 16]
                    .iter()
                    .map(|v| v.to_bits()),
            );
            if let Some(m) = g.mesh_nodes.iter().position(|&m| m == i) {
                out.extend(
                    g.bind_matrix_inverse[16 * m..16 * m + 16]
                        .iter()
                        .map(|v| v.to_bits()),
                );
            }
        }
        out
    }

    /// The TS `move`, at its `step`th application: rotations accumulate as Euler angles.
    fn move_nodes(g: &mut Graph, step: usize) {
        let k = (step + 1) as f64;
        g.set_local_quaternion(ROOT, &euler(0.1, 0.5 + 0.3 * k, -0.2));
        g.position[3 * ARMATURE as usize] = 3.0 - 0.5 * k;
        g.set_local_quaternion(HIPS, &euler(0.2, -0.1, 0.3));
        g.position[3 * SPINE as usize + 2] = 1.0 + 2.0 * k;
        g.set_local_quaternion(CARRIER, &euler(0.4 * k, 0.0, 0.0));
        g.set_local_quaternion(CARRIED, &euler(0.0, 0.0, -0.2 * k));
    }

    const FRESH: [u32; 7] = [ROOT, ARMATURE, HIPS, SPINE, ACCESSORY, CARRIER, CARRIED];
    const BESIDE_NODES: [u32; 2] = [BESIDE, LAYER];

    #[test]
    fn takes_the_path_to_each_bone_and_each_topmost_bone_subtree() {
        let g = scene();
        let refresh = SkeletonRefresh::new(&g, ROOT);
        assert_eq!(refresh.path, vec![ROOT, ARMATURE]);
        assert_eq!(refresh.subtrees, vec![HIPS, CARRIER]);
    }

    #[test]
    fn leaves_bones_their_descendants_and_their_ancestors_exactly_as_a_full_root_pass_does() {
        let mut actual = scene();
        let mut reference = scene();
        let refresh = SkeletonRefresh::new(&actual, ROOT);
        for step in 0..3 {
            move_nodes(&mut actual, step);
            move_nodes(&mut reference, step);
            let stale = state(&actual, &BESIDE_NODES);
            refresh.run(&mut actual);
            reference.update_matrix_world(ROOT, true);
            assert_eq!(
                state(&actual, &FRESH),
                state(&reference, &FRESH),
                "step {step}"
            );
            // Holds no bone: left for the next full pass.
            assert_eq!(state(&actual, &BESIDE_NODES), stale, "step {step}");
            actual.update_matrix_world(ROOT, true);
            let all: Vec<u32> = (0..9).collect();
            assert_eq!(state(&actual, &all), state(&reference, &all), "step {step}");
        }
    }
}
