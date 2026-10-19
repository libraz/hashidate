import * as THREE from 'three';
import type { ArmSolution, Rig } from '../rig';
import type { ArmSlot, FingerName, Pose, Profile, Side, Vec3Tuple } from '../types';
import type { ReachAnchors } from './anchors';
import { type ClaspLeader, type ClaspPlacement, claspMeasure, placeFollower } from './clasp';
import type { CharacterFrame } from './frame';
import { BASE_PALM } from './gestures';
import { EXTEND_ONSET, minJerk, onset } from './timing';

/**
 * What one arm of a gesture pose actually asks for, in the frame the blend
 * path works in.
 *
 * Three forms arrive here and one comes out. A pose may state its arm as
 * authored directions, as a `reach` that has to make contact with a place on
 * the body, or as a `point` back-solved from a fingertip bearing — and the
 * blend path downstream must not be able to tell them apart, because that is
 * what lets a point crossfade with a wave.
 *
 * The departure state lives here too. A reach carries the wrist through the
 * room rather than through joint space, so it needs to know where the hand was
 * standing when the gesture started: `mark` records it, and the travel is a
 * property of resolving the target rather than of blending the result.
 */

/**
 * One arm as the blend path sees it: authored directions, a solved reach, or a
 * back-solved point. All three are optional per link, and the palm and the
 * twist are stated by some poses and derived for the rest.
 */
export interface ResolvedArm {
  shoulder?: THREE.Vector3;
  upperArm?: THREE.Vector3;
  lowerArm?: THREE.Vector3;
  hand?: THREE.Vector3;
  palm?: THREE.Vector3;
  twist?: number;
}

/**
 * The fingertip request as the solver reads it.
 *
 * `PointSpec` states its directions as authored tuples; this carries the shared
 * scratch vectors after character-to-world projection, which is what keeps a
 * solve that runs up to four times a frame from allocating.
 */
interface PointSolveSpec {
  azimuth: number;
  elevation: number;
  extent: number;
  finger: FingerName;
  /** World-space scratch vectors handed to Rig.solvePoint. */
  point: THREE.Vector3 | null;
  palm: THREE.Vector3 | null;
}

/**
 * Fill in the palm direction for a *solved* arm, in place.
 *
 * Aiming a hand fixes where the fingers point and leaves the roll about that
 * axis free, so a pose that states no palm gets whatever the shortest rotation
 * happens to produce — which is nothing anybody chose. For an authored pose
 * that is tolerable: the directions were tuned by eye against exactly that
 * behaviour. For a solved one there is nothing to have tuned.
 *
 * Rolling the palm to face the way the wrist has to bend makes that bend
 * flexion instead of deviation, and a wrist has three times more flexion than
 * deviation. Without it a solved hand reaching upward came out with 61 degrees
 * of radial deviation against a limit of 20.
 */
function derivePalm(out: ArmSolution): void {
  const p = out.palm.copy(out.hand).addScaledVector(out.lowerArm, -out.hand.dot(out.lowerArm));
  // A straight wrist bends in no direction, so nothing is determined. Fall back
  // to the resting palm rather than to noise.
  if (p.lengthSq() < 4e-4) p.copy(BASE_PALM);
  p.normalize();
}
/**
 * Resolved IK output for one gesture slot, both sides. Each slot owns one, so
 * an outgoing reach and an incoming one can both be live during a crossfade
 * and neither drags the other's elbow.
 */
export function mkReachScratch(): Record<Side, ArmSolution> {
  const mk = (): ArmSolution => ({
    upperArm: new THREE.Vector3(),
    lowerArm: new THREE.Vector3(),
    hand: new THREE.Vector3(),
    palm: new THREE.Vector3(),
    tip: new THREE.Vector3(),
    twist: 0,
  });
  return { L: mk(), R: mk() };
}

