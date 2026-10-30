//! Secondary motion: spring-bone simulation.
//!
//! A port of `src/engine/secondary/spring.ts` and the numeric half of `skin-point-anchor.ts`,
//! operation for operation, reading and writing the avatar's scene graph in place. Names,
//! descriptor defaults and message text stay with the caller; failures come back as [`Status`]
//! codes.

pub mod anchor;
pub mod build;
pub mod collider;
pub mod spring;
mod tree;

pub use build::GroupSpec;
pub use spring::{DriveOutcome, Group, Joint, Spring};

/// Simulation step, seconds. Every group's figures assume it stays 1/60: drag is lost per step,
/// and stiffness and gravity move the tail `figure * STEP` per step rather than being
/// integrated, so another step would retune every avatar.
pub const STEP: f64 = 1.0 / 60.0;

/// Steps allowed in one frame.
///
/// The viewer caps a frame at 50 ms, which runs at most three steps even with a carried
/// remainder, so four is reached only by a caller passing a longer dt. Past the cap the
/// simulation deliberately falls behind rather than spending the frame catching up — hair
/// lagging for a moment after a stall is invisible, and a frame that takes twice as long because
/// the last one did is how a stall becomes permanent.
pub const MAX_STEPS: u32 = 4;

/// Relative slack on `Collider::beyond`; far above rounding, far below a millimetre.
pub const CULL_MARGIN: f64 = 1.0 + 1e-4;

/// Most colliders one `Cluster` holds; a cost trade, with no effect on the result.
pub const CLUSTER_SIZE: usize = 8;

/// What went wrong, for the caller to word.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum StatusKind {
    /// `anchor:<node> requires a finite affine local transform`
    AnchorNotAffine = 1,
    /// `anchor:<node> has a singular local transform`
    AnchorSingular = 2,
    /// `anchor:<node> does not support nonuniform scale`
    AnchorNonuniform = 3,
    /// `anchor:<node> does not support shear`
    AnchorShear = 4,
    /// `anchor:<node> transform mode changed after resolution`
    AnchorModeChanged = 5,
    /// `anchor:<node> scale changed after resolution`
    AnchorScaleChanged = 6,
    /// `anchor:<node> has a manual matrixWorld override`
    AnchorWorldOverride = 9,
    /// `anchor parent world is singular`
    AnchorParentSingular = 12,
    /// `root ancestor is simulated by another group: <node>`
    AncestorSimulated = 20,
    /// `root subtree is simulated by another group: <node>`
    SubtreeSimulated = 21,
    /// `source <node> depends on group <other> at or after this group`
    SourceDepends = 22,
}

/// One report: a group's anchor failed, and the group was switched off or dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status {
    pub kind: StatusKind,
    /// The group's registration key.
    pub group: u32,
    /// The node the failure names, or `NO_NODE`. Past the graph's table it is one of the root's
    /// ancestors, the root's parent first.
    pub node: u32,
    /// Another group's registration key, or `NO_NODE`.
    pub other: u32,
}

#[cfg(test)]
pub(crate) mod testkit {
    //! Synthetic rigs for the in-crate tests.

    use super::{GroupSpec, Spring};
    use crate::math::{Mat4, Quat, Vec3};
    use crate::scene::graph::{
        Graph, NO_NODE, R_MATRIX, R_MATRIX_WORLD, R_POSITION, R_QUATERNION, R_SCALE, RECORD, Shape,
        flag,
    };

    /// A synthetic node: three's defaults but for its parent, class and transform.
    #[derive(Clone, Debug)]
    pub struct Node {
        pub parent: u32,
        pub is_bone: bool,
        pub position: Vec3,
        pub quaternion: Quat,
        pub scale: Vec3,
    }

    impl Node {
        pub fn new(parent: u32, is_bone: bool, position: [f64; 3]) -> Self {
            Self {
                parent,
                is_bone,
                position: Vec3::new(position[0], position[1], position[2]),
                quaternion: Quat::default(),
                scale: Vec3::new(1.0, 1.0, 1.0),
            }
        }
    }

    /// Each node's position in `traverse` order, children in the order they were given. Node 0
    /// is the root; every other node's parent comes before it.
    fn traverse_order(nodes: &[Node]) -> Vec<u32> {
        let mut children = vec![Vec::new(); nodes.len()];
        for (i, n) in nodes.iter().enumerate().skip(1) {
            children[n.parent as usize].push(i);
        }
        let mut index = vec![NO_NODE; nodes.len()];
        let mut next = 0;
        let mut stack = vec![0];
        while let Some(i) = stack.pop() {
            index[i] = next;
            next += 1;
            stack.extend(children[i].iter().rev());
        }
        index
    }

