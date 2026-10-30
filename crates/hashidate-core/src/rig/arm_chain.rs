//! `rig/arm-chain.ts`: the arm chain's bone writes.
//!
//! Aims shoulder, upper arm, forearm and hand parent-first from world-space
//! direction targets, spends the roll that turns a palm over between the
//! humerus and the forearm, and holds the limiter's output to a speed a limb can
//! move at. It reads the rig's shared anatomy and roll tables rather than owning
//! them; a frame's clock and the limiter switch come from the rig through `port`.
//!
//! The TS constructor takes the rig's tables and callbacks; here the palm normals and humeral
//! fronts, which the rig fills before building the chain and never changes, are copied in, and
//! everything else the rig owns arrives with each call: the profile, joint table, scene and
//! anatomy as arguments, and the rest rotations, roll tables and twist helpers through
//! [`ArmChainPort`]. The module scratch the TS shares between chains is written before it is
//! read in every call, so it is local; the per-instance quaternions stay on the instance. A
//! direction the TS reads as a tuple or a vector is a `Vec3`, and an absent one is `None`.

// `!(x > y)` is TS's: a NaN fails it.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

use crate::anatomy::arm::{ArmAnatomy, rotation_trust};
use crate::anatomy::joints::JointTable;
use crate::anatomy::strain::roll_room;
use crate::math::f::{acos, atan2};
use crate::math::{Quat, Vec3, clamp};
use crate::profile::{ArmSlot, BoneSlot, Profile, Side};
use crate::rig::arm_configuration::PRONATION_SPLIT;
use crate::rig::arm_driver::LIMIT_SLEW;
use crate::rig::point::world_direction;
use crate::scene::graph::Graph;

/// The palm constraint one aim is solved against: the palm normal in hand-bone
/// space, where it should end up in world space, and how hard to insist.
#[derive(Clone, Copy, Debug)]
struct PalmSpec {
    local: Vec3,
    target: Vec3,
    weight: f64,
}

// Joint limits are anatomy, and live in `anatomy/`.
//
// What used to be here was a cone: each link could deviate from the one above
// it by so many radians, whatever direction it deviated in. That bounded the
// damage without needing to know a rotation axis — which is real, axes differ
// per rig — but it cannot tell flexion from extension, so it permitted 75
// degrees of radial deviation at a wrist whose actual range is 20, and it had
// no opinion at all about an elbow bending sideways.
//
// The replacement measures the pose against a body frame derived from the rig's
// own geometry, so it stays skeleton-independent while knowing which way is
// which. See `anatomy/` for the model and for why it carries two bands rather
// than one bound.

/// Below this the elbow is bent far enough that humeral rotation swings the
/// forearm instead of rolling it, and the shoulder has nothing useful to lend.
///
/// This is the reason you turn a doorknob by supinating rather than by rotating
/// your shoulder: at a right angle the shoulder's rotation has become a sideways
/// sweep of the whole forearm and does not reach the palm at all.
const ROLL_TRANSFER_MIN: f64 = 0.25;

/// The directions the anatomical clamp bounds, in the order the slew walks them.
///
/// No shoulder: the girdle is posed from the pose's own request, and `girdleRoom`
/// is the only thing that moves it.
type LimitedDirs = [Vec3; 3];

/// The three the clamp bounds, in `LimitedDirs` order.
const LIMITED_SLOTS: [ArmSlot; 3] = [ArmSlot::UpperArm, ArmSlot::LowerArm, ArmSlot::Hand];

/// What the arm chain needs from the rig that owns it, read at call time.
pub trait ArmChainPort {
    fn dt(&self) -> f64;
    fn limits_enabled(&self) -> bool;
    fn arm_context(&mut self, graph: &mut Graph, anat: &mut ArmAnatomy, side: Side) -> bool;
    /// The TS `restOf`.
    fn rest_of(&self, bone: u32) -> Quat;
    /// The TS `foreRoll[side] = fore; upperRoll[side] = humeral`.
    fn record_rolls(&mut self, side: Side, fore: f64, humeral: f64);
    /// The TS `armTwists?.stage(side)`.
    fn stage_twists(&mut self, graph: &mut Graph, side: Side);
}

/// What the roll budget delivered last frame, for its slew. See `aimArm`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct RollHeld {
    fore: f64,
    humeral: f64,
    set: bool,
}

