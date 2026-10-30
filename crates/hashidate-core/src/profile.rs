//! The numeric part of `Profile`: which node fills each slot, the rest geometry and lengths the
//! rig reads, and what construction measured off the mesh.
//!
//! The TS profile holds three objects and names; this one holds node numbers of the
//! [`Graph`](crate::scene::graph::Graph) (or [`NO_NODE`] where a slot is unresolved or its bone is
//! outside the table) and plain numbers. Labels, morph routing and everything else the rig never
//! reads stay in TS. The vertex walks (`measureVolume`, `partSkin`, `FaceSurface.measure`,
//! `buildBodyFrame`) also stay in TS; their results arrive here as arrays.
//!
//! The arrays a profile is assembled from, by the names `tests/corpora/avatar-base.json` records
//! them under. `<S>` is `L` or `R`, `<F>` a finger in [`Finger`] order; an absent array is an
//! absent value.
//!
//! | array | kind | elements |
//! |---|---|---|
//! | `profile.bones.<slot>` | u32 | 1: the node, every [`BoneSlot`] in order |
//! | `profile.fingerBones.<F>.<S>` | u32 | the chain, proximal first; absent when unresolved |
//! | `profile.restDir.<slot>` | f64 | 3: bone-local direction to the next link |
//! | `profile.restDir.<F>.<S>.<i>` | f64 | 3: the same per finger segment |
//! | `profile.sideSign` | f64 | 1 |
//! | `profile.limb.<key>.<S>` | f64 | 1: `upper` `lower` `thigh` `shin` `pitch` `proximal`, world units |
//! | `profile.limb.tip.<S>.<F>` | f64 | 1 |
//! | `profile.face.{origin,right,up,forward}` | f64 | 3 each, head-local |
//! | `profile.face.ipd` | f64 | 1 |
//! | `profile.face.mouth` | f64 | 3 |
//! | `profile.body.{right,up,forward}` | f64 | 3 each, chest-local (`buildBodyFrame`) |
//! | `profile.body.span` | f64 | 1 |
//! | `profile.anatomy.shoulder.elevation` | f64 | 3 per row: plane, free, max in degrees |
//! | `profile.anatomy.<joint>.<dof>` | f64 | 4: free lo, free hi, max lo, max hi in radians |
//! | `profile.armTwists.<slot>.{primary,next,helper}` | u32 | 1 each, [`ArmTwistSlot`] order |
//! | `avatar.armRest.<arm slot>` | f64 | 3: character-space direction, [`ArmSlot`] order |
//! | `measure.{torso,head}.r` | f32 | bands × sectors, band-major; absent when unmeasured |
//! | `measure.{torso,head}.{bands,sectors,top,bottom,radius}` | f64 | 1 each |
//! | `measure.face.{pos,nrm}` | f32 | 3 per skin vertex, in the head bone's frame |
//!
//! `profile.anatomy` joints and dofs are [`JointTable`]'s field names (`elbow.flexion`,
//! `finger.distal`, …); a finger or thumb segment the override leaves out is absent. The recorded
//! base avatar has no override. `measure.{torso,head}.frame` (12: O, up, right, fwd) is the frame
//! a volume was measured in, recorded so tests can check the core reads the same one; it is not
//! an input.

use crate::anatomy::joints::JointTable;
use crate::anatomy::surface::MeasuredVolume;
use crate::math::Vec3;
pub use crate::scene::graph::NO_NODE;

/// Which arm or leg, in the character's own terms.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    L,
    R,
}

impl Side {
    pub const BOTH: [Side; 2] = [Side::L, Side::R];
}

/// The links an arm pose names, shoulder to hand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArmSlot {
    Shoulder,
    UpperArm,
    LowerArm,
    Hand,
}

/// Every finger, thumb first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Finger {
    Thumb,
    Index,
    Middle,
    Ring,
    Little,
}

impl Finger {
    pub const ALL: [Finger; 5] = [
        Finger::Thumb,
        Finger::Index,
        Finger::Middle,
        Finger::Ring,
        Finger::Little,
    ];
}

/// Every bone slot the profile resolves, in `BoneSlot`'s declaration order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoneSlot {
    Hips,
    Spine,
    Chest,
    Neck,
    Head,
    EyeL,
    EyeR,
    ShoulderL,
    ShoulderR,
    UpperArmL,
    UpperArmR,
    LowerArmL,
    LowerArmR,
    HandL,
    HandR,
    UpperLegL,
    UpperLegR,
    LowerLegL,
    LowerLegR,
    FootL,
    FootR,
    ToeL,
    ToeR,
}

