import * as THREE from 'three';
import type { ArmAnatomy } from '../anatomy';
import type { JointTable, Profile, Side } from '../types';

/**
 * Two-link reach geometry.
 *
 * Pure functions rather than methods: none of this needs the rig's per-frame
 * state, only the profile's bones and lengths and the anatomy layer's world
 * frame. Keeping it out of the class is also what lets `poleAngle` and
 * `solveReach` share `reachRef` without either of them owning it.
 */

const _reachS = new THREE.Vector3();
const _reachD = new THREE.Vector3();
const _reachN = new THREE.Vector3();
const _reachP = new THREE.Vector3();
const _reachE = new THREE.Vector3();
/** The clamped target — where the wrist can actually get to along the bearing. */
const _reachT = new THREE.Vector3();
// Kept apart from the `_reach*` set: a caller converts a pole to an angle and
// then solves with it, so the two must not share scratch.
const _poleS = new THREE.Vector3();
const _poleN = new THREE.Vector3();
const _poleW = new THREE.Vector3();
const _poleR = new THREE.Vector3();
const _poleB = new THREE.Vector3();
// How far off the reach line a pole has to sit before it means anything —
// sin 14 degrees. Below this the elbow direction it implies is mostly noise.
const POLE_MIN_SINE = 0.25;
const _fallbackFwd = new THREE.Vector3(0, 0, 1);
const _fallbackUp = new THREE.Vector3(0, 1, 0);

/**
 * The two links a plain reach determines. The elbow search scores candidates
 * that carry nothing else, so this is what `solveReach` is allowed to want.
 */
export interface ReachLinks {
  upperArm: THREE.Vector3;
  lowerArm: THREE.Vector3;
}

/**
 * A solved arm, as the motion layer holds it.
 *
 * Allocated by the caller and filled in place — one set per gesture slot, so an
 * outgoing reach and an incoming one can both be live during a crossfade.
 */
export interface ArmSolution extends ReachLinks {
  hand: THREE.Vector3;
  palm: THREE.Vector3;
  /** Where the fingertip actually ended up, for a caller checking it arrived. */
  tip: THREE.Vector3;
  twist: number;
  /** Cost of the winning elbow, from a fingertip solve. */
  strain?: number;
  /** Last elbow angle a pole point resolved to, held across a frame where it cannot. */
  poleA?: number;
}

/**
 * The zero-angle elbow reference for a reach along `n`, written into `perp`.
 *
 * Built perpendicular rather than projected, for the reason set out in
 * `solveReach`, and shared with `poleAngle` so that converting a pole point
 * to an angle and solving with it agree on where zero is.
 */
export function reachRef(anat: ArmAnatomy, n: THREE.Vector3, perp: THREE.Vector3): THREE.Vector3 {
  const framed = anat.update();
  perp.copy(framed ? anat.fwd : _fallbackFwd);
  // Reaching straight forward is the one case where forward says nothing.
  // Up is perpendicular to it and cannot be degenerate at the same time.
  if (Math.abs(perp.dot(n)) > 0.87) {
    perp.copy(framed ? anat.up : _fallbackUp);
  }
  return perp.addScaledVector(n, -perp.dot(n)).normalize();
}

/**
 * Solve a two-link reach so the wrist lands on `targetWorld`.
 *
 * Returns world-space directions for the arm chain rather than posing the
 * bones, so the result flows through exactly the same blending path as an
 * authored gesture — a reach has to be able to crossfade with a wave.
 *
 * This exists because direction-authored gestures cannot touch anything. A
 * direction fixes where the elbow points, not where the hand ends up, and the
 * hand's position then depends on the avatar's arm length. Anything that has
 * to make contact with the face is a position, and has to be solved as one.
 *
 * `elbowAngle` resolves the one degree of freedom left once the wrist is
 * fixed: the elbow can sit anywhere on a circle around the shoulder-to-wrist
 * line, and the angle says where on that circle. Zero puts it straight in
 * front of the chest; positive swings it outward and up.
 */
