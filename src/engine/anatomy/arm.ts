import * as THREE from 'three';
import type { BodyFrame, JointReading, JointTable, Profile, Side } from '../types';
import { cost, report, score } from './cost';
import { JOINTS } from './joints';
import type { ArmMeasurement, ArmStrain } from './measurement';
import { clampDof, elevationCeiling } from './strain';
import { BodyVolumes } from './volumes';

/**
 * Measurement and limiting for one arm.
 *
 * Holds its scratch vectors because it runs twice a frame for hours; the
 * measurement is a dozen dot products and allocating for it would be the
 * dominant cost.
 *
 * Two halves, and they are kept apart: measuring a pose and bounding one both
 * work on *directions*, which is what makes them portable across rigs, while
 * whether the arm is inside its own chest is a question about positions and
 * lives in `volumes.ts`. What a measured arm costs is `cost.ts`, which needs
 * only the numbers and no geometry at all.
 */
export class ArmAnatomy {
  p: Profile;
  frame: BodyFrame | null;
  limits: JointTable;

  // World-space frame, refreshed once per frame.
  up: THREE.Vector3;
  fwd: THREE.Vector3;
  right: THREE.Vector3;
  lateral: THREE.Vector3;

  private _h: THREE.Vector3;
  private _ref: THREE.Vector3;
  private _perp: THREE.Vector3;
  private _bend: THREE.Vector3;
  private _swing: THREE.Vector3;
  private _axis: THREE.Vector3;
  private _n: THREE.Vector3;
  private _rad: THREE.Vector3;
  private _q: THREE.Quaternion;

  radialSign: Record<Side, number>;

  /** The trunk and the head, and everything that asks a question of them. */
  private readonly body: BodyVolumes;

  m: ArmMeasurement;
  strain: ArmStrain;

  constructor(profile: Profile) {
    this.p = profile;
    this.frame = profile.body; // chest-local
    this.limits = profile.anatomy ?? JOINTS;

    // World-space frame, refreshed once per frame.
    this.up = new THREE.Vector3();
    this.fwd = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.lateral = new THREE.Vector3(); // per side: the character's outside

    this._h = new THREE.Vector3();
    this._ref = new THREE.Vector3();
    this._perp = new THREE.Vector3();
    this._bend = new THREE.Vector3();
    this._swing = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._rad = new THREE.Vector3();
    this._q = new THREE.Quaternion();

    // Which of ±(palm × forearm) points at the thumb. Settled once, from the
    // rest pose, because at solve time the hand is not posed yet and the
    // direction cannot be read off the knuckles.
    this.radialSign = { L: 1, R: 1 };
    this.solveRadial();

    this.body = new BodyVolumes(profile, this.frame, this.up, this.right, this.fwd);

    // Filled by `measure`, read by the UI and by the reach cost.
    this.m = {
      elevation: 0,
      plane: 0,
      rotation: 0,
      elbow: 0,
      forearm: 0,
      wristFlex: 0,
      wristDev: 0,
      torso: 0,
      inboard: 0,
      rotationRead: 0,
    };
    this.strain = {
      elevation: 0,
      rotation: 0,
      elbow: 0,
      forearm: 0,
      wristFlex: 0,
      wristDev: 0,
      torso: 0,
    };
  }

  /** Trunk axis origin, world, per frame. */
  get axisO(): THREE.Vector3 {
    return this.body.axisO;
  }

  private solveRadial(): void {
    const { bones, fingerBones } = this.p;
    const wp = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
    for (const side of ['L', 'R'] as Side[]) {
      const hand = bones[`hand.${side}`];
      const index = fingerBones[`index.${side}`]?.[0];
      const little = fingerBones[`little.${side}`]?.[0];
      const middle = fingerBones[`middle.${side}`]?.[0];
      if (!(hand && index && little && middle)) continue;
      hand.updateWorldMatrix(true, false);
      const along = wp(middle).sub(wp(hand)).normalize();
      const across = wp(index).sub(wp(little)).normalize(); // toward the thumb
      const palm = new THREE.Vector3()
        .crossVectors(along, wp(little).sub(wp(index)).normalize())
        .normalize();
      if (palm.y > 0) palm.negate(); // bind poses hang the palms down
      const n = new THREE.Vector3().crossVectors(palm, along);
      this.radialSign[side] = n.dot(across) >= 0 ? 1 : -1;
    }
  }

