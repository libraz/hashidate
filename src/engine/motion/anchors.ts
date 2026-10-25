import * as THREE from 'three';
import { HAND_CONTACT } from '../anatomy';
import { BODY_ANCHORS, FACE_ANCHORS } from '../profile';
import { handFrame, type Rig } from '../rig';
import type { FingerSpec, Profile, ReachSpec, Side, Vec3Tuple } from '../types';
import { slerpDir } from './follow';
import { type CharacterFrame, sideMirror } from './frame';

export interface HandControls {
  readonly curls: FingerSpec;
  readonly spread: FingerSpec;
}

/** Halvings that settle how far a target slides out of the face, below a finger's half-thickness. */
const CLEAR_REFINE = 3;
/** Points a travel's arc is checked at for passing through the body. */
const TRAVEL_SAMPLES = 8;

/**
 * Where a reach is going, in world space.
 *
 * A gesture that touches the body states a *place* rather than a set of
 * directions, because a direction fixes where the elbow points and leaves where
 * the hand ends up to the avatar's arm length. Turning that place into a world
 * position is what this module does — for the face, for the trunk, for the pole
 * the elbow is drawn toward, and for the point on the way there that the hand
 * has reached so far.
 *
 * Every anchor is resolved against a frame that is refreshed each frame, so a
 * held pose survives the character leaning: the hands stay clasped in front of
 * the chest instead of being left behind by it.
 */
export class ReachAnchors {
  private readonly _anchor = new THREE.Vector3();
  // Separate from `_anchor`, which is still holding the reach target when the
  // pole is built.
  private readonly _pole = new THREE.Vector3();
  private readonly _hand = new THREE.Vector3();
  private readonly _clearX = new THREE.Vector3();
  private readonly _clearY = new THREE.Vector3();
  private readonly _clearP = new THREE.Vector3();
  private readonly _clearM = new THREE.Vector3();
  private readonly _clearN = new THREE.Vector3();
  // Head-world forward while `face()` returned the measured mouth, else null.
  private _anchorOutward: THREE.Vector3 | null = null;
  private readonly _outward = new THREE.Vector3();
  private readonly _clearF = new THREE.Matrix3();
  private readonly _contactRotation = new THREE.Matrix3();
  private readonly _contactBind = new THREE.Matrix3();
  private readonly _reachedFrame = new THREE.Matrix3();
  private readonly _clearAt = new THREE.Vector3();
  private readonly _travelS = new THREE.Vector3();
  private readonly _travelA = new THREE.Vector3();
  private readonly _travelB = new THREE.Vector3();
  private readonly _travelM = new THREE.Vector3();
  private readonly _travelL = new THREE.Vector3();
  private readonly _travelP = new THREE.Vector3();
  private readonly _travelQ = new THREE.Vector3();
  private readonly _travelV = new THREE.Vector3();
  private readonly _travelW = new THREE.Vector3();

  constructor(
    private readonly p: Profile,
    private readonly rig: Rig,
    private readonly axes: CharacterFrame,
  ) {}

  /**
   * World position of a face anchor, for gestures that touch the face.
   * `side` picks which cheek/ear/temple, so one definition serves both hands.
   */
  face(name: string, offset: Vec3Tuple | undefined, side: Side): THREE.Vector3 | null {
    const { face, bones } = this.p;
    const head = bones.head;
    if (!(face && head)) return null;
    const id = Object.hasOwn(FACE_ANCHORS, name) ? name : 'mouth';
    // The measured mouth is already on the skin; only the offset is in IPD.
    const measured = id === 'mouth' ? face.mouth : null;
    const a = measured ? [0, 0, 0] : FACE_ANCHORS[id];
    const o = offset ?? [0, 0, 0];
    const s = side === 'R' ? 1 : -1;
    const v = this._anchor.copy(measured ?? face.origin);
    v.addScaledVector(face.right, (a[0] + o[0]) * s * face.ipd);
    v.addScaledVector(face.up, (a[1] + o[1]) * face.ipd);
    v.addScaledVector(face.forward, (a[2] + o[2]) * face.ipd);
    head.updateWorldMatrix(true, false);
    this._anchorOutward = measured
      ? this._outward.copy(face.forward).transformDirection(head.matrixWorld)
      : null;
    return v.applyMatrix4(head.matrixWorld);
  }

