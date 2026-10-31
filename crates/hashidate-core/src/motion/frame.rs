//! `motion/frame.ts`: the one boundary between the character frame gestures are authored in and
//! the world frame the rig is spoken to in.
//!
//! The TS frame holds the rig and its profile; this one keeps the profile's `sideSign`, the only
//! part of the profile it reads, and takes the rig's anatomy and the graph with each call that may
//! resolve the anatomical frame. A tuple and a `Vector3` value are both `[f64; 3]` here: the TS
//! reads a missing tuple element as 0, and the caller fills it in. `None` is the TS `undefined`:
//! `lateral` defaults to `side_mirror(side)`, and an unknown `frame_ready` resolves the frame.

use crate::anatomy::arm::ArmAnatomy;
use crate::math::Vec3;
use crate::profile::{Profile, Side};
use crate::scene::graph::Graph;

// frame.ts sideMirror
//
// Lateral sign in the semantic character frame, independent of world yaw.
pub fn side_mirror(side: Side) -> f64 {
    if side == Side::R { 1.0 } else { -1.0 }
}

// frame.ts rotationMirror
//
// Axial rotation sign; it retains the shipped left/right twist orientation.
pub fn rotation_mirror(side: Side) -> f64 {
    -side_mirror(side)
}

/// Everything above this is *character space* — x outward from the midline, y up, z forward —
/// which is what lets one authored gesture serve both arms on any rig. Everything the rig is
/// handed is world space. The conversion happens here and nowhere else, and it goes both ways:
/// a solver answers in world directions and those have to come back before they are allowed to
/// become follower state, or a root turn would masquerade as a gesture change.
///
/// The fallback path matters as much as the main one. A rig whose body frame the profile could
/// not resolve has no anatomical axes to project through, and then these keep exactly the
/// pre-frame world-X behaviour the profile's `sideSign` describes — which is the behaviour every
/// avatar had before there was a frame, and the one thing that must not change underneath one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CharacterFrame {
    side_sign: f64,
}

impl CharacterFrame {
    // frame.ts CharacterFrame.constructor
    pub fn new(p: &Profile) -> CharacterFrame {
        CharacterFrame {
            side_sign: p.side_sign,
        }
    }

    // frame.ts CharacterFrame.ready
    //
    // Whether the anatomical frame resolved this frame.
    pub fn ready(&self, anat: &mut ArmAnatomy, graph: &mut Graph) -> bool {
        anat.update(graph)
    }

    // frame.ts CharacterFrame.legacyMirror
    //
    // The profile's `sideSign` is only a fallback for a rig with no body frame. Once anatomy has
    // resolved, the lateral axis comes from the live chest and therefore follows root yaw and
    // every committed spine offset.
    pub fn legacy_mirror(&self, side: Side) -> f64 {
        if side == Side::L {
            self.side_sign
        } else {
            -self.side_sign
        }
    }

    // frame.ts CharacterFrame.axialMirror
    //
    // Sign for rotations about an arm axis. With a resolved body frame the lateral semantic sign
    // and the axial sign differ; without one, preserve the profile's pre-frame convention exactly.
    pub fn axial_mirror(
        &self,
        anat: &mut ArmAnatomy,
        graph: &mut Graph,
        side: Side,
        frame_ready: Option<bool>,
    ) -> f64 {
        let ready = frame_ready.unwrap_or_else(|| self.ready(anat, graph));
        if ready {
            rotation_mirror(side)
        } else {
            self.legacy_mirror(side)
        }
    }

