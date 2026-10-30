//! `anatomy/strain.ts`: scoring a value against a joint's two bands.

use super::joints::{D, Digit, ElevationRow, JointDof, THUMB_OPPOSITION, THUMB_OPPOSITION_CURL};
use crate::math::f::{js_max, js_min};

/// The elevation ceiling at one plane, in radians: where the free band ends and
/// where the hard stop is.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ElevationCeiling {
    pub free: f64,
    pub max: f64,
}

/// The band a strain falls in, in `StrainZone`'s declaration order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StrainZone {
    Natural,
    Strained,
    Limit,
}

// strain.ts strainOf
//
// Where a value sits in its range: 0 anywhere inside the free band, rising
// linearly to 1 at the hard stop, and 1 beyond it.
//
// Linear, not smooth. A smooth ramp starts flat, which means the first few
// degrees past comfortable are free — and those are exactly the degrees a
// search will spend, because they cost nothing. The corner at the edge of the
// free band is the point.
pub fn strain_of(v: f64, d: &JointDof) -> f64 {
    let [fl, fh] = d.free;
    let [ml, mh] = d.max;
    if v > fh {
        return if mh > fh {
            js_min(1.0, (v - fh) / (mh - fh))
        } else {
            1.0
        };
    }
    if v < fl {
        return if ml < fl {
            js_min(1.0, (fl - v) / (fl - ml))
        } else {
            1.0
        };
    }
    0.0
}

// strain.ts clampDof
pub fn clamp_dof(v: f64, d: &JointDof) -> f64 {
    js_min(d.max[1], js_max(d.max[0], v))
}

// strain.ts zoneOf
pub fn zone_of(s: f64) -> StrainZone {
    if s <= 0.0 {
        StrainZone::Natural
    } else if s < 1.0 {
        StrainZone::Strained
    } else {
        StrainZone::Limit
    }
}

// strain.ts excessOf
//
// How far past the hard stop a value is, in units of the strained band.
//
// `strainOf` caps at 1, which is right for reporting — past the stop is past the
// stop, and there is no darker shade of impossible to show. It is wrong for
// searching. Capped, a candidate 90 degrees beyond a ceiling scores exactly the
// same as one a degree beyond, so where a target cannot be reached at all *every*
// candidate saturates and the choice between them falls to whatever small terms
// are left. That is how a hand asked for the chin came back with the elbow
// behind the back: not because the search preferred it, but because the search
// could not see any difference.
pub fn excess_of(v: f64, d: &JointDof) -> f64 {
    let [ml, mh] = d.max;
    let band = js_max(mh - ml, 1e-6);
    if v > mh {
        return (v - mh) / band;
    }
    if v < ml {
        return (ml - v) / band;
    }
    0.0
}

// strain.ts rollRoom
//
// How much of a rotation a joint still has, given what the pose already spends.
//
// Against the hard stop, not the free band. Lending rotation past comfortable
// normally just moves strain from one joint to another and is not worth doing —
// but this is only ever called when the alternative is a joint past *impossible*,
// and a strained shoulder beats a forearm pronated half again as far as a
// forearm goes. Capping at the free band instead made the shoulder decline to
// help in exactly the poses that needed it: a hand at the mouth has the humerus
// near the top of its comfortable rotation already, so there was nothing to give
// and the whole roll fell back onto the forearm.
//
// Signed both ways, since a roll can go either.
pub fn roll_room(used: f64, d: &JointDof) -> [f64; 2] {
    [js_min(0.0, d.max[0] - used), js_max(0.0, d.max[1] - used)]
}

