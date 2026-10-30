//! `rig/spine.ts`: the additive half of a frame.
//!
//! The arm chains are *aimed* — told a world direction and rotated onto it — and
//! the spine is not: a breath, a lean and a head turn are small rotations that
//! add up, and there is no direction to aim a hip at. So the layers above stack
//! radians per slot over a frame and this bakes the sum into local quaternions
//! once, after everything has had its say.
//!
//! The eyes ride along because they are the same shape of problem: a gaze offset
//! is additive on top of a rest orientation, and nothing aims an eyeball.
//!
//! `profile.root` is node 0 of the graph.

use crate::math::f::{js_sign, tanh};
use crate::math::{Mat4, Quat, Vec3};
use crate::profile::{BoneSlot, Profile};
use crate::scene::graph::Graph;

const ROOT: u32 = 0;

/// Spine-chain slots plus the eyes, which take the same additive treatment.
///
/// In `BoneSlot` order, so a slot's index is its bone slot's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OffsetSlot {
    Hips,
    Spine,
    Chest,
    Neck,
    Head,
    EyeL,
    EyeR,
}

impl OffsetSlot {
    pub const ALL: [OffsetSlot; 7] = [
        OffsetSlot::Hips,
        OffsetSlot::Spine,
        OffsetSlot::Chest,
        OffsetSlot::Neck,
        OffsetSlot::Head,
        OffsetSlot::EyeL,
        OffsetSlot::EyeR,
    ];

    /// The bone slot the offset turns.
    pub const fn bone(self) -> BoneSlot {
        match self {
            OffsetSlot::Hips => BoneSlot::Hips,
            OffsetSlot::Spine => BoneSlot::Spine,
            OffsetSlot::Chest => BoneSlot::Chest,
            OffsetSlot::Neck => BoneSlot::Neck,
            OffsetSlot::Head => BoneSlot::Head,
            OffsetSlot::EyeL => BoneSlot::EyeL,
            OffsetSlot::EyeR => BoneSlot::EyeR,
        }
    }
}

/// A `SpineSlot`'s knee and ceiling, radians.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpineLimit {
    pub knee: f64,
    pub max: f64,
}

/// How far the summed offset on one spine slot may turn about each axis, radians, per spine
/// slot (`hips` to `head`, [`OffsetSlot`] order).
///
/// Read by the motion schema, which refuses a keyframe past `max`, and by the
/// commit, which passes everything up to `knee` through untouched and saturates
/// smoothly toward `max` beyond it. Not anatomy: the neck and trunk ranges in
/// `anatomy/joints.ts` bound a whole region, and the built-in layers already
/// stack past them on one slot.
pub const SPINE_LIMITS: [SpineLimit; 5] = [
    // Each knee sits above the worst built-in stack on that slot — gesture table at
    // full variation, posture at every tuning maximum with two overlapping nods,
    // default gaze limits: hips 0.06, spine 0.23, chest 0.28, neck 0.60, head 0.94.
    // A held mood attitude adds its own term on top (head 0.2 for the largest), so
    // a contrived stack enters the knee and saturates; no attitude reaches it alone.
    SpineLimit {
        knee: 0.25,
        max: 0.45,
    },
    SpineLimit {
        knee: 0.3,
        max: 0.5,
    },
    SpineLimit {
        knee: 0.35,
        max: 0.55,
    },
    SpineLimit {
        knee: 0.7,
        max: 0.9,
    },
    SpineLimit {
        knee: 1.05,
        max: 1.2,
    },
];

const SPINE_CHAIN: [OffsetSlot; 5] = [
    OffsetSlot::Hips,
    OffsetSlot::Spine,
    OffsetSlot::Chest,
    OffsetSlot::Neck,
    OffsetSlot::Head,
];
const EYES: [OffsetSlot; 2] = [OffsetSlot::EyeL, OffsetSlot::EyeR];