/// How many [`BoneSlot`]s there are.
pub const BONE_SLOTS: usize = 23;

impl BoneSlot {
    /// The arm link on one side.
    pub const fn arm(slot: ArmSlot, side: Side) -> BoneSlot {
        match (slot, side) {
            (ArmSlot::Shoulder, Side::L) => BoneSlot::ShoulderL,
            (ArmSlot::Shoulder, Side::R) => BoneSlot::ShoulderR,
            (ArmSlot::UpperArm, Side::L) => BoneSlot::UpperArmL,
            (ArmSlot::UpperArm, Side::R) => BoneSlot::UpperArmR,
            (ArmSlot::LowerArm, Side::L) => BoneSlot::LowerArmL,
            (ArmSlot::LowerArm, Side::R) => BoneSlot::LowerArmR,
            (ArmSlot::Hand, Side::L) => BoneSlot::HandL,
            (ArmSlot::Hand, Side::R) => BoneSlot::HandR,
        }
    }
}

/// The arm links that may carry a twist helper.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArmTwistSlot {
    UpperArmL,
    UpperArmR,
    LowerArmL,
    LowerArmR,
}

/// World-unit segment lengths for one side; `limb` in TS, keyed `<key>.<side>`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Limb {
    pub upper: Option<f64>,
    pub lower: Option<f64>,
    pub thigh: Option<f64>,
    pub shin: Option<f64>,
    /// `tip.<side>.<finger>`, in [`Finger`] order.
    pub tip: [Option<f64>; 5],
    pub pitch: Option<f64>,
    pub proximal: Option<f64>,
}

/// A right/up/forward frame for the head, in head-local space, plus the
/// interpupillary distance the face anchors are measured in.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FaceFrame {
    pub origin: Vec3,
    pub right: Vec3,
    pub up: Vec3,
    pub forward: Vec3,
    pub ipd: f64,
    /// The mouth on the skin, measured from the lip-sync shapes; `None` where none moves it.
    pub mouth: Option<Vec3>,
}

/// The torso frame, in chest-local space. `span` is trunk half-width plus arm.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BodyFrame {
    pub right: Vec3,
    pub up: Vec3,
    pub forward: Vec3,
    pub span: Option<f64>,
}

/// A validated auxiliary bone beside one canonical arm link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArmTwistBinding {
    /// The canonical arm bone that owns both children.
    pub primary: u32,
    /// The next canonical joint in the arm chain.
    pub next: u32,
    /// The direct leaf helper recognized from the avatar's bone names.
    pub helper: u32,
}

/// The head's skin as `FaceSurface.measure` read it: positions and outward normals in the head
/// bone's frame, 3 per vertex.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FaceSkin {
    pub pos: Vec<f32>,
    pub nrm: Vec<f32>,
}

/// What construction measures off the mesh: `measureVolume` for the trunk (at the fixed
/// height range `BodyVolumes.measureTorso` sets) and for the head, and `FaceSurface.measure`.
/// `None` where TS's measurement returned null.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Measured {
    pub torso: Option<MeasuredVolume>,
    pub head: Option<MeasuredVolume>,
    pub face: Option<FaceSkin>,
}

/// The resolved avatar, as numbers.
#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    /// Node per [`BoneSlot`], or [`NO_NODE`].
    pub bones: [u32; BONE_SLOTS],
    /// Chain per finger, `side * 5 + finger`; empty where unresolved.
    pub finger_bones: [Vec<u32>; 10],
    /// Bone-local direction toward the next link, per [`BoneSlot`].
    pub rest_dir: [Option<Vec3>; BONE_SLOTS],
    /// The same per finger segment, indexed like `finger_bones`.
    pub finger_rest_dir: [Vec<Vec3>; 10],
    /// Which world X is the character's left. Derived, never assumed.
    pub side_sign: f64,
    /// Per [`Side`].
    pub limb: [Limb; 2],
    pub face: Option<FaceFrame>,
    pub body: Option<BodyFrame>,
    /// Present only where the avatar overrides the human joint table.
    pub anatomy: Option<JointTable>,
    /// Per [`ArmTwistSlot`].
    pub arm_twists: [Option<ArmTwistBinding>; 4],
    /// `avatar.armRest`, per [`ArmSlot`].
    pub arm_rest: [Option<Vec3>; 4],
    pub measured: Measured,
}