/** Where one arm stood: its three link directions, in character space. */
interface ArmStance {
  known: boolean;
  upperArm: THREE.Vector3;
  lowerArm: THREE.Vector3;
  hand: THREE.Vector3;
}

const mkStance = (): ArmStance => ({
  known: false,
  upperArm: new THREE.Vector3(),
  lowerArm: new THREE.Vector3(),
  hand: new THREE.Vector3(),
});

export class ArmResolver {
  /** Joint strain from the last fingertip solve, per arm. */
  readonly pointStrain: Record<Side, number> = { L: 0, R: 0 };

  /**
   * Where each wrist was standing when the current gesture started, and whether
   * that is known for this side.
   *
   * A reach interpolates its target from here, so the hand crosses the room in
   * a straight line instead of along whatever arc four independently blended
   * link directions happen to trace. Captured once at the switch rather than
   * tracked, because the departure point of a movement does not move.
   */
  private readonly _wristFrom: Record<Side, THREE.Vector3> = {
    L: new THREE.Vector3(),
    R: new THREE.Vector3(),
  };
  private readonly _wristKnown: Record<Side, boolean> = { L: false, R: false };
  /** Whether the current gesture is carrying this side's hand through the room. */
  private readonly _travelling: Record<Side, boolean> = { L: false, R: false };

  // Request object handed to the fingertip solver, reused rather than rebuilt
  // — `resolve` runs up to four times a frame.
  private readonly _point: PointSolveSpec = {
    azimuth: 0,
    elevation: 0,
    extent: 0.8,
    finger: 'index',
    point: null,
    palm: null,
  };
  private readonly _pointDir = new THREE.Vector3();
  private readonly _pointPalm = new THREE.Vector3();

  /** Where each arm was last posed, refreshed by `note` every frame. */
  private readonly _seen: Record<Side, ArmStance> = { L: mkStance(), R: mkStance() };
  /** The same, frozen on the frame the current gesture's exit began. */
  private readonly _exitFrom: Record<Side, ArmStance> = { L: mkStance(), R: mkStance() };
  /** The retreat's output, apart from any gesture slot's. */
  private readonly _retreatArm: Record<Side, ResolvedArm> = { L: {}, R: {} };
  private readonly _retreatDirs: Record<
    Side,
    Record<'upperArm' | 'lowerArm' | 'hand', THREE.Vector3>
  > = {
    L: { upperArm: new THREE.Vector3(), lowerArm: new THREE.Vector3(), hand: new THREE.Vector3() },
    R: { upperArm: new THREE.Vector3(), lowerArm: new THREE.Vector3(), hand: new THREE.Vector3() },
  };
  private readonly _swing = new THREE.Quaternion();
  private readonly _swingE = new THREE.Quaternion();
  private readonly _swingR = new THREE.Quaternion();
  private readonly _bendFrom = new THREE.Vector3();
  private readonly _bendRest = new THREE.Vector3();
  private readonly _bendX = new THREE.Vector3();

  /** The leader's posed hand, and where the follower goes against it. */
  private readonly _claspLeader: ClaspLeader = {
    wrist: new THREE.Vector3(),
    index: new THREE.Vector3(),
    middle: new THREE.Vector3(),
    ring: new THREE.Vector3(),
    little: new THREE.Vector3(),
    palm: new THREE.Vector3(),
  };
  private readonly _claspPlace: ClaspPlacement = {
    wrist: new THREE.Vector3(),
    hand: new THREE.Vector3(),
    palm: new THREE.Vector3(),
  };
  private readonly _claspQ = new THREE.Quaternion();
  /** Whether the current gesture's follower holds its last solve instead of tracking the leader. */
  private _claspFrozen = false;

  constructor(
    private readonly p: Profile,
    private readonly rig: Rig,
    private readonly axes: CharacterFrame,
    private readonly anchors: ReachAnchors,
  ) {}