// spine.ts boundSpineOffset
//
// One summed component, bounded by `SPINE_LIMITS`.
//
// Identity up to the knee, so every built-in pose commits bit-identically; past
// it a tanh carries on at slope 1 and approaches `max` without reaching it, so a
// stack that runs long eases to a stop instead of hitting one.
//
// `slot` is a spine-chain slot; the eyes have no bound.
pub fn bound_spine_offset(slot: OffsetSlot, value: f64) -> f64 {
    let SpineLimit { knee, max } = SPINE_LIMITS[slot as usize];
    let over = value.abs() - knee;
    if over <= 0.0 {
        return value;
    }
    let band = max - knee;
    js_sign(value) * (knee + band * tanh(over / band))
}

/// Radians about each axis, accumulated over a frame.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Offset {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// A slot's change of basis and its inverse.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Basis {
    q: Quat,
    inverse: Quat,
}

/// The TS keeps `offset` as a map and a `spare` record per slot so `add` allocates nothing in
/// steady state; here a slot's entry is present or not, which is the same thing without the
/// map.
#[derive(Clone, Debug, PartialEq)]
pub struct SpineOffsets {
    /// slot -> additive Euler offset for this frame, in [`OffsetSlot`] order
    pub offset: [Option<Offset>; 7],
    /// Basis that turns a root-authored rotation into this bone's rest frame.
    ///
    /// A pose describes the spine in one vocabulary: XYZ about the avatar's
    /// root. A model is free to put a bone's local axes somewhere else, though,
    /// and `restLocal * authored` consequently makes the same cue mean a
    /// different thing on every such model. Capture the change of basis once,
    /// while the profile is still in its rest pose, so committing a frame remains
    /// a fixed amount of quaternion work with no per-frame matrix or object
    /// creation.
    basis: [Option<Basis>; 7],
}

impl SpineOffsets {
    // spine.ts SpineOffsets.constructor
    pub fn new(profile: &Profile, graph: &mut Graph) -> SpineOffsets {
        // World quaternions are only meaningful after the hierarchy has been
        // walked. This root-authored XYZ contract deliberately keeps the runtime
        // vocabulary independent of each model's bone roll and pitch.
        graph.update_matrix_world(ROOT, true);
        // Extract in root space rather than from each world matrix directly. A
        // nonuniform root scale makes the world matrix affine, and extracting its
        // rotation first would turn that scale into a small, bone-dependent axis
        // skew. Removing the root matrix first leaves the actual rest hierarchy.
        let mut root_inverse = graph.current_matrix_world(ROOT);
        root_inverse.invert();

        let mut basis = [None; 7];
        for slot in OffsetSlot::ALL {
            let Some(bone) = profile.bone(slot.bone()) else {
                continue;
            };
            let (mut position, mut relative_q, mut scale) =
                (Vec3::default(), Quat::default(), Vec3::default());
            Mat4::default()
                .multiply_matrices(&root_inverse, &graph.current_matrix_world(bone))
                .decompose(&mut position, &mut relative_q, &mut scale);
            let mut q = relative_q;
            q.invert();
            let mut inverse = q;
            inverse.invert();
            basis[slot as usize] = Some(Basis { q, inverse });
        }
        SpineOffsets {
            offset: [None; 7],
            basis,
        }
    }

    /// A slot's change of basis, for a caller checking what construction captured.
    #[cfg(test)]
    pub(crate) fn basis_q(&self, slot: OffsetSlot) -> Option<Quat> {
        self.basis[slot as usize].map(|b| b.q)
    }

    // spine.ts SpineOffsets.clear
    pub fn clear(&mut self) {
        self.offset = [None; 7];
    }

    // spine.ts SpineOffsets.add
    //
    // Accumulate a small additive rotation on a spine-chain slot (radians).
    pub fn add(&mut self, slot: OffsetSlot, x: f64, y: f64, z: f64) {
        let o = self.offset[slot as usize].get_or_insert_with(Offset::default);
        o.x += x;
        o.y += y;
        o.z += z;
    }

