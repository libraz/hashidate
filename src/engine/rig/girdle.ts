import * as THREE from 'three';
import type { JointTable, Profile, Side, Vec3Tuple } from '../types';

const _gC = new THREE.Vector3();
const _gS = new THREE.Vector3();
const _gA = new THREE.Vector3();
const _gB = new THREE.Vector3();
const _gX = new THREE.Vector3();
// How far the clavicle may turn to get the arm room. The sternoclavicular joint
// gives roughly ten degrees of depression and twenty of retraction, and a swing
// away from a target in front of the face is a mix of the two.
const GIRDLE_ROM = 0.38;

/** The clavicle's room-making turn and the travel that bounds it. */
export class ShoulderGirdle {
  constructor(
    private readonly p: Profile,
    private readonly joints: JointTable,
  ) {}

  /**
   * Swing the shoulder girdle away from a reach, in place, before the arm is
   * solved from it.
   *
   * A hand cannot be brought to the face by the arm alone. The elbow's flexion
   * fixes a nearest reachable point — fold it as far as it goes and the wrist
   * is still a fixed distance from the shoulder — so on a narrow-shouldered,
   * short-necked figure the face can sit inside that radius and no choice of
   * elbow, pole or wrist reaches it. Measured on the validation avatar the
   * shoulder is 0.09 to 0.14 from the face anchors against an arm of 0.33; the
   * same ratio on a person is around a half to two thirds.
   *
   * What a person does about it is drop and draw back the shoulder, and that is
   * what this does: the clavicle turns away from the target until the wrist can
   * sit where the elbow's *comfortable* range wants it, bounded by the girdle's
   * own travel. It buys a couple of centimetres, which is the difference
   * between a forearm folded flat and one that reads as resting.
   *
   * `dir` is the clavicle's aim, and the turn it needs, scaled by `weight`, is
   * added to `turnOut` as a rotation vector rather than applied: every reach in
   * play adds its share, and `turnGirdle` applies the sum, bounded by the
   * girdle's travel. The current angle is taken from `dir` rather than from
   * where the bone actually points, so the result is a function of the request
   * alone — read back from the posed bone it would measure its own correction,
   * find nothing left to do, and let the shoulder spring back on the next frame.
   */
  girdleRoom(
    side: Side,
    targetWorld: THREE.Vector3,
    dir: Vec3Tuple,
    weight: number,
    turnOut: THREE.Vector3,
  ): void {
    const { bones, limb } = this.p;
    const clav = bones[`shoulder.${side}`];
    const upper = bones[`upperArm.${side}`];
    const La = limb?.[`upper.${side}`];
    const Lf = limb?.[`lower.${side}`];
    if (!(clav && upper && La && Lf) || weight <= 0) return;

    clav.updateWorldMatrix(true, false);
    upper.updateWorldMatrix(true, false);
    const C = clav.getWorldPosition(_gC);
    // Turning the clavicle cannot change this, so the posed bones give the rest
    // length as readily as the rest pose would.
    const r = C.distanceTo(upper.getWorldPosition(_gS));
    if (r < 1e-4) return;

    const a = _gA.set(dir[0], dir[1], dir[2]);
    if (a.lengthSq() < 1e-8) return;
    a.normalize();
    const b = _gB.copy(targetWorld).sub(C);
    const L = b.length();
    if (L < 1e-4) return;
    b.multiplyScalar(1 / L);

    // Where the wrist has to sit for the elbow to stay inside its free range.
    const flexFree = this.joints?.elbow?.dofs?.flexion?.free?.[1] ?? Math.PI;
    const want = Math.sqrt(La * La + Lf * Lf - 2 * La * Lf * Math.cos(Math.PI - flexFree));
    // Law of cosines on the triangle root-shoulder-target: the shoulder sits on
    // a sphere of radius r about the clavicle root, and this is the cosine that
    // puts it `want` from the target.
    const K = (r * r + L * L - want * want) / (2 * r * L);
    const cos0 = THREE.MathUtils.clamp(a.dot(b), -1, 1);
    if (!(K < cos0)) return;

    const need = Math.acos(THREE.MathUtils.clamp(K, -1, 1)) - Math.acos(cos0);
    const turn = Math.min(need, GIRDLE_ROM) * weight;
    if (turn < 1e-4) return;
    // b cross a, not a cross b: rotating about the latter carries the shoulder
    // *toward* the target, which is the wrong way round and reads as a hunch.
    const axis = _gX.crossVectors(b, a);
    if (axis.lengthSq() < 1e-8) return;
    turnOut.addScaledVector(axis.normalize(), turn);
  }

  /**
   * Turn the clavicle's aim `dir` in place by the rotation `girdleRoom`
   * gathered, its angle clamped to the girdle's travel however many reaches
   * contributed.
   */
  turnGirdle(dir: Vec3Tuple, turn: THREE.Vector3): void {
    const angle = Math.min(turn.length(), GIRDLE_ROM);
    if (angle < 1e-4) return;
    const a = _gA
      .set(dir[0], dir[1], dir[2])
      .normalize()
      .applyAxisAngle(_gX.copy(turn).normalize(), angle);
    dir[0] = a.x;
    dir[1] = a.y;
    dir[2] = a.z;
  }
}