  /**
   * World position of a body anchor, for gestures whose hands meet each other.
   *
   * No matrix to apply, unlike the face: `anatomy/arm.ts` already keeps the body
   * frame in world space and refreshes it once a frame, because every joint
   * limit is measured against it. Anchoring to the chest rather than the hips
   * is what makes a held pose survive the character leaning — the hands stay
   * clasped in front of the chest instead of being left behind by it.
   *
   * `side` mirrors the lateral component the same way the face anchors do, so
   * one spec puts both hands symmetrically either side of the midline.
   */
  body(name: string, offset: Vec3Tuple | undefined, side: Side): THREE.Vector3 | null {
    const span = this.p.body?.span;
    const anat = this.rig.anat;
    if (!(span && anat?.update())) return null;
    const a = BODY_ANCHORS[name] ?? BODY_ANCHORS.sternum;
    const o = offset ?? [0, 0, 0];
    const s = side === 'R' ? 1 : -1;
    return this._anchor
      .copy(anat.axisO)
      .addScaledVector(anat.right, (a[0] + o[0]) * s * span)
      .addScaledVector(anat.up, (a[1] + o[1]) * span)
      .addScaledVector(anat.fwd, (a[2] + o[2]) * span);
  }

  /**
   * World position of a gesture's elbow pole, offset from the shoulder in body
   * spans and character space, so the two arms mirror.
   *
   * Anchored on the shoulder rather than the chest because that is what makes
   * the numbers say something an author can picture: an elbow hanging beside
   * the ribs is roughly one upper arm below the shoulder whatever the pose is
   * doing, whereas the same place named from the sternum moves as the character
   * leans. See `poleAngle` in the rig for why this is a point and not an angle.
   */
  pole(pole: Vec3Tuple, side: Side): THREE.Vector3 | null {
    const span = this.p.body?.span;
    const upper = this.p.bones?.[`upperArm.${side}`];
    const anat = this.rig.anat;
    if (!(span && upper && anat?.update())) return null;
    const s = side === 'R' ? 1 : -1;
    upper.updateWorldMatrix(true, false);
    return upper
      .getWorldPosition(this._pole)
      .addScaledVector(anat.right, (pole[0] ?? 0) * s * span)
      .addScaledVector(anat.up, (pole[1] ?? 0) * span)
      .addScaledVector(anat.fwd, (pole[2] ?? 0) * span);
  }

  /**
   * Where a reach wants the wrist, in world space, or null if this rig cannot
   * resolve the frame it is anchored to.
   *
   * Shared with `resolveArm` because the girdle has to know the target before
   * the shoulder is posed, and the shoulder has to be posed before the arm can
   * be solved from it. Nothing here depends on the arm, so the order works out.
   */
  target(
    r: ReachSpec | undefined,
    side: Side,
    frameReady?: boolean,
    controls?: HandControls,
  ): THREE.Vector3 | null {
    if (!r) return null;
    this._anchorOutward = null;
    const target =
      r.space === 'body'
        ? this.body(r.at, r.offset, side)
        : this.p.face && this.p.bones.head
          ? this.face(r.at, r.offset, side)
          : null;
    if (!target) return null;
    if (
      r.contact &&
      controls &&
      r.hand?.length === 3 &&
      r.palm?.length === 3 &&
      r.hand.every(Number.isFinite) &&
      r.palm.every(Number.isFinite)
    ) {
      const requested = handFrame(
        this.axes.toWorld(this._clearX, r.hand, side, sideMirror(side), frameReady),
        this.axes.toWorld(this._clearY, r.palm, side, sideMirror(side), frameReady),
        this._contactRotation,
      );
      const prediction = requested
        ? this.rig.predictHandContact(side, r.contact, controls.curls, controls.spread)
        : null;
      if (prediction && requested) {
        const anchor = this._clearAt.copy(target);
        requested.multiply(this._contactBind.copy(prediction.bindFrame).transpose());
        target.sub(this._hand.copy(prediction.contact).applyMatrix3(requested));
        if (r.space !== 'body')
          this.clearFace(
            target,
            anchor,
            r.hand,
            r.palm,
            side,
            frameReady,
            prediction.shape,
            requested,
          );
        return target;
      }
    }
    if (r.hand && r.space !== 'body') {
      const anchor = this._clearAt.copy(target);
      const back = (this.p.limb?.[`tip.${side}.middle`] ?? 0) * HAND_CONTACT;
      if (back > 0) {
        target.addScaledVector(
          this.axes.toWorld(this._hand, r.hand, side, sideMirror(side), frameReady),
          -back,
        );
      }
      if (r.palm) this.clearFace(target, anchor, r.hand, r.palm, side, frameReady);
    }
    return target;
  }