    // spine.ts SpineOffsets.commit
    //
    // Bake accumulated spine offsets, bounded per slot, into local quaternions.
    pub fn commit(&self, p: &Profile, graph: &mut Graph, rest_of: &dyn Fn(u32) -> Quat) {
        for slot in SPINE_CHAIN {
            let (Some(bone), Some(o)) = (p.bone(slot.bone()), self.offset[slot as usize]) else {
                continue;
            };
            let mut authored = Quat::default();
            authored.set_from_euler_xyz(
                bound_spine_offset(slot, o.x),
                bound_spine_offset(slot, o.y),
                bound_spine_offset(slot, o.z),
            );
            if let Some(basis) = self.basis[slot as usize] {
                authored.premultiply(&basis.q).multiply(&basis.inverse);
            }
            let mut q = rest_of(bone);
            q.multiply(&authored);
            graph.set_local_quaternion(bone, &q);
        }
    }

    // spine.ts SpineOffsets.readHeadOffset
    //
    // Read the displayed head rotation relative to its root-space bind pose.
    pub fn read_head_offset(&self, p: &Profile, graph: &mut Graph, out: &mut Quat) -> bool {
        let head = p.bone(BoneSlot::Head);
        let basis = self.basis[OffsetSlot::Head as usize];
        let (Some(head), Some(basis)) = (head, basis) else {
            return false;
        };
        graph.update_world_matrix(head, true, false, false);
        let mut root_inverse = graph.current_matrix_world(ROOT);
        root_inverse.invert();
        let (mut position, mut scale) = (Vec3::default(), Vec3::default());
        Mat4::default()
            .multiply_matrices(&root_inverse, &graph.current_matrix_world(head))
            .decompose(&mut position, out, &mut scale);
        out.multiply(&basis.q).normalize();
        true
    }

    // spine.ts SpineOffsets.commitEyes
    //
    // Bake eye offsets after the final displayed head pose is known.
    pub fn commit_eyes(&self, p: &Profile, graph: &mut Graph, rest_of: &dyn Fn(u32) -> Quat) {
        for slot in EYES {
            let (Some(bone), Some(o)) = (p.bone(slot.bone()), self.offset[slot as usize]) else {
                continue;
            };
            let mut authored = Quat::default();
            authored.set_from_euler_xyz(o.x, o.y, o.z);
            if let Some(basis) = self.basis[slot as usize] {
                authored.premultiply(&basis.q).multiply(&basis.inverse);
            }
            let mut q = rest_of(bone);
            q.multiply(&authored);
            graph.set_local_quaternion(bone, &q);
        }
    }
}

#[cfg(test)]
mod tests {
    //! `tests/rig/spine.test.ts`, on the base avatar. The TS markers are child objects two
    //! offsets from each bone; with no node to add, a marker here is that offset carried by the
    //! bone's world matrix, which is where three puts an untransformed child.
    use super::*;
    use crate::rig::testkit::{avatar, bone, euler, rest_of, rest_table};

    const MARKERS: [Vec3; 2] = [
        Vec3::new(0.031, 0.017, 0.011),
        Vec3::new(-0.014, 0.026, 0.037),
    ];
    const OFFSETS: [Offset; 4] = [
        Offset {
            x: 0.17,
            y: 0.0,
            z: 0.0,
        },
        Offset {
            x: 0.0,
            y: -0.21,
            z: 0.0,
        },
        Offset {
            x: 0.0,
            y: 0.0,
            z: 0.13,
        },
        Offset {
            x: 0.11,
            y: -0.16,
            z: 0.19,
        },
    ];
    /// `DEFAULT_GAZE_LIMITS.headPitch`.
    const GAZE_HEAD_PITCH: f64 = 0.32;

    fn rebase_rotation(slot: OffsetSlot) -> Quat {
        let (x, y, z) = match slot {
            OffsetSlot::Hips => (0.23, 0.0, 0.0),
            OffsetSlot::Spine => (0.0, -0.19, 0.0),
            OffsetSlot::Chest => (0.0, 0.0, 0.27),
            OffsetSlot::Neck => (0.17, -0.12, 0.14),
            OffsetSlot::Head => (-0.2, 0.15, -0.11),
            OffsetSlot::EyeL => (0.14, 0.08, -0.18),
            OffsetSlot::EyeR => (-0.16, 0.1, 0.12),
        };
        euler(x, y, z)
    }