/// JS truthiness of a number: neither zero nor NaN.
fn truthy(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

fn rest_dir(p: &Profile, slot: ArmSlot, side: Side) -> Vec3 {
    p.rest_dir[BoneSlot::arm(slot, side) as usize]
        .expect("a resolved arm bone has a rest direction")
}

fn twist_about(axis: &Vec3, angle: f64) -> Quat {
    *Quat::default().set_from_axis_angle(axis, angle)
}

/// The links below the shoulder one `aimArmLegacy` call poses, which the TS `below` closure
/// captures.
#[derive(Clone, Copy)]
struct Below {
    fore: Option<u32>,
    hand: Option<u32>,
    above_fore: u32,
    above_hand: u32,
    fore_dir: Option<Vec3>,
    hand_dir: Option<Vec3>,
}

pub struct ArmChain {
    // Arm state below the shoulder, held aside rather than threaded through
    // `_chainQ`. Those two buffers alternate down a chain, which is enough when
    // each link is posed once; the roll budget poses the forearm and hand more
    // than once — a trial twist on the humerus has to be paid for and measured
    // — and by then the alternating buffers have been overwritten.
    upper_parent_q: Quat,
    upper_q: Quat,
    fore_parent_q: Quat,
    fore_q: Quat,
    hand_parent_q: Quat,
    hand_q: Quat,
    /// Roll the last palm solve asked for.
    roll: f64,

    /// What the roll budget delivered last frame, for its slew. See `aimArm`.
    roll_held: [RollHeld; 2],

    // Where the limiter actually left each link last frame, and whether that is
    // known for this side. See `slew`.
    held: [LimitedDirs; 2],
    held_limit: [bool; 2],
    palm_world: [Vec3; 2],

    palm_local: [Option<Vec3>; 2],
    humeral_front: [Option<Vec3>; 2],
}

impl ArmChain {
    // arm-chain.ts ArmChain.constructor
    pub fn new(palm_local: [Option<Vec3>; 2], humeral_front: [Option<Vec3>; 2]) -> ArmChain {
        ArmChain {
            upper_parent_q: Quat::default(),
            upper_q: Quat::default(),
            fore_parent_q: Quat::default(),
            fore_q: Quat::default(),
            hand_parent_q: Quat::default(),
            hand_q: Quat::default(),
            roll: 0.0,
            roll_held: [RollHeld::default(); 2],
            held: [[Vec3::default(); 3]; 2],
            held_limit: [false; 2],
            palm_world: [Vec3::default(); 2],
            palm_local,
            humeral_front,
        }
    }

    // arm-chain.ts ArmChain.releaseSlew
    //
    // Forget where the limiter left each link, so the next frame is not slewed from a stale pose.
    pub fn release_slew(&mut self) {
        self.held_limit = [false; 2];
    }

    // arm-chain.ts ArmChain.releaseContinuity
    //
    // Forget the previous frame's limiter output and roll budget.
    pub fn release_continuity(&mut self) {
        self.held_limit = [false; 2];
        self.roll_held = [RollHeld::default(); 2];
        self.roll = 0.0;
    }

    // arm-chain.ts ArmChain.parentWorld
    //
    // World rotation of `bone`'s actual parent, given the world rotation of the
    // chain bone `above` it. On a direct chain that is `aboveWorld` itself; a
    // carrier bone interposed between the two adds its own local rotation, which
    // a chain walked link by link would otherwise silently drop.
    fn parent_world(graph: &mut Graph, bone: u32, above: u32, above_world: &Quat) -> Quat {
        let parent = graph.parent_of(bone);
        if parent == Some(above) {
            return *above_world;
        }
        let mut out = Quat::default();
        let mut node = parent;
        while let Some(n) = node {
            if n == above {
                return *out.premultiply(above_world);
            }
            out.premultiply(&graph.local_quaternion(n));
            node = graph.parent_of(n);
        }
        // Not below the chain bone at all: read the parent the scene actually has.
        match parent {
            Some(p) => graph.world_quaternion(p),
            None => Quat::default(),
        }
    }

    // arm-chain.ts ArmChain.aim
    //
    // Aim one bone so its child direction points along `targetWorld`.
    // Returns this bone's world rotation, so the next
    // bone down can derive its parent rotation from it. `parentWorldQ` must be
    // the world rotation of `bone.parent` itself — see `parentWorld`.
    #[allow(clippy::too_many_arguments)]
    fn aim(
        &mut self,
        graph: &mut Graph,
        port: &dyn ArmChainPort,
        bone: u32,
        rest_dir: &Vec3,
        parent_world_q: &Quat,
        target_world: &Vec3,
        twist: f64,
        palm: Option<&PalmSpec>,
    ) -> Quat {
        let mut cur_world = *parent_world_q;
        cur_world.multiply(&port.rest_of(bone));
        let mut cur_dir = *rest_dir;
        cur_dir.apply_quaternion(&cur_world).normalize();
        let mut out = Quat::default();
        out.set_from_unit_vectors(&cur_dir, target_world)
            .multiply(&cur_world);

        // Aiming a bone leaves the roll about its own axis undetermined: pointing
        // the fingers somewhere says nothing about which way the palm faces, and
        // `setFromUnitVectors` picks the shortest rotation, so the roll comes out
        // as a side effect of the rest pose rather than as anything anyone chose.
        // Where a palm target is given, solve the roll that satisfies it.
        self.roll = 0.0;
        if let Some(palm) = palm {
            let mut cur = palm.local;
            cur.apply_quaternion(&out);
            let mut want = palm.target;
            // Both projected onto the plane normal to the aim axis; the signed angle
            // between them in that plane is the roll needed.
            let d = -cur.dot(target_world);
            cur.add_scaled_vector(target_world, d);
            let d = -want.dot(target_world);
            want.add_scaled_vector(target_world, d);
            if cur.length_sq() > 1e-8 && want.length_sq() > 1e-8 {
                cur.normalize();
                want.normalize();
                let cos = clamp(cur.dot(&want), -1.0, 1.0);
                let sin = Vec3::default().cross_vectors(&cur, &want).dot(target_world);
                // Weighted, so a pose that states no palm can give the constraint up
                // instead of inheriting one: at weight 0 this is the plain minimal
                // rotation, which is a fine default for a hand that nobody has an
                // opinion about.
                //
                // Reported, not applied. Which joints pay for the roll is a question
                // about the whole arm — the shoulder above the elbow has more of the
                // range than everything below it — and this method holds one bone.
                self.roll = atan2(sin, cos) * palm.weight;
            }
        }

        let mut local = *parent_world_q;
        local.invert().multiply(&out);
        if truthy(twist) {
            local.multiply(&twist_about(rest_dir, twist));
            // Keep `out` consistent with what the bone actually ends up at, in case
            // anything downstream threads from it.
            out.copy(parent_world_q).multiply(&local);
        }
        graph.set_local_quaternion(bone, &local);
        out
    }

    // arm-chain.ts ArmChain.hingeUpper
    //
    // Turn an aimed humerus about its own axis until its front faces the way the
    // forearm folds.
    //
    // The shortest-arc aim leaves the humerus at whatever roll the swing from rest
    // gives it, so a rotated arm bent its elbow up to eighty degrees off the bone's
    // own hinge: the crease of the mesh faced one way and the forearm folded
    // another, and pronation was counted from a frame no forearm has. Faded in with
    // the bend, by the trust the measurement gives it, because a straight elbow
    // folds nowhere.
    fn hinge_upper(
        &mut self,
        p: &Profile,
        graph: &mut Graph,
        side: Side,
        upper: u32,
        u_d: &Vec3,
        l_d: &Vec3,
    ) {
        let rest = self.humeral_front[side as usize];
        let trust = rotation_trust(acos(clamp(u_d.dot(l_d), -1.0, 1.0)));
        let Some(rest) = rest else {
            return;
        };
        if trust <= 0.0 {
            return;
        }
        let mut front = rest;
        front.apply_quaternion(&self.upper_q);
        let d = -front.dot(u_d);
        front.add_scaled_vector(u_d, d);
        let mut fold = *l_d;
        fold.add_scaled_vector(u_d, -l_d.dot(u_d));
        if front.length_sq() < 1e-8 || fold.length_sq() < 1e-8 {
            return;
        }
        front.normalize();
        fold.normalize();
        let turn = atan2(
            Vec3::default().cross_vectors(&front, &fold).dot(u_d),
            front.dot(&fold),
        );
        let mut q = graph.local_quaternion(upper);
        q.multiply(&twist_about(
            &rest_dir(p, ArmSlot::UpperArm, side),
            turn * trust,
        ));
        graph.set_local_quaternion(upper, &q);
        self.upper_q.copy(&self.upper_parent_q).multiply(&q);
    }

    // arm-chain.ts ArmChain.aimShoulder
    //
    // Pose the shoulder alone. See `Rig.aimShoulder`.
    pub fn aim_shoulder(
        &mut self,
        p: &Profile,
        graph: &mut Graph,
        port: &dyn ArmChainPort,
        side: Side,
        dir: Option<&Vec3>,
    ) {
        let bone = p.bone(BoneSlot::arm(ArmSlot::Shoulder, side));
        // The clavicle's own parent, which a rig may not have put on the chest slot.
        let parent = bone.and_then(|b| graph.parent_of(b));
        let (Some(bone), Some(parent), Some(dir)) = (bone, parent, dir) else {
            return;
        };
        let rest = rest_dir(p, ArmSlot::Shoulder, side);
        let parent_world = graph.world_quaternion(parent);
        let target = world_direction(dir);
        self.aim(graph, port, bone, &rest, &parent_world, &target, 0.0, None);
    }

    // arm-chain.ts ArmChain.aimArmLegacy
    //
    // Legacy single-chain path. See `Rig.aimArmLegacy`. `dirs` is in `ArmSlot` order; the TS
    // defaults are `twist = 0`, `palmTarget = null`, `palmWeight = 1`.
    #[allow(clippy::too_many_arguments)]
    pub fn aim_arm_legacy(
        &mut self,
        p: &Profile,
        joints: &JointTable,
        graph: &mut Graph,
        anat: &mut ArmAnatomy,
        port: &mut dyn ArmChainPort,
        side: Side,
        dirs: &[Option<Vec3>; 4],
        twist: f64,
        palm_target: Option<&Vec3>,
        palm_weight: f64,
    ) {
        let palm_local = self.palm_local[side as usize];
        let mut palm: Option<PalmSpec> = None;
        if let (Some(target), Some(local)) = (palm_target, palm_local)
            && palm_weight > 1e-3
        {
            let mut target = *target;
            target.normalize();
            palm = Some(PalmSpec {
                local,
                target,
                weight: palm_weight,
            });
        }
        let Some(chest) = p.chest() else {
            return;
        };

        // Bound the whole arm before any of it is posed, so a limit is never
        // something a pose can argue its way past. Done up front rather than link
        // by link because the anatomical measurement is not local to a joint: how
        // far the shoulder may lift depends on which plane it lifted in, and
        // whether a wrist is bent or deviated depends on which way the palm faces.
        // The chain walk below only ever holds one link at a time.
        let lim = self.limit(graph, anat, port, side, dirs, palm.as_ref());

        // The bounded directions, each in its own vector. `worldDirection` hands back one
        // shared scratch, which was enough while the chain was walked a link at a
        // time; the roll budget needs all three at once to know how much of a
        // shoulder rotation would reach the palm.
        let dir = |slot: ArmSlot| -> Option<Vec3> {
            let limited =
                lim.and_then(|l| LIMITED_SLOTS.iter().position(|&s| s == slot).map(|k| l[k]));
            let mut into = limited.or(dirs[slot as usize])?;
            into.normalize();
            Some(into)
        };
        let s_d = dir(ArmSlot::Shoulder);
        let mut u_d = dir(ArmSlot::UpperArm);
        let mut l_d = dir(ArmSlot::LowerArm);
        let mut h_d = dir(ArmSlot::Hand);

        let clav = p.bone(BoneSlot::arm(ArmSlot::Shoulder, side));
        let upper = p.bone(BoneSlot::arm(ArmSlot::UpperArm, side));
        let fore = p.bone(BoneSlot::arm(ArmSlot::LowerArm, side));
        let hand = p.bone(BoneSlot::arm(ArmSlot::Hand, side));

        // --- down as far as the upper arm ---------------------------------------
        // From the chain's real parent, which a rig may not have put on the chest slot.
        let top = clav
            .or(upper)
            .and_then(|b| graph.parent_of(b))
            .unwrap_or(chest);
        let mut q = graph.world_quaternion(top);
        if let Some(clav) = clav {
            q = match s_d {
                Some(s_d) => {
                    let rest = rest_dir(p, ArmSlot::Shoulder, side);
                    self.aim(graph, port, clav, &rest, &q, &s_d, 0.0, None)
                }
                None => {
                    let mut c = q;
                    *c.multiply(&port.rest_of(clav))
                }
            };
        }
        // The chain bone each link hangs from, whose world rotation the walk holds.
        let above_upper = clav.unwrap_or(top);
        let above_fore = upper.unwrap_or(above_upper);
        let above_hand = fore.unwrap_or(above_fore);
        self.upper_parent_q = match upper {
            Some(upper) => ArmChain::parent_world(graph, upper, above_upper, &q),
            None => q,
        };
        if let Some(upper) = upper {
            if let Some(u) = u_d {
                let rest = rest_dir(p, ArmSlot::UpperArm, side);
                let parent = self.upper_parent_q;
                self.upper_q = self.aim(graph, port, upper, &rest, &parent, &u, 0.0, None);
            } else {
                self.upper_q.copy(&q).multiply(&port.rest_of(upper));
            }
            if let (Some(u), Some(l)) = (u_d, l_d) {
                self.hinge_upper(p, graph, side, upper, &u, &l);
            }
        } else {
            self.upper_q = q;
        }

        let links = Below {
            fore,
            hand,
            above_fore,
            above_hand,
            fore_dir: fore.map(|_| rest_dir(p, ArmSlot::LowerArm, side)),
            hand_dir: hand.map(|_| rest_dir(p, ArmSlot::Hand, side)),
        };

        // --- who pays for the roll ----------------------------------------------
        let pron = joints.elbow.rotation;
        let mut r = self.below(graph, port, &links, l_d, h_d, palm.as_ref(), 0.0, 0.0);
        let mut humeral = 0.0;

        if let (Some(_), Some(_), Some(u), Some(l)) = (palm, upper, u_d, l_d)
            && r.abs() > 1e-3
        {
            let spare = r - clamp(r, pron.max[0], pron.max[1]);
            // How much of a humeral rotation arrives at the palm.
            //
            // Twisting a bone and then re-aiming the one below it to the direction it
            // was already pointing passes on the twist scaled by the cosine of the
            // angle between them — all of it in line, none at a right angle, and
            // negated past that. The palm is two joints down, so it happens twice.
            //
            // Both terms are needed. Stopping at the elbow overstates what reaches a
            // bent wrist, and it was the missing wrist term that had the shoulder
            // declining to help on the reaches that needed it most.
            let transfer = u.dot(&l) * h_d.map_or(1.0, |h| l.dot(&h));
            if truthy(spare) && transfer.abs() > ROLL_TRANSFER_MIN {
                // Measured, not assumed: the shoulder may already be rotated by where
                // the elbow points, and that spends the same range. A hand with no
                // direction of its own follows the forearm, which is a straight wrist
                // and the same substitution the elbow search makes.
                anat.measure(side, &u, &l, &h_d.unwrap_or(l), None, 0.0, 0.0);
                let room = roll_room(anat.m.rotation, &joints.shoulder.rotation);
                humeral = clamp(spare / transfer, room[0], room[1]);
            }
        }

        if let Some(upper) = upper
            && truthy(humeral)
        {
            let axis = rest_dir(p, ArmSlot::UpperArm, side);
            self.twist_upper(graph, upper, &axis, humeral);
            let after = self.below(graph, port, &links, l_d, h_d, palm.as_ref(), 0.0, 0.0);
            // The transfer estimate is a cosine, and near the gate it is a rough one.
            // A donation that left the palm further from where it was asked to face is
            // not a donation; undo it rather than ship an arm rotated for nothing.
            if after.abs() >= r.abs() {
                self.twist_upper(graph, upper, &axis, -humeral);
                humeral = 0.0;
                self.below(graph, port, &links, l_d, h_d, palm.as_ref(), 0.0, 0.0);
            } else {
                r = after;
            }
        }

        // The axial half of `slew`: neither roll shows in a link direction, so the
        // direction slew cannot see one change. A palm demand passing half a turn
        // changes sign in a frame, and the clamp sent the forearm from one stop to
        // the other; the shoulder's share steps on its gate and its undo. Eased, the
        // arm still ends where the plain answer says, however it was arrived at.
        let held = self.roll_held[side as usize];
        let roll_step = LIMIT_SLEW * port.dt();
        if held.set && roll_step > 0.0 {
            let eased = held.humeral + clamp(humeral - held.humeral, -roll_step, roll_step);
            if let Some(upper) = upper
                && eased != humeral
            {
                let axis = rest_dir(p, ArmSlot::UpperArm, side);
                self.twist_upper(graph, upper, &axis, eased - humeral);
                humeral = eased;
                r = self.below(graph, port, &links, l_d, h_d, palm.as_ref(), 0.0, 0.0);
            }
        }

        let mut total = clamp(r, pron.max[0], pron.max[1]);
        if held.set && roll_step > 0.0 {
            total = held.fore + clamp(total - held.fore, -roll_step, roll_step);
        }
        self.roll_held[side as usize] = RollHeld {
            fore: total,
            humeral,
            set: true,
        };
        let carry = total * (1.0 - PRONATION_SPLIT);
        let hw = if palm.is_some() {
            total * PRONATION_SPLIT
        } else {
            twist
        };
        self.below(graph, port, &links, l_d, h_d, palm.as_ref(), carry, hw);

        // Pronation is recorded here rather than measured later: it is a roll about
        // the forearm's own axis, and a roll about an axis leaves no trace in the
        // segment directions the rest of the model reads. Both bones' shares are
        // recorded as one number, because anatomically they are one rotation.
        port.record_rolls(side, total, humeral);

        // --- the wrist, against the palm the arm actually reached ---------------
        //
        // The clamp up top could only bound the wrist against the palm the pose
        // asked for. Where the roll budget could not deliver all of it, the palm
        // ends up somewhere else, and the split of the bend into flexion and
        // deviation turns with it. One correction pass: clamping again moves the
        // palm again, and the second-order term is not worth a third aim per arm
        // per frame.
        if port.limits_enabled()
            && let (Some(_), Some(h), Some(l), Some(_), Some(local)) =
                (palm, h_d.as_mut(), l_d.as_mut(), hand, palm_local)
        {
            let got = &mut self.palm_world[side as usize];
            got.copy(&local).apply_quaternion(&self.hand_q).normalize();
            let got = *got;
            let fix_dir = *h;
            anat.clamp_wrist(side, l, h, Some(&got));
            // Bounding the wrist can put the hand back into the face the clamp just
            // lifted it off — this runs after `clamp`, so it has the last word on
            // where the hand points, and it knows nothing about the body. Lift it out
            // again. Only the hand turns, about the wrist, so the arm above it stays
            // exactly as posed.
            if let Some(u) = u_d.as_mut() {
                anat.clear_hand(side, u, Some(l), Some(h));
            }
            if h.distance_to_squared(&fix_dir) > 1e-8 {
                self.below(graph, port, &links, l_d, h_d, palm.as_ref(), carry, hw);
            }
        }
        port.stage_twists(graph, side);
    }

    /// `upper.quaternion.multiply(twist); _upperQ = _upperParentQ * upper.quaternion`.
    fn twist_upper(&mut self, graph: &mut Graph, upper: u32, axis: &Vec3, angle: f64) {
        let mut q = graph.local_quaternion(upper);
        q.multiply(&twist_about(axis, angle));
        graph.set_local_quaternion(upper, &q);
        self.upper_q.copy(&self.upper_parent_q).multiply(&q);
    }

    // arm-chain.ts ArmChain.aimArmLegacy below
    //
    // Pose the forearm and hand from wherever the upper arm now sits, spending
    // `carry` on forearm pronation and `hw` on the hand. Returns the roll the
    // palm still wants, which does not depend on `hw` — it is measured against
    // the untwisted aim — so the same call both prices a trial and pays for it.
    #[allow(clippy::too_many_arguments)]
    fn below(
        &mut self,
        graph: &mut Graph,
        port: &dyn ArmChainPort,
        links: &Below,
        l_d: Option<Vec3>,
        h_d: Option<Vec3>,
        palm: Option<&PalmSpec>,
        carry: f64,
        hw: f64,
    ) -> f64 {
        let mut p = self.upper_q;
        if let (Some(fore), Some(fore_dir)) = (links.fore, links.fore_dir) {
            let upper_q = self.upper_q;
            self.fore_parent_q = ArmChain::parent_world(graph, fore, links.above_fore, &upper_q);
            let fp = self.fore_parent_q;
            if let Some(l) = l_d {
                self.fore_q = self.aim(graph, port, fore, &fore_dir, &fp, &l, 0.0, None);
            } else {
                self.fore_q.copy(&fp).multiply(&port.rest_of(fore));
            }
            if truthy(carry) {
                let mut q = graph.local_quaternion(fore);
                q.multiply(&twist_about(&fore_dir, carry));
                graph.set_local_quaternion(fore, &q);
                self.fore_q.copy(&fp).multiply(&q);
            }
            p = self.fore_q;
        }
        let (Some(hand), Some(hand_dir)) = (links.hand, links.hand_dir) else {
            return 0.0;
        };
        self.hand_parent_q = ArmChain::parent_world(graph, hand, links.above_hand, &p);
        let hp = self.hand_parent_q;
        let Some(h) = h_d else {
            let rest = port.rest_of(hand);
            graph.set_local_quaternion(hand, &rest);
            self.hand_q.copy(&hp).multiply(&rest);
            return 0.0;
        };
        self.hand_q = self.aim(graph, port, hand, &hand_dir, &hp, &h, hw, palm);
        self.roll
    }

    // arm-chain.ts ArmChain.palmWorld
    //
    // The palm normal to measure a wrist against, in world space.
    //
    // The palm *target* the pose asked for, or null where it asked for nothing.
    //
    // Null is the meaningful case, not a fallback. The wrist has to be bounded
    // before the arm is aimed, and the roll that decides where the palm ends up
    // is solved during the aim — so the only palm knowable here is the one the
    // pose stated. Where it stated none, the palm is genuinely free, and
    // `anatomy/` scores the wrist accordingly. Substituting last frame's actual
    // palm looks more informed and is worse: it feeds the previous clamp back
    // into the next one.
    fn palm_world(&mut self, side: Side, palm: Option<&PalmSpec>) -> Option<Vec3> {
        let palm = palm?;
        let out = &mut self.palm_world[side as usize];
        out.copy(&palm.target).normalize();
        Some(*out)
    }

    // arm-chain.ts ArmChain.limit
    //
    // Pull one arm's directions inside its anatomical stops.
    //
    // Returns rig-owned vectors rather than editing `dirs` in place: `dirs` is
    // the body layer's smoothed state, and folding a limit back into it would
    // make the limit accumulate — an arm held against a stop would keep being
    // pushed further into it, one frame's clamp at a time.
    fn limit(
        &mut self,
        graph: &mut Graph,
        anat: &mut ArmAnatomy,
        port: &mut dyn ArmChainPort,
        side: Side,
        dirs: &[Option<Vec3>; 4],
        palm: Option<&PalmSpec>,
    ) -> Option<LimitedDirs> {
        if !(port.limits_enabled() && anat.update(graph)) {
            return None;
        }
        let (Some(u), Some(l), Some(h)) = (
            dirs[ArmSlot::UpperArm as usize],
            dirs[ArmSlot::LowerArm as usize],
            dirs[ArmSlot::Hand as usize],
        ) else {
            return None;
        };
        port.arm_context(graph, anat, side);
        let mut out = [
            world_direction(&u),
            world_direction(&l),
            world_direction(&h),
        ];
        let palm_world = self.palm_world(side, palm);
        let [u, l, h] = &mut out;
        anat.clamp(side, u, l, h, palm_world.as_ref());
        self.slew(side, &mut out, port.dt());
        Some(out)
    }

    // arm-chain.ts ArmChain.slew
    //
    // Hold the limiter's output to a speed a limb can move at.
    //
    // The body layer takes great care that nothing it hands down here steps — the
    // followers in `motion/follow.ts` exist for that and nothing else — and then
    // this layer puts a step back in. A clamp is a projection onto the set of
    // poses a joint allows, that set is not convex, and projection onto a
    // non-convex set is discontinuous by construction: the humeral rotation is
    // bounded to half a circle, so a request that drifts past the far side of it
    // is equally close to both stops and the nearest one changes in a single
    // frame. The forearm then swings a hundred and eighty degrees between two
    // frames. Measured across every ordered switch between two gestures, one in
    // six carried the wrist faster than four metres a second and the worst carried
    // it at twenty-six, against a peak of two or three for the movement itself.
    // Switching the limiter off entirely left five in a thousand over four, which
    // is what said the clamp was the whole of it rather than a part.
    //
    // The elevation ceiling, the elbow and the wrist each have a seam of their own
    // and no one of them accounts for it, so this bounds the result rather than
    // chasing them: whatever the clamp asks for, the arm travels there at a speed
    // a limb has. Below the cap nothing changes at all, which is what makes it
    // safe — see `LIMIT_SLEW`. The cost is that for the tenth of a second after a
    // seam the arm is outside the stop it was being pulled inside, and that is the
    // trade: `measure` reads the posed bones, so the panel shows the excursion
    // honestly rather than reporting the pose the clamp asked for.
    fn slew(&mut self, side: Side, out: &mut LimitedDirs, dt: f64) {
        let s = side as usize;
        let step = LIMIT_SLEW * dt;
        if !(self.held_limit[s] && step > 0.0) {
            self.held[s] = *out;
            self.held_limit[s] = true;
            return;
        }
        for (cur, want) in self.held[s].iter_mut().zip(out.iter_mut()) {
            let mut axis = Vec3::default();
            axis.cross_vectors(cur, want);
            let sin = axis.length();
            let cos = clamp(cur.dot(want), -1.0, 1.0);
            if atan2(sin, cos) <= step {
                cur.copy(want);
            } else if sin > 1e-9 {
                axis.divide_scalar(sin);
                cur.apply_axis_angle(&axis, step).normalize();
            } else {
                // Exactly opposed, which is the half-turn this exists for and the one
                // case where the shortest rotation does not name an axis. Any
                // perpendicular is as short as any other and one has to be picked —
                // leaving the axis at zero would park the link on the far side of the
                // sphere and call it arrived, which is the teleport rather than a fix.
                let mut perp = Vec3::new(1.0, 0.0, 0.0);
                if cur.x.abs() > 0.9 {
                    perp.set(0.0, 1.0, 0.0);
                }
                axis.cross_vectors(cur, &perp).normalize();
                cur.apply_axis_angle(&axis, step).normalize();
            }
            want.copy(cur);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Mat4;
    use crate::rig::testkit::{Driven, avatar, bone, euler, with_helper_above};

    fn v(x: f64, y: f64, z: f64) -> Option<Vec3> {
        Some(Vec3::new(x, y, z))
    }

    /// `interposeBone`: a carrier at `fraction` of `slot`'s offset, turned by `rotation`, which
    /// `slot` is attached to with its world pose kept.
    fn interpose(
        g: &Graph,
        p: &Profile,
        slot: BoneSlot,
        rotation: [f64; 3],
        fraction: f64,
    ) -> (Graph, Profile) {
        let child = bone(p, slot);
        let mut at = g.local_position(child);
        at.multiply_scalar(fraction);
        let turn = euler(rotation[0], rotation[1], rotation[2]);
        let one = Vec3::new(1.0, 1.0, 1.0);
        let mut carrier = Mat4::default();
        carrier.compose(&at, &turn, &one);
        carrier.invert();
        let mut local = Mat4::default();
        local.compose(
            &g.local_position(child),
            &g.local_quaternion(child),
            &g.local_scale(child),
        );
        let mut attached = Mat4::default();
        attached.multiply_matrices(&carrier, &local);
        let (mut position, mut quaternion, mut scale) =
            (Vec3::default(), Quat::default(), Vec3::default());
        attached.decompose(&mut position, &mut quaternion, &mut scale);
        let (mut g, p, helper) = with_helper_above(g, p, child, &at, &turn, &one);
        let moved = helper + 1;
        g.set_local_position(moved, &position);
        g.set_local_quaternion(moved, &quaternion);
        g.set_local_scale(moved, &scale);
        g.update_matrix_world(0, true);
        (g, p)
    }

    fn world_direction_of(h: &mut Driven, slot: BoneSlot) -> Vec3 {
        let b = bone(&h.profile, slot);
        h.graph.update_matrix_world(0, true);
        let mut d = h.profile.rest_dir[slot as usize].unwrap();
        d.apply_quaternion(&h.graph.world_quaternion(b)).normalize();
        d
    }

    // --- tests/rig/arm-legacy-chain.test.ts ----------------------------------------------------

    const DIRS: [Option<Vec3>; 4] = [
        Some(Vec3::new(0.97, 0.18, 0.12)),
        Some(Vec3::new(0.62, -0.58, 0.53)),
        Some(Vec3::new(0.08, -0.12, 0.99)),
        Some(Vec3::new(0.2, 0.05, 0.98)),
    ];

    #[test]
    fn aims_every_link_through_a_carrier_bone_interposed_in_the_chain() {
        let (g, p) = avatar();
        let (g, p) = interpose(&g, &p, BoneSlot::LowerArmR, [0.31, -0.42, 0.57], 0.5);
        let (g, p) = interpose(&g, &p, BoneSlot::HandR, [-0.27, 0.36, 0.19], 0.4);
        let lower = bone(&p, BoneSlot::LowerArmR);
        let hand = bone(&p, BoneSlot::HandR);
        assert_ne!(g.parent_of(lower), p.bone(BoneSlot::UpperArmR));
        assert_ne!(g.parent_of(hand), Some(lower));
        let mut h = Driven::of(g, p);
        h.limits = false;

        h.aim_arm_legacy(Side::R, &DIRS, 0.0, None, 1.0);

        for (slot, want) in [
            (BoneSlot::UpperArmR, DIRS[1]),
            (BoneSlot::LowerArmR, DIRS[2]),
            (BoneSlot::HandR, DIRS[3]),
        ] {
            let mut target = want.unwrap();
            target.normalize();
            assert!(
                world_direction_of(&mut h, slot).angle_to(&target) < 1e-6,
                "{slot:?}"
            );
        }
    }

    /// The direct-chain pose legacy aiming produces; carrier handling must not perturb it.
    const DIRECT_CHAIN: [[f64; 4]; 4] = [
        [
            0.0,
            -0.06073764267905947,
            0.09110646401858921,
            0.9939871985975576,
        ],
        [
            0.8750971991677953,
            -0.42201809309429394,
            0.20025045706242162,
            0.12651235337320635,
        ],
        [
            -0.3686596031308643,
            0.3859315640306271,
            0.17182780287242339,
            0.8280230256848553,
        ],
        [
            -0.2741408299207991,
            0.09769154370491118,
            -0.03585446588758928,
            0.9560426899123289,
        ],
    ];

    #[test]
    fn poses_a_direct_chain_exactly_as_before() {
        let mut h = Driven::new();
        h.limits = false;
        h.aim_arm_legacy(Side::R, &DIRS, 0.3, v(0.1, -0.9, 0.4).as_ref(), 0.8);
        let posed = [
            ArmSlot::Shoulder,
            ArmSlot::UpperArm,
            ArmSlot::LowerArm,
            ArmSlot::Hand,
        ]
        .map(|slot| {
            let q = h
                .graph
                .local_quaternion(bone(&h.profile, BoneSlot::arm(slot, Side::R)));
            [q.x, q.y, q.z, q.w]
        });
        assert_eq!(posed, DIRECT_CHAIN);
    }

    // --- tests/rig/arm-twists-lifecycle.test.ts, the chain's half ------------------------------

    #[test]
    fn stages_actual_legacy_roll_after_the_final_wrist() {
        for side in Side::BOTH {
            let mut h = Driven::new();
            h.limits = false;
            let sign = if side == Side::L { -1.0 } else { 1.0 };
            let dirs = [v(sign, 0.0, 0.0); 4];
            let upper = h.profile.arm_twists[side as usize].unwrap();
            let lower = h.profile.arm_twists[2 + side as usize].unwrap();
            let upper_rest = h.graph.local_quaternion(upper.helper);
            let lower_rest = h.graph.local_quaternion(lower.helper);
            let angle = 80.0 * (core::f64::consts::PI / 180.0);
            let axis = rest_dir(&h.profile, ArmSlot::LowerArm, side);
            let mut palm = h.hands.palm_local()[side as usize].expect("missing palm");
            palm.apply_axis_angle(&axis, angle);

            h.aim_arm_legacy(side, &dirs, 0.0, Some(&palm), 1.0);

            let expected = |share: f64, rest: &Quat| {
                let mut q = twist_about(&axis, angle * share);
                *q.multiply(rest)
            };
            let got = |b: u32| h.graph.local_quaternion(b);
            assert!(got(upper.helper).angle_to(&expected(0.3, &upper_rest)) < 1e-7);
            assert!(got(lower.helper).angle_to(&expected(0.2, &lower_rest)) < 1e-7);
            assert!(got(lower.primary).angle_to(&twist_about(&axis, angle * 0.6)) < 1e-7);
            h.twists.as_ref().unwrap().reset(&mut h.graph);
            assert_eq!(h.graph.local_quaternion(upper.helper), upper_rest);
            assert_eq!(h.graph.local_quaternion(lower.helper), lower_rest);
        }
    }
}

/// `tests/corpora/rig-d-battery-{a,b,c}`: the TS arm drivers, routes, twist helpers and chain on
/// the base avatar through a fixed run of their calls, replayed record by record on the port. See
/// `record-corpora.test.ts`.
#[cfg(test)]
mod battery {
    use super::*;
    use crate::anatomy::volumes::VolumePose;
    use crate::corpus_replay::Corpus;
    use crate::rig::arm_configuration::{ArmConfiguration, ArmForwardContext};
    use crate::rig::arm_driver::{ArmDriver, ArmDriverAcceptedSnapshot, DriverOutput};
    use crate::rig::arm_path::plan::{
        ArmPathClearance, ArmPathPlanOutput, ArmPathRequest, ArmPathStatus, configuration_from_q,
    };
    use crate::rig::arm_route::ArmRoute;
    use crate::rig::testkit::{
        ChainPort, Driven, Stream, configuration_of, configuration_values, context_values,
        definition_values, forward_context, forward_values, graph_hash, halves, hash_halves, q4,
        v3,
    };
    use std::cell::RefCell;
    use std::rc::Rc;

    const FILES: [&str; 3] = ["rig-d-battery-a", "rig-d-battery-b", "rig-d-battery-c"];

    const TAGS: [&str; 35] = [
        "setup",
        "context",
        "volume",
        "compose",
        "forConfig",
        "fromPose",
        "bound",
        "fillBounds",
        "plan",
        "restore",
        "validate",
        "accept",
        "refresh",
        "capture",
        "restoreState",
        "sample",
        "routeReset",
        "routeRetime",
        "routeTrack",
        "routeCommand",
        "routeLimit",
        "routeAbsorb",
        "routeStop",
        "routeTail",
        "routeAccept",
        "twistStage",
        "twistAccept",
        "twistReset",
        "aimShoulder",
        "aimArm",
        "releaseSlew",
        "releaseContinuity",
        "set",
        "update",
        "planHook",
    ];

    /// The recorder's `planFrom` override: see `recordRigDBattery`.
    #[derive(Clone, Copy)]
    struct Hook {
        kind: usize,
        status: ArmPathStatus,
        error: f64,
        calls: usize,
    }

    const STATUSES: [ArmPathStatus; 4] = [
        ArmPathStatus::Progress,
        ArmPathStatus::Settled,
        ArmPathStatus::Stationary,
        ArmPathStatus::Blocked,
    ];

    pub(super) fn rows_hash(rows: &[ArmPathClearance]) -> [f64; 2] {
        let flat: Vec<f64> = rows
            .iter()
            .flat_map(|r| {
                [
                    r.key.map_or(-1.0, f64::from),
                    r.point_index.map_or(-1.0, |p| p as f64),
                    f64::from(u8::from(r.valid)),
                    r.distance,
                    r.normal.x,
                    r.normal.y,
                    r.normal.z,
                ]
            })
            .collect();
        hash_halves(&flat)
    }

    pub(super) fn same_request(s: &mut Stream, r: &ArmPathRequest) {
        s.same(&v3(&r.wrist), "request.wrist");
        s.same(&v3(&r.hand), "request.hand");
        s.same_opt_vec3(r.palm.as_ref(), "request.palm");
        s.same_opt_vec3(r.elbow.as_ref(), "request.elbow");
        s.same_spec(&r.curls, "request.curls");
        s.same_spec(&r.spread, "request.spread");
    }

    fn same_summary(s: &mut Stream, o: &ArmPathPlanOutput, statuses: &mut [usize; 4]) {
        s.same(&o.q, "q");
        s.same(
            &[
                o.status as usize as f64,
                o.position_error,
                o.orientation_error,
                o.secondary_error,
                o.max_violation,
                o.iterations as f64,
                o.environment_batches as f64,
            ],
            "status and errors",
        );
        s.same(&hash_halves(&forward_values(&o.forward)), "forward");
        let points: Vec<f64> = o.points.iter().flat_map(|p| v3(&p.position)).collect();
        s.same(&hash_halves(&points), "points");
        s.same(&rows_hash(&o.clearances), "rows");
        statuses[o.status as usize] += 1;
    }

    fn same_sampled(s: &mut Stream, driver: &ArmDriver, from: usize) {
        let taken: Vec<f64> = driver.environment.trace[from..]
            .iter()
            .flat_map(|[p, r]| {
                let (p, r) = (halves(*p), halves(*r));
                [p[0], p[1], r[0], r[1]]
            })
            .collect();
        s.same(&[(taken.len() / 4) as f64], "samples");
        s.same(&hash_halves(&taken), "sampled rows");
    }

    fn same_accepted(s: &mut Stream, d: &ArmDriver) {
        s.same(&d.accepted_q, "acceptedQ");
        s.same(
            &configuration_values(&d.accepted_configuration),
            "acceptedConfiguration",
        );
        s.same(&d.accepted_curls, "acceptedCurls");
        s.same(&d.accepted_spread, "acceptedSpread");
        s.same(
            &hash_halves(&forward_values(&d.accepted_forward)),
            "acceptedForward",
        );
        s.same(&[d.request_roll_history()], "rollHistory");
    }

    fn same_route(s: &mut Stream, r: &ArmRoute) {
        let mut flat = Vec::with_capacity(63);
        for a in [
            &r.goal_q,
            &r.q_acc,
            &r.v_acc,
            &r.a_acc,
            &r.tail0,
            &r.tail_v,
            &r.tail_a,
            &r.carry_from,
            &r.carry_rate,
        ] {
            flat.extend_from_slice(a);
        }
        s.same(&hash_halves(&flat), "route");
        s.same_flag(r.projected(), "projected");
        s.same_flag(r.solved(), "solved");
        s.same_flag(r.stopping(), "stopping");
    }

    fn same_touched(s: &mut Stream, h: &Driven, side: Side) {
        for slot in [
            ArmSlot::Shoulder,
            ArmSlot::UpperArm,
            ArmSlot::LowerArm,
            ArmSlot::Hand,
        ] {
            let b = h.profile.bone(BoneSlot::arm(slot, side)).unwrap();
            s.same(&q4(&h.graph.local_quaternion(b)), "arm bone");
        }
        for t in [side as usize, 2 + side as usize] {
            if let Some(binding) = h.profile.arm_twists[t] {
                s.same(&q4(&h.graph.local_quaternion(binding.helper)), "helper");
            }
        }
        s.same(
            &[h.fore_roll[side as usize], h.upper_roll[side as usize]],
            "rolls",
        );
    }

    fn same_volume(s: &mut Stream, d: &ArmDriver) {
        let frame = d.environment.volume_frame;
        for pose in [frame.torso, frame.head] {
            match pose {
                Some(VolumePose { o, up, right, fwd }) => {
                    let mut v = vec![1.0];
                    for x in [o, up, right, fwd] {
                        v.extend(v3(&x));
                    }
                    s.same(&v, "volume frame");
                }
                None => s.same(&[0.0], "volume frame"),
            }
        }
    }

    fn driver(h: &mut Driven, side: Side) -> (&mut ArmDriver, &mut ArmAnatomy) {
        h.driver(side)
    }

    #[test]
    fn replays_the_ts_arm_driver_route_twists_and_chain_bit_for_bit() {
        let corpora: Vec<Corpus> = FILES.iter().map(|f| Corpus::load(f)).collect();
        let mut h = Driven::new();
        let mut contexts: [Option<ArmForwardContext>; 2] = [None, None];
        let mut routes = [ArmRoute::new(0.25), ArmRoute::new(0.25)];
        let mut snapshots = [ArmDriverAcceptedSnapshot::default(); 2];
        let mut seen = [0usize; 35];
        let hook = Rc::new(RefCell::new(Hook {
            kind: 0,
            status: ArmPathStatus::Progress,
            error: 0.0,
            calls: 0,
        }));
        for d in h.drivers.iter_mut().flatten() {
            let hook = hook.clone();
            d.plan_hook = Some(Box::new(move |_, start, out| {
                let mut k = hook.borrow_mut();
                match k.kind {
                    1 => {
                        out.status = k.status;
                        out.q = *start;
                    }
                    2 => {
                        if k.calls == 0 {
                            out.status = ArmPathStatus::Blocked;
                            out.position_error = 0.05;
                            out.q = *start;
                        } else {
                            out.status = k.status;
                            out.position_error = k.error;
                        }
                        k.calls += 1;
                    }
                    3 => out.status = k.status,
                    _ => {}
                }
            }));
        }
        let mut statuses = [0usize; 4];
        let mut n = 0;
        for (file, corpus) in FILES.iter().zip(&corpora) {
            let case = corpus.case(0);
            let mut s = Stream::new(case.output("stream"));
            let mut records = 0;
            while !s.done() {
                let tag = s.index();
                s.what = format!("{file} record {records} (#{n} {})", TAGS[tag]);
                seen[tag] += 1;
                records += 1;
                n += 1;
                match TAGS[tag] {
                    "setup" => {
                        s.same_flag(h.twists.is_some(), "twists");
                        for side in Side::BOTH {
                            s.same_opt_vec3(h.hands.palm_local()[side as usize].as_ref(), "palm");
                            s.same_opt_vec3(h.humeral_front[side as usize].as_ref(), "front");
                            s.same(
                                &[
                                    h.anat.radial_sign[side as usize],
                                    crate::rig::testkit::finger_clearance(&h.profile, side),
                                ],
                                "radial sign and finger clearance",
                            );
                        }
                        for side in Side::BOTH {
                            let present = h.drivers[side as usize].is_some();
                            s.same_flag(present, "driver");
                            if !present {
                                continue;
                            }
                            let d = h.drivers[side as usize].as_ref().unwrap();
                            s.same(
                                &hash_halves(&definition_values(&d.calibration, &d.hand_geometry)),
                                "definition",
                            );
                            s.same(
                                &[d.environment.row_count as f64, d.sweep_resolution],
                                "rows and resolution",
                            );
                            let context = h.seeded[side as usize].unwrap();
                            s.same(&context_values(&context), "context");
                            contexts[side as usize] = Some(context);
                            s.same_flag(true, "seeded");
                            s.same(&d.accepted_q, "acceptedQ");
                            s.same(&[d.request_roll_history()], "roll");
                        }
                    }
                    "context" => {
                        let side = s.side();
                        let c = forward_context(&h.profile, &mut h.graph, &mut h.anat, side);
                        s.same_flag(c.is_some(), "context ok");
                        if let Some(c) = c {
                            contexts[side as usize] = Some(c);
                        }
                        let c = contexts[side as usize].unwrap();
                        s.same(&context_values(&c), "context");
                    }
                    "volume" => {
                        let side = s.side();
                        h.capture_volume_frame(side);
                        same_volume(&mut s, h.drivers[side as usize].as_ref().unwrap());
                    }
                    "compose" => {
                        let side = s.side();
                        let (u, l, hd) = (s.vec3(), s.vec3(), s.vec3());
                        let palm = s.opt_vec3();
                        let (weight, twist) = (s.f64(), s.f64());
                        let (curls, spread) = (s.spec(), s.spec());
                        let advance = s.flag();
                        let c = contexts[side as usize].unwrap();
                        let (d, _) = driver(&mut h, side);
                        let r = *d.compose_request(
                            &c,
                            &u,
                            &l,
                            &hd,
                            palm.as_ref(),
                            weight,
                            twist,
                            &curls,
                            &spread,
                            advance,
                        );
                        same_request(&mut s, &r);
                        s.same(&[d.request_roll_history()], "rollHistory");
                    }
                    "forConfig" => {
                        let side = s.side();
                        let q = s.q();
                        let (curls, spread) = (s.spec(), s.spec());
                        let c = contexts[side as usize].unwrap();
                        let mut conf = ArmConfiguration::default();
                        configuration_from_q(&q, &mut conf);
                        let (d, _) = driver(&mut h, side);
                        let r = *d.request_for_configuration(&conf, &c, &curls, &spread);
                        same_request(&mut s, &r);
                    }
                    "fromPose" => {
                        let side = s.side();
                        let (u, l, hd) = (s.vec3(), s.vec3(), s.vec3());
                        let palm = s.opt_vec3();
                        let c = contexts[side as usize].unwrap();
                        let (d, _) = driver(&mut h, side);
                        let ok = d.configuration_from_pose(&c, &u, &l, &hd, palm.as_ref());
                        s.same_flag(ok, "ok");
                        s.same(
                            &configuration_values(&d.target_configuration),
                            "targetConfiguration",
                        );
                        s.same(&d.target_q, "targetQ");
                    }
                    "bound" => {
                        let side = s.side();
                        let wild = configuration_of(s.take(7));
                        let (d, _) = driver(&mut h, side);
                        let mut out = wild;
                        d.bound_configuration(&wild, &mut out);
                        s.same(&configuration_values(&out), "bounded");
                    }
                    "fillBounds" => {
                        let side = s.side();
                        let start = s.q();
                        let (dt, temporal) = (s.f64(), s.flag());
                        let (d, _) = driver(&mut h, side);
                        let b = *d.fill_bounds(&start, dt, temporal);
                        s.same(&b.lower, "lower");
                        s.same(&b.upper, "upper");
                    }
                    "validate" => {
                        let side = s.side();
                        let q = s.q();
                        let (curls, spread) = (s.spec(), s.spec());
                        let bridge = s.flag();
                        let c = contexts[side as usize].unwrap();
                        let (d, anat) = driver(&mut h, side);
                        let from = d.environment.trace.len();
                        let into = if bridge {
                            DriverOutput::Bridge
                        } else {
                            DriverOutput::Output
                        };
                        let ok = d.validate_locked_pose(anat, &q, &c, &curls, &spread, into);
                        s.same_flag(ok, "ok");
                        let o = if bridge { &d.bridge_output } else { &d.output };
                        same_summary(&mut s, o, &mut statuses);
                        same_sampled(&mut s, d, from);
                    }
                    "plan" => {
                        let side = s.side();
                        let start = s.q();
                        let (dt, temporal) = (s.f64(), s.flag());
                        let c = contexts[side as usize].unwrap();
                        let (d, anat) = driver(&mut h, side);
                        let from = d.environment.trace.len();
                        d.plan_from(anat, &start, &c, dt, temporal);
                        same_summary(&mut s, &d.output, &mut statuses);
                        same_sampled(&mut s, d, from);
                    }
                    "restore" => {
                        let side = s.side();
                        let start = s.q();
                        let (dt, temporal) = (s.f64(), s.flag());
                        let c = contexts[side as usize].unwrap();
                        let (d, anat) = driver(&mut h, side);
                        let from = d.environment.trace.len();
                        let ok = d.restore_endpoint_from(anat, &start, &c, dt, temporal);
                        s.same_flag(ok, "ok");
                        same_summary(&mut s, &d.output, &mut statuses);
                        same_sampled(&mut s, d, from);
                    }
                    "accept" => {
                        let side = s.side();
                        let q = s.q();
                        let (curls, spread) = (s.spec(), s.spec());
                        let c = contexts[side as usize].unwrap();
                        let (d, _) = driver(&mut h, side);
                        d.accept(&q, &c, &curls, &spread);
                        same_accepted(&mut s, d);
                    }
                    "refresh" => {
                        let side = s.side();
                        let c = contexts[side as usize].unwrap();
                        let (d, _) = driver(&mut h, side);
                        let f = *d.refresh_accepted_forward(&c);
                        s.same(&forward_values(&f), "forward");
                    }
                    "capture" => {
                        let side = s.side();
                        let (d, _) = driver(&mut h, side);
                        d.capture_accepted_state(&mut snapshots[side as usize]);
                        same_accepted(&mut s, d);
                    }
                    "restoreState" => {
                        let side = s.side();
                        let (d, _) = driver(&mut h, side);
                        d.restore_accepted_state(&snapshots[side as usize]);
                        same_accepted(&mut s, d);
                    }
                    "sample" => {
                        let side = s.side();
                        let (d, anat) = driver(&mut h, side);
                        let points: Vec<_> = d.bridge_output.points.iter().rev().copied().collect();
                        let mut rows = d.bridge_output.clearances.clone();
                        let from = d.environment.trace.len();
                        d.sample_environment(anat, &points, &mut rows);
                        same_sampled(&mut s, d, from);
                        s.same(&rows_hash(&rows), "rows");
                    }
                    "routeReset" | "routeRetime" | "routeTrack" | "routeCommand" | "routeLimit"
                    | "routeAbsorb" | "routeStop" | "routeTail" | "routeAccept" => {
                        let side = s.side();
                        let route = &mut routes[side as usize];
                        let c = contexts[side as usize].unwrap();
                        match TAGS[tag] {
                            "routeReset" => route.reset(&s.q()),
                            "routeRetime" => route.retime(s.f64()),
                            "routeTrack" => {
                                let raw = s.q();
                                let (curls, spread) = (s.spec(), s.spec());
                                let dt = s.f64();
                                let (d, anat) = driver(&mut h, side);
                                let from = d.environment.trace.len();
                                let batches = route.track(d, anat, &c, &raw, &curls, &spread, dt);
                                s.same(&[batches as f64], "batches");
                                same_sampled(&mut s, d, from);
                            }
                            "routeCommand" => {
                                let mut out = [0.0; 7];
                                route.command(driver(&mut h, side).0, &mut out);
                                s.same(&out, "command");
                            }
                            "routeLimit" => {
                                let mut command = s.q();
                                let dt = s.f64();
                                let d = &*driver(&mut h, side).0;
                                let accepted = d.accepted_forward;
                                let ok = route.limit_slew(&mut command, &accepted, d, &c, dt);
                                s.same_flag(ok, "limited");
                                s.same(&command, "command");
                            }
                            "routeAbsorb" => route.absorb(&s.q()),
                            "routeStop" => route.begin_stop(s.f64()),
                            "routeTail" => {
                                let mut out = [0.0; 7];
                                route.tail_sample(&mut out);
                                s.same(&out, "tail");
                            }
                            _ => {
                                let q = s.q();
                                route.accept(&q, s.f64());
                            }
                        }
                        same_route(&mut s, &routes[side as usize]);
                    }
                    "twistStage" | "twistAccept" | "twistReset" => {
                        let side = s.side();
                        let twists = h.twists.as_mut().unwrap();
                        match TAGS[tag] {
                            "twistStage" => twists.stage(&mut h.graph, side),
                            "twistAccept" => twists.accept(&mut h.graph, side),
                            _ => twists.reset(&mut h.graph),
                        }
                        same_touched(&mut s, &h, side);
                    }
                    "aimShoulder" => {
                        let side = s.side();
                        let dir = s.opt_vec3();
                        let port = ChainPort {
                            p: &h.profile,
                            rest: &h.rest,
                            dt: h.dt,
                            limits: h.limits,
                            fore_roll: &mut h.fore_roll,
                            upper_roll: &mut h.upper_roll,
                            twists: h.twists.as_mut(),
                        };
                        h.chain
                            .aim_shoulder(&h.profile, &mut h.graph, &port, side, dir.as_ref());
                        same_touched(&mut s, &h, side);
                    }
                    "aimArm" => {
                        let side = s.side();
                        let dirs: [Option<Vec3>; 4] = std::array::from_fn(|_| s.opt_vec3());
                        let twist = s.f64();
                        let palm = s.opt_vec3();
                        let weight = s.f64();
                        h.dt = s.f64();
                        h.limits = s.flag();
                        h.aim_arm_legacy(side, &dirs, twist, palm.as_ref(), weight);
                        same_touched(&mut s, &h, side);
                    }
                    "releaseSlew" => h.chain.release_slew(),
                    "releaseContinuity" => h.chain.release_continuity(),
                    "set" => {
                        let node = s.index() as u32;
                        let (p, q) = (s.vec3(), s.quat());
                        h.graph.set_local_position(node, &p);
                        h.graph.set_local_quaternion(node, &q);
                    }
                    "update" => h.graph.update_matrix_world(0, true),
                    "planHook" => {
                        let kind = s.index();
                        let status = STATUSES[s.index()];
                        let error = s.f64();
                        *hook.borrow_mut() = Hook {
                            kind,
                            status,
                            error,
                            calls: 0,
                        };
                    }
                    other => panic!("unknown record {other}"),
                }
                let hash = graph_hash(&h.graph);
                s.same(&halves(hash), "hash");
            }
            assert_eq!(
                records as f64,
                case.scalar("records", false),
                "{file}: records"
            );
        }
        let branches: Vec<usize> = (0..6)
            .map(|b| routes.iter().map(|r| r.branches[b]).sum())
            .collect();
        eprintln!(
            "rig-d battery: {seen:?}, plan statuses {statuses:?}, track branches {branches:?}"
        );
        assert!(seen.iter().all(|&k| k > 0), "{seen:?}");
        assert!(statuses.iter().all(|&k| k > 0), "{statuses:?}");
        assert!(branches.iter().all(|&k| k > 0), "{branches:?}");
    }
}
