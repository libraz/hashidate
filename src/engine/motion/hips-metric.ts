import * as THREE from 'three';
import type { Profile } from '../types';

/**
 * Parent-local vectors for metre-sized hips translations.
 *
 * Body's weight shift is the one place in the runtime that writes a bone
 * *translation* rather than a rotation, and a translation is in the parent's
 * units — which may be rotated or scaled differently on each axis. Rotations
 * are radians and are the same number on any rig, which is why nothing else
 * has needed this — and why the omission was invisible. The sway follows the
 * anatomical right projected onto the floor and the lift follows world up,
 * the gravity the hop uses; each world metre goes through the inverse parent
 * transform unnormalised, so it lands as a metre.
 *
 * One of these avatars is authored in centimetres under a 0.01 scale at the
 * armature (the same fact `profile/bones.ts` records for the arm lengths),
 * so a figure written as 12 mm landed as 0.12 mm and the hips did not move
 * at all. The other is authored in metres and behaved as written, which is
 * exactly the shape of bug that survives being looked at on one avatar.
 */
export class HipsMetric {
  /** The parent whose live linear transform turns metre vectors into local translations. */
  private readonly _hipsParent: THREE.Object3D | null;
  /** Rest anatomical right, held in the hips parent frame so root turns do not feed back through the live chest. */
  private readonly _hipsRestRight = new THREE.Vector3();
  private _hipsHasAnatomicalRight = false;
  private readonly _hipsParentLinear = new THREE.Matrix3();
  private readonly _hipsParentInverse = new THREE.Matrix3();
  private readonly _hipsFrameLinear = new THREE.Matrix3();
  private readonly _hipsRightWorld = new THREE.Vector3();
  private readonly _hipsUpWorld = new THREE.Vector3();
  private readonly _hipsRestRightWorld = new THREE.Vector3();
  private readonly _hipsRestHipsXWorld = new THREE.Vector3();
  private readonly _hipsRestHipsQ = new THREE.Quaternion();

  constructor(private readonly p: Profile) {
    this._hipsParent = p.bones.hips?.parent ?? null;
  }

  /**
   * Recompute the parent-local metre vectors from the current parent transform.
   *
   * The anatomical right is captured once in the hips parent's rest frame. It
   * is deliberately not read from the live chest here: the chest is also
   * driven by posture, and feeding that pose back into the translation axis
   * makes a breath slowly rotate the direction it is trying to express. The
   * floor projection is applied only after the rest vector has been carried
   * through the current parent, so a root turn or non-uniform scale changes the
   * metric without changing the authored sign.
   */
  refresh(hipsRight: THREE.Vector3, hipsUp: THREE.Vector3, captureRest = false): void {
    const hips = this.p.bones.hips;
    const parent = this._hipsParent;
    if (!(hips && parent)) return;

    // The host may transform an outer wrapper without walking its own scene
    // graph. Update the parent chain first; updating the root alone would
    // otherwise reuse that wrapper's previous matrix for this frame. The full
    // walk is only for the rest capture, which reads the chest's world matrix.
    parent.updateWorldMatrix(true, false);
    if (captureRest) this.p.root.updateMatrixWorld(true);
    const parentLinear = this._hipsParentLinear.setFromMatrix4(parent.matrixWorld);
    const determinant = parentLinear.determinant();
    if (
      !Number.isFinite(determinant) ||
      determinant === 0 ||
      !parentLinear.elements.every(Number.isFinite)
    ) {
      // A singular host transform has no meaningful inverse metric. Keep the
      // last finite vectors rather than allowing one bad frame to poison the
      // posture state with NaNs.
      return;
    }
    const parentInverse = this._hipsParentInverse.copy(parentLinear).invert();
    if (!parentInverse.elements.every(Number.isFinite)) return;

    if (captureRest) {
      this._hipsHasAnatomicalRight = false;
      const frameBone = this.p.bones.chest ?? this.p.bones.spine ?? hips;
      const frame = this.p.body;
      if (frame && frameBone) {
        const restRightWorld = this._hipsRestRightWorld
          .copy(frame.right)
          .applyMatrix3(this._hipsFrameLinear.setFromMatrix4(frameBone.matrixWorld));
        const restRightLengthSq = restRightWorld.lengthSq();
        if (Number.isFinite(restRightLengthSq) && restRightLengthSq > 1e-12) {
          restRightWorld.normalize();
          // Exporters disagree on whether right is +X; the rest hips axis keeps
          // the tuned sway sign. This gauge is intentionally captured once.
          const hipsXWorld = this._hipsRestHipsXWorld
            .set(1, 0, 0)
            .applyQuaternion(hips.getWorldQuaternion(this._hipsRestHipsQ));
          const hipsXLengthSq = hipsXWorld.lengthSq();
          const floorRight = this._hipsRightWorld.copy(restRightWorld);
          floorRight.y = 0;
          const floorHipsX = this._hipsUpWorld.copy(hipsXWorld);
          floorHipsX.y = 0;
          const floorRightLengthSq = floorRight.lengthSq();
          const floorHipsXLengthSq = floorHipsX.lengthSq();
          if (
            Number.isFinite(hipsXLengthSq) &&
            hipsXLengthSq > 1e-12 &&
            Number.isFinite(floorRightLengthSq) &&
            floorRightLengthSq > 1e-12 &&
            Number.isFinite(floorHipsXLengthSq) &&
            floorHipsXLengthSq > 1e-12
          ) {
            floorRight.normalize();
            floorHipsX.normalize();
            if (floorRight.dot(floorHipsX) < 0) restRightWorld.negate();
          }

          this._hipsRestRight.copy(restRightWorld).applyMatrix3(parentInverse);
          const restParentLengthSq = this._hipsRestRight.lengthSq();
          this._hipsHasAnatomicalRight =
            Number.isFinite(restParentLengthSq) && restParentLengthSq > 1e-12;
        }
      }
    }

    this._hipsUpWorld.set(0, 1, 0);
    const up = this._hipsUpWorld.applyMatrix3(parentInverse);
    const upLengthSq = up.lengthSq();
    if (Number.isFinite(upLengthSq) && upLengthSq > 1e-12) hipsUp.copy(up);

    let rightValid = false;
    if (this._hipsHasAnatomicalRight) {
      const rightWorld = this._hipsRightWorld.copy(this._hipsRestRight).applyMatrix3(parentLinear);
      const rightLengthSq = rightWorld.lengthSq();
      if (Number.isFinite(rightLengthSq) && rightLengthSq > 1e-12) {
        rightWorld.y = 0;
        const floorLengthSq = rightWorld.lengthSq();
        if (Number.isFinite(floorLengthSq) && floorLengthSq > 1e-12) {
          rightWorld.normalize();
          // Not normalised: a non-uniform scale needs the per-axis length for a metre.
          const right = rightWorld.applyMatrix3(parentInverse);
          const localLengthSq = right.lengthSq();
          if (Number.isFinite(localLengthSq) && localLengthSq > 1e-12) {
            hipsRight.copy(right);
            rightValid = true;
          }
        }
      }
    }

    if (!rightValid) {
      // No body frame (or a frame whose right has become vertical): preserve
      // the old parent-local-X fallback, refreshed for the current metric.
      const xWorld = this._hipsRightWorld.set(1, 0, 0).applyMatrix3(parentLinear);
      const xLengthSq = xWorld.lengthSq();
      if (Number.isFinite(xLengthSq) && xLengthSq > 1e-12) {
        const xLength = Math.sqrt(xLengthSq);
        if (Number.isFinite(xLength)) hipsRight.set(1 / xLength, 0, 0);
      }
    }
  }
}