  /**
   * Record where an arm has just been sent: the departure point for an exit
   * that starts before the next frame does. The follower's output rather than
   * the posed bones, so the first frame of the exit asks for exactly what the
   * follower already holds and nothing steps.
   */
  note(side: Side, upperArm: Vec3Tuple, lowerArm: Vec3Tuple, hand: Vec3Tuple): void {
    const seen = this._seen[side];
    seen.upperArm.fromArray(upperArm);
    seen.lowerArm.fromArray(lowerArm);
    seen.hand.fromArray(hand);
    seen.known = true;
  }

  /** Freeze the last noted stance of both arms as where the exit leaves from. */
  beginExit(): void {
    for (const side of ['L', 'R'] as const) {
      const from = this._exitFrom[side];
      const seen = this._seen[side];
      from.known = seen.known;
      from.upperArm.copy(seen.upperArm);
      from.lowerArm.copy(seen.lowerArm);
      from.hand.copy(seen.hand);
    }
  }

  /**
   * The arm on its way back to rest, `u` of the way through the exit, or null
   * when no departure stance was noted and the blend should take it.
   *
   * Taken in joint terms rather than as four link directions eased back
   * independently: those unfold a raised forearm first and swing the straight
   * arm in from the side. Here the upper arm swings home, the elbow keeps its
   * fold and opens late — see `EXTEND_ONSET` — and the direction it bends in
   * turns about the upper arm to the resting one along the shorter way.
   *
   * Solving the wrist home along an arc about the shoulder instead swung the
   * hand out past the side, and the elbow it needed there left the upper arm
   * behind the body with the folded forearm pointing outward: a humerus turned
   * out a quarter turn, which reads as an elbow bent the wrong way. Turning the
   * bend directly brings the forearm down in front, as a lowered hand does.
   */
  retreat(
    resolved: ResolvedArm | null,
    side: Side,
    u: number,
    rest: Record<ArmSlot, THREE.Vector3>,
  ): ResolvedArm | null {
    const from = this._exitFrom[side];
    if (!from.known) return null;

    const e = minJerk(u);
    const out = this._retreatDirs[side];

    // The upper arm along the shortest swing, and both bends carried with it.
    const swing = this._swing.setFromUnitVectors(from.upperArm, rest.upperArm);
    const swingE = this._swingE.identity().slerp(swing, e);
    const U = out.upperArm.copy(from.upperArm).applyQuaternion(swingE);
    const bendFrom = this.bendOf(this._bendFrom, from.upperArm, from.lowerArm);
    const bendRest = this.bendOf(this._bendRest, rest.upperArm, rest.lowerArm);
    if (bendFrom && bendRest) {
      bendFrom.applyQuaternion(swingE);
      // From the resting upper arm to the current one: swingE · swing⁻¹.
      bendRest.applyQuaternion(this._swingR.copy(swing).invert().premultiply(swingE));
    }
    const bend = bendFrom ?? bendRest;

    const foldFrom = from.upperArm.angleTo(from.lowerArm);
    const foldRest = rest.upperArm.angleTo(rest.lowerArm);
    const fold = foldFrom + (foldRest - foldFrom) * minJerk(onset(u, EXTEND_ONSET));

    if (bend) {
      if (bendFrom && bendRest) {
        const x = this._bendX.crossVectors(bendFrom, bendRest);
        bend.applyAxisAngle(U, Math.atan2(x.dot(U), bendFrom.dot(bendRest)) * e);
      }
      bend.addScaledVector(U, -bend.dot(U)).normalize();
      out.lowerArm.copy(U).multiplyScalar(Math.cos(fold)).addScaledVector(bend, Math.sin(fold));
    } else {
      out.lowerArm.copy(U);
    }
    out.lowerArm.normalize();

    const arm = this._retreatArm[side];
    arm.upperArm = U;
    arm.lowerArm = out.lowerArm;
    // The wrist's bend relative to the forearm eases home; the hand never
    // points where the forearm no longer is.
    arm.hand = out.hand
      .copy(from.hand)
      .sub(from.lowerArm)
      .multiplyScalar(1 - e)
      .addScaledVector(rest.hand, e)
      .addScaledVector(rest.lowerArm, -e)
      .add(out.lowerArm)
      .normalize();
    arm.palm = resolved?.palm;
    arm.twist = resolved?.twist;
    return arm;
  }

