//! `anatomy/cost.ts` and `anatomy/measurement.ts`: what a measured arm costs.
//!
//! Three readings of the same numbers, for three different callers: `score` for
//! anything that wants strain per joint, `cost` for the elbow search, which
//! needs one number to minimise, and `report` for the panel, which needs a row
//! per joint with a range beside it.
//!
//! Every weight here was arrived at by watching two avatars reach for things,
//! and most of them carry a comment saying which pose they exist to prevent.
//!
//! `report` keeps its numbers here; the row labels and units stay in TS, keyed by
//! [`ReadingId`].

use super::joints::{BODY_DEPTH, BODY_HIT, D, INBOARD_COST, JointTable, LIFT_COST};
use super::strain::{
    StrainZone, elevation_ceiling, elevation_strain, excess_of, strain_of, zone_of,
};
use crate::math::f::cos;
use core::f64::consts::PI;

/// One arm's pose, in the quantities anatomy has an opinion about. Radians,
/// except `torso` and `inboard`, which are fractions.
///
/// `measurement.ts`: filled by `ArmAnatomy::measure` and handed out as a shared
/// record, since the elbow search evaluates a couple of dozen candidates per arm per
/// frame.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ArmMeasurement {
    pub elevation: f64,
    pub plane: f64,
    pub rotation: f64,
    pub elbow: f64,
    pub forearm: f64,
    pub wrist_flex: f64,
    pub wrist_dev: f64,
    pub torso: f64,
    pub inboard: f64,
    /// How much the humeral rotation reading can be trusted, 0..1.
    pub rotation_read: f64,
}

/// Strain per degree of freedom, 0 inside the free band and 1 at the stop.
///
/// The fields are in the order TS's `for (const k in s)` visits them, which is the
/// order the cost sums them in.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ArmStrain {
    pub elevation: f64,
    pub rotation: f64,
    pub elbow: f64,
    pub forearm: f64,
    pub wrist_flex: f64,
    pub wrist_dev: f64,
    pub torso: f64,
}

impl ArmStrain {
    /// Every field but `torso`, in declaration order.
    fn joints(&self) -> [f64; 6] {
        [
            self.elevation,
            self.rotation,
            self.elbow,
            self.forearm,
            self.wrist_flex,
            self.wrist_dev,
        ]
    }
}

// cost.ts armDegrees
//
// How far past `deg` a raw reading is, as this file reports it.
pub fn arm_degrees(value: f64) -> f64 {
    value / D
}

// cost.ts score
//
// Strain per degree of freedom for the last measurement.
//
// Returned as a shared object, deliberately: this runs inside a search loop
// that evaluates a couple of dozen candidates per arm per frame.
pub fn score<'s>(m: &ArmMeasurement, limits: &JointTable, out: &'s mut ArmStrain) -> &'s ArmStrain {
    let l = limits;
    let s = out;
    s.elevation = elevation_strain(
        m.elevation,
        &elevation_ceiling(m.plane, &l.shoulder.elevation),
    );
    // Humeral rotation is read off where the elbow points, so a straight elbow
    // does not measure it: there is no bend to point anywhere, and what is left
    // is the direction of a vector that is almost entirely rounding error. This
    // is why the clinical test flexes the elbow to 90 first.
    //
    // Without the fade, an arm resting at the side — 11 degrees of elbow bend —
    // reported 50 degrees of rotation and was flagged strained. Every gesture
    // in the table was, including the ones that do not move the arms at all.
    s.rotation = strain_of(m.rotation, &l.shoulder.rotation) * m.rotation_read;
    s.elbow = strain_of(m.elbow, &l.elbow.flexion);
    s.forearm = strain_of(m.forearm, &l.elbow.rotation);
    s.wrist_flex = strain_of(m.wrist_flex, &l.wrist.flexion);
    s.wrist_dev = strain_of(m.wrist_dev, &l.wrist.deviation);
    // Contact, not strain — but it belongs in the same table, because to
    // whoever is watching an elbow inside the ribcage and an elbow past its
    // rotation stop are the same defect. Any penetration at all is the limit;
    // there is no comfortable amount of being inside your own chest.
    s.torso = if m.torso > 0.0 { 1.0 } else { 0.0 };
    s
}