    /// The nodes as a built graph, with identity matrices and every node's graph index.
    pub fn graph(nodes: &[Node]) -> (Graph, Vec<u32>) {
        let index = traverse_order(nodes);
        let mut order = vec![0; nodes.len()];
        for (i, &k) in index.iter().enumerate() {
            order[k as usize] = i;
        }
        let mut g = Graph::new(Shape {
            nodes: nodes.len(),
            ..Shape::default()
        });
        let identity = Mat4::default().elements;
        for i in order {
            let n = &nodes[i];
            let (p, q, s) = (&n.position, &n.quaternion, &n.scale);
            let mut r = [0.0; RECORD];
            r[R_POSITION..R_POSITION + 3].copy_from_slice(&[p.x, p.y, p.z]);
            r[R_QUATERNION..R_QUATERNION + 4].copy_from_slice(&[q.x, q.y, q.z, q.w]);
            r[R_SCALE..R_SCALE + 3].copy_from_slice(&[s.x, s.y, s.z]);
            r[R_MATRIX..R_MATRIX + 16].copy_from_slice(&identity);
            r[R_MATRIX_WORLD..R_MATRIX_WORLD + 16].copy_from_slice(&identity);
            let flags = flag::MATRIX_AUTO_UPDATE
                | flag::MATRIX_WORLD_AUTO_UPDATE
                | if n.is_bone { flag::BONE } else { 0 };
            let parent = if n.parent == NO_NODE {
                NO_NODE
            } else {
                index[n.parent as usize]
            };
            g.push_node(parent, flags, &r);
        }
        g.build();
        (g, index)
    }

    /// `root.updateMatrixWorld(true)`, as the caller runs it before each update.
    pub fn world_update(graph: &mut Graph) {
        graph.update_matrix_world(0, true);
    }

    pub fn quaternion(graph: &Graph, i: u32) -> Quat {
        let q = &graph.quaternion[4 * i as usize..];
        Quat::new(q[0], q[1], q[2], q[3])
    }

    pub fn set_quaternion(graph: &mut Graph, i: u32, q: &Quat) {
        graph.quaternion[4 * i as usize..4 * i as usize + 4].copy_from_slice(&[q.x, q.y, q.z, q.w]);
    }

    fn mat4(s: &[f64], i: u32) -> Mat4 {
        let mut elements = [0.0; 16];
        elements.copy_from_slice(&s[16 * i as usize..16 * i as usize + 16]);
        Mat4::from_elements(elements)
    }

    pub fn matrix(graph: &Graph, i: u32) -> Mat4 {
        mat4(&graph.matrix, i)
    }

    pub fn matrix_world(graph: &Graph, i: u32) -> Mat4 {
        mat4(&graph.matrix_world, i)
    }

    pub fn needs_update(graph: &Graph, i: u32) -> bool {
        graph.flags[i as usize] & flag::MATRIX_WORLD_NEEDS_UPDATE != 0
    }

    /// Sets a node's rotation from XYZ Euler angles.
    pub fn rotate(graph: &mut Graph, node: u32, euler: [f64; 3]) {
        set_quaternion(graph, node, &euler_xyz(euler));
    }

    /// Every node's rotation and world matrix and every tail, as bits.
    pub fn state(graph: &Graph, spring: &Spring) -> Vec<u64> {
        let mut out = Vec::new();
        for i in 0..graph.len() as u32 {
            let q = quaternion(graph, i);
            out.extend([q.x, q.y, q.z, q.w].map(f64::to_bits));
            out.extend(matrix_world(graph, i).elements.map(f64::to_bits));
        }
        for g in spring.groups() {
            for j in &g.joints {
                out.extend([j.cur.x, j.cur.y, j.cur.z].map(f64::to_bits));
            }
        }
        out
    }

    /// A humanoid-ish armature laid out in metres under an armature scale. Nodes are numbered
    /// as they are added; `at` gives a node's graph index once every node is in.
    pub struct Rig {
        nodes: Vec<Node>,
        names: Vec<(String, u32)>,
        scale: f64,
    }