  /** The direction a forearm bends off its upper arm, or null for a straight arm. */
  private bendOf(
    out: THREE.Vector3,
    upper: THREE.Vector3,
    lower: THREE.Vector3,
  ): THREE.Vector3 | null {
    out.copy(lower).addScaledVector(upper, -lower.dot(upper));
    return out.lengthSq() < 1e-8 ? null : out.normalize();
  }

  /** Hold (or release) every clasp follower at its last solve; set while the gesture exits. */
  freezeClasp(on: boolean): void {
    this._claspFrozen = on;
  }

  /**
   * Place the follower of a clasp against the leader's posed hand, writing the
   * slot's solver output. False leaves the reach path to take the side.
   */
  private resolveClasp(
    pose: Pose,
    side: Side,
    reach: Record<Side, ArmSolution>,
    handEntrance: number,
    timed: boolean,
    frameReady?: boolean,
  ): ResolvedArm | null {
    const c = pose.clasp;
    if (!c || side === c.lead) return null;
    const out = reach[side];
    if (!timed || this._claspFrozen) return out.clasp ? out : null;

    const lead = c.lead;
    const measure = claspMeasure(this.p.limb, lead);
    const palmLocal = this.rig.palmLocal[lead];
    const hand = this.p.bones[`hand.${lead}`];
    const chains = this.p.fingerBones;
    const index = chains[`index.${lead}`]?.[0];
    const middle = chains[`middle.${lead}`]?.[0];
    const ring = chains[`ring.${lead}`]?.[0];
    const little = chains[`little.${lead}`]?.[0];
    if (!(measure && palmLocal && hand && index && middle && ring && little)) return null;

    const l = this._claspLeader;
    hand.updateWorldMatrix(true, false);
    hand.getWorldPosition(l.wrist);
    l.palm.copy(palmLocal).applyQuaternion(hand.getWorldQuaternion(this._claspQ)).normalize();
    index.updateWorldMatrix(true, false);
    index.getWorldPosition(l.index);
    middle.updateWorldMatrix(true, false);
    middle.getWorldPosition(l.middle);
    ring.updateWorldMatrix(true, false);
    ring.getWorldPosition(l.ring);
    little.updateWorldMatrix(true, false);
    little.getWorldPosition(l.little);
    const f = this._claspPlace;
    if (!placeFollower(l, measure, c.dihedral, f)) return null;

    if (handEntrance < 1 && this._wristKnown[side]) {
      this.anchors.travel(f.wrist, this._wristFrom[side], side, handEntrance);
    }
    if (this._wristKnown[side]) this._travelling[side] = true;
    if (!this.rig.solveReachNatural(side, f.wrist, f.hand, out)) return null;
    this.axes.toCharacter(out.upperArm, out.upperArm, side, frameReady);
    this.axes.toCharacter(out.lowerArm, out.lowerArm, side, frameReady);
    this.axes.toCharacter(out.hand, f.hand, side, frameReady);
    this.axes.toCharacter(out.palm, f.palm, side, frameReady);
    out.twist = pose.reach?.[side]?.twist ?? 0;
    out.clasp = true;
    return out;
  }

  /** Whether a travelling reach is deciding where this side's hand goes. */
  travelling(side: Side): boolean {
    return this._travelling[side];
  }

  /** Clear the travel flag for a frame that has not resolved yet. */
  clearTravelling(side: Side): void {
    this._travelling[side] = false;
  }

