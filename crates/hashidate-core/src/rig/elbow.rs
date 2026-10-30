//! `rig/elbow.ts`: where the elbow goes.
//!
//! Once a wrist position is fixed the elbow can still sit anywhere on a circle
//! around the shoulder-to-wrist line, and geometry has no opinion about where.
//! This is the part that turns a position into a pose, and it is the one place
//! in the rig that searches rather than solves.
//!
//! Every number here was arrived at by watching two avatars reach for things.
//!
//! The search holds no state between calls: what it remembers lives in the caller's
//! `ArmSolution::swivel_dir`. Its scratch is per call.

use super::reach::{ArmSolution, ReachLinks, reach_ref, refresh_frame, swivel_of};
use crate::anatomy::arm::ArmAnatomy;
use crate::anatomy::cost::contact_cost;
use crate::math::Vec3;
use crate::math::f::{SWIVEL_RATE, atan2, cos, exp, js_max, sin};
use crate::profile::{ArmSlot, BoneSlot, Profile, Side};
use crate::scene::graph::Graph;
use core::f64::consts::PI;

/// Elbow positions tried when solving a fingertip target.
///
/// The elbow sits somewhere on a circle around the shoulder-to-wrist line, and
/// nothing about the fingertip says where. Sampling the circle and scoring each
/// position is what turns "put the fingertip here" into a pose an arm would
/// actually adopt — it is the whole of the back-solve, and the reason the anatomy
/// model needs a cost rather than a pass/fail limit.
///
/// 24 samples puts them 15 degrees apart, which is finer than the cost surface
/// varies; the parabolic refinement afterwards costs one more evaluation and
/// removes the residual stepping.
const SWIVEL_SAMPLES: usize = 24;

/// How far the elbow moves toward its answer each frame. See `search`.
///
/// `SWIVEL_RATE` (`math::f`) is this as a per-second rate at the 60 Hz it was set at, so
/// tracking depends on time rather than call count.
pub const SWIVEL_TRACK: f64 = 0.25;

/// How close the elbow has to get before it is simply put there, in radians.
///
/// Tracking a fraction of the remaining distance each frame approaches the
/// answer and never reaches it, so a pose merely being held keeps creeping for
/// as long as it is held. That did not show while the hysteresis below was in
/// force, because staying put was itself the winning answer and the distance to
/// close was zero; with the elbow predicted from the target instead, the
/// remainder is real and has to be given somewhere to stop.
///
/// A tenth of a degree. Small enough that closing it in one frame cannot be
/// seen, and it buys the property that matters more: the same target now yields
/// exactly the same elbow, so a pose looks the same however it was arrived at.
const SWIVEL_SETTLE: f64 = 0.002;

/// The prior is not always available: it lands on the reach line, and says
/// nothing there, whenever the hand is roughly where a hanging elbow would be —
/// an arm at rest by the side is exactly that case. The elbow circle is a
/// pinhead there and the choice does not matter, so what is wanted is only that
/// it does not jump about; the continuity weight is enough on its own.
const SWIVEL_INERTIA: f64 = 0.05;

/// Where a person's elbow goes for a given hand position, and how hard the
/// search is held to it.
///
/// The strain search above answers "which elbow is most comfortable", and that
/// is not the question. An arm's posture is very nearly a function of where the
/// hand is — put your hand somewhere twice and the elbow arrives in the same
/// place both times, whatever route it took — and comfort is not what picks it.
/// The two shallow minima most targets have really are close to equally
/// comfortable, so scoring comfort alone leaves the choice underdetermined, and
/// everything that used to sit here — a continuity weight, a hysteresis margin,
/// a preference for staying put — existed to break a tie that comfort was never
/// going to break. Those are memory, and memory is exactly what an arm posture
/// does not have: they are also why a held pose could sit at one elbow and the
/// same pose reached from the other side sit at the other.
///
/// So the search gets a prior instead: a predicted elbow position, from the hand
/// position alone, added to the cost as a penalty for departing from it. It
/// decides which of the two minima is in play; strain still does the fine work
/// within it, so every number the anatomy model was tuned to still applies.
///
/// Being a function of the target and nothing else, the prior cannot flip-flop:
/// a target that is being held still predicts the same elbow every frame.
///
/// The pole is stated in body spans from the shoulder, in the anatomy frame,
/// with the lateral axis pointing away from the midline on either side. It rides
/// three facts:
///
///  - the elbow hangs *below* the shoulder, and rises with the hand at roughly
///    half the hand's own rate — the elevation regression
///  - it swings outward as the hand rises, and further outward as the hand
///    crosses toward the midline. Bringing a hand to the far cheek with the
///    elbow tucked against the ribs is not a pose an arm can hold
///  - it sits slightly behind the shoulder at rest and comes forward as the hand
///    reaches forward, but much less far
///
/// Only a prior, so these are the shape of the answer rather than the answer.
const ELBOW_PRIOR: f64 = 2.0;
const ELBOW_POLE_OUT: f64 = 0.3;
const ELBOW_POLE_OUT_RISE: f64 = 0.34;
const ELBOW_POLE_OUT_CROSS: f64 = 0.24;
const ELBOW_POLE_UP: f64 = -0.92;
const ELBOW_POLE_UP_RISE: f64 = 0.55;
const ELBOW_POLE_FWD: f64 = -0.08;
const ELBOW_POLE_FWD_REACH: f64 = 0.3;