    struct Case {
        graph: Graph,
        profile: Profile,
        spine: SpineOffsets,
        rest: Vec<f64>,
        /// Each slot's two markers in its bone's frame.
        markers: [[Vec3; 2]; 7],
        rest_positions: Vec<Vec3>,
    }

    /// Turn a bone's local axes by `rotation` while its children keep their world placement.
    fn rebase(g: &mut Graph, b: u32, rotation: &Quat) {
        let mut inverse = *rotation;
        inverse.invert();
        let mut q = g.local_quaternion(b);
        q.multiply(rotation);
        g.set_local_quaternion(b, &q);
        let n = b as usize;
        for k in g.child_offsets[n]..g.child_offsets[n + 1] {
            let child = g.children[k as usize];
            let mut p = g.local_position(child);
            p.apply_quaternion(&inverse);
            g.set_local_position(child, &p);
            let mut cq = g.local_quaternion(child);
            cq.premultiply(&inverse);
            g.set_local_quaternion(child, &cq);
        }
    }

    /// Every slot's two markers, in world space, as the full pass leaves them.
    fn snapshot(g: &mut Graph, p: &Profile, markers: &[[Vec3; 2]; 7]) -> Vec<Vec3> {
        g.update_matrix_world(ROOT, true);
        let mut out = Vec::new();
        for slot in OffsetSlot::ALL {
            let m = g.current_matrix_world(bone(p, slot.bone()));
            for marker in markers[slot as usize] {
                let mut v = marker;
                v.apply_matrix4(&m);
                out.push(v);
            }
        }
        out
    }

    fn make_case(rebased: bool, transformed: bool) -> Case {
        let (mut graph, profile) = avatar();
        if transformed {
            graph.position[0..3].copy_from_slice(&[0.37, -0.24, 0.19]);
            let q = euler(0.11, -0.29, 0.17);
            graph.set_local_quaternion(ROOT, &q);
            graph.scale[0..3].copy_from_slice(&[0.8, 1.2, 1.1]);
            graph.update_matrix_world(ROOT, true);
        }
        let mut markers = [MARKERS; 7];
        if rebased {
            // Rebase the complete chain in parent order. The head and eyes make the
            // multi-level case observable instead of comparing only an isolated bone.
            for slot in OffsetSlot::ALL {
                let rotation = rebase_rotation(slot);
                rebase(&mut graph, bone(&profile, slot.bone()), &rotation);
                // The markers are the bone's children too.
                let mut inverse = rotation;
                inverse.invert();
                for m in &mut markers[slot as usize] {
                    m.apply_quaternion(&inverse);
                }
            }
        }
        graph.update_matrix_world(ROOT, true);
        let rest = rest_table(&graph);
        let spine = SpineOffsets::new(&profile, &mut graph);
        let rest_positions = snapshot(&mut graph, &profile, &markers);
        Case {
            graph,
            profile,
            spine,
            rest,
            markers,
            rest_positions,
        }
    }

    fn restore(c: &mut Case) {
        c.graph.quaternion.copy_from_slice(&c.rest);
        c.graph.update_matrix_world(ROOT, true);
    }

    fn pose_offsets(c: &mut Case, offsets: &[(OffsetSlot, Offset)]) -> Vec<Vec3> {
        restore(c);
        c.spine.clear();
        for (slot, o) in offsets {
            c.spine.add(*slot, o.x, o.y, o.z);
        }
        let rest = c.rest.clone();
        c.spine.commit(&c.profile, &mut c.graph, &rest_of(&rest));
        c.spine
            .commit_eyes(&c.profile, &mut c.graph, &rest_of(&rest));
        snapshot(&mut c.graph, &c.profile, &c.markers)
    }