  /**
   * Move this frame's wrist target out until the hand as last posed, placed
   * there, is off the face. In place; after `target`, whose anchor it reuses.
   *
   * `target` clears the stated hand, which a pose past the forearm's roll
   * range never reaches. The arm arrives with the hand it can have, and on the
   * way in its fingers ran into the cheek at speed and stopped the arm dead
   * there: a cuteSalute entrance peaked at 58 m/s². Clearing the request with
   * the reached hand as well, on the way in and at the hold, brought it to 15.
   */
  clearReached(target: THREE.Vector3, r: ReachSpec, side: Side, frameReady?: boolean): void {
    if (!(r.hand && r.palm && r.space !== 'body')) return;
    this.clearFace(
      target,
      this._clearAt,
      r.hand,
      r.palm,
      side,
      frameReady,
      undefined,
      this._reachedFrame.copy(this.rig.fingerFrame(side)),
    );
  }

  /**
   * Move a wrist target out until the fingers it brings are off the face. In
   * place.
   *
   * Out along the skin's normal at the anchor, or along the head's forward when
   * the anchor is the measured mouth: its lip leans downward, and sliding along
   * that would lower the hand onto the chin.
   *
   * The back-off above puts the palm's contact point on the anchor and says
   * nothing about the fingers past it, which go where the hand points, as far
   * as this avatar's fingers are long: on a face small against its hands, a
   * finger pointed up at the cheek ran on into it, and a turn of the hand could
   * not bring it out. So the hand is placed as the pose orients it, holding the
   * shape it was last given, and slid out along the skin's normal at the
   * anchor until every finger clears. Out along that one direction and not the
   * skin's under each finger: a fingertip a centimetre into the face is nearest
   * the inside of the mouth or the far wall of a cheek, and stepping the way
   * those face drew the hand further in.
   */
  private clearFace(
    target: THREE.Vector3,
    anchor: THREE.Vector3,
    hand: Vec3Tuple,
    palm: Vec3Tuple,
    side: Side,
    frameReady?: boolean,
    predictedShape?: readonly THREE.Vector3[],
    contactRotation?: THREE.Matrix3,
  ): void {
    const face = this.rig.anat?.face;
    if (!face) return;
    const F =
      contactRotation ??
      handFrame(
        this.axes.toWorld(this._clearX, hand, side, sideMirror(side), frameReady),
        this.axes.toWorld(this._clearY, palm, side, sideMirror(side), frameReady),
        this._clearF,
      );
    if (!F) return;
    const shape = predictedShape ?? this.rig.fingerShape(side);
    const clear = this.rig.fingerClearance(side);
    if (!(shape.length && clear > 0)) return;
    face.refresh();
    // The anchor is on the skin, where its normal can be read.
    let out = this._clearN;
    if (this._anchorOutward) out = this._anchorOutward;
    else if (face.shortfall(anchor, Number.POSITIVE_INFINITY, out) <= 0) return;
    let reach = 0;
    for (const local of shape) reach = Math.max(reach, local.length());
    const clearAt = (s: number) => {
      for (const local of shape) {
        const P = this._clearP.copy(local).applyMatrix3(F).add(target).addScaledVector(out, s);
        if (face.shortfall(P, clear, this._clearM) > 0) return false;
      }
      return true;
    };
    if (clearAt(0)) return;
    let lo = 0;
    let hi = clear;
    while (!clearAt(hi)) {
      lo = hi;
      hi += clear;
      if (hi > reach + clear) return;
    }
    for (let i = 0; i < CLEAR_REFINE; i++) {
      const mid = 0.5 * (lo + hi);
      if (clearAt(mid)) hi = mid;
      else lo = mid;
    }
    target.addScaledVector(out, hi);
  }