/// What the search needs from the rig around it.
pub trait ElbowContext {
    /// Solve the two-link reach at one trial elbow angle, in a frame already refreshed.
    #[allow(clippy::too_many_arguments)]
    fn solve_reach(
        &mut self,
        graph: &mut Graph,
        anat: &mut ArmAnatomy,
        side: Side,
        target_world: &Vec3,
        angle: f64,
        out: &mut ReachLinks,
        framed: bool,
    ) -> bool;
    /// Hand the anatomy model this arm's origin and segment lengths.
    fn arm_context(&mut self, graph: &mut Graph, anat: &mut ArmAnatomy, side: Side) -> bool;
    /// Seconds the current frame covers.
    fn dt(&self) -> f64;
}

/// The reach line of one search: the shoulder and the unit bearing to the wrist.
#[derive(Clone, Copy, Debug)]
struct Line {
    s: Vec3,
    n: Vec3,
}

/// One search's inputs, held so the scoring of a candidate reads like the TS closure.
struct Request<'a> {
    side: Side,
    wrist_target: &'a Vec3,
    hand_dir: Option<&'a Vec3>,
    palm_n: Option<&'a Vec3>,
    framed: bool,
    authored: bool,
    prior: Option<f64>,
    prev: Option<f64>,
}

/// The TS instance holds only scratch (`_lineS`, `_cand`, …), none of it read before it is
/// written in a call, so the port holds nothing.
#[derive(Clone, Copy, Debug, Default)]
pub struct ElbowSearch;

impl ElbowSearch {
    // elbow.ts ElbowSearch.constructor
    pub fn new() -> ElbowSearch {
        ElbowSearch
    }

