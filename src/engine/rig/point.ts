import * as THREE from 'three';
import type { ArmAnatomy } from '../anatomy';
import type { PointSpec, Profile, Side, Vec3Tuple } from '../types';
import type { ArmSolution } from './reach';

/**
 * A fingertip request, back-solved into an arm.
 *
 * Its own module because it is the one place a *bearing* becomes a pose. The
 * rest of the rig is told world directions and aims bones onto them; here the
 * caller says "up and to the right, most of the way out", and turning that into
 * a wrist position — hand length taken out, palm derived rather than assumed —
 * is a self-contained piece of arithmetic that the arm chain never has to know
 * about.
 */

const _t = new THREE.Vector3();

/**
 * A world direction from either form a caller holds one in.
 *
 * Hands back one shared scratch vector, so the result is only valid until the
 * next call — anything needing two directions at once has to copy them out.
 */
function target(a: Vec3Tuple | THREE.Vector3): THREE.Vector3 {
  return Array.isArray(a) ? _t.set(a[0], a[1], a[2]).normalize() : _t.copy(a).normalize();
}

/**
 * A fingertip request as the solver receives it.
 *
 * `PointSpec` states its directions as character-space tuples, which is how a
 * gesture authors them; the motion layer projects them into world-space
 * scratch vectors first, so both forms arrive here in the solver's frame.
 */
export interface PointRequest extends Omit<PointSpec, 'point' | 'palm'> {
  point?: Vec3Tuple | THREE.Vector3 | null;
  palm?: Vec3Tuple | THREE.Vector3 | null;
}

/** Where the elbow is chosen, as this solver reaches it. */
type ElbowSearchFn = (
  side: Side,
  wristTarget: THREE.Vector3,
  handDir: THREE.Vector3 | null,
  palmN: THREE.Vector3 | null,
  out: ArmSolution,
) => number | null;

export class PointSolver {
  private readonly _pt = {
    dir: new THREE.Vector3(),
    tip: new THREE.Vector3(),
    wrist: new THREE.Vector3(),
    finger: new THREE.Vector3(),
    palm: new THREE.Vector3(),
    shoulder: new THREE.Vector3(),
  };

  constructor(
    private readonly p: Profile,
    private readonly anat: ArmAnatomy,
    private readonly search: ElbowSearchFn,
  ) {}

  /**
   * Back-solve an arm from a fingertip.
   *
   * The request is angular: a bearing from the shoulder in the body's own
   * frame, plus how far out along it. That is the coordinate a pointing gesture
   * is actually specified in — "up and to the right, most of the way out" — and
   * unlike a world position it survives the character turning, leaning or being
   * a different size.
   *
   *   azimuth    radians, 0 straight ahead, positive toward the character's right
   *   elevation  radians, 0 at shoulder height, positive up
   *   extent     0..1 of the arm's full reach, fingertip included
   *   finger     which fingertip the coordinate refers to
   *   point      optional world direction the finger should point along
   *   palm       optional world direction the palm should face
   *
   * Two things are solved here that a plain reach does not have to. The target
   * is a fingertip and the solver's chain ends at the wrist, so the hand's own
   * length has to be taken out of the target first — a third of a forearm, and
   * ignoring it puts the hand through whatever is being pointed at. And the
   * elbow is not given: it is searched for, against the anatomy model's strain
   * and against where a person would have put it. Without that search a
   * fingertip target has a whole circle of correct answers and no reason to
   * prefer the one an arm would use.
   */
  solve(side: Side, spec: PointRequest, out: ArmSolution): ArmSolution | null {
    const { bones, limb } = this.p;
    const upper = bones[`upperArm.${side}`];
    const La = limb?.[`upper.${side}`];
    const Lf = limb?.[`lower.${side}`];
    if (!(upper && La && Lf && this.anat.update())) return null;

    const s = this._pt;
    const anat = this.anat;
    const finger = spec.finger ?? 'index';
    const Lt = limb[`tip.${side}.${finger}`] ?? limb[`tip.${side}.index`] ?? 0;

    upper.updateWorldMatrix(true, false);
    const S = upper.getWorldPosition(s.shoulder);

    // Bearing, in the body frame. Built rather than projected, so it cannot be
    // degenerate at any azimuth or elevation.
    const az = spec.azimuth ?? 0;
    const el = spec.elevation ?? 0;
    const ce = Math.cos(el);
    s.dir
      .copy(anat.fwd)
      .multiplyScalar(ce * Math.cos(az))
      .addScaledVector(anat.right, ce * Math.sin(az))
      .addScaledVector(anat.up, Math.sin(el))
      .normalize();

    const reach = La + Lf + Lt;
    const extent = THREE.MathUtils.clamp(spec.extent ?? 0.8, 0.1, 1);
    s.tip.copy(S).addScaledVector(s.dir, reach * extent);

    // A finger points along the bearing unless told otherwise. That is what
    // pointing *is* — the line from the shoulder through the fingertip is the
    // line being indicated — and it also keeps the hand from having to bend to
    // an angle the wrist does not have.
    s.finger.copy(spec.point ? target(spec.point) : s.dir).normalize();
    s.wrist.copy(s.tip).addScaledVector(s.finger, -Lt);

    // Palm. An explicit one constrains the wrist; without one the palm is a
    // free roll about the pointing axis, and it is *derived* from the solve
    // below rather than assumed. Assuming it — "a hand points palm-down" — was
    // the first version, and it charged the wrist for deviation it would never
    // have had to make: a cross-body point came back with 47 degrees of wrist
    // flexion and 11 of deviation, both flagged, when the real answer is that
    // the forearm rolls over and the wrist barely bends.
    const wanted = spec.palm;
    const fixedPalm = !!wanted;
    if (wanted) {
      s.palm.copy(target(wanted));
      s.palm.addScaledVector(s.finger, -s.palm.dot(s.finger));
      if (s.palm.lengthSq() < 1e-8) s.palm.copy(anat.up).negate();
      s.palm.normalize();
    }

    const bestC = this.search(side, s.wrist, s.finger, fixedPalm ? s.palm : null, out);
    if (bestC === null) return null;

    // Derive the palm from the pose that won: point it along the direction the
    // hand had to bend, which makes that bend flexion rather than deviation.
    // The roll needed to get there is pronation, and `aimArm` hands it to the
    // forearm — which is the joint that actually performs it.
    if (!fixedPalm) {
      s.palm.copy(s.finger).addScaledVector(out.lowerArm, -s.finger.dot(out.lowerArm));
      if (s.palm.lengthSq() < 1e-6) {
        // A straight wrist bends in no direction, so nothing is determined and
        // a hand pointing at something rests palm-down.
        s.palm.copy(anat.up).negate();
        s.palm.addScaledVector(s.finger, -s.palm.dot(s.finger));
        if (s.palm.lengthSq() < 1e-8) s.palm.copy(anat.fwd).negate();
      }
      s.palm.normalize();
    }

    out.hand.copy(s.finger);
    out.twist = 0;
    // Copied, never aliased: `_pt` is one scratch object shared by both arms
    // and by both gesture slots, so handing out a reference to it means the
    // next solve silently rewrites an answer the caller is still holding.
    out.palm.copy(s.palm);
    // Where the fingertip actually ended up, so a caller can tell a request
    // that was honoured from one the arm was too short for.
    out.tip.copy(s.tip);
    out.strain = bestC;
    return out;
  }
}