    impl Rig {
        /// An empty rig whose root carries `scale`.
        pub fn new(scale: f64) -> Self {
            let mut root = Node::new(NO_NODE, false, [0.0; 3]);
            root.scale.set(scale, scale, scale);
            Self {
                nodes: vec![root],
                names: vec![("Armature".into(), 0)],
                scale,
            }
        }

        pub fn humanoid(scale: f64) -> Self {
            let mut rig = Self::new(scale);
            let hips = rig.named("Hips", 0, [0.0, 0.9, 0.0]);
            let spine = rig.named("Spine", hips, [0.0, 0.09, 0.0]);
            let chest = rig.named("Chest", spine, [0.0, 0.065, 0.0]);
            let upper = rig.named("UpperChest", chest, [0.0, 0.065, 0.0]);
            let neck = rig.named("Neck", upper, [0.0, 0.09, 0.0]);
            let head = rig.named("Head", neck, [0.0, 0.04, 0.0]);
            rig.named("Crown", head, [0.0, 0.13, 0.0]);
            for (side, sign) in [("L", -1.0), ("R", 1.0)] {
                let shoulder =
                    rig.named(&format!("Shoulder_{side}"), upper, [sign * 0.05, 0.05, 0.0]);
                let arm = rig.named(
                    &format!("UpperArm_{side}"),
                    shoulder,
                    [sign * 0.11, 0.0, 0.0],
                );
                rig.named(&format!("LowerArm_{side}"), arm, [sign * 0.17, 0.0, 0.0]);
            }
            rig
        }

        /// Adds a bone under `parent` at an offset in metres; returns its id.
        pub fn add(&mut self, parent: u32, offset: [f64; 3]) -> u32 {
            let s = self.scale;
            self.nodes.push(Node::new(
                parent,
                true,
                [offset[0] / s, offset[1] / s, offset[2] / s],
            ));
            (self.nodes.len() - 1) as u32
        }

        pub fn named(&mut self, name: &str, parent: u32, offset: [f64; 3]) -> u32 {
            let id = self.add(parent, offset);
            self.names.push((name.into(), id));
            id
        }

        /// The graph index of node `id`.
        pub fn at(&self, id: u32) -> u32 {
            traverse_order(&self.nodes)[id as usize]
        }

        /// The id of a named bone.
        pub fn bone(&self, name: &str) -> u32 {
            self.names
                .iter()
                .find(|(n, _)| n == name)
                .unwrap_or_else(|| panic!("no bone {name}"))
                .1
        }

        /// The graph index of a named bone.
        pub fn node(&self, name: &str) -> u32 {
            self.at(self.bone(name))
        }

        /// The rig's graph after a world update, and a solver over it.
        pub fn spring(&self) -> (Graph, Spring) {
            let (mut graph, _) = graph(&self.nodes);
            world_update(&mut graph);
            let spring = Spring::new(&graph);
            (graph, spring)
        }
    }

    /// A straight chain of `joints` links and its leaf, returned root first.
    pub fn chain(
        rig: &mut Rig,
        parent: u32,
        joints: usize,
        root_offset: [f64; 3],
        segment: [f64; 3],
    ) -> Vec<u32> {
        let mut out = Vec::new();
        let mut attach = parent;
        for i in 0..=joints {
            attach = rig.add(attach, if i == 0 { root_offset } else { segment });
            out.push(attach);
        }
        out
    }

    /// three's `setFromEuler` for order XYZ; bit equality with three is not needed here.
    pub fn euler_xyz([x, y, z]: [f64; 3]) -> Quat {
        let (c1, c2, c3) = ((x / 2.0).cos(), (y / 2.0).cos(), (z / 2.0).cos());
        let (s1, s2, s3) = ((x / 2.0).sin(), (y / 2.0).sin(), (z / 2.0).sin());
        Quat::new(
            s1 * c2 * c3 + c1 * s2 * s3,
            c1 * s2 * c3 - s1 * c2 * s3,
            c1 * c2 * s3 + s1 * s2 * c3,
            c1 * c2 * c3 - s1 * s2 * s3,
        )
    }

    /// A group with the descriptor defaults for everything but the three figures.
    pub fn group(stiffness: f64, drag: f64, gravity: f64) -> GroupSpec {
        GroupSpec {
            stiffness,
            drag,
            gravity,
            gravity_dir: Vec3::new(0.0, -1.0, 0.0),
            radius: 0.02,
        }
    }
}