    // elbow.ts ElbowSearch.search
    //
    // Find where the elbow belongs on its circle, and solve there.
    //
    // Every position on that circle is sampled and scored, and the cheapest wins.
    // The score is the anatomy model's strain, plus a penalty for departing from
    // where a person would have put it — see `ELBOW_PRIOR` for why strain alone
    // cannot decide.
    //
    // `handDir` is the direction the hand will point, needed to score the wrist;
    // pass null and the wrist is left out of the scoring, which is the right
    // thing when the hand's direction is not decided until the elbow is.
    // `palmN` likewise: null means the palm is free to roll.
    //
    // `pole` is a world point the elbow is drawn toward, as the gesture table
    // states one. It replaces the predicted elbow as the prior, and it silences
    // every strain term but the body: an authored pole was placed by eye against
    // a render, and the inside of the chest is the one thing a render does not
    // show. Solved at the pole outright, a hand brought inside the shoulder line
    // had its elbow in the chest and left the limiter to lift it out, part by
    // part and a frame at a time; scored on strain as well, the search moved
    // elbows the author had placed — the hand behind the ear by a forearm's
    // length — because the stop the pole leans on reads as a cost.
    //
    // `out` carries the slot's own elbow state in `swivelDir`, so two slots
    // solving one side in a frame do not pull a shared elbow between them. Zero,
    // the answer is taken outright, which is what a probe solve wants.
    //
    // Returns the strain of the pose solved — the anatomy cost alone, prior
    // excluded — or null if the target cannot be solved at all.
    #[allow(clippy::too_many_arguments)]
    pub fn search(
        &self,
        p: &Profile,
        graph: &mut Graph,
        anat: &mut ArmAnatomy,
        ctx: &mut dyn ElbowContext,
        side: Side,
        wrist_target: &Vec3,
        hand_dir: Option<&Vec3>,
        palm_n: Option<&Vec3>,
        out: &mut ArmSolution,
        pole: Option<&Vec3>,
    ) -> Option<f64> {
        let mut cand = ReachLinks::default();
        ctx.arm_context(graph, anat, side);
        // Once per search: every candidate is solved in the same body frame.
        let framed = refresh_frame(graph, anat);
        let line = if framed {
            Self::line(p, graph, side, wrist_target)
        } else {
            None
        };
        let prev = match &line {
            Some(line) => Self::remembered(graph, anat, line, out, framed),
            None => None,
        };
        // Computed before the sweep, not inside it: the prior is a function of the
        // target, and the target does not change while the circle is being sampled.
        let pole_a = match (pole, &line) {
            (Some(pole), Some(line)) => {
                let mut w = *pole;
                w.sub(&line.s);
                swivel_of(graph, anat, &line.n, &w, Some(framed))
            }
            _ => None,
        };
        // A pole on the reach line says nothing, and the frame is searched as a
        // pose with no pole; the slot's elbow memory carries it across either way.
        // Holding the pole's rule there instead, with no strain scored, hung the
        // forearm bent backward until the pole came off the line and flipped it.
        let authored = pole_a.is_some();
        let prior = if authored {
            pole_a
        } else {
            match &line {
                Some(line) => Self::predict(p, graph, anat, side, line, framed),
                None => None,
            }
        };
        let request = Request {
            side,
            wrist_target,
            hand_dir,
            palm_n,
            framed,
            authored,
            prior,
            prev,
        };

        let step = (PI * 2.0) / SWIVEL_SAMPLES as f64;

        let mut best_a = prev.unwrap_or(0.0);
        let mut best_c = f64::INFINITY;
        for i in 0..SWIVEL_SAMPLES {
            let a = -PI + i as f64 * step;
            let c = Self::score(graph, anat, ctx, &request, &mut cand, a);
            if c < best_c {
                best_c = c;
                best_a = a;
            }
        }
        if !best_c.is_finite() {
            return None;
        }
        best_a = Self::refine(graph, anat, ctx, &request, &mut cand, step, best_a, best_c);

        // Track toward the answer instead of jumping to it.
        //
        // Where the target is close to the shoulder the elbow circle is wide, and
        // the map from swivel angle to shoulder elevation gets steep — on the
        // hand-to-chin poses six degrees of swivel is fifty of elevation. The cost
        // surface there is not smooth enough for the parabolic step to land in the
        // same place twice, so the refinement alternated between two angles a few
        // degrees apart and the arm swung through a wide arc every frame while the
        // pose was merely being held.
        //
        // Damping costs a few frames of lag on a genuine move, which the direction
        // blend was going to smooth anyway.
        //
        // This smooths a value; it does not choose one. What is being tracked toward
        // is a function of the target alone, so the elbow still ends up in the same
        // place whatever route it took there — which is the property the prior
        // exists for, and the reason the stickiness that used to sit here is gone.
        let mut settled = best_a;
        if let Some(prev) = prev {
            let mut d = best_a - prev;
            d = atan2(sin(d), cos(d)); // the short way round
            let k = 1.0 - exp(-SWIVEL_RATE * ctx.dt());
            if d.abs() >= SWIVEL_SETTLE {
                settled = prev + d * k;
            }
        }

        if !ctx.solve_reach(
            graph,
            anat,
            side,
            wrist_target,
            settled,
            &mut out.links,
            framed,
        ) {
            return None;
        }
        if let Some(line) = &line {
            Self::remember(graph, anat, line, out, settled, framed);
        }
        // Reported at the elbow the arm was given and without the prior, which
        // steers the choice but is no part of what the pose costs.
        let links = out.links;
        anat.measure(
            side,
            &links.upper_arm,
            &links.lower_arm,
            hand_dir.unwrap_or(&links.lower_arm),
            palm_n,
            0.0,
            0.0,
        );
        Some(if authored {
            contact_cost(&anat.m)
        } else {
            anat.cost()
        })
    }