  /**
   * Move a reach's target back along the path the wrist is taking to it, to
   * wherever the entrance has got to. In place.
   *
   * Interpolated about the shoulder — the bearing swung and the distance eased
   * — and not along the straight line between the two points.
   *
   * A straight line is what the minimum-jerk result describes, and it is the
   * right path for a reach out into the room. It is the wrong one for a reach
   * that lands on the body. The straight line from a hand at the hip to a hand
   * at the chin passes within a hand's breadth of the shoulder itself, and the
   * two-link solve there is worthless: the elbow circle is enormous, the map
   * from swivel to pose is near-vertical, and the arm has to fold past its own
   * flexion stop to put the wrist on the line at all. Driven along it the wrist
   * dived to within four centimetres of the shoulder with the elbow at 169
   * degrees against a limit of 150, then snapped back out — a worse artefact
   * than the wandering it was meant to fix.
   *
   * Swinging the bearing keeps the wrist on an arc that stays inside the
   * reachable band the whole way, because both of its endpoints are, and it is
   * also what an arm reaching to its own face does: the hand comes round rather
   * than through. The result is still a straight line wherever the two ends sit
   * at a similar distance from the shoulder, which is the case the minimum-jerk
   * model was measured on.
   *
   * The arc is the shortest one, except where that runs behind the body. A
   * hand at the hip going to behind the ear is nearly a half turn away, the
   * plane of the shortest arc is then decided by whichever end sits a few
   * centimetres further back, and the wrist was carried round the back with
   * the arm half folded — a forearm bent backward past the shoulder's whole
   * range, which the limiter answered by flipping it. The back is somewhere a
   * hand goes and never somewhere it passes through, so an arc that would dip
   * further behind the shoulder than either of its ends is drawn out to the
   * side instead, and the hand comes up as a lateral raise.
   */
  travel(target: THREE.Vector3, from: THREE.Vector3, side: Side, e: number): void {
    const upper = this.p.bones[`upperArm.${side}`];
    const anat = this.rig.anat;
    if (!(upper && anat.update())) {
      target.lerpVectors(from, target, e);
      return;
    }
    upper.updateWorldMatrix(true, false);
    const S = upper.getWorldPosition(this._travelS);
    const a = this._travelA.copy(from).sub(S);
    const b = this._travelB.copy(target).sub(S);
    const ra = a.length();
    const rb = b.length();
    if (ra < 1e-6 || rb < 1e-6) {
      target.lerpVectors(from, target, e);
      return;
    }
    a.divideScalar(ra);
    b.divideScalar(rb);

    const mid = this._travelM.addVectors(a, b);
    const behind =
      mid.lengthSq() > 1e-12 &&
      mid.normalize().dot(anat.fwd) < Math.min(a.dot(anat.fwd), b.dot(anat.fwd));
    // The same bulge mirrored to the front of the body: a spherical Bezier
    // drawn toward the arc's midpoint reflected through the frontal plane,
    // so the bearing turns smoothly rather than cornering at a via point.
    const via = behind
      ? this._travelL.copy(mid).addScaledVector(anat.fwd, -2 * mid.dot(anat.fwd))
      : this.clearance(S, a, b, ra, rb);
    if (via) {
      const p = slerpDir(this._travelP, a, via, e);
      const q = slerpDir(this._travelQ, via, b, e);
      slerpDir(a, p, q, e);
    } else {
      slerpDir(a, a, b, e);
    }
    target.copy(S).addScaledVector(a, ra + (rb - ra) * e);
  }

  /**
   * The bearing a travel has to be drawn toward to keep the wrist out of the
   * body, or null where the plain arc already does.
   *
   * The arc between two points on the body is not clear of it just because its
   * ends are: from the mouth to behind the ear, the shortest swing about the
   * shoulder carries the wrist through the cheek. Each of a few samples is
   * lifted to the surface, and the control point moves off the arc's midpoint —
   * where it reproduces the plain arc exactly — by what the worst of them needs.
   * Proportional to the lift, so the bulge grows out of nothing as the arc
   * first touches the body rather than appearing whole.
   */
  private clearance(
    S: THREE.Vector3,
    a: THREE.Vector3,
    b: THREE.Vector3,
    ra: number,
    rb: number,
  ): THREE.Vector3 | null {
    const anat = this.rig.anat;
    const push = this._travelW.set(0, 0, 0);
    let need = 0;
    for (let i = 1; i < TRAVEL_SAMPLES; i++) {
      const t = i / TRAVEL_SAMPLES;
      const on = slerpDir(this._travelP, a, b, t);
      const P = this._travelV.copy(S).addScaledVector(on, ra + (rb - ra) * t);
      if (anat.surface(P) <= 0) continue;
      // A control-point move shifts the curve at t by 2t(1-t) of itself.
      const off = P.sub(S)
        .normalize()
        .sub(on)
        .divideScalar(2 * t * (1 - t));
      const n = off.lengthSq();
      if (n > need) {
        need = n;
        push.copy(off);
      }
    }
    if (need <= 0) return null;
    return slerpDir(this._travelL, a, b, 0.5).add(push).normalize();
  }
}