    // frame.ts CharacterFrame.toWorld
    //
    // Project a character-space direction into world space without touching the authored tuple.
    // `lateral` is normally the semantic side sign; a value of one is used for an absolute point
    // bearing. The fallback deliberately keeps the old world-X behaviour when no anatomical frame
    // can be resolved.
    #[allow(clippy::too_many_arguments)]
    pub fn to_world<'o>(
        &self,
        anat: &mut ArmAnatomy,
        graph: &mut Graph,
        out: &'o mut Vec3,
        value: &[f64; 3],
        side: Side,
        lateral: Option<f64>,
        frame_ready: Option<bool>,
    ) -> &'o mut Vec3 {
        let lateral = lateral.unwrap_or_else(|| side_mirror(side));
        let x = value[0] * lateral;
        let y = value[1];
        let z = value[2];
        let ready = frame_ready.unwrap_or_else(|| self.ready(anat, graph));
        if ready {
            return out
                .copy(anat.right())
                .multiply_scalar(x)
                .add_scaled_vector(anat.up(), y)
                .add_scaled_vector(anat.fwd(), z)
                .normalize();
        }
        out.set(value[0] * -self.side_sign * lateral, y, z)
            .normalize()
    }

    // frame.ts CharacterFrame.tupleToWorld
    //
    // The tuple form of `toWorld`, for the world-space contract at the Rig boundary. A separate
    // buffer keeps `_armDirs` and `_palmOut` canonical.
    #[allow(clippy::too_many_arguments)]
    pub fn tuple_to_world<'o>(
        &self,
        anat: &mut ArmAnatomy,
        graph: &mut Graph,
        out: &'o mut [f64; 3],
        value: &[f64; 3],
        side: Side,
        lateral: Option<f64>,
        frame_ready: Option<bool>,
    ) -> &'o mut [f64; 3] {
        let lateral = lateral.unwrap_or_else(|| side_mirror(side));
        let x = value[0] * lateral;
        let y = value[1];
        let z = value[2];
        let ready = frame_ready.unwrap_or_else(|| self.ready(anat, graph));
        if ready {
            let (right, up, fwd) = (anat.right(), anat.up(), anat.fwd());
            out[0] = right.x * x + up.x * y + fwd.x * z;
            out[1] = right.y * x + up.y * y + fwd.y * z;
            out[2] = right.z * x + up.z * y + fwd.z * z;
            return out;
        }
        out[0] = value[0] * -self.side_sign * lateral;
        out[1] = y;
        out[2] = z;
        out
    }

    // frame.ts CharacterFrame.toCharacter
    //
    // Bring a world-space solver result back into the canonical blend frame. Solvers never write
    // into the follower state directly: this inverse is the one boundary where a world result
    // becomes a character-space direction.
    pub fn to_character<'o>(
        &self,
        anat: &mut ArmAnatomy,
        graph: &mut Graph,
        out: &'o mut Vec3,
        value: &Vec3,
        side: Side,
        frame_ready: Option<bool>,
    ) -> &'o mut Vec3 {
        let ready = frame_ready.unwrap_or_else(|| self.ready(anat, graph));
        if ready {
            let x = value.dot(anat.right()) * side_mirror(side);
            let y = value.dot(anat.up());
            let z = value.dot(anat.fwd());
            return out.set(x, y, z).normalize();
        }
        out.set(value.x * self.legacy_mirror(side), value.y, value.z)
            .normalize()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::base;

    const VALUE: [f64; 3] = [0.3, -0.8, 0.5];

    fn unit(x: f64, y: f64, z: f64) -> Vec3 {
        let mut v = Vec3::new(x, y, z);
        v.normalize();
        v
    }

    fn close(a: &Vec3, b: &Vec3) {
        assert!(a.distance_to(b) < 1e-12, "{a:?} against {b:?}");
    }

    #[test]
    fn gives_the_axial_sign_opposite_to_the_lateral_one() {
        assert_eq!(side_mirror(Side::R), 1.0);
        assert_eq!(side_mirror(Side::L), -1.0);
        for side in Side::BOTH {
            assert_eq!(rotation_mirror(side), -side_mirror(side));
        }
    }

    #[test]
    fn projects_through_the_resolved_body_frame_and_back() {
        let (mut g, p) = base::avatar();
        let mut anat = ArmAnatomy::new(&p, &mut g);
        let axes = CharacterFrame::new(&p);
        assert!(axes.ready(&mut anat, &mut g));
        for side in Side::BOTH {
            let mut world = Vec3::default();
            axes.to_world(&mut anat, &mut g, &mut world, &VALUE, side, None, None);
            let mut want = *anat.right();
            want.multiply_scalar(VALUE[0] * side_mirror(side))
                .add_scaled_vector(anat.up(), VALUE[1])
                .add_scaled_vector(anat.fwd(), VALUE[2])
                .normalize();
            assert_eq!(world, want);
            let mut tuple = [0.0; 3];
            axes.tuple_to_world(&mut anat, &mut g, &mut tuple, &VALUE, side, None, None);
            close(&unit(tuple[0], tuple[1], tuple[2]), &world);
            let mut back = Vec3::default();
            axes.to_character(&mut anat, &mut g, &mut back, &world, side, None);
            close(&back, &unit(VALUE[0], VALUE[1], VALUE[2]));
            // An absolute bearing keeps its sign on both sides.
            axes.to_world(
                &mut anat,
                &mut g,
                &mut world,
                &VALUE,
                side,
                Some(1.0),
                Some(true),
            );
            let mut absolute = Vec3::default();
            axes.to_world(
                &mut anat,
                &mut g,
                &mut absolute,
                &VALUE,
                Side::R,
                None,
                Some(true),
            );
            assert_eq!(world, absolute);
            assert_eq!(
                axes.axial_mirror(&mut anat, &mut g, side, None),
                rotation_mirror(side)
            );
        }
    }

    #[test]
    fn keeps_the_profile_world_x_convention_without_a_body_frame() {
        for side_sign in [1.0, -1.0] {
            let (mut g, mut p) = base::avatar();
            p.body = None;
            p.side_sign = side_sign;
            let mut anat = ArmAnatomy::new(&p, &mut g);
            let axes = CharacterFrame::new(&p);
            assert!(!axes.ready(&mut anat, &mut g));
            assert_eq!(axes.legacy_mirror(Side::L), side_sign);
            assert_eq!(axes.legacy_mirror(Side::R), -side_sign);
            for side in Side::BOTH {
                let mirror = side_mirror(side);
                assert_eq!(
                    axes.axial_mirror(&mut anat, &mut g, side, None),
                    axes.legacy_mirror(side)
                );
                let mut world = Vec3::default();
                axes.to_world(&mut anat, &mut g, &mut world, &VALUE, side, None, None);
                assert_eq!(
                    world,
                    unit(VALUE[0] * -side_sign * mirror, VALUE[1], VALUE[2])
                );
                let mut tuple = [0.0; 3];
                axes.tuple_to_world(&mut anat, &mut g, &mut tuple, &VALUE, side, None, None);
                assert_eq!(tuple, [VALUE[0] * -side_sign * mirror, VALUE[1], VALUE[2]]);
                let mut back = Vec3::default();
                axes.to_character(&mut anat, &mut g, &mut back, &world, side, None);
                let legacy = axes.legacy_mirror(side);
                assert_eq!(back, unit(world.x * legacy, world.y, world.z));
            }
        }
    }

    #[test]
    fn takes_a_given_frame_readiness_over_the_resolved_frame() {
        let (mut g, p) = base::avatar();
        let mut anat = ArmAnatomy::new(&p, &mut g);
        let axes = CharacterFrame::new(&p);
        assert!(axes.ready(&mut anat, &mut g));
        let mut world = Vec3::default();
        axes.to_world(
            &mut anat,
            &mut g,
            &mut world,
            &VALUE,
            Side::L,
            None,
            Some(false),
        );
        let legacy = VALUE[0] * -p.side_sign * side_mirror(Side::L);
        assert_eq!(world, unit(legacy, VALUE[1], VALUE[2]));
        assert_eq!(
            axes.axial_mirror(&mut anat, &mut g, Side::L, Some(false)),
            axes.legacy_mirror(Side::L)
        );
    }
}