// cost.ts cost
//
// One number for how unlikely a pose is — what the elbow search minimises.
//
// Strain is only part of it. Range of motion says which poses are *possible*,
// and for a fingertip target most of the elbow circle is: pointing straight
// ahead can be done with the elbow hanging below the wrist or cocked above
// it, and both are comfortably inside every joint's range. Scored on strain
// alone the two are indistinguishable, and the search picked the raised elbow
// — anatomically fine, and not what anybody does.
//
// So effort is scored as well. Holding an arm up costs something whether or
// not any joint is near its limit, and that cost is what separates the pose a
// person adopts from the set of poses a person could adopt.
pub fn cost(m: &ArmMeasurement, limits: &JointTable, strain: &mut ArmStrain) -> f64 {
    let s = *score(m, limits, strain);
    let mut total = 0.0;
    // Squared, so the search spreads strain rather than concentrating it: two
    // joints slightly outside comfortable beat one joint at its stop, which is
    // both how a person distributes a reach and what stops the solver parking a
    // single joint against a hard limit while the rest of the arm idles.
    //
    // Torso contact is excluded and charged below: it is not a strain that gets
    // gradually worse, and squaring a binary would leave the search no slope to
    // follow out of the chest.
    for v in s.joints() {
        total += v * v;
    }
    // The hard stop is not just an expensive place to be, it is a place the
    // result will be clamped out of — so a candidate that reaches one is worse
    // than its strain suggests, because the pose that comes back is not the
    // pose that was scored.
    for v in s.joints() {
        if v >= 1.0 {
            total += 4.0;
        }
    }
    // And how far past it. Strain stops at the stop; this does not, so where
    // nothing on the elbow circle is reachable the search can still tell the
    // least impossible pose from the worst one instead of choosing between
    // saturated equals. Charged steeply — being outside the range at all is
    // already the flat 4 above, and this only has to break the tie.
    let l = limits;
    let mut over = excess_of(m.elbow, &l.elbow.flexion)
        + excess_of(m.forearm, &l.elbow.rotation)
        + excess_of(m.wrist_flex, &l.wrist.flexion)
        + excess_of(m.wrist_dev, &l.wrist.deviation)
        + excess_of(m.rotation, &l.shoulder.rotation) * m.rotation_read;
    let ceil = elevation_ceiling(m.plane, &l.shoulder.elevation);
    if m.elevation > ceil.max {
        over += (m.elevation - ceil.max) / PI;
    }
    total += 8.0 * over;
    // Being inside the body: a flat charge that outbids any joint, plus a slope
    // so the search can tell "just inside" from "buried" and walk out the
    // shallow side.
    //
    // The slope has to be much larger than the step, and was not. At 6 and 6, a
    // pose 83% inside the head cost 3.3 more than one 28% inside — less than a
    // single joint reaching its stop — so wherever the whole elbow circle was
    // penetrating, which is the case that matters, the search was choosing on
    // the joint terms and was very nearly blind to depth.
    total += contact_cost(m);
    // Gravity: zero for an arm hanging, half at horizontal, one overhead.
    //
    // Charged from hanging and not from horizontal, which is the version this
    // started as. A horizontal upper arm costs a shoulder real effort, and
    // scoring it free let the search park the elbow out at shoulder height on
    // every point — anatomically fine, and a chicken wing. What holds it back
    // from the opposite mistake, tucking the elbow across the ribs to get it
    // low, is the elevation ceiling: that direction runs out of range at 45
    // degrees, so the strain term outbids the saving long before it gets there.
    let lift = (1.0 - cos(m.elevation)) / 2.0;
    total += LIFT_COST * lift * lift;
    // Bringing the elbow inside the shoulder line. Anatomically available and
    // almost never used: a tucked-in elbow is a closed, guarded posture, and
    // outside of folding your arms nobody holds one to do something with their
    // hand. Everything else here is either a joint limit or gravity, and both
    // are indifferent to it — the ceiling table drops toward the midline, but
    // only bites *above* the ceiling, so an elbow tucked across the body at a
    // low elevation was free. It is what the search picked whenever a target
    // near the face made the honest solutions expensive.
    //
    // Weighted to outbid the saving it buys. Tucking the elbow in is usually
    // also tucking it *down*, so it collects a gravity discount, and at a lower
    // weight the search still took the trade.
    total += INBOARD_COST * m.inboard * m.inboard;
    total
}