  /** Refresh the world-space body frame. Call once per frame, before measuring. */
  update(): boolean {
    const chest = this.p.bones.chest ?? this.p.bones.spine ?? this.p.bones.hips;
    if (!(this.frame && chest)) return false;
    chest.updateWorldMatrix(true, false);
    const q = chest.getWorldQuaternion(this._q);
    this.up.copy(this.frame.up).applyQuaternion(q);
    this.fwd.copy(this.frame.forward).applyQuaternion(q);
    this.right.copy(this.frame.right).applyQuaternion(q);
    this.body.update(chest);
    return true;
  }

  /**
   * Tell the model where this arm starts and how long its two segments are, so
   * the arm can be *placed* rather than only pointed.
   *
   * Everything else here works on directions, which is what keeps it portable.
   * The torso is the exception: whether the arm is inside the chest is a
   * question about positions, and no amount of angle says it.
   */
  setArm(S: THREE.Vector3, La: number, Lf = 0, Lh = 0): void {
    this.body.setArm(S, La, Lf, Lh);
  }

  clearArm(): void {
    this.body.clearArm();
  }

  /** Point `lateral` at the character's outside for this side. */
  private side(side: Side): void {
    this.lateral.copy(this.right);
    if (side === 'L') this.lateral.negate();
  }

  // --- measurement --------------------------------------------------------

  /**
   * Shoulder position of the upper arm direction, as (elevation, plane).
   *
   * Elevation is measured from the arm hanging straight down, which is where a
   * goniometer measures it from and — usefully — is also a pose no rig can
   * disagree about, unlike a T-pose or an A-pose.
   */
  private shoulder(side: Side, u: THREE.Vector3): { theta: number; plane: number } {
    this.side(side);
    const theta = Math.acos(THREE.MathUtils.clamp(-u.dot(this.up), -1, 1));
    const h = this._h.copy(u);
    h.addScaledVector(this.up, -h.dot(this.up));
    // Straight down: the plane is undefined and so is any limit that uses it.
    const plane = h.lengthSq() < 1e-8 ? 0 : Math.atan2(h.dot(this.fwd), h.dot(this.lateral));
    return { theta, plane };
  }

  /**
   * Zero-rotation reference for the humerus: the direction the elbow points
   * when the arm is neutral, which is forward.
   *
   * Degenerates when the arm itself points forward, and then falls back to
   * down. Rotation about a swinging axis is path-dependent in general — the
   * same end pose is reachable with different accumulated twist — so this is a
   * reference, not a measurement of how the arm got there. For bounding a pose
   * that is the right thing: what matters is whether the elbow ends up
   * somewhere a shoulder can put it.
   */
  private humeralRef(u: THREE.Vector3): THREE.Vector3 {
    const r = this._ref.copy(this.fwd);
    r.addScaledVector(u, -r.dot(u));
    if (r.lengthSq() < 0.04) {
      r.copy(this.up).negate();
      r.addScaledVector(u, -r.dot(u));
    }
    return r.normalize();
  }

  /** Orthonormal partner to `ref` in the plane normal to `u`, toward outside. */
  private lateralPerp(u: THREE.Vector3, ref: THREE.Vector3): THREE.Vector3 {
    const p = this._perp.copy(this.lateral);
    p.addScaledVector(u, -p.dot(u));
    p.addScaledVector(ref, -p.dot(ref));
    if (p.lengthSq() < 1e-10) p.crossVectors(u, ref);
    return p.normalize();
  }

