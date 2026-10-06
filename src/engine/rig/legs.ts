import * as THREE from 'three';
import type { LegBoneSlot, Profile, Side } from '../types';

/** The two sides are kept explicit so a one-sided rig can never look grounded. */
interface LegState {
  upper: THREE.Bone;
  lower: THREE.Bone;
  foot: THREE.Bone;
  toe: THREE.Bone | undefined;
  upperLength: number;
  lowerLength: number;
  upperRestQ: THREE.Quaternion;
  lowerRestQ: THREE.Quaternion;
  /** Full root-relative rest matrix, retaining affine scale/shear context. */
  footRestRootMatrix: THREE.Matrix4;
  toeRestQ: THREE.Quaternion | null;
  upperRestDir: THREE.Vector3;
  lowerRestDir: THREE.Vector3;
  /** Foot origin in profile-root coordinates; this is the ground anchor. */
  anchorRoot: THREE.Vector3;
  /** Rest knee direction projected off the hip-to-ankle line. */
  kneePole: THREE.Vector3;
  /** Scratch for the solved frame. */
  targetMetric: THREE.Vector3;
  hipMetric: THREE.Vector3;
  hipAfter: THREE.Vector3;
  kneeMetric: THREE.Vector3;
  reachAxis: THREE.Vector3;
  upperTarget: THREE.Vector3;
  lowerTarget: THREE.Vector3;
  pole: THREE.Vector3;
  interval: ReachInterval;
  solution: KneeSolution;
}

interface ReachInterval {
  lower: number;
  upper: number;
}

interface KneeSolution {
  hip: THREE.Vector3;
  target: THREE.Vector3;
  knee: THREE.Vector3;
  upperDir: THREE.Vector3;
  lowerDir: THREE.Vector3;
}

const SIDES = ['L', 'R'] as const;

/**
 * The grounded lower-body pass.
 *
 * A leg is optional data. Profiles that do not resolve a complete pair keep
 * their authored lower-body pose, while a complete standing humanoid gets
 * a two-link solve that keeps both ankle anchors on the floor. The solver
 * works in the local frame of `hips.parent`: applying the inverse frame matrix
 * removes the armature's translation, rotation and authored scale before any
 * length or direction is compared.
 *
 * The standing classifier is deliberately a geometry policy, not a medical
 * range-of-motion claim. It requires a nearly extended hip-to-ankle span, a
 * mostly vertical descent, and level ankles. A seated, quadruped, or partial
 * profile therefore opts out without changing the pose authored by the caller.
 */
export class GroundedLegs {
  /** Geometry-only safeguards. These are not pose tuning values. */
  static readonly EPS = 1e-9;
  static readonly STANDING_RATIO = 0.9;
  static readonly STANDING_DESCENT = 0.8;
  static readonly ANKLE_LEVEL = 0.05;
  /** A few Float32 ULPs from GLB export are still an authored uniform scale. */
  static readonly SCALE_ISOTROPY_EPS = 1e-6;

  private readonly profile: Profile;
  private readonly root: THREE.Object3D;
  private readonly metric: THREE.Object3D;
  private readonly hips: THREE.Bone;
  private readonly legs: Record<Side, LegState>;

  private readonly metricInverse = new THREE.Matrix4();
  private readonly metricInverseLinear = new THREE.Matrix3();
  private readonly rootMetric = new THREE.Matrix4();
  private readonly rootMetricFrame = new THREE.Matrix4();
  private readonly footTargetMetric = new THREE.Matrix4();
  private readonly rootMetricQ = new THREE.Quaternion();
  private readonly parentQ = new THREE.Quaternion();
  private readonly parentInverseQ = new THREE.Quaternion();
  private readonly aimDeltaQ = new THREE.Quaternion();
  private readonly aimQ = new THREE.Quaternion();
  private readonly footTargetQ = new THREE.Quaternion();
  private readonly decomposePosition = new THREE.Vector3();
  private readonly decomposeScale = new THREE.Vector3();
  private readonly forwardMetric = new THREE.Matrix4();
  private readonly forwardLinear = new THREE.Matrix3();
  private readonly forwardScratch = new THREE.Vector3();

  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly metricUp = new THREE.Vector3();
  private readonly intervalV = new THREE.Vector3();
  private readonly rootAnchorWorld = new THREE.Vector3();
  private readonly anatomicalForward = new THREE.Vector3();
  private readonly fallbackPole = new THREE.Vector3();
  private readonly restParentDir = new THREE.Vector3();
  private readonly targetParentDir = new THREE.Vector3();

