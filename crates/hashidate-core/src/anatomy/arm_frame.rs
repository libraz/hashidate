//! `anatomy/arm-frame.ts`: the humerus's zero-rotation reference and its partner.

use crate::math::Vec3;

// arm-frame.ts humeralReference
//
// Zero-rotation reference for the humerus: the direction the elbow points
// when the arm is neutral, which is forward on a hanging arm.
//
// In front of the shoulder it is where the shoulder carries that forward
// elbow on swinging straight to `u`: up at a horizontal flexion, back over
// the shoulder above it. Projecting forward onto the arm's normal plane
// instead flips half a turn as the arm passes straight forward, and every
// hand brought to the face read as rotated past its stop and was whipped
// sideways on the way in. Behind the shoulder it is still that projection,
// which matches how an elbow is taken back and has its own flip only straight
// behind, past the elevation ceiling. The two agree on the frontal plane, and
// the one singular direction left is straight up.
//
// Rotation about a swinging axis is path-dependent in general, so this is a
// reference rather than a measurement of how the arm got there.
pub fn humeral_reference(u: &Vec3, up: &Vec3, forward: &Vec3, out: &mut Vec3) {
    let ahead = u.dot(forward);
    let lift = 1.0 - u.dot(up);
    out.copy(forward);
    if ahead > 0.0 && lift > 1e-6 {
        out.add_scaled_vector(u, -ahead / lift)
            .add_scaled_vector(up, ahead / lift);
    }
    let along = -out.dot(u);
    out.add_scaled_vector(u, along);
    if out.length_sq() < 1e-8 {
        out.copy(up);
    }
    out.normalize();
}

// arm-frame.ts lateralReference
//
// Orthonormal partner to `ref` in the plane normal to `u`, toward outside.
//
// Handed rather than projected off the lateral axis, which lies in that plane
// once the arm is out at the side and flips the sign of every rotation above it.
pub fn lateral_reference(
    u: &Vec3,
    reference: &Vec3,
    up: &Vec3,
    forward: &Vec3,
    lateral: &Vec3,
    out: &mut Vec3,
) {
    out.cross_vectors(reference, u);
    let handedness = up.x * (forward.y * lateral.z - forward.z * lateral.y)
        + up.y * (forward.z * lateral.x - forward.x * lateral.z)
        + up.z * (forward.x * lateral.y - forward.y * lateral.x);
    if handedness < 0.0 {
        out.negate();
    }
    out.normalize();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::corpus_replay::Corpus;

    const EXACT: f64 = 1e-9;
    const UP: Vec3 = Vec3::new(0.0, 1.0, 0.0);
    const FORWARD: Vec3 = Vec3::new(0.0, 0.0, 1.0);
    const RIGHT: Vec3 = Vec3::new(1.0, 0.0, 0.0);

    fn unit(x: f64, y: f64, z: f64) -> Vec3 {
        let mut v = Vec3::new(x, y, z);
        v.normalize();
        v
    }

    fn left() -> Vec3 {
        let mut v = RIGHT;
        v.negate();
        v
    }

    #[test]
    fn keeps_the_reference_forward_on_a_hanging_arm_and_upright_at_a_forward_reach() {
        let mut reference = Vec3::default();
        humeral_reference(&Vec3::new(0.0, -1.0, 0.0), &UP, &FORWARD, &mut reference);
        assert!(reference.distance_to(&FORWARD) < EXACT);
        humeral_reference(&FORWARD, &UP, &FORWARD, &mut reference);
        assert!(reference.distance_to(&UP) < EXACT);
    }

    #[test]
    fn returns_an_orthonormal_bend_plane_for_oblique_directions() {
        let u = unit(-0.37, 0.42, 0.83);
        let mut reference = Vec3::default();
        let mut perp = Vec3::default();
        humeral_reference(&u, &UP, &FORWARD, &mut reference);
        lateral_reference(&u, &reference, &UP, &FORWARD, &left(), &mut perp);
        assert!(reference.dot(&u).abs() < EXACT);
        assert!(perp.dot(&u).abs() < EXACT);
        assert!(perp.dot(&reference).abs() < EXACT);
        assert!((reference.length() - 1.0).abs() < EXACT);
        assert!((perp.length() - 1.0).abs() < EXACT);
    }

    #[test]
    fn mirrors_the_perpendicular_when_the_lateral_axis_changes_sides() {
        let u = unit(0.31, 0.2, 0.93);
        let mut reference = Vec3::default();
        humeral_reference(&u, &UP, &FORWARD, &mut reference);
        let mut right_perp = Vec3::default();
        let mut left_perp = Vec3::default();
        lateral_reference(&u, &reference, &UP, &FORWARD, &RIGHT, &mut right_perp);
        lateral_reference(&u, &reference, &UP, &FORWARD, &left(), &mut left_perp);
        assert!((right_perp.dot(&left_perp) + 1.0).abs() < 5e-10);
    }

    fn vec3(s: &[f64]) -> Vec3 {
        Vec3::new(s[0], s[1], s[2])
    }

    fn bits(v: &Vec3) -> [u64; 3] {
        [v.x.to_bits(), v.y.to_bits(), v.z.to_bits()]
    }

    fn bits_of(s: &[f64]) -> [u64; 3] {
        [s[0].to_bits(), s[1].to_bits(), s[2].to_bits()]
    }

    #[test]
    fn humeral_reference_replays_its_corpus_bit_for_bit() {
        let corpus = Corpus::load("humeralReference");
        for case in corpus.iter() {
            let mut out = vec3(case.input("out"));
            humeral_reference(
                &vec3(case.input("u")),
                &vec3(case.input("up")),
                &vec3(case.input("forward")),
                &mut out,
            );
            assert_eq!(bits(&out), bits_of(case.output("return")));
            assert_eq!(bits(&out), bits_of(case.output("out")));
        }
    }

    #[test]
    fn lateral_reference_replays_its_corpus_bit_for_bit() {
        let corpus = Corpus::load("lateralReference");
        for case in corpus.iter() {
            let mut out = vec3(case.input("out"));
            lateral_reference(
                &vec3(case.input("u")),
                &vec3(case.input("ref")),
                &vec3(case.input("up")),
                &vec3(case.input("forward")),
                &vec3(case.input("lateral")),
                &mut out,
            );
            assert_eq!(bits(&out), bits_of(case.output("return")));
            assert_eq!(bits(&out), bits_of(case.output("out")));
        }
    }
}
