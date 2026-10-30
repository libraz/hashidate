//! `rig/hand-geometry.ts`: the hand hierarchy captured once at bind, evaluated without live bones.
//!
//! A captured path refers to its finger point and its contact segment ends by their index in
//! `points`, where the TS holds the path objects themselves. The module scratch of the TS is
//! written before it is read in every call, so it is local here.

use super::finger_axes::FingerAxes;
use super::hands::{FingerSpec, compose_finger_rotation};
use crate::anatomy::joints::JointTable;
use crate::anatomy::strain::finger_curl;
use crate::math::{Mat3, Mat4, Quat, Vec3};
use crate::profile::{ArmSlot, BoneSlot, Finger, Profile, Side};
use crate::scene::graph::{Graph, NO_NODE, flag};

/// The virtual fingertip carries this much of the final bone past the last joint.
pub const FINGER_TIP_EXTENSION: f64 = 0.75;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FingerJointPath {
    pub position: Vec3,
    pub rest: Quat,
    pub scale: Vec3,
    pub curl_axis: Option<Vec3>,
    pub splay_axis: Option<Vec3>,
    pub joint_index: Option<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FingerPointPath {
    pub finger: Finger,
    pub joint_index: usize,
    pub tip: bool,
    pub nodes: Option<Vec<FingerJointPath>>,
    pub previous_point: Option<usize>,
    pub last_point: Option<usize>,
}

/// Captured hand hierarchy in the hand bone's local coordinate frame.
#[derive(Clone, Debug, PartialEq)]
pub struct HandGeometryCalibration {
    /// Absent on legacy collision-only calibrations; contacts require an explicit capture.
    pub hand_present: Option<bool>,
    pub metric_scale: f64,
    pub joints: JointTable,
    pub points: Vec<FingerPointPath>,
}

/// A point on one finger, with a stable identity across samples.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HandGeometryPoint {
    pub finger: Finger,
    pub joint_index: usize,
    pub tip: bool,
    pub position: Vec3,
}

/// Reusable result buffer; create once per calibration with [`make_hand_geometry_sample`].
#[derive(Clone, Debug, PartialEq)]
pub struct HandGeometrySample {
    pub points: Vec<HandGeometryPoint>,
}

// hand-geometry.ts pathFromHand
//
// A chain bone outside the table never reaches the hand, as an outside bone does not in TS.
fn path_from_hand(graph: &Graph, hand: u32, target: u32) -> Option<Vec<u32>> {
    if target == NO_NODE {
        return None;
    }
    let mut path = Vec::new();
    let mut node = Some(target);
    while let Some(n) = node
        && n != hand
    {
        path.insert(0, n);
        node = graph.parent_of(n);
    }
    (node == Some(hand)).then_some(path)
}

// hand-geometry.ts captureHandGeometry
//
// Capture the resolved hand hierarchy once, while the avatar is in its bind pose.
// `metricScale` is the hand's uniform world scale: it is applied once to the
// hand-bone-local points, so a .01 armature and a unit-scale armature agree in metres.
//
// `rest` is the TS `rest.get(bone)`: `None` where the map has no entry.
pub fn capture_hand_geometry(
    profile: &Profile,
    graph: &Graph,
    side: Side,
    rest: &dyn Fn(u32) -> Option<Quat>,
    axes: &FingerAxes,
    joints: &JointTable,
    metric_scale: f64,
) -> HandGeometryCalibration {
    let mut points = Vec::new();
    let hand = profile.bone(BoneSlot::arm(ArmSlot::Hand, side));

    if let Some(hand) = hand {
        for finger in Finger::ALL {
            let chain = profile.finger(finger, side);
            if chain.is_empty() {
                continue;
            }

            let mut finger_point_indices = Vec::new();
            let chains: Vec<Option<Vec<u32>>> = chain
                .iter()
                .map(|&bone| path_from_hand(graph, hand, bone))
                .collect();
            if chains.iter().any(Option::is_none) {
                continue;
            }

            for (joint_index, path) in chains.iter().enumerate() {
                let path = path.as_ref().expect("checked above");
                let nodes = path
                    .iter()
                    .map(|&node| {
                        let is_bone = graph.flags[node as usize] & flag::BONE != 0;
                        let index = if is_bone {
                            chain.iter().position(|&b| b == node)
                        } else {
                            None
                        };
                        let curl_axis = if is_bone { axes.axis(node) } else { None };
                        let splay_axis = if index == Some(0) && is_bone {
                            axes.splay_axis(node)
                        } else {
                            None
                        };
                        FingerJointPath {
                            position: graph.local_position(node),
                            rest: if is_bone {
                                rest(node).unwrap_or_else(|| graph.local_quaternion(node))
                            } else {
                                graph.local_quaternion(node)
                            },
                            scale: graph.local_scale(node),
                            curl_axis: curl_axis.copied(),
                            splay_axis: splay_axis.copied(),
                            joint_index: index,
                        }
                    })
                    .collect();
                finger_point_indices.push(points.len());
                points.push(FingerPointPath {
                    finger,
                    joint_index,
                    tip: false,
                    nodes: Some(nodes),
                    previous_point: None,
                    last_point: None,
                });
            }

            if chain.len() >= 2 {
                points.push(FingerPointPath {
                    finger,
                    joint_index: chain.len() - 1,
                    tip: true,
                    nodes: None,
                    previous_point: Some(finger_point_indices[chain.len() - 2]),
                    last_point: Some(finger_point_indices[chain.len() - 1]),
                });
            }
        }
    }

    HandGeometryCalibration {
        hand_present: Some(hand.is_some()),
        metric_scale,
        joints: joints.clone(),
        points,
    }
}