  private constructor(
    profile: Profile,
    root: THREE.Object3D,
    metric: THREE.Object3D,
    hips: THREE.Bone,
    legs: Record<Side, LegState>,
  ) {
    this.profile = profile;
    this.root = root;
    this.metric = metric;
    this.hips = hips;
    this.legs = legs;
  }

  /**
   * Build a grounded solver when the profile describes a human standing pair.
   *
   * `restOf` is supplied by `Rig`, which owns the complete rest-quaternion
   * table. Keeping that callback at this boundary means the leg pass does not
   * need to know how the rest pose was captured.
   */
  static create(
    profile: Profile,
    restOf: (bone: THREE.Bone) => THREE.Quaternion,
  ): GroundedLegs | null {
    // A stated anatomy table means the avatar is deliberately outside the
    // engine's human assumptions. `profile.anatomy` is also checked because a
    // caller may attach the override after profile construction in a test or
    // in a custom loader.
    if (profile.avatar.anatomy != null || profile.anatomy != null) return null;

    const hips = profile.bones.hips;
    const metric = hips?.parent;
    if (!(hips && metric)) return null;

    profile.root.updateMatrixWorld(true);
    metric.updateWorldMatrix(true, false);

    const root = profile.root;
    const metricInverse = new THREE.Matrix4().copy(metric.matrixWorld).invert();
    const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();

    const slots = profile.bones as Partial<Record<LegBoneSlot, THREE.Bone>>;
    const built: Partial<Record<Side, LegState>> = {};
    const worldHip = new THREE.Vector3();
    const worldFoot = new THREE.Vector3();
    const worldFootL = new THREE.Vector3();
    const worldFootR = new THREE.Vector3();
    const hipMetric = new THREE.Vector3();
    const kneeMetric = new THREE.Vector3();
    const footMetric = new THREE.Vector3();
    const bodyForward = new THREE.Vector3();

    for (const side of SIDES) {
      const upper = slots[`upperLeg.${side}`];
      const lower = slots[`lowerLeg.${side}`];
      const foot = slots[`foot.${side}`];
      const toe = slots[`toe.${side}`];
      // The toe is an orientation follower only. A missing toe is valid; any
      // missing core link disables the whole pair rather than grounding one
      // side and leaving the other to drift.
      if (!(upper && lower && foot)) return null;
      // The metric direction is the translation to the direct child. A name
      // match through a twist/helper branch is not enough to aim safely, so a
      // core chain with an interposed or disjoint bone opts out.
      if (upper.parent !== hips || lower.parent !== upper || foot.parent !== lower) return null;
      // Root scale is removed by the metric frame, but an anisotropic scale on
      // a controlled bone changes a child offset as that bone rotates. The
      // two-link geometry cannot represent that affine segment, so opt out
      // rather than silently slipping the foot.
      if (![hips, upper, lower, foot].every((value) => uniformScale(value.scale))) return null;
      // A non-direct optional toe is ignored: it cannot be given the promised
      // rest-local orientation without also solving the intervening chain.
      const supportedToe = toe?.parent === foot ? toe : undefined;

      upper.updateWorldMatrix(true, false);
      lower.updateWorldMatrix(true, false);
      foot.updateWorldMatrix(true, false);
      if (supportedToe) supportedToe.updateWorldMatrix(true, false);

      const upperRestDir = lower.position.clone();
      const lowerRestDir = foot.position.clone();
      const upperDirLength = upperRestDir.length();
      const lowerDirLength = lowerRestDir.length();
      if (!(upperDirLength > GroundedLegs.EPS && lowerDirLength > GroundedLegs.EPS)) return null;
      upperRestDir.multiplyScalar(1 / upperDirLength);
      lowerRestDir.multiplyScalar(1 / lowerDirLength);

      const upperRestQ = restOf(upper).clone().normalize();
      const lowerRestQ = restOf(lower).clone().normalize();
      const footRestQ = restOf(foot).clone().normalize();
      const toeRestQ = supportedToe ? restOf(supportedToe).clone().normalize() : null;
      if (
        !(
          validQuaternion(upperRestQ) &&
          validQuaternion(lowerRestQ) &&
          validQuaternion(footRestQ)
        ) ||
        (toeRestQ !== null && !validQuaternion(toeRestQ))
      ) {
        return null;
      }

      const upperMetric = upper.getWorldPosition(new THREE.Vector3()).applyMatrix4(metricInverse);
      const lowerMetric = lower.getWorldPosition(new THREE.Vector3()).applyMatrix4(metricInverse);
      const footMetricAtRest = foot
        .getWorldPosition(new THREE.Vector3())
        .applyMatrix4(metricInverse);
      const upperLength = upperMetric.distanceTo(lowerMetric);
      const lowerLength = lowerMetric.distanceTo(footMetricAtRest);
      if (
        !(
          Number.isFinite(upperLength) &&
          Number.isFinite(lowerLength) &&
          upperLength > GroundedLegs.EPS &&
          lowerLength > GroundedLegs.EPS
        )
      ) {
        return null;
      }

      hips.getWorldPosition(worldHip);
      foot.getWorldPosition(worldFoot);
      if (side === 'L') worldFootL.copy(worldFoot);
      else worldFootR.copy(worldFoot);

      upper.getWorldPosition(hipMetric).applyMatrix4(metricInverse);
      lower.getWorldPosition(kneeMetric).applyMatrix4(metricInverse);
      foot.getWorldPosition(footMetric).applyMatrix4(metricInverse);
      const restReach = footMetric.clone().sub(hipMetric);
      const restReachSq = restReach.lengthSq();
      if (!(restReachSq > GroundedLegs.EPS)) return null;
      const restKnee = kneeMetric.sub(hipMetric);
      const restPole = restKnee.addScaledVector(restReach, -restKnee.dot(restReach) / restReachSq);
      const restPoleScale = GroundedLegs.EPS * Math.max(1, restReachSq, restKnee.lengthSq());
      if (restPole.lengthSq() > restPoleScale) restPole.normalize();
      else restPole.set(0, 0, 0);

      // Root-relative orientation is captured through the root inverse. A
      // world quaternion would include an armature scale and can decompose to
      // a different rotation when that scale is non-uniform.
      const footRootMatrix = new THREE.Matrix4().copy(rootInverse).multiply(foot.matrixWorld);
      const footRootQ = new THREE.Quaternion();
      footRootMatrix.decompose(new THREE.Vector3(), footRootQ, new THREE.Vector3());
      footRootQ.normalize();
      if (!validQuaternion(footRootQ)) return null;

      const state: LegState = {
        upper,
        lower,
        foot,
        toe: supportedToe,
        upperLength,
        lowerLength,
        upperRestQ,
        lowerRestQ,
        footRestRootMatrix: footRootMatrix,
        toeRestQ,
        upperRestDir,
        lowerRestDir,
        anchorRoot: foot.getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInverse),
        kneePole: restPole.lengthSq() > GroundedLegs.EPS ? restPole : new THREE.Vector3(),
        targetMetric: new THREE.Vector3(),
        hipMetric: new THREE.Vector3(),
        hipAfter: new THREE.Vector3(),
        kneeMetric: new THREE.Vector3(),
        reachAxis: new THREE.Vector3(),
        upperTarget: new THREE.Vector3(),
        lowerTarget: new THREE.Vector3(),
        pole: new THREE.Vector3(),
        interval: { lower: 0, upper: 0 },
        solution: {
          hip: new THREE.Vector3(),
          target: new THREE.Vector3(),
          knee: new THREE.Vector3(),
          upperDir: new THREE.Vector3(),
          lowerDir: new THREE.Vector3(),
        },
      };

      // A straight rest leg has no authored bend direction. Capture a stable
      // anatomical-forward fallback once, so the sign cannot alternate as a
      // moving target crosses the forward plane.
      if (state.kneePole.lengthSq() <= GroundedLegs.EPS) {
        anatomicalForward(profile, metricInverse, bodyForward);
        projectPole(bodyForward, restReach, state.kneePole);
        if (state.kneePole.lengthSq() <= GroundedLegs.EPS) return null;
      }

      built[side] = state;
    }