    // elbow.ts ElbowSearch.search, its `score` closure
    fn score(
        graph: &mut Graph,
        anat: &mut ArmAnatomy,
        ctx: &mut dyn ElbowContext,
        r: &Request,
        cand: &mut ReachLinks,
        angle: f64,
    ) -> f64 {
        if !ctx.solve_reach(graph, anat, r.side, r.wrist_target, angle, cand, r.framed) {
            return f64::INFINITY;
        }
        anat.measure(
            r.side,
            &cand.upper_arm,
            &cand.lower_arm,
            r.hand_dir.unwrap_or(&cand.lower_arm),
            r.palm_n,
            0.0,
            0.0,
        );
        let strain = if r.authored {
            contact_cost(&anat.m)
        } else {
            anat.cost()
        };
        if let Some(prior) = r.prior {
            // Cosine rather than a squared difference so the penalty wraps with the
            // circle: the angle is periodic, and a difference of just under a turn
            // is a small move and must not be charged as a large one.
            return strain + ELBOW_PRIOR * (1.0 - cos(angle - prior));
        }
        // Continuity, so a target drifting between two equally comfortable elbow
        // positions does not flip between them.
        let d = angle - r.prev.unwrap_or(0.0);
        strain + SWIVEL_INERTIA * (1.0 - cos(d))
    }

    // elbow.ts ElbowSearch.search, its `refine` closure
    //
    // Parabolic refinement through a winner and its neighbours. One extra
    // evaluation each side, and it removes the 15-degree stepping that is
    // otherwise visible as the elbow ratcheting when a target sweeps across.
    #[allow(clippy::too_many_arguments)]
    fn refine(
        graph: &mut Graph,
        anat: &mut ArmAnatomy,
        ctx: &mut dyn ElbowContext,
        r: &Request,
        cand: &mut ReachLinks,
        step: f64,
        a0: f64,
        c0: f64,
    ) -> f64 {
        let cl = Self::score(graph, anat, ctx, r, cand, a0 - step);
        let cr = Self::score(graph, anat, ctx, r, cand, a0 + step);
        let denom = cl - 2.0 * c0 + cr;
        if cl.is_finite() && cr.is_finite() && denom.abs() > 1e-9 {
            let shift = (0.5 * (cl - cr)) / denom;
            if shift.abs() < 1.0 {
                return a0 + shift * step;
            }
        }
        a0
    }

    // elbow.ts ElbowSearch.line
    //
    // The reach line for this solve — shoulder in `_lineS`, unit bearing in
    // `_lineN` — or false where the rig has no arm to draw it from. The caller
    // has already refreshed the body frame.
    fn line(p: &Profile, graph: &mut Graph, side: Side, wrist_target: &Vec3) -> Option<Line> {
        let upper = p.bone(BoneSlot::arm(ArmSlot::UpperArm, side))?;
        graph.update_world_matrix(upper, true, false, false);
        let s = graph.world_position(upper);
        let mut n = *wrist_target;
        n.sub(&s);
        if n.length_sq() < 1e-10 {
            return None;
        }
        n.normalize();
        Some(Line { s, n })
    }

    // elbow.ts ElbowSearch.remembered
    //
    // The slot's remembered elbow as an angle on this frame's circle, if it has one.
    fn remembered(
        graph: &mut Graph,
        anat: &mut ArmAnatomy,
        line: &Line,
        out: &ArmSolution,
        framed: bool,
    ) -> Option<f64> {
        let d = out.swivel_dir;
        if d.length_sq() == 0.0 {
            return None;
        }
        let mut w = *anat.right();
        w.multiply_scalar(d.x)
            .add_scaled_vector(anat.up(), d.y)
            .add_scaled_vector(anat.fwd(), d.z);
        swivel_of(graph, anat, &line.n, &w, Some(framed))
    }

    // elbow.ts ElbowSearch.remember
    //
    // Record the elbow's standoff direction at `angle`, in the body frame.
    fn remember(
        graph: &mut Graph,
        anat: &mut ArmAnatomy,
        line: &Line,
        out: &mut ArmSolution,
        angle: f64,
        framed: bool,
    ) {
        let n = line.n;
        let mut reference = Vec3::default();
        reach_ref(graph, anat, &n, &mut reference, Some(framed));
        let mut bi = n;
        bi.cross(&reference);
        let mut w = reference;
        w.multiply_scalar(cos(angle))
            .add_scaled_vector(&bi, sin(angle));
        out.swivel_dir
            .set(w.dot(anat.right()), w.dot(anat.up()), w.dot(anat.fwd()));
    }

