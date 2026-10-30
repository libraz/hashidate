//! Anatomy, ported from `src/engine/anatomy/`: what a joint can do, and what the body it hangs on
//! is in the way of.
//!
//! `joints` is the table itself, `strain` scores a value against it, `surface` queries a body
//! part's measured surface, and `volumes` assembles the trunk and the head from those
//! measurements. `arm` puts them together for one arm, and `cost` turns what it reads off a pose
//! into strain, a search cost and a readout. `face` is the head's skin for the fingers.
//!
//! Node reads go through the [`Graph`] the way three's do: every world read updates the node's
//! ancestors first, so the update calls stay one for one with the TS.

pub mod arm;
pub mod arm_frame;
pub mod cost;
pub mod face;
pub mod joints;
pub mod palm_frame;
pub mod strain;
pub mod surface;
pub mod volumes;

/// The base avatar with its anatomy built, as `tests/anatomy/*.test.ts` build theirs.
#[cfg(test)]
pub(crate) mod testkit {
    use super::arm::ArmAnatomy;
    use crate::math::{Quat, Vec3};
    use crate::profile::{BoneSlot, Finger, Profile, Side, base};
    use crate::scene::graph::Graph;

    pub struct Body {
        pub graph: Graph,
        pub profile: Profile,
        pub anat: ArmAnatomy,
        pub up: Vec3,
        pub down: Vec3,
        pub fwd: Vec3,
        pub right: Vec3,
    }

    impl Body {
        /// The character's own outside, per side.
        pub fn outward(&self, side: Side) -> Vec3 {
            let mut v = self.right;
            if side == Side::L {
                v.negate();
            }
            v
        }

        /// The chest bone the anatomy reads.
        pub fn chest(&self) -> u32 {
            self.profile.chest().expect("a chest")
        }

        /// Put the arm's origin and lengths in, so the torso terms are live.
        pub fn place_arm(&mut self, side: Side) {
            let (s, la, lf, lh) = arm_of(&mut self.graph, &self.profile, side);
            self.anat.set_arm(&s, la, lf, lh);
        }
    }

    /// The shoulder and segment lengths `placeArm` hands `setArm`.
    pub fn arm_of(graph: &mut Graph, p: &Profile, side: Side) -> (Vec3, f64, f64, f64) {
        let bone = p
            .bone(match side {
                Side::L => BoneSlot::UpperArmL,
                Side::R => BoneSlot::UpperArmR,
            })
            .expect("an upper arm");
        graph.update_world_matrix(bone, true, false, false);
        let limb = &p.limb[side as usize];
        (
            graph.world_position(bone),
            limb.upper.unwrap(),
            limb.lower.unwrap(),
            limb.tip[Finger::Middle as usize].unwrap() * 0.35,
        )
    }

    /// The base avatar with its root turned `yaw` about up and scaled by `scale`, then updated.
    pub fn graph_and_profile(yaw: f64, scale: f64) -> (Graph, Profile) {
        let (mut graph, profile) = base::avatar();
        if yaw != 0.0 {
            let mut q = Quat::default();
            q.set_from_euler_xyz(0.0, yaw, 0.0);
            graph.set_local_quaternion(0, &q);
        }
        for s in &mut graph.scale[0..3] {
            *s *= scale;
        }
        graph.update_matrix_world(0, true);
        (graph, profile)
    }

    /// An anatomy over `graph` and `profile`, updated once.
    pub fn body_of(mut graph: Graph, profile: Profile) -> Body {
        let mut anat = ArmAnatomy::new(&profile, &mut graph);
        assert!(anat.update(&mut graph));
        let (up, fwd, right) = (*anat.up(), *anat.fwd(), *anat.right());
        let mut down = up;
        down.negate();
        Body {
            graph,
            profile,
            anat,
            up,
            down,
            fwd,
            right,
        }
    }

    pub fn body() -> Body {
        let (graph, profile) = graph_and_profile(0.0, 1.0);
        body_of(graph, profile)
    }

    /// A direction `angle` away from `from`, swung toward `toward`.
    pub fn swung(from: &Vec3, toward: &Vec3, angle: f64) -> Vec3 {
        let mut v = *from;
        v.multiply_scalar(angle.cos())
            .add_scaled_vector(toward, angle.sin())
            .normalize();
        v
    }

    /// vitest's `toBeCloseTo(b, digits)`.
    pub fn close(a: f64, b: f64, digits: i32) {
        let tolerance = 10f64.powi(-digits) / 2.0;
        assert!((a - b).abs() < tolerance, "{a} is not close to {b}");
    }
}