// hand-geometry.ts makeHandGeometrySample
//
// Create a result buffer with identities and vectors stable across every sample.
pub fn make_hand_geometry_sample(calibration: &HandGeometryCalibration) -> HandGeometrySample {
    HandGeometrySample {
        points: calibration
            .points
            .iter()
            .map(|path| HandGeometryPoint {
                finger: path.finger,
                joint_index: path.joint_index,
                tip: path.tip,
                position: Vec3::default(),
            })
            .collect(),
    }
}

// hand-geometry.ts sampleHandGeometry
//
// Evaluate finger joints and virtual tips from captured rest geometry only.
// The sample never reads or writes the avatar's live bones or any pose history.
pub fn sample_hand_geometry<'s>(
    calibration: &HandGeometryCalibration,
    curls: &FingerSpec,
    spread: &FingerSpec,
    out: &'s mut HandGeometrySample,
) -> &'s mut HandGeometrySample {
    assert!(
        out.points.len() == calibration.points.len(),
        "hand geometry sample buffer was created for a different calibration"
    );

    let mut path_matrix = Mat4::default();
    let points = &calibration.points;
    for (output_index, path) in points.iter().enumerate() {
        let output = &out.points[output_index];
        assert!(
            output.finger == path.finger
                && output.joint_index == path.joint_index
                && output.tip == path.tip,
            "hand geometry sample buffer identities do not match the calibration"
        );

        if path.tip {
            let previous =
                out.points[path.previous_point.expect("a tip's previous point")].position;
            let last = out.points[path.last_point.expect("a tip's last point")].position;
            let mut tip_delta = Vec3::default();
            tip_delta.sub_vectors(&last, &previous);
            let mut position = last;
            position.add_scaled_vector(&tip_delta, FINGER_TIP_EXTENSION);
            out.points[output_index].position = position;
            continue;
        }

        evaluate_finger_path(calibration, path, curls, spread, &mut path_matrix);
        let mut position = Vec3::default();
        position
            .set_from_matrix_position(&path_matrix)
            .multiply_scalar(calibration.metric_scale);
        out.points[output_index].position.copy(&position);
    }
    out
}

// hand-geometry.ts evaluateFingerPath
//
// Compose the same captured hierarchy for collision points and contact landmarks.
fn evaluate_finger_path(
    calibration: &HandGeometryCalibration,
    path: &FingerPointPath,
    curls: &FingerSpec,
    spread: &FingerSpec,
    out: &mut Mat4,
) {
    out.identity();
    let mut local_quaternion = Quat::default();
    let mut local_matrix = Mat4::default();
    let mut rotation_scratch = Quat::default();
    for node in path.nodes.as_deref().unwrap_or(&[]) {
        let joint_index = node.joint_index;
        let amount = match joint_index {
            None => 0.0,
            Some(_) => curls[path.finger as usize].unwrap_or(0.0),
        };
        let node_joints = if path.finger == Finger::Thumb {
            &calibration.joints.thumb
        } else {
            &calibration.joints.finger
        };
        if let Some(curl_axis) = &node.curl_axis {
            compose_finger_rotation(
                &mut local_quaternion,
                &node.rest,
                curl_axis,
                // An index the TS leaves undefined reads the distal row.
                finger_curl(node_joints, joint_index.unwrap_or(2), amount),
                node.splay_axis.as_ref(),
                if joint_index == Some(0) {
                    spread[path.finger as usize].unwrap_or(0.0)
                } else {
                    0.0
                },
                None,
                0.0,
                &mut rotation_scratch,
            );
        } else {
            local_quaternion.copy(&node.rest);
        }
        local_matrix.compose(&node.position, &local_quaternion, &node.scale);
        out.multiply(&local_matrix);
    }
}

/// `HandContact['surface']`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContactSurface {
    Center,
    Pad,
    Back,
}

/// The palm contact's `region`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PalmRegion {
    Heel,
    Center,
}