  /**
   * Measure one arm from its three world directions.
   *
   * `palmN` is the palm normal — needed to tell wrist flexion from deviation,
   * since both are a bend of the hand away from the forearm and only the palm
   * says which plane it happened in. Where the caller has a palm *target* it
   * should pass that: it is what the hand is about to be rolled to, and it is
   * known before the aim rather than after it.
   *
   * **Pass null when the palm is genuinely unconstrained**, and the bend is
   * scored as pure flexion — the best orientation available. That is not a
   * shortcut, it is what the arm does: the forearm rolls so the hand bends the
   * way a hand bends. Scoring an unconstrained wrist against an assumed palm
   * charges it for deviation it would never have to make, and a wrist has three
   * times more flexion than deviation, so the difference decides poses.
   */
  measure(
    side: Side,
    u: THREE.Vector3,
    l: THREE.Vector3,
    h: THREE.Vector3,
    palmN: THREE.Vector3 | null,
    forearmRoll = 0,
    humeralRoll = 0,
  ): ArmMeasurement {
    this.side(side);
    const m = this.m;

    const sh = this.shoulder(side, u);
    m.elevation = sh.theta;
    m.plane = sh.plane;
    m.torso = this.body.torsoDepth(u, l, h);

    // Elbow: the angle between the two segments, and nothing else. Straight is
    // zero however the arm is oriented in the world.
    m.elbow = Math.acos(THREE.MathUtils.clamp(u.dot(l), -1, 1));

    // Humeral rotation, read off where the elbow points. Meaningless on a
    // straight arm — there is no bend to point anywhere — and reported as
    // neutral there rather than as noise.
    const ref = this.humeralRef(u);
    const perp = this._perp.copy(this.lateral);
    perp.addScaledVector(u, -perp.dot(u));
    perp.addScaledVector(ref, -perp.dot(ref));
    if (perp.lengthSq() < 1e-10) perp.crossVectors(u, ref);
    perp.normalize();
    // How much the measurement can be trusted: nothing below 15 degrees of
    // elbow bend, fully by 45.
    m.rotationRead = THREE.MathUtils.clamp((m.elbow - 0.26) / 0.52, 0, 1);
    const bend = this._bend.copy(l);
    bend.addScaledVector(u, -bend.dot(u));
    if (m.rotationRead > 0 && bend.lengthSq() > 1e-10) {
      bend.normalize();
      m.rotation = Math.atan2(bend.dot(perp), bend.dot(ref));
    } else m.rotation = 0;

    // Twist applied to the humerus about its own axis, which the geometry above
    // cannot see: rolling a bone about the line it points along moves nothing
    // that this model measures. It is the same degree of freedom as the reading
    // from the elbow, so the two add.
    //
    // Applied rotation is known exactly, unlike the inferred kind, so it carries
    // its own confidence: a straight arm whose humerus was deliberately rolled
    // 40 degrees has a rotation worth reporting even though there is no elbow
    // bend to read it from.
    if (humeralRoll) {
      m.rotation += humeralRoll;
      m.rotationRead = Math.max(m.rotationRead, Math.min(1, Math.abs(humeralRoll) / 0.09));
    }

    // How far the elbow has come inside the shoulder, 0 when it is directly
    // below or above it and 1 when it points straight across the midline.
    //
    // A direction, not a distance: the elbow sits at S + u * La, so its offset
    // from the shoulder along the body's lateral axis is exactly `u . lateral`
    // times a length that divides straight back out again.
    m.inboard = Math.max(0, -u.dot(this.lateral));

    m.forearm = forearmRoll;

    // Wrist: the swing of the hand away from the forearm, split into the plane
    // the palm faces (flexion) and the plane it lies in (deviation).
    const swing = this._swing.copy(h);
    swing.addScaledVector(l, -swing.dot(l));
    const theta = Math.acos(THREE.MathUtils.clamp(l.dot(h), -1, 1));
    if (swing.lengthSq() > 1e-10 && theta > 1e-4) {
      swing.normalize();
      if (!palmN) {
        // Free to roll: the forearm turns until the bend is flexion.
        m.wristFlex = theta;
        m.wristDev = 0;
      } else {
        const n = this._n.copy(palmN);
        n.addScaledVector(l, -n.dot(l));
        if (n.lengthSq() > 1e-10) {
          n.normalize();
          const rad = this._rad
            .crossVectors(n, l)
            .multiplyScalar(this.radialSign[side])
            .normalize();
          m.wristFlex = theta * swing.dot(n);
          m.wristDev = theta * swing.dot(rad);
        } else {
          m.wristFlex = 0;
          m.wristDev = theta;
        }
      }
    } else {
      m.wristFlex = 0;
      m.wristDev = 0;
    }

    return m;
  }