impl Profile {
    /// A profile with nothing resolved.
    pub fn empty() -> Profile {
        Profile {
            bones: [NO_NODE; BONE_SLOTS],
            finger_bones: Default::default(),
            rest_dir: [None; BONE_SLOTS],
            finger_rest_dir: Default::default(),
            side_sign: 1.0,
            limb: [Limb::default(); 2],
            face: None,
            body: None,
            anatomy: None,
            arm_twists: [None; 4],
            arm_rest: [None; 4],
            measured: Measured::default(),
        }
    }

    /// The node filling `slot`, if any.
    pub fn bone(&self, slot: BoneSlot) -> Option<u32> {
        let b = self.bones[slot as usize];
        (b != NO_NODE).then_some(b)
    }

    /// A finger's chain; empty where it did not resolve.
    pub fn finger(&self, finger: Finger, side: Side) -> &[u32] {
        &self.finger_bones[side as usize * 5 + finger as usize]
    }

    /// The first bone of a finger's chain, if it is in the table.
    pub fn finger_root(&self, finger: Finger, side: Side) -> Option<u32> {
        self.finger(finger, side)
            .first()
            .copied()
            .filter(|&b| b != NO_NODE)
    }

    /// `bones.chest ?? bones.spine ?? bones.hips`.
    pub fn chest(&self) -> Option<u32> {
        self.bone(BoneSlot::Chest)
            .or_else(|| self.bone(BoneSlot::Spine))
            .or_else(|| self.bone(BoneSlot::Hips))
    }
}

/// The base synthetic avatar of `tests/corpora/avatar-base`, assembled as the core sees it.
#[cfg(test)]
pub(crate) mod base {
    use super::*;
    use crate::corpus_replay::AvatarBase;
    use crate::math::Mat4;
    use crate::scene::graph::{Graph, RECORD, Shape, flag};

    /// The slot names `profile.bones.<slot>` uses, in [`BoneSlot`] order.
    pub const SLOT_NAMES: [&str; BONE_SLOTS] = [
        "hips",
        "spine",
        "chest",
        "neck",
        "head",
        "eye.L",
        "eye.R",
        "shoulder.L",
        "shoulder.R",
        "upperArm.L",
        "upperArm.R",
        "lowerArm.L",
        "lowerArm.R",
        "hand.L",
        "hand.R",
        "upperLeg.L",
        "upperLeg.R",
        "lowerLeg.L",
        "lowerLeg.R",
        "foot.L",
        "foot.R",
        "toe.L",
        "toe.R",
    ];
    const FINGER_NAMES: [&str; 5] = ["thumb", "index", "middle", "ring", "little"];
    const SIDE_NAMES: [&str; 2] = ["L", "R"];

    fn vec3(s: &[f64]) -> Vec3 {
        Vec3::new(s[0], s[1], s[2])
    }

    fn mat4(s: &[f64], i: usize) -> Mat4 {
        let mut elements = [0.0; 16];
        elements.copy_from_slice(&s[16 * i..16 * i + 16]);
        Mat4::from_elements(elements)
    }

    /// The node table as `node.*`, `skinned.*` and `skeleton.*` record it, built.
    pub fn graph(base: &AvatarBase) -> Graph {
        let get = |name: &str| base.f64(name).unwrap_or_else(|| panic!("{name}"));
        let kind = base.u32("node.kind").unwrap();
        let parent = base.u32("node.parent").unwrap();
        let flags = base.u32("node.flags").unwrap();
        let (position, quaternion, scale, pivot) = (
            get("node.position"),
            get("node.quaternion"),
            get("node.scale"),
            get("node.pivot"),
        );
        let (matrix, matrix_world) = (get("node.matrix"), get("node.matrixWorld"));
        let mesh_nodes = base.u32("skinned.node").unwrap();
        let bind_mode = base.u32("skinned.bindMode").unwrap();
        let bone_count = base.u32("skeleton.boneCount").unwrap();
        let bones = base.u32("skeleton.bones").unwrap();
        let (bind, bind_inverse) = (get("skinned.bindMatrix"), get("skinned.bindMatrixInverse"));
        let bone_inverses = get("skeleton.boneInverses");

        let mut g = Graph::new(Shape {
            nodes: kind.len(),
            meshes: mesh_nodes.len(),
            skeletons: bone_count.len(),
            bones: bones.len(),
        });
        let mut record = [0.0; RECORD];
        for i in 0..kind.len() {
            record[0..3].copy_from_slice(&position[3 * i..3 * i + 3]);
            record[3..7].copy_from_slice(&quaternion[4 * i..4 * i + 4]);
            record[7..10].copy_from_slice(&scale[3 * i..3 * i + 3]);
            record[10..13].copy_from_slice(&pivot[3 * i..3 * i + 3]);
            record[13..29].copy_from_slice(&matrix[16 * i..16 * i + 16]);
            record[29..45].copy_from_slice(&matrix_world[16 * i..16 * i + 16]);
            let mut f = flags[i] as u8;
            match kind[i] {
                1 => f |= flag::BONE,
                3 => {
                    f |= flag::SKINNED;
                    let m = mesh_nodes.iter().position(|&n| n as usize == i).unwrap();
                    if bind_mode[m] == 1 {
                        f |= flag::DETACHED;
                    }
                }
                _ => {}
            }
            g.push_node(parent[i], f, &record);
        }
        for (m, &node) in mesh_nodes.iter().enumerate() {
            g.push_mesh(node, &mat4(&bind, m), &mat4(&bind_inverse, m));
        }
        let mut b = 0;
        for &count in &bone_count {
            g.push_skeleton();
            for _ in 0..count {
                g.push_bone(bones[b], &mat4(&bone_inverses, b));
                b += 1;
            }
        }
        g.build();
        g
    }