    // elbow.ts ElbowSearch.predict
    //
    // Where the elbow belongs for a wrist on the current reach line, as an angle
    // on the elbow circle. Null on a rig whose body frame the profile could not
    // resolve, and where the predicted pole lands on the reach line and therefore
    // says nothing — see `swivelOf`.
    //
    // Predicted as a *point* and converted, rather than as an angle directly. The
    // angle is measured about the shoulder-to-wrist line, and that line swings
    // through most of a right angle between a hand at the hip and a hand at the
    // mouth, so a formula written in angles would be describing a different elbow
    // at every target. A point beside the ribs is the same place whatever the
    // hand is doing, which is the whole reason the gesture table states poles.
    //
    // See `ELBOW_PRIOR` for what the coefficients mean.
    fn predict(
        p: &Profile,
        graph: &mut Graph,
        anat: &mut ArmAnatomy,
        side: Side,
        line: &Line,
        framed: bool,
    ) -> Option<f64> {
        let span = p
            .body
            .and_then(|b| b.span)
            .filter(|&s| s != 0.0 && !s.is_nan())?;
        let u = line.n;

        // The hand's bearing from the shoulder, resolved in the body's own frame so
        // it survives the character leaning or turning. `s` mirrors the lateral
        // axis, so "outward" means away from the midline on either arm and one set
        // of coefficients serves both.
        let s = if side == Side::R { 1.0 } else { -1.0 };
        let outward = u.dot(anat.right()) * s;
        let up = u.dot(anat.up());
        let fwd = u.dot(anat.fwd());

        let po = ELBOW_POLE_OUT
            + ELBOW_POLE_OUT_RISE * js_max(0.0, up)
            + ELBOW_POLE_OUT_CROSS * js_max(0.0, -outward);
        let pu = ELBOW_POLE_UP + ELBOW_POLE_UP_RISE * up;
        let pf = ELBOW_POLE_FWD + ELBOW_POLE_FWD_REACH * js_max(0.0, fwd);

        // The pole as an offset from the shoulder, which is all `swivelOf` needs.
        let mut prior_pole = Vec3::default();
        prior_pole
            .add_scaled_vector(anat.right(), po * s * span)
            .add_scaled_vector(anat.up(), pu * span)
            .add_scaled_vector(anat.fwd(), pf * span);

        swivel_of(graph, anat, &u, &prior_pole, Some(framed))
    }
}

#[cfg(test)]
mod tests {
    //! `tests/rig/elbow-swivel.test.ts`, on the base avatar.
    //!
    //! Each gesture slot carries its own elbow, and tracking runs on elapsed time,
    //! so neither a second slot solving the same arm nor a faster display changes
    //! where one slot's elbow is after a given time.
    use super::*;
    use crate::math::f::{js_round, sqrt};
    use crate::rig::reach::FRAME_REFRESHES;
    use crate::rig::testkit::{Arms, close};

    struct Setup {
        arms: Arms,
        shoulder: Vec3,
        ahead: Vec3,
        across: Vec3,
    }

    fn setup() -> Setup {
        let mut arms = Arms::new();
        let shoulder = arms.shoulder(Side::R);
        let limb = arms.profile.limb[Side::R as usize];
        let span = limb.upper.unwrap_or(0.0) + limb.lower.unwrap_or(0.0);
        // In front of the chest and up, where the elbow circle is wide.
        let at = |x: f64, y: f64, z: f64| {
            let mut v = Vec3::new(x, y, z);
            v.multiply_scalar(span).add(&shoulder);
            v
        };
        let (ahead, across) = (at(-0.2, 0.25, 0.6), at(-0.6, -0.1, 0.4));
        Setup {
            arms,
            shoulder,
            ahead,
            across,
        }
    }

    /// Run one slot for `seconds` at `hz` from an elbow offset from its answer; the angle still
    /// to close.
    fn track_for(hz: f64, seconds: f64, interleave: bool) -> f64 {
        let Setup {
            mut arms,
            shoulder,
            ahead,
            across,
        } = setup();
        let mut slot = ArmSolution::default();
        let mut other = ArmSolution::default();
        arms.solve_reach_natural(Side::R, &ahead, None, &mut slot, None);
        let answer = slot.swivel_dir;
        // Push the remembered elbow 0.8 rad round its circle, about the reach line
        // expressed in the body frame the memory is kept in.
        let mut n = ahead;
        n.sub(&shoulder).normalize();
        let axis = Vec3::new(
            n.dot(arms.anat.right()),
            n.dot(arms.anat.up()),
            n.dot(arms.anat.fwd()),
        );
        slot.swivel_dir.apply_axis_angle(&axis, 0.8);
        arms.dt = 1.0 / hz;
        for _ in 0..js_round(seconds * hz) as usize {
            if interleave {
                arms.solve_reach_natural(Side::R, &across, None, &mut other, None);
            }
            arms.solve_reach_natural(Side::R, &ahead, None, &mut slot, None);
        }
        slot.swivel_dir.angle_to(&answer)
    }