  /**
   * Note where both wrists are standing, as the departure point for any reach
   * the gesture about to start carries.
   *
   * Read off the posed bones rather than reconstructed from the blend state:
   * what a movement leaves from is where the hand *is*, including everything
   * the clamp and the secondary layers did to it, and not where the layer
   * believes it asked for it to be.
   */
  mark(): void {
    for (const side of ['L', 'R'] as const) {
      const hand = this.p.bones[`hand.${side}`];
      this._travelling[side] = false;
      if (!hand) {
        this._wristKnown[side] = false;
        continue;
      }
      hand.updateWorldMatrix(true, false);
      hand.getWorldPosition(this._wristFrom[side]);
      this._wristKnown[side] = true;
    }
  }

  /**
   * The arm spec for one side of a gesture pose: authored directions, the
   * solved result of a `reach`, or the back-solved result of a `point`. All
   * three come back in character space, so the blend path downstream cannot
   * tell them apart — which is what lets a point crossfade with a wave.
   *
   * `reach` is the calling slot's own solver output and elbow state; see
   * `mkReachScratch`.
   */
  resolve(
    pose: Pose | null,
    side: Side,
    mirror: number,
    reach: Record<Side, ArmSolution>,
    handEntrance: number,
    timed = false,
    frameReady?: boolean,
  ): ResolvedArm | null {
    const pt = pose?.point?.[side];
    if (pt) {
      const out = reach[side];
      // Azimuth is a bearing in the body's own frame, where positive is the
      // character's right for both arms. A gesture wants it mirrored — "point
      // outward" should work on either hand — and an external caller naming an
      // absolute direction does not, so the spec says which it meant.
      const spec = this._point;
      spec.azimuth = (pt.azimuth ?? 0) * (pt.mirror === false ? 1 : mirror);
      spec.elevation = pt.elevation ?? 0;
      spec.extent = pt.extent ?? 0.8;
      spec.finger = pt.finger ?? 'index';
      // These tuples are authored in the character frame too. An absolute
      // point bearing and its palm keep their lateral sign for either arm;
      // otherwise both mirror because the pose is relative to the hand's side.
      spec.point = pt.point
        ? this.axes.toWorld(
            this._pointDir,
            pt.point,
            side,
            pt.mirror === false ? 1 : mirror,
            frameReady,
          )
        : null;
      spec.palm = pt.palm
        ? this.axes.toWorld(
            this._pointPalm,
            pt.palm,
            side,
            pt.mirror === false ? 1 : mirror,
            frameReady,
          )
        : null;
      if (!this.rig.solvePoint(side, spec, out)) return pose?.arms?.[side] ?? null;
      // How hard the resulting pose was on the joints, kept so a caller can
      // tell an aim that was met from one the arm could only approximate.
      // Reaching for something out of range does not fail — the arm goes as far
      // as it can, which is what a person does — so without this the answer to
      // "did it work" is a screenshot.
      this.pointStrain[side] = out.strain ?? 0;
      // The solver reports world directions. Keep the follower/blend state in
      // canonical character space until the final Rig call below.
      this.axes.toCharacter(out.upperArm, out.upperArm, side, frameReady);
      this.axes.toCharacter(out.lowerArm, out.lowerArm, side, frameReady);
      this.axes.toCharacter(out.hand, out.hand, side, frameReady);
      this.axes.toCharacter(out.palm, out.palm, side, frameReady);
      out.twist = pt.twist ?? 0;
      return out;
    }

    if (pose?.clasp) {
      const arm = this.resolveClasp(pose, side, reach, handEntrance, timed, frameReady);
      if (arm) return arm;
    }

    const r = pose?.reach?.[side];
    if (!r) return pose?.arms?.[side] ?? null;

    // Either frame can be unavailable on a rig the profile could not fully
    // resolve, and a gesture that cannot be solved falls back to whatever
    // directions it also carries rather than dropping the arm.
    //
    // The anchor is where the *hand* meets the body and the wrist belongs
    // behind it, which `reachTarget` accounts for. Putting the wrist on the
    // anchor is what the first version did, and it buries the whole hand: the
    // anchor sits on the skin, so the palm and fingers continue on into it.
    // Every one of the face-touching gestures came out with the hand inside the
    // head, and no choice of elbow could fix it — sampling the whole elbow
    // circle for a hand held beside the temple, the *shallowest* candidate was
    // still 28% inside. The elbow has no authority over where the wrist is.
    const target = this.anchors.target(r, side, frameReady);
    if (!target) return pose?.arms?.[side] ?? null;

    // Carry the wrist through the room rather than through joint space.
    //
    // Solving at the final anchor every frame and blending the four link
    // directions toward the answer is what this did before, and it leaves the
    // hand's path in the room as a by-product: four unit vectors each turning
    // at its own rate trace a path nobody chose, and the hand wanders on its
    // way. People do the opposite — the hand goes where it is going and the
    // joint angles are whatever that requires.
    //
    // So the *target* interpolates and the solver runs on the interpolated
    // point. Departure is where the wrist actually was when the gesture
    // started, so this composes with whatever the arm was doing rather than
    // starting from a rest pose it may be nowhere near.
    //
    // On the entrance only. The way back to rest is `retreat`'s, which every
    // kind of pose takes.
    if (timed && this._wristKnown[side]) {
      const e = handEntrance;
      if (e < 1) this.anchors.travel(target, this._wristFrom[side], side, e);
      this._travelling[side] = true;
    }

    const out = reach[side];
    out.clasp = false;
    const hint = r.hand
      ? this.axes.toWorld(this._pointDir, r.hand, side, mirror, frameReady)
      : null;

    // A pole point is the preferred way to state the elbow, and the only one
    // that stays meaningful while the hand is travelling. `elbow` remains for a
    // pose that wants the raw angle, and a pose that states neither falls back
    // to searching the circle for the least strained place to put it.
    const poleW = r.pole ? this.anchors.pole(r.pole, side) : null;
    const poleA = poleW ? this.rig.poleAngle(side, target, poleW) : null;
    let solved = false;
    if (poleA !== null) {
      out.poleA = poleA;
      solved = !!this.rig.solveReach(side, target, poleA, out);
    } else if (r.pole && out.poleA !== undefined) {
      // The pole crossed the reach line, where it says nothing about the elbow.
      // Holding the last angle rides through; recomputing from the noise, or
      // dropping to a different rule for a frame, both show as a snap. The slot
      // is reused by successive gestures, so this can be a stale angle on the
      // first frame of a new one — a frame of the wrong elbow, and not a jump.
      solved = !!this.rig.solveReach(side, target, out.poleA, out);
    } else if (r.elbow !== undefined) {
      // Authored in character terms, so the two arms mirror. A rotation about a
      // mirrored axis runs the other way; this is axial, not the lateral sign
      // used to project point bearings and directions.
      solved = !!this.rig.solveReach(
        side,
        target,
        r.elbow * this.axes.axialMirror(side, frameReady),
        out,
      );
    } else {
      solved = !!this.rig.solveReachNatural(side, target, hint, out);
    }
    if (!solved) return pose?.arms?.[side] ?? null;

    // Back to character space before blending. The solver's world result is
    // never allowed to become the follower's state, so a root turn cannot
    // masquerade as a gesture change.
    this.axes.toCharacter(out.upperArm, out.upperArm, side, frameReady);
    this.axes.toCharacter(out.lowerArm, out.lowerArm, side, frameReady);
    if (r.hand) out.hand.set(r.hand[0], r.hand[1], r.hand[2]).normalize();
    else out.hand.copy(out.lowerArm);
    if (r.palm) out.palm.set(r.palm[0], r.palm[1], r.palm[2]).normalize();
    else derivePalm(out);
    out.twist = r.twist ?? 0;
    return out;
  }
}