    fn volume(base: &AvatarBase, name: &str) -> Option<MeasuredVolume> {
        let one = |field: &str| base.f64(&format!("measure.{name}.{field}")).map(|v| v[0]);
        Some(MeasuredVolume {
            r: base.f32(&format!("measure.{name}.r")),
            bands: one("bands")?,
            sectors: one("sectors")?,
            top: one("top")?,
            bottom: one("bottom")?,
            radius: one("radius")?,
        })
    }

    /// The profile as `profile.*`, `avatar.*` and `measure.*` record it.
    pub fn profile(base: &AvatarBase) -> Profile {
        let mut p = Profile::empty();
        for (i, name) in SLOT_NAMES.iter().enumerate() {
            p.bones[i] = base.u32(&format!("profile.bones.{name}")).unwrap()[0];
            p.rest_dir[i] = base
                .f64(&format!("profile.restDir.{name}"))
                .map(|v| vec3(&v));
        }
        for (s, side) in SIDE_NAMES.iter().enumerate() {
            for (f, finger) in FINGER_NAMES.iter().enumerate() {
                let k = s * 5 + f;
                if let Some(chain) = base.u32(&format!("profile.fingerBones.{finger}.{side}")) {
                    p.finger_rest_dir[k] = (0..chain.len())
                        .map(|i| {
                            vec3(
                                &base
                                    .f64(&format!("profile.restDir.{finger}.{side}.{i}"))
                                    .unwrap(),
                            )
                        })
                        .collect();
                    p.finger_bones[k] = chain;
                }
            }
            let one = |key: &str| base.f64(&format!("profile.limb.{key}")).map(|v| v[0]);
            let limb = &mut p.limb[s];
            limb.upper = one(&format!("upper.{side}"));
            limb.lower = one(&format!("lower.{side}"));
            limb.thigh = one(&format!("thigh.{side}"));
            limb.shin = one(&format!("shin.{side}"));
            limb.pitch = one(&format!("pitch.{side}"));
            limb.proximal = one(&format!("proximal.{side}"));
            for (f, finger) in FINGER_NAMES.iter().enumerate() {
                limb.tip[f] = one(&format!("tip.{side}.{finger}"));
            }
        }
        p.side_sign = base.f64("profile.sideSign").unwrap()[0];
        let v = |name: &str| base.f64(name).map(|v| vec3(&v));
        if let Some(origin) = v("profile.face.origin") {
            p.face = Some(FaceFrame {
                origin,
                right: v("profile.face.right").unwrap(),
                up: v("profile.face.up").unwrap(),
                forward: v("profile.face.forward").unwrap(),
                ipd: base.f64("profile.face.ipd").unwrap()[0],
                mouth: v("profile.face.mouth"),
            });
        }
        if let Some(right) = v("profile.body.right") {
            p.body = Some(BodyFrame {
                right,
                up: v("profile.body.up").unwrap(),
                forward: v("profile.body.forward").unwrap(),
                span: base.f64("profile.body.span").map(|s| s[0]),
            });
        }
        for (i, slot) in ["upperArm.L", "upperArm.R", "lowerArm.L", "lowerArm.R"]
            .iter()
            .enumerate()
        {
            let node = |field: &str| {
                base.u32(&format!("profile.armTwists.{slot}.{field}"))
                    .map(|v| v[0])
            };
            if let Some(primary) = node("primary") {
                p.arm_twists[i] = Some(ArmTwistBinding {
                    primary,
                    next: node("next").unwrap(),
                    helper: node("helper").unwrap(),
                });
            }
        }
        for (i, slot) in ["shoulder", "upperArm", "lowerArm", "hand"]
            .iter()
            .enumerate()
        {
            p.arm_rest[i] = v(&format!("avatar.armRest.{slot}"));
        }
        p.measured = Measured {
            torso: volume(base, "torso"),
            head: volume(base, "head"),
            face: base.f32("measure.face.pos").map(|pos| FaceSkin {
                pos,
                nrm: base.f32("measure.face.nrm").unwrap(),
            }),
        };
        p
    }