    const left = built.L;
    const right = built.R;
    if (!(left && right)) return null;

    hips.getWorldPosition(worldHip);
    // Standing classification is intentionally expressed in world geometry.
    // The solver lengths above are metric-frame units (which may be centimetres
    // under a 0.01 armature scale), while this policy compares the visible
    // hip-to-ankle span with the visible thigh and shin spans.
    const worldUpperL = left.upper.getWorldPosition(new THREE.Vector3());
    const worldKneeL = left.lower.getWorldPosition(new THREE.Vector3());
    const worldUpperR = right.upper.getWorldPosition(new THREE.Vector3());
    const worldKneeR = right.lower.getWorldPosition(new THREE.Vector3());
    const totalL = worldUpperL.distanceTo(worldKneeL) + worldKneeL.distanceTo(worldFootL);
    const totalR = worldUpperR.distanceTo(worldKneeR) + worldKneeR.distanceTo(worldFootR);
    const ratioL = worldHip.distanceTo(worldFootL) / totalL;
    const ratioR = worldHip.distanceTo(worldFootR) / totalR;
    const descentL = (worldHip.y - worldFootL.y) / totalL;
    const descentR = (worldHip.y - worldFootR.y) / totalR;
    const standingL =
      ratioL >= GroundedLegs.STANDING_RATIO && descentL >= GroundedLegs.STANDING_DESCENT;
    const standingR =
      ratioR >= GroundedLegs.STANDING_RATIO && descentR >= GroundedLegs.STANDING_DESCENT;
    const meanLength = (totalL + totalR) * 0.5;
    const ankleHeight = Math.abs(worldFootL.y - worldFootR.y);
    if (!(standingL && standingR) || ankleHeight > GroundedLegs.ANKLE_LEVEL * meanLength) {
      return null;
    }