export function solveReach(
  p: Profile,
  joints: JointTable,
  anat: ArmAnatomy,
  side: Side,
  targetWorld: THREE.Vector3,
  elbowAngle: number,
  out: ReachLinks,
): ReachLinks | null {
  const { bones, limb } = p;
  const upper = bones[`upperArm.${side}`];
  const La = limb?.[`upper.${side}`];
  const Lf = limb?.[`lower.${side}`];
  if (!(upper && La && Lf)) return null;

  upper.updateWorldMatrix(true, false);
  const S = upper.getWorldPosition(_reachS);
  const D = _reachD.copy(targetWorld).sub(S);
  let d = D.length();
  if (d < 1e-6) return null;

  // Clamp into the annulus the arm can actually reach. Held just inside the
  // bounds: a fully straight or fully folded arm makes the elbow direction
  // degenerate, and the joint flips as the target crosses the limit.
  //
  // The near bound is the elbow's own flexion limit, not `|La - Lf|`. The
  // geometric figure closes at 180 degrees of flexion, which is a forearm
  // folded flat against the upper arm and something no elbow does; the joint
  // stops at 150. The difference is not academic on a short-necked avatar,
  // where the face sits close to the shoulder: measured on the validation
  // model, eight of the eleven face-touching gestures asked for a wrist
  // nearer the shoulder than 150 degrees allows, the geometric clamp let
  // every one of them through, and the pose then came apart downstream when
  // the joint clamp had to take back what the solver had granted. Bounded
  // here, the hand instead stops short along the same bearing, which is what
  // an arm that cannot quite reach actually looks like.
  const flexMax = joints?.elbow?.dofs?.flexion?.max?.[1] ?? Math.PI;
  const fold = Math.cos(Math.PI - flexMax);
  const dMin = Math.max(
    Math.abs(La - Lf) + 1e-3,
    Math.sqrt(La * La + Lf * Lf - 2 * La * Lf * fold) * 1.001,
  );
  const dMax = (La + Lf) * 0.999;
  d = Math.min(dMax, Math.max(dMin, d));
  const n = _reachN.copy(D).normalize();

  // Elbow-out direction.
  //
  // This used to be authored as a vector and projected onto the plane normal
  // to the reach. That does not work, and it fails quietly. A hand travelling
  // to the face goes up and inward, so a pole written as "out and down" — the
  // obvious way to describe a hanging elbow — ends up nearly *anti*-parallel
  // to the reach. Subtracting the parallel part then removes more sideways
  // component than the pole had to begin with, and what is left points the
  // other way: on the validation avatar a pole of (-0.52, -0.86, 0.12) came
  // back as (+0.42, -0.68, 0.60), swinging the right elbow across the chest.
  // Nothing caught it, because the residue was still 0.43 long — a guard on
  // the residue's length only catches the exactly-parallel case, and this was
  // 156 degrees away.
  //
  // So the direction is built perpendicular instead of projected. Forward is
  // the reference because it is close to perpendicular to every path a hand
  // takes to the face, and because in front of the chest is where an elbow
  // belongs when the arm is folded up. The angle then swings it around the
  // reach line from there, and can never be degenerate.
  const perp = reachRef(anat, n, _reachP);
  if (elbowAngle) perp.applyAxisAngle(n, elbowAngle);

  // Angle between the reach line and the upper arm.
  const cosA = (La * La + d * d - Lf * Lf) / (2 * La * d);
  const A = Math.acos(Math.min(1, Math.max(-1, cosA)));

  out.upperArm.copy(n).multiplyScalar(Math.cos(A)).addScaledVector(perp, Math.sin(A)).normalize();

  // Elbow, then the forearm direction that closes onto the target.
  //
  // Onto the *clamped* target — the point at `d` along the bearing — and not
  // onto the one that was asked for. Where nothing was clamped the two are the
  // same point and this is exactly the old arithmetic; where the target sat
  // inside the elbow's flexion stop, aiming at the raw request folded the joint
  // straight back past the bound the clamp above had just established. The upper
  // arm stopped short and the forearm did not, which is not "an arm that cannot
  // quite reach" but an elbow bent the wrong way, and it left the joint clamp
  // downstream taking back what the solver had granted.
  const reached = _reachT.copy(S).addScaledVector(n, d);
  const E = _reachE.copy(S).addScaledVector(out.upperArm, La);
  out.lowerArm.copy(reached).sub(E);
  if (out.lowerArm.lengthSq() < 1e-10) out.lowerArm.copy(out.upperArm);
  else out.lowerArm.normalize();
  return out;
}

/**
 * Where on the elbow circle a pole *point* puts the elbow, in radians.
 *
 * This is the conversion that lets a gesture name a position instead of an
 * angle, which is what every animation package asks for — Unity's hint
 * transform, Unreal's joint target location. It matters because the angle is
 * measured about the shoulder-to-wrist line, and that line swings through the
 * best part of a right angle between a hand at the hip and a hand at the
 * mouth. A constant angle is therefore only meaningful at the one pose it was
 * measured on, and describes a wild arc on the way there; a point fixed
 * beside the ribs holds still, so the elbow moves continuously with the hand.
 *
 * Returns null when the pole sits on the reach line, where it says nothing.
 * A point out beside the body cannot reach that state while the hand is in
 * front of the face — unlike a pole *direction* anchored at the shoulder,
 * which goes anti-parallel exactly when the arm folds up, and which is why
 * the first attempt at this was abandoned for an angle.
 */
export function poleAngle(
  p: Profile,
  anat: ArmAnatomy,
  side: Side,
  targetWorld: THREE.Vector3,
  poleWorld: THREE.Vector3,
): number | null {
  const upper = p.bones?.[`upperArm.${side}`];
  if (!upper) return null;
  upper.updateWorldMatrix(true, false);
  const S = upper.getWorldPosition(_poleS);
  const n = _poleN.copy(targetWorld).sub(S);
  if (n.lengthSq() < 1e-10) return null;
  n.normalize();
  const w = _poleW.copy(poleWorld).sub(S);
  const len = w.length();
  if (len < 1e-6) return null;
  w.addScaledVector(n, -w.dot(n));
  // The residue as a fraction of the offset is the sine of the angle between
  // the pole and the reach, so this rejects near-parallel as well as parallel.
  // A bare length test does not: the residue of a long, almost-collinear
  // offset is still long, and the direction it points is noise. That is the
  // hole the earlier pole-as-vector attempt fell through.
  if (w.length() / len < POLE_MIN_SINE) return null;
  w.normalize();
  const ref = reachRef(anat, n, _poleR);
  const bi = _poleB.copy(n).cross(ref);
  return Math.atan2(w.dot(bi), w.dot(ref));
}