    /// The frame `measureVolume` was called with for `name`: O, up, right, fwd.
    pub fn measured_frame(base: &AvatarBase, name: &str) -> [Vec3; 4] {
        let f = base.f64(&format!("measure.{name}.frame")).unwrap();
        [vec3(&f[0..]), vec3(&f[3..]), vec3(&f[6..]), vec3(&f[9..])]
    }

    /// The base avatar's graph and profile.
    pub fn avatar() -> (Graph, Profile) {
        let base = AvatarBase::load();
        (graph(&base), profile(&base))
    }
}

#[cfg(test)]
mod tests {
    use super::base::{SLOT_NAMES, avatar};
    use super::*;
    use crate::corpus_replay::AvatarBase;
    use crate::scene::graph::flag;

    #[test]
    fn the_base_profile_resolves_every_slot_to_a_bone_of_the_table() {
        let (graph, p) = avatar();
        for (i, name) in SLOT_NAMES.iter().enumerate() {
            let b = p.bones[i];
            assert!((b as usize) < graph.len(), "{name}");
            assert!(graph.flags[b as usize] & flag::BONE != 0, "{name}");
            assert!(p.rest_dir[i].is_some(), "{name}");
        }
        assert_eq!(p.chest(), Some(p.bones[BoneSlot::Chest as usize]));
        for side in Side::BOTH {
            for finger in Finger::ALL {
                let chain = p.finger(finger, side);
                assert!(chain.len() >= 2, "{finger:?}.{side:?}");
                assert_eq!(
                    p.finger_rest_dir[side as usize * 5 + finger as usize].len(),
                    chain.len()
                );
                assert_eq!(p.finger_root(finger, side), Some(chain[0]));
            }
            let limb = p.limb[side as usize];
            assert!(limb.upper.unwrap() > 0.0 && limb.lower.unwrap() > 0.0);
            assert!(limb.tip.iter().all(Option::is_some));
        }
    }

    #[test]
    fn the_base_profile_carries_its_frames_twists_and_measurements() {
        let (_, p) = avatar();
        let body = p.body.unwrap();
        assert!((body.up.length() - 1.0).abs() < 1e-12);
        assert!(body.span.is_some());
        assert!(p.face.is_some());
        assert!(p.anatomy.is_none());
        assert!(p.arm_twists.iter().all(Option::is_some));
        let twist = p.arm_twists[ArmTwistSlot::UpperArmL as usize].unwrap();
        assert_eq!(twist.primary, p.bones[BoneSlot::UpperArmL as usize]);
        assert_eq!(twist.next, p.bones[BoneSlot::LowerArmL as usize]);
        let torso = p.measured.torso.as_ref().unwrap();
        assert_eq!(
            torso.r.as_ref().unwrap().len() as f64,
            torso.bands * torso.sectors
        );
        assert!(torso.top > torso.bottom);
        let face = p.measured.face.as_ref().unwrap();
        assert_eq!(face.pos.len(), face.nrm.len());
        assert!(!face.pos.is_empty() && face.pos.len().is_multiple_of(3));
    }

    #[test]
    fn the_base_graph_reproduces_its_recorded_world_matrices() {
        let base = AvatarBase::load();
        let mut graph = base::graph(&base);
        let recorded = base.f64("node.matrixWorld").unwrap();
        graph.update_matrix_world(0, true);
        for (i, (&got, &want)) in graph.matrix_world.iter().zip(&recorded).enumerate() {
            assert_eq!(got.to_bits(), want.to_bits(), "matrixWorld element {i}");
        }
    }

    #[test]
    fn slots_map_onto_both_sides() {
        assert_eq!(
            BoneSlot::arm(ArmSlot::Hand, Side::R) as usize,
            BoneSlot::HandR as usize
        );
        assert_eq!(BONE_SLOTS, BoneSlot::ToeR as usize + 1);
        let p = Profile::empty();
        assert_eq!(p.bone(BoneSlot::Head), None);
        assert_eq!(p.chest(), None);
    }
}