    fn expect_same_markers(standard: &[Vec3], rebased: &[Vec3]) {
        for (a, b) in standard.iter().zip(rebased) {
            assert!(b.distance_to(a) < 1e-9, "{a:?} against {b:?}");
        }
    }

    fn moved(posed: &[Vec3], rest: &[Vec3]) -> bool {
        posed.iter().zip(rest).any(|(a, b)| a.distance_to(b) > 1e-5)
    }

    #[test]
    fn commits_the_head_and_eyes_in_separate_phases() {
        let mut c = make_case(false, false);
        let head = bone(&c.profile, BoneSlot::Head);
        let eye = bone(&c.profile, BoneSlot::EyeL);
        let head_rest = c.graph.local_quaternion(head);
        let eye_rest = c.graph.local_quaternion(eye);
        let rest = c.rest.clone();
        c.spine.add(OffsetSlot::Head, 0.02, 0.0, 0.0);
        c.spine.add(OffsetSlot::EyeL, -0.01, 0.0, 0.0);
        c.spine.commit(&c.profile, &mut c.graph, &rest_of(&rest));
        assert!(c.graph.local_quaternion(head).angle_to(&head_rest) > 0.01);
        assert!(c.graph.local_quaternion(eye).equals(&eye_rest));
        let displayed_head = c.graph.local_quaternion(head);
        c.spine
            .commit_eyes(&c.profile, &mut c.graph, &rest_of(&rest));
        assert!(c.graph.local_quaternion(eye).angle_to(&eye_rest) > 0.005);
        assert!(c.graph.local_quaternion(head).equals(&displayed_head));
    }

    #[test]
    fn keeps_every_standard_slot_equal_to_rest_local_times_euler_xyz() {
        let mut c = make_case(false, false);
        for slot in OffsetSlot::ALL {
            let b = bone(&c.profile, slot.bone());
            let rest_q = rest_of(&c.rest)(b);
            for o in OFFSETS {
                pose_offsets(&mut c, &[(slot, o)]);
                let mut expected = rest_q;
                expected.multiply(&euler(o.x, o.y, o.z));
                assert!(c.graph.local_quaternion(b).dot(&expected).abs() > 1.0 - 1e-12);
            }
        }
    }

    #[test]
    fn preserves_marker_motion_when_every_controlled_bone_uses_different_local_axes() {
        let mut standard = make_case(false, false);
        let mut rebased = make_case(true, false);
        for (a, b) in standard.rest_positions.iter().zip(&rebased.rest_positions) {
            assert!(b.distance_to(a) < 1e-10);
        }
        for slot in OffsetSlot::ALL {
            for o in OFFSETS {
                let posed = pose_offsets(&mut standard, &[(slot, o)]);
                let portable = pose_offsets(&mut rebased, &[(slot, o)]);
                expect_same_markers(&posed, &portable);
                assert!(moved(&portable, &rebased.rest_positions));
            }
        }
    }

    fn simultaneous() -> [(OffsetSlot, Offset); 3] {
        [
            (
                OffsetSlot::Chest,
                Offset {
                    x: 0.08,
                    y: -0.14,
                    z: 0.05,
                },
            ),
            (
                OffsetSlot::Neck,
                Offset {
                    x: -0.11,
                    y: 0.06,
                    z: 0.13,
                },
            ),
            (
                OffsetSlot::Head,
                Offset {
                    x: 0.16,
                    y: 0.09,
                    z: -0.12,
                },
            ),
        ]
    }

    #[test]
    fn keeps_simultaneous_chest_neck_and_head_offsets_portable() {
        let mut standard = make_case(false, false);
        let mut rebased = make_case(true, false);
        let expected = pose_offsets(&mut standard, &simultaneous());
        let got = pose_offsets(&mut rebased, &simultaneous());
        expect_same_markers(&expected, &got);
        assert!(moved(&got, &rebased.rest_positions));
    }