    return new GroundedLegs(profile, root, metric, hips, { L: left, R: right });
  }

  /**
   * Keep the rest ankle anchors fixed on the floor, or lift them by `rise`
   * while a hop is airborne. A failed common reach leaves every bone as the
   * caller posed it for this frame; slipping one foot to make the other reach
   * would be much more visible than retaining the authored pose.
   */
  apply(rise: number): void {
    this.root.updateMatrixWorld(true);
    this.metric.updateWorldMatrix(true, false);
    this.metricInverse.copy(this.metric.matrixWorld).invert();
    this.metricInverseLinear.setFromMatrix4(this.metricInverse);
    this.metricUp.copy(this.worldUp).applyMatrix3(this.metricInverseLinear);
    if (this.metricUp.lengthSq() <= GroundedLegs.EPS) return;

    const lift = Number.isFinite(rise) ? Math.max(0, rise) : 0;
    this.rootMetricFrame.copy(this.metricInverse).multiply(this.root.matrixWorld);
    this.rootMetricFrame.decompose(this.decomposePosition, this.rootMetricQ, this.decomposeScale);
    if (!validQuaternion(this.rootMetricQ)) return;

    // Root-relative anchors follow the root's current placement. The lift is
    // stated in world metres, then converted to metric coordinates below.
    for (const side of SIDES) {
      const state = this.legs[side];
      this.rootAnchorWorld.copy(state.anchorRoot).applyMatrix4(this.root.matrixWorld);
      this.rootAnchorWorld.y += lift;
      state.targetMetric.copy(this.rootAnchorWorld).applyMatrix4(this.metricInverse);
      state.upper.getWorldPosition(state.hipMetric).applyMatrix4(this.metricInverse);
    }
    // The same downward pelvis correction has to satisfy both legs. Solve the
    // outer-reach intervals first, intersect them, and only then touch hips.
    if (!(this.reachInterval(this.legs.L) && this.reachInterval(this.legs.R))) return;
    const lower = Math.max(0, this.legs.L.interval.lower, this.legs.R.interval.lower);
    const upper = Math.min(this.legs.L.interval.upper, this.legs.R.interval.upper);
    if (!(Number.isFinite(lower) && Number.isFinite(upper)) || lower > upper + GroundedLegs.EPS) {
      return;
    }

    const delta = lower;
    if (!(this.kneeSolution(this.legs.L, delta) && this.kneeSolution(this.legs.R, delta))) return;

    // Everything above this point is validation and geometry. Apply the one
    // common translation, then aim parent-first so every child reads the new
    // parent matrix rather than a stale one.
    if (delta > GroundedLegs.EPS) {
      this.hips.position.addScaledVector(this.metricUp, -delta);
      this.hips.updateWorldMatrix(false, true);
    }

    for (const side of SIDES) {
      const state = this.legs[side];
      const solution = state.solution;
      this.aimBone(state.upper, state.upperRestQ, state.upperRestDir, solution.upperDir);
      state.upper.updateWorldMatrix(false, true);

      this.aimBone(state.lower, state.lowerRestQ, state.lowerRestDir, solution.lowerDir);
      state.lower.updateWorldMatrix(false, true);

      // Preserve the foot's orientation relative to the profile root. The
      // optional toe retains its local rest rotation and therefore follows the
      // foot without acquiring an extra aim.
      // Decompose only after composing the full affine chain. Multiplying two
      // separately decomposed quaternions loses the interaction between a
      // nested metric frame's non-uniform scale and a tilted foot.
      this.footTargetMetric.copy(this.rootMetricFrame).multiply(state.footRestRootMatrix);
      this.footTargetMetric.decompose(
        this.decomposePosition,
        this.footTargetQ,
        this.decomposeScale,
      );
      if (!validQuaternion(this.footTargetQ)) return;
      this.parentMetricQuaternion(state.foot, this.parentQ);
      this.parentInverseQ.copy(this.parentQ).invert();
      state.foot.quaternion.copy(this.parentInverseQ).multiply(this.footTargetQ).normalize();
      state.foot.updateWorldMatrix(false, true);
      if (state.toe && state.toeRestQ) {
        state.toe.quaternion.copy(state.toeRestQ);
        state.toe.updateWorldMatrix(false, true);
      }
    }
  }

  /** Solve the outer reach interval for one leg under a downward world shift. */
  private reachInterval(state: LegState): boolean {
    this.intervalV.copy(state.hipMetric).sub(state.targetMetric);
    const a = this.metricUp.lengthSq();
    const b = this.intervalV.dot(this.metricUp);
    const c = this.intervalV.lengthSq() - (state.upperLength + state.lowerLength) ** 2;
    const discriminant = b * b - a * c;
    const scale = Math.max(1, b * b, Math.abs(a * c));
    if (discriminant < -GroundedLegs.EPS * scale) return false;
    const root = Math.sqrt(Math.max(0, discriminant));
    const one = (b - root) / a;
    const two = (b + root) / a;
    const lower = Math.max(0, Math.min(one, two));
    const upper = Math.max(one, two);
    if (!(Number.isFinite(lower) && Number.isFinite(upper)) || upper < -GroundedLegs.EPS) {
      return false;
    }
    state.interval.lower = lower;
    state.interval.upper = upper;
    return true;
  }

  /** Solve a knee after the common pelvis correction has been selected. */
  private kneeSolution(state: LegState, delta: number): boolean {
    state.hipAfter.copy(state.hipMetric).addScaledVector(this.metricUp, -delta);
    state.reachAxis.copy(state.targetMetric).sub(state.hipAfter);
    const distance = state.reachAxis.length();
    const minimum = Math.abs(state.upperLength - state.lowerLength);
    const maximum = state.upperLength + state.lowerLength;
    const tolerance = GroundedLegs.EPS * Math.max(1, maximum);
    if (
      !(distance > GroundedLegs.EPS) ||
      distance < minimum - tolerance ||
      distance > maximum + tolerance
    ) {
      return false;
    }

    state.reachAxis.multiplyScalar(1 / distance);
    const along =
      (state.upperLength * state.upperLength -
        state.lowerLength * state.lowerLength +
        distance * distance) /
      (2 * distance);
    const heightSquared = state.upperLength * state.upperLength - along * along;
    if (heightSquared < -tolerance) return false;
    const height = Math.sqrt(Math.max(0, heightSquared));

    state.pole.copy(state.kneePole);
    state.pole.addScaledVector(state.reachAxis, -state.pole.dot(state.reachAxis));
    if (state.pole.lengthSq() <= GroundedLegs.EPS) {
      this.anatomicalForwardDirection(this.anatomicalForward);
      projectPole(this.anatomicalForward, state.reachAxis, this.fallbackPole);
      state.pole.copy(this.fallbackPole);
    }
    if (state.pole.lengthSq() <= GroundedLegs.EPS) {
      projectPole(this.metricUp, state.reachAxis, this.fallbackPole);
      state.pole.copy(this.fallbackPole);
    }
    if (state.pole.lengthSq() <= GroundedLegs.EPS) return false;
    // Keep the selected branch stable even when the fallback projection moves
    // through a near-parallel configuration.
    if (state.pole.dot(state.kneePole) < 0) state.pole.negate();
    state.pole.normalize();

    state.kneeMetric
      .copy(state.hipAfter)
      .addScaledVector(state.reachAxis, along)
      .addScaledVector(state.pole, height);
    state.upperTarget.copy(state.kneeMetric);
    state.lowerTarget.copy(state.targetMetric);
    state.upperTarget.sub(state.hipAfter);
    state.lowerTarget.sub(state.kneeMetric);
    if (
      state.upperTarget.lengthSq() <= GroundedLegs.EPS ||
      state.lowerTarget.lengthSq() <= GroundedLegs.EPS
    ) {
      return false;
    }
    state.upperTarget.normalize();
    state.lowerTarget.normalize();
    state.solution.hip.copy(state.hipAfter);
    state.solution.target.copy(state.targetMetric);
    state.solution.knee.copy(state.kneeMetric);
    state.solution.upperDir.copy(state.upperTarget);
    state.solution.lowerDir.copy(state.lowerTarget);
    return true;
  }

  /** Read the current anatomical-forward axis without allocating in apply(). */
  private anatomicalForwardDirection(out: THREE.Vector3): void {
    const chest = this.profile.bones.chest ?? this.profile.bones.spine ?? this.profile.bones.hips;
    const frame = this.profile.body;
    if (chest && frame) {
      this.forwardMetric.copy(this.metricInverse).multiply(chest.matrixWorld);
      this.forwardLinear.setFromMatrix4(this.forwardMetric);
      out.copy(frame.forward).applyMatrix3(this.forwardLinear);
      if (out.lengthSq() > GroundedLegs.EPS) {
        out.normalize();
        return;
      }
    }
    this.forwardLinear.setFromMatrix4(this.metricInverse);
    hipForward(this.profile, this.forwardLinear, out, this.forwardScratch);
  }

  /** Aim one link while retaining its captured local twist/rest frame. */
  private aimBone(
    bone: THREE.Bone,
    restQ: THREE.Quaternion,
    restDir: THREE.Vector3,
    targetMetricDir: THREE.Vector3,
  ): void {
    this.parentMetricQuaternion(bone, this.parentQ);
    this.parentInverseQ.copy(this.parentQ).invert();
    this.restParentDir.copy(restDir).applyQuaternion(restQ);
    this.targetParentDir.copy(targetMetricDir).applyQuaternion(this.parentInverseQ).normalize();
    if (this.restParentDir.lengthSq() <= GroundedLegs.EPS) return;
    this.aimDeltaQ.setFromUnitVectors(this.restParentDir.normalize(), this.targetParentDir);
    this.aimQ.copy(this.aimDeltaQ).multiply(restQ).normalize();
    bone.quaternion.copy(this.aimQ);
  }

  /** Pure parent rotation in the metric frame; ancestor scale is discarded. */
  private parentMetricQuaternion(bone: THREE.Bone, out: THREE.Quaternion): void {
    const parent = bone.parent;
    if (!parent) {
      out.identity();
      return;
    }
    this.rootMetric.copy(this.metricInverse).multiply(parent.matrixWorld);
    this.rootMetric.decompose(this.decomposePosition, out, this.decomposeScale);
    out.normalize();
  }
}