/// `HandContact`: an internal procedural contact landmark; never part of the motion wire format.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum HandContact {
    Palm {
        region: PalmRegion,
        surface: Option<ContactSurface>,
    },
    Finger {
        finger: Finger,
        /// Real joint-to-joint segment: 0 joins joints 0–1, 1 joins joints 1–2.
        segment: u8,
        fraction: f64,
        surface: Option<ContactSurface>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContactSegment {
    pub finger: Finger,
    pub segment: u8,
    /// Index of the segment's start in the geometry's `points`.
    pub start: usize,
    /// Index of the segment's end in the geometry's `points`.
    pub end: usize,
    pub normal: Option<Vec3>,
}

/// Captured contact geometry in metric hand-bone coordinates, without live bones.
#[derive(Clone, Debug, PartialEq)]
pub struct HandContactCalibration {
    pub geometry: HandGeometryCalibration,
    pub palm_normal: Option<Vec3>,
    pub palm_center: Option<Vec3>,
    pub segments: Vec<ContactSegment>,
}

// hand-geometry.ts finiteVector
fn finite_vector(value: &Vec3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

// hand-geometry.ts captureHandContactGeometry
//
// Capture normals and palm landmarks from the existing bind hierarchy.
pub fn capture_hand_contact_geometry(
    geometry: &HandGeometryCalibration,
    palm_local: &Vec3,
) -> HandContactCalibration {
    let palm_normal = (finite_vector(palm_local) && palm_local.length_sq() > 0.0).then(|| {
        let mut n = *palm_local;
        n.normalize();
        n
    });
    let mut segments = Vec::new();
    let mut palm_center = (geometry.hand_present == Some(true)).then(Vec3::default);
    let mut contact_start = Mat4::default();
    let mut contact_end = Mat4::default();
    let mut contact_linear = Mat3::default();
    let mut contact_point = Vec3::default();
    let mut contact_normal = Vec3::default();
    let mut contact_tangent = Vec3::default();
    for finger in Finger::ALL {
        let real = |joint: usize| {
            geometry
                .points
                .iter()
                .position(|p| p.finger == finger && !p.tip && p.joint_index == joint)
        };
        if finger != Finger::Thumb && palm_center.is_some() {
            match real(0) {
                None => palm_center = None,
                Some(mcp) => {
                    evaluate_finger_path(
                        geometry,
                        &geometry.points[mcp],
                        &EMPTY_CONTROLS,
                        &EMPTY_CONTROLS,
                        &mut contact_start,
                    );
                    if let Some(center) = palm_center.as_mut() {
                        center.add(
                            contact_point
                                .set_from_matrix_position(&contact_start)
                                .multiply_scalar(geometry.metric_scale),
                        );
                    }
                }
            }
        }
        for segment in [0u8, 1] {
            let (Some(start), Some(end)) = (real(segment as usize), real(segment as usize + 1))
            else {
                continue;
            };
            evaluate_finger_path(
                geometry,
                &geometry.points[start],
                &EMPTY_CONTROLS,
                &EMPTY_CONTROLS,
                &mut contact_start,
            );
            evaluate_finger_path(
                geometry,
                &geometry.points[end],
                &EMPTY_CONTROLS,
                &EMPTY_CONTROLS,
                &mut contact_end,
            );
            contact_tangent
                .set_from_matrix_position(&contact_end)
                .sub(contact_point.set_from_matrix_position(&contact_start));
            let mut normal = None;
            contact_linear.set_from_matrix4(&contact_start);
            if let Some(palm_normal) = &palm_normal
                && finite_vector(&contact_tangent)
                && contact_tangent.length_sq() > 0.0
                && contact_linear.determinant().is_finite()
                && contact_linear.determinant() != 0.0
            {
                contact_tangent.normalize();
                contact_normal
                    .copy(palm_normal)
                    .add_scaled_vector(&contact_tangent, -palm_normal.dot(&contact_tangent));
                if finite_vector(&contact_normal) && contact_normal.length_sq() > 0.0 {
                    // A normal is a covector: bind transpose stores it in the segment carrier.
                    normal = Some(
                        *contact_normal
                            .normalize()
                            .apply_matrix3(contact_linear.transpose()),
                    );
                }
            }
            segments.push(ContactSegment {
                finger,
                segment,
                start,
                end,
                normal,
            });
        }
    }
    // Halfway from the hand origin to the mean of the four non-thumb MCPs.
    if let Some(center) = palm_center.as_mut() {
        center.multiply_scalar(1.0 / 8.0);
    }
    HandContactCalibration {
        geometry: geometry.clone(),
        palm_normal,
        palm_center,
        segments,
    }
}

const EMPTY_CONTROLS: FingerSpec = [None; 5];

// hand-geometry.ts sampleHandContact
//
// Evaluate a contact proxy, leaving out unchanged for unsupported or invalid selectors.
pub fn sample_hand_contact(
    calibration: &HandContactCalibration,
    curls: &FingerSpec,
    spread: &FingerSpec,
    selector: &HandContact,
    clearance: f64,
    out: &mut Vec3,
) -> bool {
    let geometry = &calibration.geometry;
    if geometry.hand_present != Some(true)
        || !geometry.metric_scale.is_finite()
        || geometry.metric_scale <= 0.0
    {
        return false;
    }
    let surface = match selector {
        HandContact::Palm { surface, .. } | HandContact::Finger { surface, .. } => {
            surface.unwrap_or(ContactSurface::Center)
        }
    };
    if surface != ContactSurface::Center && (!clearance.is_finite() || clearance < 0.0) {
        return false;
    }
    let mut contact_point = Vec3::default();
    let mut contact_normal = Vec3::default();
    match *selector {
        HandContact::Palm { region, .. } => {
            match (region, &calibration.palm_center) {
                (PalmRegion::Heel, _) => {
                    contact_point.set(0.0, 0.0, 0.0);
                }
                (PalmRegion::Center, Some(center)) => {
                    contact_point.copy(center);
                }
                (PalmRegion::Center, None) => return false,
            }
            if surface != ContactSurface::Center {
                let Some(palm_normal) = &calibration.palm_normal else {
                    return false;
                };
                contact_normal.copy(palm_normal);
            }
        }
        HandContact::Finger {
            finger,
            segment,
            fraction,
            ..
        } => {
            if !fraction.is_finite() || !(0.0..=1.0).contains(&fraction) {
                return false;
            }
            let Some(segment) = calibration
                .segments
                .iter()
                .find(|entry| entry.finger == finger && entry.segment == segment)
            else {
                return false;
            };
            let mut contact_start = Mat4::default();
            let mut contact_end = Mat4::default();
            evaluate_finger_path(
                geometry,
                &geometry.points[segment.start],
                curls,
                spread,
                &mut contact_start,
            );
            evaluate_finger_path(
                geometry,
                &geometry.points[segment.end],
                curls,
                spread,
                &mut contact_end,
            );
            contact_point.set_from_matrix_position(&contact_start);
            let mut contact_end_point = Vec3::default();
            contact_end_point.set_from_matrix_position(&contact_end);
            contact_point
                .lerp(&contact_end_point, fraction)
                .multiply_scalar(geometry.metric_scale);
            if surface != ContactSurface::Center {
                let Some(normal) = &segment.normal else {
                    return false;
                };
                let mut contact_linear = Mat3::default();
                contact_linear.set_from_matrix4(&contact_start);
                let determinant = contact_linear.determinant();
                if !determinant.is_finite() || determinant == 0.0 {
                    return false;
                }
                contact_normal
                    .copy(normal)
                    .apply_matrix3(contact_linear.invert().transpose());
                if !finite_vector(&contact_normal) || contact_normal.length_sq() == 0.0 {
                    return false;
                }
                contact_normal.normalize();
            }
        }
    }
    if surface != ContactSurface::Center {
        contact_point.add_scaled_vector(
            &contact_normal,
            if surface == ContactSurface::Pad {
                clearance
            } else {
                -clearance
            },
        );
    }
    if !finite_vector(&contact_point) {
        return false;
    }
    out.copy(&contact_point);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anatomy::joints::FINGER_WIDTH;
    use crate::math::f::js_max;
    use crate::rig::finger_axes::solve_finger_axes;
    use crate::rig::hands::{EMPTY_SPEC, Hands};
    use crate::rig::testkit::{
        avatar, bone, centimetre, euler, rest_of, rest_table, with_helper_above,
    };

    const SIDES: [Side; 2] = Side::BOTH;

    fn spec(values: &[(Finger, f64)]) -> FingerSpec {
        let mut out = EMPTY_SPEC;
        for &(f, v) in values {
            out[f as usize] = Some(v);
        }
        out
    }

    /// `open`, `fist`, `point` and `peace`, as `CURLS` names them.
    fn curls() -> [(&'static str, FingerSpec, FingerSpec); 4] {
        use Finger::*;
        [
            ("open", EMPTY_SPEC, EMPTY_SPEC),
            (
                "fist",
                spec(&[
                    (Thumb, 0.8),
                    (Index, 1.0),
                    (Middle, 1.0),
                    (Ring, 1.0),
                    (Little, 1.0),
                ]),
                EMPTY_SPEC,
            ),
            (
                "point",
                spec(&[
                    (Thumb, 0.25),
                    (Index, 0.0),
                    (Middle, 0.8),
                    (Ring, 0.8),
                    (Little, 0.8),
                ]),
                EMPTY_SPEC,
            ),
            (
                "peace",
                spec(&[
                    (Thumb, 0.3),
                    (Index, 0.0),
                    (Middle, 0.0),
                    (Ring, 0.85),
                    (Little, 0.85),
                ]),
                spec(&[(Index, 0.12), (Middle, -0.08)]),
            ),
        ]
    }

    fn hand(p: &Profile, side: Side) -> u32 {
        bone(p, BoneSlot::arm(ArmSlot::Hand, side))
    }

    /// A world point in the hand bone's frame, in metres.
    fn metric_hand_point(g: &Graph, point: &Vec3, hand: u32, metric_scale: f64) -> Vec3 {
        let mut inverse = g.current_matrix_world(hand);
        inverse.invert();
        let mut out = *point;
        out.apply_matrix4(&inverse).multiply_scalar(metric_scale);
        out
    }

    /// Every finger joint and virtual tip as the live bones place them, in sample order.
    fn live_geometry(
        g: &mut Graph,
        p: &Profile,
        side: Side,
        metric_scale: f64,
    ) -> Vec<(Finger, usize, bool, Vec3)> {
        let h = hand(p, side);
        let mut points = Vec::new();
        for f in Finger::ALL {
            let chain = p.finger(f, side);
            for (j, &b) in chain.iter().enumerate() {
                let world = g.world_position(b);
                points.push((f, j, false, metric_hand_point(g, &world, h, metric_scale)));
            }
            if chain.len() < 2 {
                continue;
            }
            let previous = g.world_position(chain[chain.len() - 2]);
            let last = g.world_position(chain[chain.len() - 1]);
            let mut d = last;
            d.sub(&previous);
            let mut tip = last;
            tip.add_scaled_vector(&d, 0.75);
            points.push((
                f,
                chain.len() - 1,
                true,
                metric_hand_point(g, &tip, h, metric_scale),
            ));
        }
        points
    }

    struct Fixture {
        graph: Graph,
        profile: Profile,
        rest: Vec<f64>,
        axes: crate::rig::finger_axes::FingerAxes,
        hands: Hands,
        joints: JointTable,
    }

    impl Fixture {
        fn new(mut graph: Graph, profile: Profile) -> Fixture {
            graph.update_matrix_world(0, true);
            let rest = rest_table(&graph);
            let axes = solve_finger_axes(&profile, &mut graph);
            let hands = Hands::new(&profile, &mut graph);
            Fixture {
                graph,
                profile,
                rest,
                axes,
                hands,
                joints: JointTable::human(),
            }
        }

        /// The hand's world scale; 1 where the hand is gone, as the unit-scale fixture's.
        fn metric_scale(&mut self, side: Side) -> f64 {
            match self.profile.bone(BoneSlot::arm(ArmSlot::Hand, side)) {
                Some(h) => self.graph.world_scale(h).x,
                None => 1.0,
            }
        }

        fn capture(&mut self, side: Side) -> HandGeometryCalibration {
            let scale = self.metric_scale(side);
            let rest = rest_of(&self.rest);
            capture_hand_geometry(
                &self.profile,
                &self.graph,
                side,
                &|i| Some(rest(i)),
                &self.axes,
                &self.joints,
                scale,
            )
        }

        fn curl_hand(&mut self, side: Side, curls: &FingerSpec, spread: &FingerSpec) {
            let rest = rest_of(&self.rest);
            self.hands.curl_hand(
                &self.profile,
                &self.joints,
                &mut self.graph,
                &rest,
                side,
                curls,
                spread,
            );
            self.graph.update_matrix_world(0, true);
        }

        fn clearance(&self, side: Side) -> f64 {
            0.5 * FINGER_WIDTH * self.profile.limb[side as usize].pitch.unwrap()
        }

        /// The base geometry, its contact capture, and the palm it was captured with.
        fn capture_side(
            &mut self,
            side: Side,
        ) -> (HandGeometryCalibration, HandContactCalibration, Vec3, f64) {
            let base = self.capture(side);
            let palm = self.axes.palm_local[side as usize].unwrap_or(Vec3::new(0.0, 1.0, 0.0));
            let contact = capture_hand_contact_geometry(&base, &palm);
            let scale = self.metric_scale(side);
            (base, contact, palm, scale)
        }
    }

    /// `buildRig({ armatureScale })` with its root turned by `rotation`.
    fn turned(scale: f64, rotation: Quat) -> (Graph, Profile) {
        let (mut g, p) = avatar();
        if scale != 1.0 {
            centimetre(&mut g);
        }
        g.set_local_quaternion(0, &rotation);
        g.update_matrix_world(0, true);
        (g, p)
    }

    #[test]
    fn matches_the_actual_hands_curl_at_unit_and_centimetre_scale() {
        for scale in [1.0, 0.01] {
            let (g, p) = turned(scale, euler(0.0, 0.7, 0.0));
            let mut fx = Fixture::new(g, p);
            for side in SIDES {
                let metric_scale = fx.metric_scale(side);
                let calibration = fx.capture(side);
                let mut sample = make_hand_geometry_sample(&calibration);
                let mut first_open = None;
                for (name, curl, spread) in curls() {
                    fx.curl_hand(side, &curl, &spread);
                    let before = fx.graph.quaternion.clone();
                    sample_hand_geometry(&calibration, &curl, &spread, &mut sample);
                    assert_eq!(fx.graph.quaternion, before, "{side:?} bones after {name}");
                    let actual = live_geometry(&mut fx.graph, &fx.profile, side, metric_scale);
                    assert_eq!(sample.points.len(), actual.len());
                    for (point, (f, j, tip, at)) in sample.points.iter().zip(&actual) {
                        assert_eq!((point.finger, point.joint_index, point.tip), (*f, *j, *tip));
                        assert!(
                            point.position.distance_to(at) < 1e-9,
                            "{side:?} {name} {f:?}.{j}.{tip}"
                        );
                    }
                    if name == "open" {
                        first_open = Some(sample.clone());
                    }
                    if name == "peace" {
                        sample_hand_geometry(&calibration, &EMPTY_SPEC, &EMPTY_SPEC, &mut sample);
                        assert_eq!(Some(&sample), first_open.as_ref());
                    }
                }
            }
        }
    }

    #[test]
    fn uses_the_copied_hierarchy_and_calibrated_thumb_axes_after_live_bones_change() {
        let (mut src, p) = avatar();
        centimetre(&mut src);
        let thumb = p.finger(Finger::Thumb, Side::R).to_vec();
        let (mut g, p, _) = with_helper_above(
            &src,
            &p,
            thumb[1],
            &Vec3::new(0.003, -0.004, 0.002),
            Quat::default().set_from_axis_angle(&Vec3::new(0.0, 1.0, 0.0), 0.2),
            &Vec3::new(1.1, 0.9, 1.05),
        );
        g.set_local_quaternion(0, &euler(0.0, 0.7, 0.0));
        let mut fx = Fixture::new(g, p);
        let metric_scale = fx.metric_scale(Side::R);
        let calibration = fx.capture(Side::R);
        let mut sample = make_hand_geometry_sample(&calibration);
        let open_spec = spec(&[(Finger::Thumb, 0.0)]);
        let closed_spec = spec(&[(Finger::Thumb, 0.8)]);

        fx.curl_hand(Side::R, &open_spec, &EMPTY_SPEC);
        sample_hand_geometry(&calibration, &open_spec, &EMPTY_SPEC, &mut sample);
        let actual = live_geometry(&mut fx.graph, &fx.profile, Side::R, metric_scale);
        for (point, (.., at)) in sample.points.iter().zip(&actual) {
            assert!(point.position.distance_to(at) < 1e-9);
        }
        let open = sample.clone();
        sample_hand_geometry(&calibration, &closed_spec, &EMPTY_SPEC, &mut sample);
        let closed = sample.clone();
        fx.curl_hand(Side::R, &closed_spec, &EMPTY_SPEC);
        let actual = live_geometry(&mut fx.graph, &fx.profile, Side::R, metric_scale);
        for (point, (.., at)) in sample.points.iter().zip(&actual) {
            assert!(point.position.distance_to(at) < 1e-9);
        }
        let chain = fx.profile.finger(Finger::Thumb, Side::R).to_vec();
        assert!(fx.axes.axis(chain[0]).unwrap().length() > 0.99);
        let moved: f64 = (0..3)
            .map(|i| {
                closed.points[i]
                    .position
                    .distance_to(&open.points[i].position)
            })
            .sum();
        assert!(moved > 1e-3);

        for side in SIDES {
            for f in Finger::ALL {
                for &b in fx.profile.finger(f, side) {
                    let mut at = fx.graph.local_position(b);
                    at.x += 0.2;
                    fx.graph.set_local_position(b, &at);
                    fx.graph.set_local_quaternion(
                        b,
                        Quat::default().set_from_axis_angle(&Vec3::new(0.0, 1.0, 0.0), 1.1),
                    );
                    fx.graph.set_local_scale(b, &Vec3::new(1.2, 0.8, 1.1));
                }
            }
        }
        sample_hand_geometry(&calibration, &closed_spec, &EMPTY_SPEC, &mut sample);
        assert_eq!(sample, closed);
        sample_hand_geometry(&calibration, &open_spec, &EMPTY_SPEC, &mut sample);
        assert_eq!(sample, open);
    }

    #[test]
    fn omits_missing_finger_chains_without_shifting_the_remaining_identities() {
        let (g, p) = avatar();
        let mut fx = Fixture::new(g, p);
        fx.profile.finger_bones[Side::R as usize * 5 + Finger::Ring as usize].clear();
        let calibration = fx.capture(Side::R);
        let mut sample = make_hand_geometry_sample(&calibration);
        sample_hand_geometry(&calibration, &EMPTY_SPEC, &EMPTY_SPEC, &mut sample);
        assert!(!sample.points.iter().any(|q| q.finger == Finger::Ring));
        let middle: Vec<(usize, bool)> = sample
            .points
            .iter()
            .filter(|q| q.finger == Finger::Middle)
            .map(|q| (q.joint_index, q.tip))
            .collect();
        assert_eq!(middle, [(0, false), (1, false), (2, false), (2, true)]);
    }

    /// `contactFixture`: the root tilted and turned, and with `helpers` a plain node between
    /// each middle finger's first two joints.
    fn contact_fixture(scale: f64, helpers: bool) -> Fixture {
        let (mut g, mut p) = avatar();
        if scale != 1.0 {
            centimetre(&mut g);
        }
        if helpers {
            for side in SIDES {
                let second = p.finger(Finger::Middle, side)[1];
                let (next, profile, _) = with_helper_above(
                    &g,
                    &p,
                    second,
                    &Vec3::new(0.002 / scale, -0.003 / scale, 0.004 / scale),
                    &euler(0.2, -0.15, 0.13),
                    &Vec3::new(1.2, 0.8, 1.1),
                );
                g = next;
                p = profile;
            }
        }
        g.set_local_quaternion(0, &euler(0.1, 0.7, -0.1));
        Fixture::new(g, p)
    }

    fn finger_selector(
        finger: Finger,
        segment: u8,
        fraction: f64,
        surface: Option<ContactSurface>,
    ) -> HandContact {
        HandContact::Finger {
            finger,
            segment,
            fraction,
            surface,
        }
    }

    #[test]
    fn matches_actual_posed_bones_and_transported_surface_normals() {
        for scale in [1.0, 0.01] {
            let mut fx = contact_fixture(scale, true);
            let mut maximum_error: f64 = 0.0;
            for side in SIDES {
                let h = hand(&fx.profile, side);
                let (base, contact, palm, metric_scale) = fx.capture_side(side);
                let captured = contact.clone();
                let mut collision = make_hand_geometry_sample(&base);
                let ids: Vec<_> = collision
                    .points
                    .iter()
                    .map(|q| (q.finger, q.joint_index, q.tip))
                    .collect();
                // The bind oracle per finger segment: its inverse carrier, tangent and across.
                let mut bind = Vec::new();
                for f in Finger::ALL {
                    for segment in 0..2 {
                        let chain = fx.profile.finger(f, side).to_vec();
                        let mut matrix = fx.graph.current_matrix_world(h);
                        matrix
                            .invert()
                            .multiply(&fx.graph.current_matrix_world(chain[segment]));
                        let a = fx.graph.world_position(chain[segment]);
                        let start = metric_hand_point(&fx.graph, &a, h, metric_scale);
                        let b = fx.graph.world_position(chain[segment + 1]);
                        let mut tangent = metric_hand_point(&fx.graph, &b, h, metric_scale);
                        tangent.sub(&start).normalize();
                        let mut normal = palm;
                        normal
                            .add_scaled_vector(&tangent, -palm.dot(&tangent))
                            .normalize();
                        let mut across = normal;
                        across.cross(&tangent).normalize();
                        matrix.invert();
                        bind.push((matrix, tangent, across));
                    }
                }
                for (_, curl, spread) in curls() {
                    fx.curl_hand(side, &curl, &spread);
                    let before = fx.graph.quaternion.clone();
                    for (k, f) in Finger::ALL.iter().enumerate() {
                        for segment in 0..2 {
                            for surface in [
                                ContactSurface::Center,
                                ContactSurface::Pad,
                                ContactSurface::Back,
                            ] {
                                let chain = fx.profile.finger(*f, side).to_vec();
                                let (inverse, tangent, across) = &bind[k * 2 + segment];
                                let a = fx.graph.world_position(chain[segment]);
                                let mut expected =
                                    metric_hand_point(&fx.graph, &a, h, metric_scale);
                                let b = fx.graph.world_position(chain[segment + 1]);
                                let end = metric_hand_point(&fx.graph, &b, h, metric_scale);
                                expected.lerp(&end, 0.37);
                                let mut deformation = fx.graph.current_matrix_world(h);
                                deformation
                                    .invert()
                                    .multiply(&fx.graph.current_matrix_world(chain[segment]))
                                    .multiply(inverse);
                                let mut linear = Mat3::default();
                                linear.set_from_matrix4(&deformation);
                                let mut t = *tangent;
                                t.apply_matrix3(&linear);
                                let mut c = *across;
                                c.apply_matrix3(&linear);
                                let mut normal = t;
                                normal.cross(&c).normalize();
                                let clearance = fx.clearance(side);
                                if surface != ContactSurface::Center {
                                    expected.add_scaled_vector(
                                        &normal,
                                        if surface == ContactSurface::Pad {
                                            clearance
                                        } else {
                                            -clearance
                                        },
                                    );
                                }
                                let mut out = Vec3::new(9.0, 8.0, 7.0);
                                assert!(sample_hand_contact(
                                    &contact,
                                    &curl,
                                    &spread,
                                    &finger_selector(*f, segment as u8, 0.37, Some(surface)),
                                    clearance,
                                    &mut out,
                                ));
                                let error = out.distance_to(&expected);
                                maximum_error = js_max(maximum_error, error);
                                assert!(error < 1e-9, "{side:?} {f:?} {segment} {surface:?}");
                            }
                        }
                    }
                    sample_hand_geometry(&base, &curl, &spread, &mut collision);
                    let now: Vec<_> = collision
                        .points
                        .iter()
                        .map(|q| (q.finger, q.joint_index, q.tip))
                        .collect();
                    assert_eq!(now, ids);
                    assert_eq!(contact, captured);
                    assert_eq!(fx.graph.quaternion, before);
                }
            }
            assert!(maximum_error < 1e-9);
        }
    }

    #[test]
    fn samples_palm_heel_and_center_independently_of_live_bone_history() {
        let mut fx = contact_fixture(1.0, false);
        for side in SIDES {
            let (_, contact, palm, metric_scale) = fx.capture_side(side);
            let h = hand(&fx.profile, side);
            let mut center = Vec3::default();
            for f in &Finger::ALL[1..] {
                let b = fx.profile.finger_root(*f, side).unwrap();
                let w = fx.graph.world_position(b);
                center.add(&metric_hand_point(&fx.graph, &w, h, metric_scale));
            }
            center.multiply_scalar(1.0 / 8.0);
            let mut out = Vec3::default();
            let clearance = fx.clearance(side);
            for region in [PalmRegion::Heel, PalmRegion::Center] {
                for surface in [
                    ContactSurface::Center,
                    ContactSurface::Pad,
                    ContactSurface::Back,
                ] {
                    let selector = HandContact::Palm {
                        region,
                        surface: Some(surface),
                    };
                    let mut expected = if region == PalmRegion::Heel {
                        Vec3::default()
                    } else {
                        center
                    };
                    if surface != ContactSurface::Center {
                        expected.add_scaled_vector(
                            &palm,
                            if surface == ContactSurface::Pad {
                                clearance
                            } else {
                                -clearance
                            },
                        );
                    }
                    assert!(sample_hand_contact(
                        &contact,
                        &spec(&[(Finger::Middle, 0.8)]),
                        &spec(&[(Finger::Middle, 0.1)]),
                        &selector,
                        clearance,
                        &mut out,
                    ));
                    assert!(out.distance_to(&expected) < 1e-9);
                }
            }
            let selector = finger_selector(Finger::Middle, 1, 0.6, Some(ContactSurface::Pad));
            let curl = spec(&[(Finger::Middle, 0.8)]);
            sample_hand_contact(&contact, &curl, &EMPTY_SPEC, &selector, clearance, &mut out);
            let expected = out;
            for &b in &fx.profile.finger(Finger::Middle, side).to_vec() {
                fx.graph.set_local_position(b, &Vec3::new(2.0, 3.0, 4.0));
                fx.graph.set_local_quaternion(b, &euler(0.7, 0.4, 0.2));
                fx.graph.set_local_scale(b, &Vec3::new(2.0, 1.0, 3.0));
            }
            assert!(sample_hand_contact(
                &contact,
                &curl,
                &EMPTY_SPEC,
                &selector,
                clearance,
                &mut out
            ));
            assert_eq!(out, expected);
        }
    }

    #[test]
    fn rejects_invalid_selectors_and_absent_real_joints_without_changing_output() {
        let mut fx = contact_fixture(1.0, false);
        fx.profile.finger_bones[Side::R as usize * 5 + Finger::Middle as usize].truncate(2);
        fx.profile.finger_bones[Side::R as usize * 5 + Finger::Ring as usize].clear();
        let (_, contact, ..) = fx.capture_side(Side::R);
        let sentinel = Vec3::new(9.0, 8.0, 7.0);
        let mut selectors = vec![
            finger_selector(Finger::Middle, 1, 0.5, None),
            HandContact::Palm {
                region: PalmRegion::Center,
                surface: None,
            },
        ];
        for fraction in [-0.1, 1.1, f64::NAN, f64::INFINITY] {
            selectors.push(finger_selector(Finger::Index, 0, fraction, None));
        }
        selectors.push(finger_selector(Finger::Index, 2, 0.5, None));
        let clearance = fx.clearance(Side::R);
        for selector in &selectors {
            let mut out = sentinel;
            assert!(!sample_hand_contact(
                &contact,
                &EMPTY_SPEC,
                &EMPTY_SPEC,
                selector,
                clearance,
                &mut out
            ));
            assert_eq!(out, sentinel);
        }
        fx.profile.bones[BoneSlot::HandR as usize] = crate::scene::graph::NO_NODE;
        let (_, missing, ..) = fx.capture_side(Side::R);
        let mut out = sentinel;
        let heel = HandContact::Palm {
            region: PalmRegion::Heel,
            surface: None,
        };
        assert!(!sample_hand_contact(
            &missing,
            &EMPTY_SPEC,
            &EMPTY_SPEC,
            &heel,
            0.0,
            &mut out
        ));
        assert_eq!(out, sentinel);
    }

    #[test]
    fn rejects_singular_or_degenerate_surface_normals_without_replacing_the_output() {
        let mut fx = contact_fixture(1.0, false);
        let chain = fx.profile.finger(Finger::Middle, Side::R).to_vec();
        let clearance = fx.clearance(Side::R);
        let mut s = fx.graph.local_scale(chain[0]);
        s.y = 0.0;
        fx.graph.set_local_scale(chain[0], &s);
        let (_, contact, ..) = fx.capture_side(Side::R);
        let mut out = Vec3::new(9.0, 8.0, 7.0);
        let pad = finger_selector(Finger::Middle, 0, 0.5, Some(ContactSurface::Pad));
        assert!(!sample_hand_contact(
            &contact,
            &spec(&[(Finger::Middle, 0.8)]),
            &EMPTY_SPEC,
            &pad,
            clearance,
            &mut out,
        ));
        assert_eq!(out, Vec3::new(9.0, 8.0, 7.0));
        s.y = 1.0;
        fx.graph.set_local_scale(chain[0], &s);
        fx.graph.set_local_position(chain[1], &Vec3::default());
        let (_, degenerate, ..) = fx.capture_side(Side::R);
        let back = finger_selector(Finger::Middle, 0, 0.5, Some(ContactSurface::Back));
        assert!(!sample_hand_contact(
            &degenerate,
            &EMPTY_SPEC,
            &EMPTY_SPEC,
            &back,
            clearance,
            &mut out
        ));
        assert_eq!(out, Vec3::new(9.0, 8.0, 7.0));
        // The center remains meaningful even though the surface normal is unavailable.
        let center = finger_selector(Finger::Middle, 0, 0.5, None);
        assert!(sample_hand_contact(
            &degenerate,
            &EMPTY_SPEC,
            &EMPTY_SPEC,
            &center,
            0.0,
            &mut out
        ));
    }

    #[test]
    fn requires_captured_hand_provenance_and_a_nondegenerate_palm_for_surfaces() {
        let mut fx = contact_fixture(1.0, false);
        let (base, _, palm, _) = fx.capture_side(Side::R);
        let no_provenance = capture_hand_contact_geometry(
            &HandGeometryCalibration {
                hand_present: None,
                ..base.clone()
            },
            &palm,
        );
        let mut out = Vec3::new(9.0, 8.0, 7.0);
        let heel = HandContact::Palm {
            region: PalmRegion::Heel,
            surface: None,
        };
        assert!(!sample_hand_contact(
            &no_provenance,
            &EMPTY_SPEC,
            &EMPTY_SPEC,
            &heel,
            0.0,
            &mut out
        ));
        assert_eq!(out, Vec3::new(9.0, 8.0, 7.0));
        let no_normal = capture_hand_contact_geometry(&base, &Vec3::default());
        let pad = HandContact::Palm {
            region: PalmRegion::Center,
            surface: Some(ContactSurface::Pad),
        };
        assert!(!sample_hand_contact(
            &no_normal,
            &EMPTY_SPEC,
            &EMPTY_SPEC,
            &pad,
            fx.clearance(Side::R),
            &mut out,
        ));
        assert_eq!(out, Vec3::new(9.0, 8.0, 7.0));
        let center = HandContact::Palm {
            region: PalmRegion::Center,
            surface: None,
        };
        assert!(sample_hand_contact(
            &no_normal,
            &EMPTY_SPEC,
            &EMPTY_SPEC,
            &center,
            0.0,
            &mut out
        ));
    }

    #[test]
    fn uses_exact_real_endpoints_with_the_default_center_surface() {
        let mut fx = contact_fixture(0.01, true);
        let (_, contact, _, metric_scale) = fx.capture_side(Side::R);
        let h = hand(&fx.profile, Side::R);
        let chain = fx.profile.finger(Finger::Middle, Side::R).to_vec();
        let curl = spec(&[(Finger::Middle, 0.7)]);
        let spread = spec(&[(Finger::Middle, 0.1)]);
        fx.curl_hand(Side::R, &curl, &spread);
        for segment in 0..2 {
            for fraction in [0usize, 1] {
                let mut out = Vec3::default();
                assert!(sample_hand_contact(
                    &contact,
                    &curl,
                    &spread,
                    &finger_selector(Finger::Middle, segment as u8, fraction as f64, None),
                    0.0,
                    &mut out,
                ));
                let w = fx.graph.world_position(chain[segment + fraction]);
                let expected = metric_hand_point(&fx.graph, &w, h, metric_scale);
                assert!(out.distance_to(&expected) < 1e-9);
            }
        }
    }
}
