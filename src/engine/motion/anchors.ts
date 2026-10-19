import * as THREE from 'three';
import { HAND_CONTACT } from '../anatomy';
import { BODY_ANCHORS, FACE_ANCHORS } from '../profile';
import type { Rig } from '../rig';
import type { Profile, ReachSpec, Side, Vec3Tuple } from '../types';
import { type CharacterFrame, sideMirror } from './frame';

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
  private readonly _travelS = new THREE.Vector3();
  private readonly _travelA = new THREE.Vector3();
  private readonly _travelB = new THREE.Vector3();

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
    const a = FACE_ANCHORS[name] ?? FACE_ANCHORS.mouth;
    const o = offset ?? [0, 0, 0];
    const s = side === 'R' ? 1 : -1;
    const v = this._anchor.copy(face.origin);
    v.addScaledVector(face.right, (a[0] + o[0]) * s * face.ipd);
    v.addScaledVector(face.up, (a[1] + o[1]) * face.ipd);
    v.addScaledVector(face.forward, (a[2] + o[2]) * face.ipd);
    head.updateWorldMatrix(true, false);
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
   * leans. See `Rig.poleAngle` for why this is a point and not an angle.
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
  target(r: ReachSpec | undefined, side: Side, frameReady?: boolean): THREE.Vector3 | null {
    if (!r) return null;
    const target =
      r.space === 'body'
        ? this.body(r.at, r.offset, side)
        : this.p.face && this.p.bones.head
          ? this.face(r.at, r.offset, side)
          : null;
    if (!target) return null;
    if (r.hand && r.space !== 'body') {
      const back = (this.p.limb?.[`tip.${side}.middle`] ?? 0) * HAND_CONTACT;
      if (back > 0) {
        target.addScaledVector(
          this.axes.toWorld(this._hand, r.hand, side, sideMirror(side), frameReady),
          -back,
        );
      }
    }
    return target;
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
   */
  travel(target: THREE.Vector3, from: THREE.Vector3, side: Side, e: number): void {
    const upper = this.p.bones[`upperArm.${side}`];
    if (!upper) {
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

    const angle = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
    const sin = Math.sin(angle);
    // Nothing to swing through, or the two bearings are opposed and every arc
    // between them is as good as any other. Easing the distance alone is the
    // whole answer in the first case and no worse than a guess in the second.
    if (sin > 1e-6) {
      a.multiplyScalar(Math.sin((1 - e) * angle) / sin).addScaledVector(
        b,
        Math.sin(e * angle) / sin,
      );
      a.normalize();
    }
    target.copy(S).addScaledVector(a, ra + (rb - ra) * e);
  }
}