  /**
   * Strain per degree of freedom for the last measurement.
   *
   * Returned as a shared object, deliberately: this runs inside a search loop
   * that evaluates a couple of dozen candidates per arm per frame.
   */
  score(): ArmStrain {
    return score(this.m, this.limits, this.strain);
  }

  /**
   * One number for how unlikely a pose is — what the elbow search minimises.
   * See `cost.ts` for what each term is there to prevent.
   */
  cost(): number {
    return cost(this.m, this.limits, this.strain);
  }

  /** A readable snapshot, for the panel. Allocates; not for the frame loop. */
  report(): JointReading[] {
    return report(this.m, this.limits, this.strain, {
      torso: !!this.body.torso,
      arm: this.body.armSet,
    });
  }

  // --- limiting -----------------------------------------------------------
  /**
   * Pull a set of arm directions inside the hard stops, in place.
   *
   * Applied to everything, not only to solved reaches: an authored direction is
   * as capable of naming an impossible pose as a solver is, and a gesture that
   * has to be checked by hand against a table of angles is a gesture that will
   * not be.
   */
  clamp(
    side: Side,
    u: THREE.Vector3,
    l: THREE.Vector3,
    h: THREE.Vector3,
    palmN: THREE.Vector3 | null,
  ): void {
    this.side(side);

    // --- shoulder: how far it may lift, in the plane it lifted in -----------
    const sh = this.shoulder(side, u);
    const ceil = elevationCeiling(sh.plane);
    if (sh.theta > ceil.max) {
      const p = sh.plane;
      const st = Math.sin(ceil.max);
      const ct = Math.cos(ceil.max);
      u.copy(this.up)
        .multiplyScalar(-ct)
        .addScaledVector(this.lateral, st * Math.cos(p))
        .addScaledVector(this.fwd, st * Math.sin(p))
        .normalize();
    }

    this.clampElbow(u, l);
    this.clampWrist(side, l, h, palmN);

    // --- and last, out of its own chest -------------------------------------
    //
    // Last because it outranks the rest. The elevation ceiling and the trunk
    // disagree constantly — the ceiling drops toward the midline precisely
    // because the ribcage is there, so cutting elevation at a plane that points
    // across the body is a rotation *into* the chest. Whichever of the two runs
    // second wins, and the trunk has to be the one that does: an arm at an odd
    // elevation is a pose, an arm inside the ribcage is a hole in the character.
    //
    // Run here because it outranks the angular limits: the escape may leave a
    // joint over its stop, and that is the trade being made. The panel reports
    // it, so a pose bought at that price is visible rather than silent.
    this.body.clear(u, l, h, this.lateral);
  }

  /**
   * Re-run the hand's escape alone, after something downstream has moved it.
   *
   * The rig layer re-bounds the wrist once the roll is settled, against the palm
   * the arm actually reached rather than the one the pose asked for — and that
   * runs after the clamp, so it can put a hand straight back into the face it
   * was just lifted off. It did: the three poses still reporting contact were
   * all hand-only, all of them past the wrist, and all of them cleared before
   * this second bound undid it.
   *
   * Only the hand moves, about the wrist, so nothing above it is disturbed and
   * the caller's already-posed arm stays valid.
   */
  clearHand(
    side: Side,
    u: THREE.Vector3,
    l: THREE.Vector3 | null,
    h: THREE.Vector3 | null,
  ): boolean {
    this.side(side);
    return this.body.clear(u, l, h, this.lateral, 'hand');
  }