// strain.ts elevationCeiling
//
// Interpolate the elevation ceiling for a plane angle, in radians. `rows` is the table's
// `shoulder.elevation`; TS defaults it to `ELEVATION`.
pub fn elevation_ceiling(plane: f64, rows: &[ElevationRow]) -> ElevationCeiling {
    let mut out = ElevationCeiling::default();
    let mut deg = (plane / D) % 360.0;
    if deg > 180.0 {
        deg -= 360.0;
    }
    if deg < -180.0 {
        deg += 360.0;
    }
    for i in 1..rows.len() {
        let a = rows[i - 1];
        let b = rows[i];
        if deg <= b[0] {
            let t = (deg - a[0]) / (b[0] - a[0]);
            out.free = (a[1] + (b[1] - a[1]) * t) * D;
            out.max = (a[2] + (b[2] - a[2]) * t) * D;
            return out;
        }
    }
    let last = rows[rows.len() - 1];
    out.free = last[1] * D;
    out.max = last[2] * D;
    out
}

// strain.ts elevationStrain
//
// Strain for elevation, which carries its ceiling rather than a fixed band.
pub fn elevation_strain(theta: f64, ceiling: &ElevationCeiling) -> f64 {
    if theta <= ceiling.free {
        return 0.0;
    }
    if ceiling.max <= ceiling.free {
        return 1.0;
    }
    js_min(1.0, (theta - ceiling.free) / (ceiling.max - ceiling.free))
}

// strain.ts fingerCurl
//
// Finger curl limits, as a curl fraction rather than an angle.
//
// The rig drives fingers by a single 0..1 curl per finger, which is the right
// control — nobody flexes one interphalangeal joint on purpose — but the three
// segments do not share a range, and driving them from one number through a
// hand-guessed taper gets the ratios wrong. Curl 1 is the top of each joint's
// *free* band, so a fist closes to a real fist; the strained band above it is
// reachable only by asking for more than 1, which nothing does by accident.
pub fn finger_curl(joints: &Digit, index: usize, amount: f64) -> f64 {
    let d = match index {
        0 => joints.proximal,
        1 => joints.intermediate,
        _ => joints.distal,
    };
    let Some(d) = d else {
        return 0.0;
    };
    let a = amount * d.free[1];
    js_min(d.max[1], js_max(d.max[0], a))
}