// cost.ts contactCost
//
// What being inside the body costs on its own; `cost` says why it has a step and a slope.
pub fn contact_cost(m: &ArmMeasurement) -> f64 {
    if m.torso > 0.0 {
        BODY_HIT + BODY_DEPTH * m.torso
    } else {
        0.0
    }
}

/// The rows of `report`, in the order it returns them. TS maps each to its `id` and label.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadingId {
    Elevation,
    Plane,
    Rotation,
    Elbow,
    Forearm,
    WristFlex,
    WristDev,
    Torso,
    Inboard,
}

/// The numbers of one `JointReading`. `percent` is TS's `unit: '%'`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Reading {
    pub id: ReadingId,
    pub deg: f64,
    pub percent: bool,
    pub strain: f64,
    pub zone: StrainZone,
    pub range: [f64; 2],
    pub measured: bool,
}

/// Which parts of the body `report` could read: a measured trunk, and a placed arm.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Seen {
    pub torso: bool,
    pub arm: bool,
}

// cost.ts report
//
// A readable snapshot, for the panel. Not for the frame loop.
pub fn report(
    m: &ArmMeasurement,
    limits: &JointTable,
    strain: &mut ArmStrain,
    seen: Seen,
) -> [Reading; 9] {
    let s = *score(m, limits, strain);
    let ceil = elevation_ceiling(m.plane, &limits.shoulder.elevation);
    // `measured: false` marks a quantity that exists but is not determined by
    // the current pose — the plane of a hanging arm, the rotation of a straight
    // one. Showing a zone for those would be reporting noise as a judgement.
    let row = |id, value: f64, strain: f64, range: [f64; 2], measured| Reading {
        id,
        deg: value / D,
        percent: false,
        strain,
        zone: zone_of(strain),
        range,
        measured,
    };
    let l = limits;
    let deg = |r: [f64; 2]| [r[0] / D, r[1] / D];
    [
        row(
            ReadingId::Elevation,
            m.elevation,
            s.elevation,
            [0.0, ceil.max / D],
            true,
        ),
        row(ReadingId::Plane, m.plane, 0.0, [-180.0, 180.0], false),
        row(
            ReadingId::Rotation,
            m.rotation,
            s.rotation,
            deg(l.shoulder.rotation.max),
            m.rotation_read > 0.01,
        ),
        row(
            ReadingId::Elbow,
            m.elbow,
            s.elbow,
            deg(l.elbow.flexion.max),
            true,
        ),
        row(
            ReadingId::Forearm,
            m.forearm,
            s.forearm,
            deg(l.elbow.rotation.max),
            true,
        ),
        row(
            ReadingId::WristFlex,
            m.wrist_flex,
            s.wrist_flex,
            deg(l.wrist.flexion.max),
            true,
        ),
        row(
            ReadingId::WristDev,
            m.wrist_dev,
            s.wrist_dev,
            deg(l.wrist.deviation.max),
            true,
        ),
        // Reported as a percentage of the trunk radius rather than an angle,
        // because it is not one.
        Reading {
            id: ReadingId::Torso,
            deg: m.torso * 100.0,
            percent: true,
            strain: s.torso,
            zone: zone_of(s.torso),
            range: [0.0, 100.0],
            measured: seen.torso && seen.arm,
        },
        // Not a limit — an elbow inside the shoulder line is available, it is just
        // not what people do. Reported because when a solved pose looks closed or
        // guarded, this is usually the number that says why.
        Reading {
            id: ReadingId::Inboard,
            deg: m.inboard * 100.0,
            percent: true,
            strain: 0.0,
            zone: StrainZone::Natural,
            range: [0.0, 100.0],
            measured: true,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hanging() -> ArmMeasurement {
        ArmMeasurement::default()
    }

    #[test]
    fn a_hanging_arm_costs_nothing_and_an_overhead_one_does() {
        let t = JointTable::human();
        let mut strain = ArmStrain::default();
        assert_eq!(cost(&hanging(), &t, &mut strain), 0.0);
        let overhead = ArmMeasurement {
            elevation: PI,
            ..hanging()
        };
        let c = cost(&overhead, &t, &mut strain);
        assert!(c.is_finite() && c > 0.0);
    }

    #[test]
    fn the_cost_sums_squared_strain_then_four_per_saturated_joint() {
        let t = JointTable::human();
        let mut strain = ArmStrain::default();
        // Elbow at its stop: strain 1, squared 1, saturated 4, no excess.
        let m = ArmMeasurement {
            elbow: t.elbow.flexion.max[1],
            ..hanging()
        };
        assert_eq!(cost(&m, &t, &mut strain), 5.0);
        assert_eq!(strain.elbow, 1.0);
        // Past it, the excess keeps charging where the strain has stopped.
        let past = ArmMeasurement {
            elbow: t.elbow.flexion.max[1] + 0.1,
            ..hanging()
        };
        assert!(cost(&past, &t, &mut strain) > 5.0);
    }

    #[test]
    fn contact_is_a_step_and_a_slope() {
        assert_eq!(contact_cost(&hanging()), 0.0);
        let shallow = ArmMeasurement {
            torso: 0.1,
            ..hanging()
        };
        let deep = ArmMeasurement {
            torso: 0.5,
            ..hanging()
        };
        assert_eq!(contact_cost(&shallow), BODY_HIT + BODY_DEPTH * 0.1);
        assert!(contact_cost(&deep) > contact_cost(&shallow));
        let t = JointTable::human();
        let mut strain = ArmStrain::default();
        // Torso contact is charged once, not squared and saturated as a joint.
        assert_eq!(cost(&deep, &t, &mut strain), contact_cost(&deep));
        assert_eq!(strain.torso, 1.0);
    }

    #[test]
    fn the_report_rows_are_zoned_by_their_strain() {
        let t = JointTable::human();
        let mut strain = ArmStrain::default();
        let m = ArmMeasurement {
            elevation: 2.0,
            rotation: 1.4,
            rotation_read: 1.0,
            torso: 0.2,
            inboard: 0.3,
            ..hanging()
        };
        let rows = report(
            &m,
            &t,
            &mut strain,
            Seen {
                torso: true,
                arm: false,
            },
        );
        for row in &rows {
            assert_eq!(row.zone, zone_of(row.strain), "{:?}", row.id);
            assert!(row.range[1] > row.range[0], "{:?}", row.id);
        }
        assert_eq!(rows[0].id, ReadingId::Elevation);
        assert!((rows[0].deg - 2.0 / D).abs() < 1e-12);
        assert!(!rows[1].measured);
        assert!(rows[2].measured);
        assert!(rows[7].percent && rows[8].percent);
        assert!(!rows[7].measured);
        assert_eq!(rows[7].zone, StrainZone::Limit);
        assert_eq!(rows[8].deg, 30.0);
        assert_eq!(arm_degrees(D), 1.0);
    }
}
