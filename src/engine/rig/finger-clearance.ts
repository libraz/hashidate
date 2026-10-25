/**
 * Hand frames and finger clearance.
 *
 * `handFrame` builds the orthonormal frame a hand's pointing direction and palm
 * normal make. `FingerClearance` records the shape a hand's fingers take in that
 * frame, and keeps them off the face by turning the hand and curling fingers.
 */

import * as THREE from 'three';
import type { ArmAnatomy } from '../anatomy';
import { JOINTS } from '../anatomy';
import type { FingerSpec, Profile, Side } from '../types';
import { FINGER_NAMES } from '../types';
import { FINGER_TIP_EXTENSION } from './hand-geometry';
import type { Hands } from './hands';

const _hfY = new THREE.Vector3();
const _hfZ = new THREE.Vector3();
/**
 * The frame a hand's pointing direction and palm normal make, as columns:
 * pointing, palm, and their cross. Null when the two are parallel. Normalises
 * `point` in place.
 */
export function handFrame(
  point: THREE.Vector3,
  palm: THREE.Vector3,
  out: THREE.Matrix3,
): THREE.Matrix3 | null {
  const x = point.lengthSq() > 1e-12 ? point.normalize() : null;
  if (!x) return null;
  const y = _hfY.copy(palm).addScaledVector(x, -palm.dot(x));
  if (y.lengthSq() < 1e-8) return null;
  y.normalize();
  const z = _hfZ.crossVectors(x, y);
  return out.set(x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z);
}
/** Turns per hand per frame: the later ones catch a finger an earlier one brought in. */
const FINGER_PASSES = 3;
/** Damping on the fingers' turn, in squared finger half-thicknesses. */
const FINGER_DAMP = 0.01;
/**
 * Most a hand turns in a frame to clear its fingers: the span of the wrist's
 * narrowest comfortable range. A correction, not a pose — a hand set inside the
 * face needs its arm moved, and turned further it only folded the wrist.
 */
const FINGER_TURN_MAX = JOINTS.wrist.dofs.deviation.free[1] - JOINTS.wrist.dofs.deviation.free[0];
const _fW = new THREE.Vector3();
const _fP = new THREE.Vector3();
const _fT = new THREE.Vector3();
const _fU = new THREE.Vector3();
const _fN = new THREE.Vector3();
const _fG = new THREE.Vector3();
const _fB = new THREE.Vector3();
const _fA = new THREE.Matrix3();
const _fTurn = new THREE.Quaternion();
const _fParent = new THREE.Quaternion();
const _fLocal = new THREE.Quaternion();
const _fFrame = new THREE.Matrix3();
/** Trial flexion that measures a curl's lever on a finger's points. */
const FINGER_CURL_PROBE = 0.05;
const _fSpec: FingerSpec = {};
const _fIn = Array.from({ length: 5 }, () => ({
  p: new THREE.Vector3(),
  n: new THREE.Vector3(),
  d: 0,
  i: 0,
}));

/** Keeps a hand's fingers off the face and records the shape they take. */
export class FingerClearance {
  /** Each hand's fingers as last posed, in its own frame. See `fingerShape`. */
  private readonly _fingerShape: Record<Side, THREE.Vector3[]> = { L: [], R: [] };
  /** The frame each hand reached when its shape was recorded. See `fingerFrame`. */
  private readonly _fingerFrame: Record<Side, THREE.Matrix3> = {
    L: new THREE.Matrix3(),
    R: new THREE.Matrix3(),
  };

  private readonly palmLocal: Hands['palmLocal'];

  constructor(
    private readonly p: Profile,
    private readonly hands: Hands,
    private readonly anat: ArmAnatomy,
    private readonly fingerClearance: (side: Side) => number,
  ) {
    this.palmLocal = hands.palmLocal;
  }

  /** The fingers as last posed, in the frame the hand reached. See `Rig.fingerShape`. */
  fingerShape(side: Side): readonly THREE.Vector3[] {
    return this._fingerShape[side];
  }

