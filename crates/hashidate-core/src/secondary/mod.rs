//! Secondary motion: spring-bone simulation.
//!
//! A port of `src/engine/secondary/spring.ts` and the numeric half of `skin-point-anchor.ts`,
//! operation for operation, over a node table the caller mirrors from three. Names, descriptor
//! defaults and message text stay with the caller; failures come back as [`Status`] codes.

pub mod anchor;
pub mod build;
pub mod collider;
pub mod spring;

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
    /// `anchor path was reparented at <node>`
    AnchorPathReparented = 7,
    /// `anchor path root was reparented at <node>`
    AnchorPathRootReparented = 8,
    /// `anchor:<node> has a manual matrixWorld override`
    AnchorWorldOverride = 9,
    /// `anchor root was reparented at <node>`
    AnchorRootReparented = 10,
    /// `anchor subtree was reparented at <node>`
    AnchorSubtreeReparented = 11,
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
    /// The node the failure names, or `scene::NONE`.
    pub node: u32,
    /// Another group's registration key, or `scene::NONE`.
    pub other: u32,
}

#[cfg(test)]
pub(crate) mod testkit {
    //! Synthetic rigs for the in-crate tests.

    use super::{GroupSpec, Spring};
    use crate::math::{Quat, Vec3};
    use crate::scene::Node;

    /// A humanoid-ish armature laid out in metres under an armature scale.
    pub struct Rig {
        pub nodes: Vec<Node>,
        names: Vec<(String, u32)>,
        scale: f64,
    }

    impl Rig {
        /// An empty rig whose root carries `scale`.
        pub fn new(scale: f64) -> Self {
            let mut root = Node::default();
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

        /// Adds a bone under `parent` at an offset in metres.
        pub fn add(&mut self, parent: u32, offset: [f64; 3]) -> u32 {
            let mut node = Node {
                parent,
                is_bone: true,
                ..Node::default()
            };
            let s = self.scale;
            node.position
                .set(offset[0] / s, offset[1] / s, offset[2] / s);
            self.nodes.push(node);
            (self.nodes.len() - 1) as u32
        }

        pub fn named(&mut self, name: &str, parent: u32, offset: [f64; 3]) -> u32 {
            let index = self.add(parent, offset);
            self.names.push((name.into(), index));
            index
        }

        pub fn bone(&self, name: &str) -> u32 {
            self.names
                .iter()
                .find(|(n, _)| n == name)
                .unwrap_or_else(|| panic!("no bone {name}"))
                .1
        }

        /// A solver over the rig, every node registered and posed.
        pub fn spring(&self) -> Spring {
            let mut spring = Spring::new(0);
            for node in &self.nodes {
                spring.add_node(node.clone());
            }
            self.world_update(&mut spring);
            spring
        }

        /// `root.updateMatrixWorld(true)` over the whole rig.
        pub fn world_update(&self, spring: &mut Spring) {
            let all: Vec<u32> = (0..self.nodes.len() as u32).collect();
            spring.scene_mut().update_matrix_world_forced(&all);
        }

        /// Sets a node's rotation from XYZ Euler angles.
        pub fn rotate(&self, spring: &mut Spring, node: u32, euler: [f64; 3]) {
            spring.scene_mut().node_mut(node).quaternion = euler_xyz(euler);
        }

        /// Every node's rotation and world matrix and every tail, as bits.
        pub fn state(&self, spring: &Spring) -> Vec<u64> {
            let mut out = Vec::new();
            for i in 0..self.nodes.len() as u32 {
                let n = spring.scene().node(i);
                let q = n.quaternion;
                out.extend([q.x, q.y, q.z, q.w].map(f64::to_bits));
                out.extend(n.matrix_world.elements.map(f64::to_bits));
            }
            for g in spring.groups() {
                for j in &g.joints {
                    out.extend([j.cur.x, j.cur.y, j.cur.z].map(f64::to_bits));
                }
            }
            out
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