    #[test]
    fn settles_a_fresh_slot_at_its_answer_outright() {
        let Setup {
            mut arms, ahead, ..
        } = setup();
        let (mut a, mut b) = (ArmSolution::default(), ArmSolution::default());
        arms.solve_reach_natural(Side::R, &ahead, None, &mut a, None);
        arms.solve_reach_natural(Side::R, &ahead, None, &mut b, None);
        close(a.swivel_dir.length(), 1.0, 12);
        assert!(b.swivel_dir.angle_to(&a.swivel_dir) < 1e-12);
        assert!(b.links.upper_arm.angle_to(&a.links.upper_arm) < 1e-12);
    }

    #[test]
    fn covers_the_same_ground_in_the_same_time_at_any_frame_rate() {
        let at60 = track_for(60.0, 1.0 / 12.0, false);
        let at144 = track_for(144.0, 1.0 / 12.0, false);
        assert!(at60 > 0.05);
        assert!(at60 < 0.8);
        close(at144, at60, 6);
    }

    #[test]
    fn is_not_pulled_by_another_slot_solving_the_same_arm() {
        close(track_for(60.0, 0.1, true), track_for(60.0, 0.1, false), 12);
    }

    #[test]
    fn keeps_the_elbow_where_it_was_when_the_reach_reference_switches_between_frames() {
        // The zero of the swivel angle is forward projected off the reach line,
        // and up once the reach runs close enough to forward. Two targets a degree
        // apart sit either side of that switch; what the slot remembers between
        // them must mean the same elbow in both frames.
        let Setup {
            mut arms, shoulder, ..
        } = setup();
        let limb = arms.profile.limb[Side::R as usize];
        let span = limb.upper.unwrap_or(0.0) + limb.lower.unwrap_or(0.0);
        let (fwd, up, right) = (*arms.anat.fwd(), *arms.anat.up(), *arms.anat.right());
        let bearing = |ahead: f64| {
            let rest = sqrt(1.0 - ahead * ahead);
            let mut v = Vec3::default();
            v.add_scaled_vector(&fwd, ahead)
                .add_scaled_vector(&up, -0.4 * rest)
                .add_scaled_vector(&right, -sqrt(1.0 - 0.16) * rest);
            v
        };
        let target = |ahead: f64| {
            let mut v = shoulder;
            v.add_scaled_vector(&bearing(ahead), 0.7 * span);
            v
        };
        let (before, after) = (target(0.86), target(0.88));
        let mut ref_before = Vec3::default();
        let mut ref_after = Vec3::default();
        reach_ref(
            &mut arms.graph,
            &mut arms.anat,
            &bearing(0.86),
            &mut ref_before,
            None,
        );
        reach_ref(
            &mut arms.graph,
            &mut arms.anat,
            &bearing(0.88),
            &mut ref_after,
            None,
        );
        assert!(ref_before.angle_to(&ref_after) > 1.0);

        let mut slot = ArmSolution::default();
        arms.dt = 1.0 / 60.0;
        for _ in 0..30 {
            arms.solve_reach_natural(Side::R, &before, None, &mut slot, None);
        }
        let held = slot.links.upper_arm;
        arms.solve_reach_natural(Side::R, &after, None, &mut slot, None);
        assert!(slot.links.upper_arm.angle_to(&held) < 0.05);
    }

    #[test]
    fn refreshes_the_body_frame_once_per_search_not_once_per_candidate() {
        let Setup {
            mut arms, ahead, ..
        } = setup();
        let mut slot = ArmSolution::default();
        let before = FRAME_REFRESHES.with(|c| c.get());
        arms.solve_reach_natural(Side::R, &ahead, None, &mut slot, None);
        assert_eq!(FRAME_REFRESHES.with(|c| c.get()) - before, 1);
    }
}
