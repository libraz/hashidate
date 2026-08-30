import * as THREE from 'three';
import type { ArmSolution, Rig } from '../rig';
import type { FingerName, Pose, Profile, Side } from '../types';
import type { ReachAnchors } from './anchors';
import type { CharacterFrame } from './frame';
import { BASE_PALM } from './gestures';

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
interface ResolvedArm {
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

  // Resolved IK output, one set per gesture slot so an outgoing reach and an
  // incoming one can both be live during a crossfade.
  private readonly _reach: { cur: Record<Side, ArmSolution>; prev: Record<Side, ArmSolution> };

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

  constructor(
    private readonly p: Profile,
    private readonly rig: Rig,
    private readonly axes: CharacterFrame,
    private readonly anchors: ReachAnchors,
  ) {
    const mkReach = (): ArmSolution => ({
      upperArm: new THREE.Vector3(),
      lowerArm: new THREE.Vector3(),
      hand: new THREE.Vector3(),
      palm: new THREE.Vector3(),
      tip: new THREE.Vector3(),
      twist: 0,
    });
    this._reach = {
      cur: { L: mkReach(), R: mkReach() },
      prev: { L: mkReach(), R: mkReach() },
    };
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
   */
  resolve(
    pose: Pose | null,
    side: Side,
    mirror: number,
    slotName: 'cur' | 'prev',
    handEntrance: number,
    timed = false,
    frameReady?: boolean,
  ): ResolvedArm | null {
    const pt = pose?.point?.[side];
    if (pt) {
      const out = this._reach[slotName][side];
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
    // On the entrance only. Coming off a pose the arm blends back the old way,
    // because a retreat has nowhere in particular to be and the release ramp
    // already governs it.
    if (timed && this._wristKnown[side]) {
      const e = handEntrance;
      if (e < 1) this.anchors.travel(target, this._wristFrom[side], side, e);
      this._travelling[side] = true;
    }

    const out = this._reach[slotName][side];
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