// strain.ts thumbOpposition
//
// The distal thumb hinge's turn for a thumb curl: none below the ramp, `THUMB_OPPOSITION` above it, linear between.
pub fn thumb_opposition(amount: f64) -> f64 {
    let [start, full] = THUMB_OPPOSITION_CURL;
    THUMB_OPPOSITION * js_min(1.0, js_max(0.0, (amount - start) / (full - start)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anatomy::joints::{ELEVATION, JointTable, dof};
    use crate::corpus_replay::Corpus;

    // The strain functions, in degrees.
    //
    // Everything the module takes and returns is radians, so the tests build their
    // fixtures the same way the joint table does — authored in degrees, converted
    // once — and compare in radians. `deg` is only for reading a result back out.
    fn deg(radians: f64) -> f64 {
        radians / D
    }

    fn close(a: f64, b: f64, digits: i32) {
        let tolerance = 10f64.powi(-digits) / 2.0;
        assert!((a - b).abs() < tolerance, "{a} is not close to {b}");
    }

    /// free -20..40, strained down to -50 and up to 60. Asymmetric on purpose.
    const BAND: JointDof = dof(-20.0, 40.0, -50.0, 60.0);

    #[test]
    fn strain_is_zero_inside_the_free_band_including_both_edges() {
        assert_eq!(strain_of(0.0, &BAND), 0.0);
        assert_eq!(strain_of(-20.0 * D, &BAND), 0.0);
        assert_eq!(strain_of(40.0 * D, &BAND), 0.0);
        assert_eq!(strain_of(39.999 * D, &BAND), 0.0);
    }

    #[test]
    fn strain_rises_linearly_to_exactly_one_at_the_stop() {
        // Upper strained band is 40..60, so half of it is 50.
        close(strain_of(50.0 * D, &BAND), 0.5, 12);
        close(strain_of(45.0 * D, &BAND), 0.25, 12);
        close(strain_of(60.0 * D, &BAND), 1.0, 12);
    }

    #[test]
    fn strain_has_a_corner_rather_than_an_ease_at_the_free_edge() {
        // The comment states the ramp is linear precisely so the first degrees past
        // comfortable are not free. A smooth ramp would leave the slope near zero
        // here; linear makes it the full band slope from the first step out.
        let step = 0.001 * D;
        let slope = (strain_of(40.0 * D + step, &BAND) - strain_of(40.0 * D, &BAND)) / step;
        close(slope, 1.0 / (20.0 * D), 6);
    }

    #[test]
    fn strain_saturates_past_the_stop_and_ramps_on_the_low_side() {
        assert_eq!(strain_of(61.0 * D, &BAND), 1.0);
        assert_eq!(strain_of(150.0 * D, &BAND), 1.0);
        assert_eq!(strain_of(-51.0 * D, &BAND), 1.0);
        assert_eq!(strain_of(-500.0 * D, &BAND), 1.0);
        // Lower strained band is -20..-50, three times the width used above.
        close(strain_of(-35.0 * D, &BAND), 0.5, 12);
        close(strain_of(-50.0 * D, &BAND), 1.0, 12);
    }

    #[test]
    fn strain_reports_one_for_any_excursion_on_a_degenerate_band() {
        let pinned = dof(10.0, 20.0, 10.0, 20.0);
        assert_eq!(strain_of(20.0 * D, &pinned), 0.0);
        assert_eq!(strain_of(20.0001 * D, &pinned), 1.0);
        assert_eq!(strain_of(10.0 * D, &pinned), 0.0);
        assert_eq!(strain_of(9.9999 * D, &pinned), 1.0);
    }

    #[test]
    fn strain_reads_a_real_asymmetric_joint_on_both_sides() {
        // Wrist deviation: free -20..10, stop -30..20. The thumb side has a third
        // of the free travel the little-finger side has.
        let d = JointTable::human().wrist.deviation;
        close(strain_of(15.0 * D, &d), 0.5, 12);
        close(strain_of(-25.0 * D, &d), 0.5, 12);
    }

    #[test]
    fn excess_is_zero_inside_the_hard_stop_and_grows_past_it() {
        assert_eq!(excess_of(0.0, &BAND), 0.0);
        assert_eq!(excess_of(50.0 * D, &BAND), 0.0);
        assert_eq!(excess_of(60.0 * D, &BAND), 0.0);
        assert_eq!(excess_of(-50.0 * D, &BAND), 0.0);
        // This is the difference the elbow search runs on: a degree over and ninety
        // degrees over must not score the same.
        let one_over = excess_of(61.0 * D, &BAND);
        let ninety_over = excess_of(150.0 * D, &BAND);
        assert!(one_over > 0.0);
        assert!(ninety_over > one_over * 50.0);
        assert_eq!(strain_of(61.0 * D, &BAND), strain_of(150.0 * D, &BAND));
    }

    #[test]
    fn excess_is_measured_in_whole_bands_and_is_monotone() {
        // Band is -50..60, so 110 degrees; one band over the top is 170.
        close(excess_of(170.0 * D, &BAND), 1.0, 12);
        close(excess_of(115.0 * D, &BAND), 0.5, 12);
        close(excess_of(-160.0 * D, &BAND), 1.0, 12);
        let mut over = 1.0;
        while over < 90.0 {
            assert!(
                excess_of((60.0 + over + 1.0) * D, &BAND) > excess_of((60.0 + over) * D, &BAND)
            );
            assert!(
                excess_of((-50.0 - over - 1.0) * D, &BAND) > excess_of((-50.0 - over) * D, &BAND)
            );
            over += 7.0;
        }
        let pinned = dof(0.0, 0.0, 0.0, 0.0);
        assert!(excess_of(D, &pinned).is_finite());
        assert!(excess_of(D, &pinned) > 0.0);
    }

    #[test]
    fn clamp_dof_pulls_to_the_hard_stop_and_is_the_identity_inside() {
        // The elbow's free flexion ends at 130 and its stop at 150. Clamping to the
        // free band instead would make every effortful pose unreachable.
        let d = JointTable::human().elbow.flexion;
        close(deg(clamp_dof(160.0 * D, &d)), 150.0, 9);
        close(deg(clamp_dof(140.0 * D, &d)), 140.0, 9);
        close(deg(clamp_dof(-10.0 * D, &d)), 0.0, 9);
        assert_eq!(clamp_dof(0.0, &BAND), 0.0);
        assert_eq!(clamp_dof(55.0 * D, &BAND), 55.0 * D);
    }

    #[test]
    fn zone_of_places_each_strain() {
        for (strain, zone) in [
            (-1.0, StrainZone::Natural),
            (0.0, StrainZone::Natural),
            (f64::from_bits(1), StrainZone::Strained),
            (0.5, StrainZone::Strained),
            (0.999999, StrainZone::Strained),
            (1.0, StrainZone::Limit),
            (4.0, StrainZone::Limit),
        ] {
            assert_eq!(zone_of(strain), zone, "{strain}");
        }
        // Every zone is reachable, so every label the TS side holds is used.
        let mut seen = [false; 3];
        let mut s = -0.5;
        while s <= 2.0 {
            seen[zone_of(s) as usize] = true;
            s += 0.05;
        }
        assert_eq!(seen, [true; 3]);
    }

    #[test]
    fn roll_room_lends_past_the_free_band_and_keeps_its_signs() {
        let forearm = JointTable::human().elbow.rotation; // free -55..55, stop -80..80
        let [lo, hi] = roll_room(0.0, &forearm);
        close(deg(lo), -80.0, 9);
        close(deg(hi), 80.0, 9);
        // 60 degrees is already past the free 55. Measured against the free band
        // this would be zero and the shoulder would decline to help exactly where
        // the alternative is a forearm past its own stop.
        let [lo, hi] = roll_room(60.0 * D, &forearm);
        close(deg(hi), 20.0, 9);
        close(deg(lo), -140.0, 9);
        assert!(hi > 0.0);
        let mut used = -120.0;
        while used <= 120.0 {
            let [lo, hi] = roll_room(used * D, &forearm);
            assert!(lo <= 0.0 && hi >= 0.0);
            used += 5.0;
        }
        // Nothing in the direction already past the stop.
        assert_eq!(roll_room(90.0 * D, &forearm)[1], 0.0);
        assert_eq!(roll_room(-90.0 * D, &forearm)[0], 0.0);
    }

    #[test]
    fn elevation_ceiling_returns_rows_and_interpolates_between_them() {
        for [plane, free, max] in ELEVATION {
            let c = elevation_ceiling(plane * D, &ELEVATION);
            close(deg(c.free), free, 9);
            close(deg(c.max), max, 9);
        }
        // Halfway from [0, 100, 175] to [45, 105, 178].
        let c = elevation_ceiling(22.5 * D, &ELEVATION);
        close(deg(c.free), 102.5, 9);
        close(deg(c.max), 176.5, 9);
    }

    #[test]
    fn elevation_ceiling_closes_the_circle_and_normalises_the_plane() {
        let plus = elevation_ceiling(180.0 * D, &ELEVATION);
        let minus = elevation_ceiling(-180.0 * D, &ELEVATION);
        close(plus.free, minus.free, 12);
        close(plus.max, minus.max, 12);
        close(deg(plus.max), 45.0, 9);
        for (plane, same) in [
            (190.0, -170.0),
            (-190.0, 170.0),
            (405.0, 45.0),
            (-405.0, -45.0),
        ] {
            let a = elevation_ceiling(plane * D, &ELEVATION);
            let b = elevation_ceiling(same * D, &ELEVATION);
            close(a.free, b.free, 12);
            close(a.max, b.max, 12);
        }
    }

    #[test]
    fn elevation_ceiling_has_the_shape_the_table_describes() {
        let widest = elevation_ceiling(45.0 * D, &ELEVATION);
        for row in ELEVATION.iter().filter(|r| r[0] != 45.0) {
            assert!(deg(widest.max) > row[2]);
        }
        let across = elevation_ceiling(180.0 * D, &ELEVATION);
        let behind = elevation_ceiling(-90.0 * D, &ELEVATION);
        let side = elevation_ceiling(0.0, &ELEVATION);
        let forward = elevation_ceiling(90.0 * D, &ELEVATION);
        assert!(across.max < behind.max);
        assert!(behind.max < side.max);
        assert!(behind.max < forward.max);
        // Reaching across the chest gets a quarter of the lift the side does.
        close(deg(across.max), 45.0, 9);
        close(deg(behind.max), 60.0, 9);
        let mut plane = -180.0;
        while plane <= 180.0 {
            let c = elevation_ceiling(plane * D, &ELEVATION);
            assert!(c.max > c.free && c.free > 0.0);
            plane += 3.0;
        }
    }

    #[test]
    fn elevation_strain_scores_against_its_ceiling() {
        let ceiling = ElevationCeiling {
            free: 100.0 * D,
            max: 175.0 * D,
        };
        for (theta, strain) in [
            (0.0, 0.0),
            (90.0, 0.0),
            (100.0, 0.0),
            (137.5, 0.5),
            (175.0, 1.0),
            (220.0, 1.0),
        ] {
            close(elevation_strain(theta * D, &ceiling), strain, 12);
        }
        let flat = ElevationCeiling {
            free: 40.0 * D,
            max: 40.0 * D,
        };
        assert_eq!(elevation_strain(40.0 * D, &flat), 0.0);
        assert_eq!(elevation_strain(40.001 * D, &flat), 1.0);
        // Zero right up to the free edge, then straight onto the ramp.
        assert_eq!(elevation_strain(ceiling.free, &ceiling), 0.0);
        let step = 0.001 * D;
        close(
            elevation_strain(ceiling.free + step, &ceiling),
            step / (ceiling.max - ceiling.free),
            12,
        );
    }

    #[test]
    fn finger_curl_puts_one_at_the_top_of_each_free_band() {
        let t = JointTable::human();
        let finger = t.finger;
        close(deg(finger_curl(&finger, 0, 1.0)), 90.0, 9);
        close(deg(finger_curl(&finger, 1, 1.0)), 100.0, 9);
        close(deg(finger_curl(&finger, 2, 1.0)), 70.0, 9);
        // A fist closes to a real fist, not to the end of the strained band.
        assert!(finger_curl(&finger, 0, 1.0) < finger.proximal.unwrap().max[1]);
        assert!(finger_curl(&finger, 1, 1.0) < finger.intermediate.unwrap().max[1]);
        assert!(finger_curl(&finger, 2, 1.0) < finger.distal.unwrap().max[1]);
        let [p, i, d] = [0, 1, 2].map(|n| finger_curl(&finger, n, 0.5));
        close(deg(p), 45.0, 9);
        close(deg(i), 50.0, 9);
        close(deg(d), 35.0, 9);
        assert!(i > p && p > d);
        assert_eq!(finger_curl(&finger, 0, 0.0), 0.0);
        close(
            finger_curl(&finger, 1, 0.25),
            finger_curl(&finger, 1, 0.5) / 2.0,
            12,
        );
    }

    #[test]
    fn finger_curl_reaches_the_strained_band_and_hyperextends_only_where_allowed() {
        let finger = JointTable::human().finger;
        close(deg(finger_curl(&finger, 0, 1.1)), 99.0, 9);
        close(deg(finger_curl(&finger, 0, 1.2)), 100.0, 9);
        close(deg(finger_curl(&finger, 0, 9.0)), 100.0, 9);
        // The knuckle bends back 30 degrees; the middle joint does not bend back
        // at all, so a negative curl there is clamped to straight.
        close(deg(finger_curl(&finger, 0, -0.2)), -18.0, 9);
        close(deg(finger_curl(&finger, 0, -1.0)), -30.0, 9);
        assert_eq!(finger_curl(&finger, 1, -0.2), 0.0);
        assert_eq!(finger_curl(&finger, 1, -5.0), 0.0);
        close(deg(finger_curl(&finger, 2, -1.0)), -10.0, 9);
    }

    #[test]
    fn finger_curl_falls_back_to_distal_and_reads_the_thumb_table() {
        let t = JointTable::human();
        for index in [3, 4, 17] {
            assert_eq!(
                finger_curl(&t.finger, index, 0.6),
                finger_curl(&t.finger, 2, 0.6)
            );
            assert_eq!(
                finger_curl(&t.thumb, index, 0.6),
                finger_curl(&t.thumb, 2, 0.6)
            );
        }
        close(deg(finger_curl(&t.thumb, 0, 1.0)), 45.0, 9);
        close(deg(finger_curl(&t.thumb, 1, 1.0)), 50.0, 9);
        close(deg(finger_curl(&t.thumb, 2, 1.0)), 70.0, 9);
        assert_ne!(
            finger_curl(&t.thumb, 0, 1.0),
            finger_curl(&t.finger, 0, 1.0)
        );
        let boneless = Digit::default();
        assert_eq!(finger_curl(&boneless, 0, 1.0), 0.0);
        assert_eq!(finger_curl(&boneless, 2, 1.0), 0.0);
    }

    #[test]
    fn thumb_opposition_ramps_toward_the_fold() {
        let [start, full] = THUMB_OPPOSITION_CURL;
        const { assert!(THUMB_OPPOSITION < 0.0) };
        close(thumb_opposition(start), 0.0, 12);
        close(thumb_opposition(0.0), 0.0, 12);
        close(thumb_opposition(-1.0), 0.0, 12);
        close(thumb_opposition(full), THUMB_OPPOSITION, 12);
        close(thumb_opposition(1.0), THUMB_OPPOSITION, 12);
        close(thumb_opposition(2.0), THUMB_OPPOSITION, 12);
        close(
            thumb_opposition((start + full) / 2.0),
            THUMB_OPPOSITION / 2.0,
            12,
        );
        close(
            thumb_opposition(start + 0.25 * (full - start)),
            THUMB_OPPOSITION / 4.0,
            12,
        );
    }

    fn pair(s: &[f64]) -> [f64; 2] {
        [s[0], s[1]]
    }

    fn bits(values: &[f64]) -> Vec<u64> {
        values.iter().map(|v| v.to_bits()).collect()
    }

    #[test]
    fn roll_room_replays_its_corpus_bit_for_bit() {
        let corpus = Corpus::load("rollRoom");
        for case in corpus.iter() {
            let d = JointDof {
                free: pair(case.input("d.free")),
                max: pair(case.input("d.max")),
            };
            let got = roll_room(case.scalar("used", false), &d);
            assert_eq!(bits(&got), bits(case.output("return")));
        }
    }

    #[test]
    fn finger_curl_replays_its_corpus_bit_for_bit() {
        let corpus = Corpus::load("fingerCurl");
        for case in corpus.iter() {
            let segment = |name: &str| {
                Some(JointDof {
                    free: pair(case.input(&format!("joints.dofs.{name}.free"))),
                    max: pair(case.input(&format!("joints.dofs.{name}.max"))),
                })
            };
            let joints = Digit {
                proximal: segment("proximal"),
                intermediate: segment("intermediate"),
                distal: segment("distal"),
            };
            let index = case.scalar("index", false);
            assert_eq!(index, index.trunc());
            let got = finger_curl(&joints, index as usize, case.scalar("amount", false));
            assert_eq!(got.to_bits(), case.scalar("return", true).to_bits());
        }
    }

    #[test]
    fn thumb_opposition_replays_its_corpus_bit_for_bit() {
        let corpus = Corpus::load("thumbOpposition");
        for case in corpus.iter() {
            let got = thumb_opposition(case.scalar("amount", false));
            assert_eq!(got.to_bits(), case.scalar("return", true).to_bits());
        }
    }
}