    #[test]
    fn keeps_the_gauge_portable_under_root_yaw_translation_and_nonuniform_scale() {
        let mut standard = make_case(false, true);
        let mut rebased = make_case(true, true);
        for (a, b) in standard.rest_positions.iter().zip(&rebased.rest_positions) {
            assert!(b.distance_to(a) < 1e-10);
        }
        let offsets = [
            (
                OffsetSlot::Hips,
                Offset {
                    x: 0.07,
                    y: -0.05,
                    z: 0.09,
                },
            ),
            (
                OffsetSlot::Chest,
                Offset {
                    x: -0.13,
                    y: 0.08,
                    z: 0.11,
                },
            ),
            (
                OffsetSlot::Head,
                Offset {
                    x: 0.12,
                    y: -0.09,
                    z: -0.07,
                },
            ),
            (
                OffsetSlot::EyeL,
                Offset {
                    x: -0.08,
                    y: 0.1,
                    z: 0.06,
                },
            ),
        ];
        let expected = pose_offsets(&mut standard, &offsets);
        let got = pose_offsets(&mut rebased, &offsets);
        expect_same_markers(&expected, &got);
    }

    #[test]
    fn keeps_an_extreme_stacked_head_offset_inside_the_slot_bound() {
        let mut c = make_case(true, false);
        let head = bone(&c.profile, BoneSlot::Head);
        let rest_q = rest_of(&c.rest)(head);
        let limit = SPINE_LIMITS[OffsetSlot::Head as usize];
        for sign in [1.0, -1.0] {
            for axis in 0..3 {
                restore(&mut c);
                c.spine.clear();
                // A loaded motion at its limit, plus the gaze and a nod on top.
                for amount in [1.5, GAZE_HEAD_PITCH, 0.1] {
                    let mut o = [0.0; 3];
                    o[axis] = sign * amount;
                    c.spine.add(OffsetSlot::Head, o[0], o[1], o[2]);
                }
                let rest = c.rest.clone();
                c.spine.commit(&c.profile, &mut c.graph, &rest_of(&rest));
                let angle = c.graph.local_quaternion(head).angle_to(&rest_q);
                assert!(angle < limit.max);
                assert!(angle > limit.knee);
            }
        }
    }

    #[test]
    fn saturates_smoothly_rather_than_stopping() {
        for slot in SPINE_CHAIN {
            let SpineLimit { knee, max } = SPINE_LIMITS[slot as usize];
            let mut last = bound_spine_offset(slot, knee);
            let mut x = knee + 0.01;
            while x < knee + 4.0 * (max - knee) {
                let y = bound_spine_offset(slot, x);
                assert!(y > last);
                assert!(y < max);
                assert_eq!(bound_spine_offset(slot, -x).to_bits(), (-y).to_bits());
                last = y;
                x += 0.01;
            }
            // Slope 1 at the knee: no visible kink where saturation begins.
            let h = 1e-4;
            assert!((bound_spine_offset(slot, knee + h) - knee) / h > 0.99);
        }
    }

    #[test]
    fn passes_everything_up_to_the_knee_through_bit_for_bit() {
        for slot in SPINE_CHAIN {
            let knee = SPINE_LIMITS[slot as usize].knee;
            for v in [0.0, -0.0, 0.5 * knee, -0.9 * knee, knee, -knee] {
                assert_eq!(bound_spine_offset(slot, v).to_bits(), v.to_bits());
            }
        }
    }

    #[test]
    fn reads_the_displayed_head_back_through_its_root_space_basis() {
        let mut c = make_case(true, true);
        let mut out = Quat::default();
        assert!(c.spine.read_head_offset(&c.profile, &mut c.graph, &mut out));
        // At rest the displayed head is its bind pose.
        assert!(out.angle_to(&Quat::default()) < 1e-9);
        pose_offsets(&mut c, &[(OffsetSlot::Head, OFFSETS[3])]);
        assert!(c.spine.read_head_offset(&c.profile, &mut c.graph, &mut out));
        let o = OFFSETS[3];
        assert!(out.angle_to(&euler(o.x, o.y, o.z)) < 1e-9);
    }
}