  /** The frame the hand reached when `fingerShape` was recorded. See `Rig.fingerFrame`. */
  fingerFrame(side: Side): Readonly<THREE.Matrix3> {
    return this._fingerFrame[side];
  }

  /**
   * Pose the fingers of `spec` clear of the face, returning the amounts they
   * ended at.
   */
  curlClearOfFace(side: Side, spec: FingerSpec, spread: FingerSpec): FingerSpec {
    for (const finger of FINGER_NAMES) _fSpec[finger] = spec[finger] ?? 0;
    this.clearFingers(side, spec, spread);
    return _fSpec;
  }

  noteFingers(side: Side): void {
    const hand = this.p.bones[`hand.${side}`];
    const palm = this.palmLocal[side];
    if (!(hand && palm)) return;
    // The fingers are where the reached bones put them, even if the requested
    // direction and palm could not pass the wrist limits. Using the request as
    // the inverse frame made this shape carry the clamp error into `clearFace`
    // and feed it back into the next hand placement.
    hand.getWorldQuaternion(_fParent);
    _fG.copy(this.p.restDir[`hand.${side}`]).applyQuaternion(_fParent);
    _fN.copy(palm).applyQuaternion(_fParent);
    const F = handFrame(_fG, _fN, _fFrame);
    if (!F) return;
    this._fingerFrame[side].copy(F);
    F.transpose();
    const W = hand.getWorldPosition(_fW);
    const out = this._fingerShape[side];
    let k = 0;
    for (const f of FINGER_NAMES) {
      const chain = this.p.fingerBones[`${f}.${side}`];
      if (!chain?.length) continue;
      for (let i = 0; i <= chain.length; i++) {
        if (!this.fingerPoint(chain, i, _fP)) continue;
        if (k === out.length) out.push(new THREE.Vector3());
        out[k++].copy(_fP).sub(W).applyMatrix3(F);
      }
    }
    out.length = k;
  }

  /**
   * Point `i` of a finger chain, the last one past its last bone: the tip has no
   * bone, so the last segment is carried on, as `limb` estimates it.
   */
  private fingerPoint(chain: THREE.Bone[], i: number, out: THREE.Vector3): boolean {
    if (i < chain.length) {
      chain[i].getWorldPosition(out);
      return true;
    }
    if (chain.length < 2) return false;
    chain[i - 1].getWorldPosition(out);
    out.addScaledVector(
      _fT.subVectors(out, chain[i - 2].getWorldPosition(_fU)),
      FINGER_TIP_EXTENSION,
    );
    return true;
  }