function validQuaternion(q: THREE.Quaternion): boolean {
  return (
    Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w)
  );
}

function uniformScale(scale: THREE.Vector3): boolean {
  const maximum = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
  return (
    Number.isFinite(maximum) &&
    maximum > GroundedLegs.EPS &&
    Math.abs(scale.x - scale.y) <= GroundedLegs.SCALE_ISOTROPY_EPS * maximum &&
    Math.abs(scale.x - scale.z) <= GroundedLegs.SCALE_ISOTROPY_EPS * maximum
  );
}

/** Direction of the body's anatomical forward axis in metric coordinates. */
function anatomicalForward(
  profile: Profile,
  metricInverse: THREE.Matrix4,
  out: THREE.Vector3,
): void {
  const chest = profile.bones.chest ?? profile.bones.spine ?? profile.bones.hips;
  const frame = profile.body;
  if (chest && frame) {
    const chestMetric = new THREE.Matrix4().copy(metricInverse).multiply(chest.matrixWorld);
    out.copy(frame.forward).applyMatrix3(new THREE.Matrix3().setFromMatrix4(chestMetric));
    if (out.lengthSq() > GroundedLegs.EPS) {
      out.normalize();
      return;
    }
  }
  const linear = new THREE.Matrix3().setFromMatrix4(metricInverse);
  hipForward(profile, linear, out, new THREE.Vector3());
}