  /** Bound the elbow's flexion, and the direction it bent in, in place. */
  private clampElbow(u: THREE.Vector3, l: THREE.Vector3): void {
    const L = this.limits;
    const ref = this.humeralRef(u);
    const perp = this.lateralPerp(u, ref);
    let flex = Math.acos(THREE.MathUtils.clamp(u.dot(l), -1, 1));
    const bend = this._bend.copy(l);
    bend.addScaledVector(u, -bend.dot(u));
    // Below a usable bend the rotation is not measured, so it must not be
    // corrected either — rebuilding the forearm from a noisy angle would swing
    // a nearly straight arm sideways to satisfy a number that means nothing.
    if (flex > 0.26 && bend.lengthSq() > 1e-10) {
      bend.normalize();
      const rot = Math.atan2(bend.dot(perp), bend.dot(ref));
      const cf = clampDof(flex, L.elbow.dofs.flexion);
      const cr = clampDof(rot, L.shoulder.dofs.rotation);
      if (cf !== flex || cr !== rot) {
        flex = cf;
        bend.copy(ref).multiplyScalar(Math.cos(cr)).addScaledVector(perp, Math.sin(cr));
        l.copy(u).multiplyScalar(Math.cos(flex)).addScaledVector(bend, Math.sin(flex)).normalize();
      }
    } else if (flex > L.elbow.dofs.flexion.max[1]) {
      // Folded straight back onto the upper arm with no bend direction at all.
      l.copy(u);
    }
  }

  /**
   * Pull the hand inside the wrist's stops, in place.
   *
   * Separate from `clamp` because it has to be able to run twice. The split of a
   * wrist bend into flexion and deviation is taken in the palm's frame, and the
   * palm is not known when the rest of the arm is bounded: which way it faces is
   * decided by the roll, and the roll is solved during the aim. So the first run
   * bounds the wrist against the palm the pose asked for, and the caller runs it
   * again against the palm the arm actually ended up with.
   *
   * Without the second run the two disagree by however much of the roll the arm
   * could not deliver, and a bend bounded as 40 degrees of flexion comes out as
   * 80 degrees of deviation against a limit of 20 — clamped, reported as
   * over-range, and both statements true of different poses.
   */
  clampWrist(side: Side, l: THREE.Vector3, h: THREE.Vector3, palmN: THREE.Vector3 | null): void {
    this.side(side);
    const L = this.limits;
    const swing = this._swing.copy(h);
    swing.addScaledVector(l, -swing.dot(l));
    const theta = Math.acos(THREE.MathUtils.clamp(l.dot(h), -1, 1));
    if (swing.lengthSq() < 1e-10 || theta < 1e-4) return;
    swing.normalize();
    if (!palmN) {
      // Palm unconstrained, so the forearm rolls until the bend is flexion and
      // only the flexion limit applies. Bounding it against deviation as well
      // would clamp a wrist for a rotation it was never going to have to make.
      const cap = L.wrist.dofs.flexion.max[1];
      if (theta <= cap) return;
      h.copy(l).multiplyScalar(Math.cos(cap)).addScaledVector(swing, Math.sin(cap)).normalize();
      return;
    }
    const n = this._n.copy(palmN);
    n.addScaledVector(l, -n.dot(l));
    if (n.lengthSq() < 1e-10) return;
    n.normalize();
    const rad = this._rad.crossVectors(n, l).multiplyScalar(this.radialSign[side]).normalize();
    const f = theta * swing.dot(n);
    const dv = theta * swing.dot(rad);
    const cf = clampDof(f, L.wrist.dofs.flexion);
    const cd = clampDof(dv, L.wrist.dofs.deviation);
    if (cf === f && cd === dv) return;
    const mag = Math.hypot(cf, cd);
    if (mag < 1e-6) {
      h.copy(l);
      return;
    }
    this._axis
      .copy(n)
      .multiplyScalar(cf / mag)
      .addScaledVector(rad, cd / mag);
    h.copy(l).multiplyScalar(Math.cos(mag)).addScaledVector(this._axis, Math.sin(mag)).normalize();
  }
}