  /**
   * Keep the fingers out of the face: turn the hand about the wrist, and curl a
   * finger the turn could not free.
   *
   * The arm's escape ends the hand at the palm's contact point, deliberately —
   * see `HAND_CONTACT` — so the fingers past it went wherever the hand pointed:
   * a hand turning from behind the ear to the mouth swept them through the
   * cheek, and curled knuckles beside a cheek sank into it. Each joint and the
   * tip is held half a finger's thickness off the skin, that thickness taken
   * from the avatar's own knuckle pitch. Only the hand and its fingers move, so
   * the arm above them, and everything it reported, stands.
   */
  private clearFingers(side: Side, spec: FingerSpec, spread: FingerSpec): void {
    const face = this.anat.face;
    const hand = this.p.bones[`hand.${side}`];
    const clear = this.fingerClearance(side);
    const parent = hand?.parent;
    if (!(face && hand && parent && clear > 0)) return;
    const damp = FINGER_DAMP * clear * clear;
    face.refresh();
    hand.updateWorldMatrix(true, true);
    const W = hand.getWorldPosition(_fW);
    let turned = 0;
    for (let pass = 0; pass < FINGER_PASSES && turned < FINGER_TURN_MAX; pass++) {
      // One small turn for every finger that is in, solved together. Pushing
      // the worst one alone pressed the next one in: fingers kissed to the lips
      // touch skin that faces several ways, and the hand rocked between them.
      // Each point gains (w x r).n = w.(r x n) along its normal; least squares
      // over that, damped so a point straight down the lever does not throw it.
      _fA.set(0, 0, 0, 0, 0, 0, 0, 0, 0);
      _fB.set(0, 0, 0);
      let any = false;
      for (const f of FINGER_NAMES) {
        const chain = this.p.fingerBones[`${f}.${side}`];
        if (!chain?.length) continue;
        for (let i = 0; i <= chain.length; i++) {
          if (!this.fingerPoint(chain, i, _fP)) continue;
          const d = face.shortfall(_fP, clear, _fN);
          if (d <= 0) continue;
          any = true;
          const g = _fG.copy(_fP).sub(W).cross(_fN);
          const e = _fA.elements;
          e[0] += g.x * g.x;
          e[1] += g.y * g.x;
          e[2] += g.z * g.x;
          e[3] += g.x * g.y;
          e[4] += g.y * g.y;
          e[5] += g.z * g.y;
          e[6] += g.x * g.z;
          e[7] += g.y * g.z;
          e[8] += g.z * g.z;
          _fB.addScaledVector(g, d);
        }
      }
      if (!any) return;
      const e = _fA.elements;
      e[0] += damp;
      e[4] += damp;
      e[8] += damp;
      const w = _fB.applyMatrix3(_fA.invert());
      const angle = w.length();
      if (!(angle > 1e-6)) break;
      const turn = Math.min(angle, FINGER_TURN_MAX - turned);
      turned += turn;
      _fTurn.setFromAxisAngle(w.divideScalar(angle), turn);
      // A world turn about the wrist, put into the hand's own parent space.
      parent.getWorldQuaternion(_fParent);
      hand.quaternion.premultiply(
        _fLocal.copy(_fParent).invert().multiply(_fTurn).multiply(_fParent),
      );
      hand.updateWorldMatrix(false, true);
    }

    // What the turn left in: fingers pressed on skin facing opposite ways, the
    // tip under the jaw and the knuckles at the cheek. A finger gives to what
    // it is pushed into, so each one left in curls or straightens on its own,
    // least squares over its points, between straight and its full flexion.
    for (const f of FINGER_NAMES) _fSpec[f] = spec[f] ?? 0;
    for (let pass = 0; pass < FINGER_PASSES; pass++) {
      let moved = false;
      for (const f of FINGER_NAMES) {
        const chain = this.p.fingerBones[`${f}.${side}`];
        const from = _fSpec[f] ?? 0;
        const lo = Math.min(from, 0) - from;
        const hi = Math.max(from, 1) - from;
        if (!chain?.length) continue;
        let n = 0;
        for (let i = 0; i <= chain.length && n < _fIn.length; i++) {
          if (!this.fingerPoint(chain, i, _fIn[n].p)) continue;
          _fIn[n].d = face.shortfall(_fIn[n].p, clear, _fIn[n].n);
          if (_fIn[n].d > 0) _fIn[n++].i = i;
        }
        if (!n) continue;
        // The curl's lever on each point, by a small trial flexion.
        _fSpec[f] = from + FINGER_CURL_PROBE;
        this.hands.curlHand(side, _fSpec, spread);
        hand.updateWorldMatrix(false, true);
        let num = 0;
        let den = damp;
        for (let k = 0; k < n; k++) {
          const q = _fIn[k];
          this.fingerPoint(chain, q.i, _fP);
          const j = _fP.sub(q.p).dot(q.n) / FINGER_CURL_PROBE;
          num += j * q.d;
          den += j * j;
        }
        _fSpec[f] = from + THREE.MathUtils.clamp(num / den, lo, hi);
        this.hands.curlHand(side, _fSpec, spread);
        hand.updateWorldMatrix(false, true);
        if (_fSpec[f] !== from) moved = true;
      }
      if (!moved) return;
    }
  }
}