/**
 * Without a body frame, forward by the same handedness — up cross the
 * character's right — with the right taken from the hips. Zero if they coincide.
 */
function hipForward(
  profile: Profile,
  metricInverseLinear: THREE.Matrix3,
  out: THREE.Vector3,
  scratch: THREE.Vector3,
): void {
  const left = profile.bones['upperLeg.L'];
  const right = profile.bones['upperLeg.R'];
  if (!(left && right)) {
    out.set(0, 0, 0);
    return;
  }
  right.getWorldPosition(scratch).sub(left.getWorldPosition(out));
  out.set(0, 1, 0).cross(scratch).applyMatrix3(metricInverseLinear);
  if (out.lengthSq() > GroundedLegs.EPS) out.normalize();
}

/** Project a direction onto the plane normal to `reach`, if it has one. */
function projectPole(direction: THREE.Vector3, reach: THREE.Vector3, out: THREE.Vector3): void {
  out.copy(direction);
  if (reach.lengthSq() <= GroundedLegs.EPS) {
    out.set(0, 0, 0);
    return;
  }
  const reachLength = Math.sqrt(reach.lengthSq());
  out.addScaledVector(reach, -out.dot(reach) / (reachLength * reachLength));
  if (out.lengthSq() <= GroundedLegs.EPS) {
    out.set(0, 0, 0);
    return;
  }
  out.normalize();
}
