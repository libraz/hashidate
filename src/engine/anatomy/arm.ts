import * as THREE from 'three';
import type { Localized } from '../../i18n/locale';
import type { BodyFrame, BoneSlot, JointReading, JointTable, Profile, Side } from '../types';
import {
  BODY_DEPTH,
  BODY_HIT,
  D,
  INBOARD_COST,
  JOINTS,
  LIFT_COST,
  TORSO_ARM_START,
  TORSO_BANDS,
  TORSO_PASSES,
  TORSO_SAMPLES,
  TORSO_SECTORS,
} from './joints';
import { clampDof, elevationCeiling, elevationStrain, excessOf, strainOf, zoneOf } from './strain';
import { type MeasuredVolume, measureVolume, surfaceOf } from './volume';

/** Where a volume sits and how it is oriented, in world space, this frame. */
export interface VolumeFrame {
  O: THREE.Vector3;
  up: THREE.Vector3;
  right: THREE.Vector3;
  fwd: THREE.Vector3;
}

/** The head's surface plus the bone and rest axes that carry it each frame. */
interface HeadMeasurement extends MeasuredVolume {
  bone: THREE.Bone;
  local: { up: THREE.Vector3; right: THREE.Vector3; forward: THREE.Vector3 };
}

type HeadVolume = HeadMeasurement & VolumeFrame;

/** Where this arm starts and how long its segments are, in world units. */
interface ArmSegments {
  S: THREE.Vector3;
  La: number;
  Lf: number;
  Lh: number;
  set: boolean;
}

/** The deepest sample found on a run of the arm, and what it is inside. */
interface DeepResult {
  depth: number;
  vol: MeasuredVolume | null;
  frame: VolumeFrame | null;
}

/**
 * One arm's pose, in the quantities anatomy has an opinion about. Radians,
 * except `torso` and `inboard`, which are fractions.
 */
export interface ArmMeasurement {
  elevation: number;
  plane: number;
  rotation: number;
  elbow: number;
  forearm: number;
  wristFlex: number;
  wristDev: number;
  torso: number;
  inboard: number;
  /** How much the humeral rotation reading can be trusted, 0..1. */
  rotationRead: number;
}

/** Strain per degree of freedom, 0 inside the free band and 1 at the stop. */
export interface ArmStrain {
  elevation: number;
  rotation: number;
  elbow: number;
  forearm: number;
  wristFlex: number;
  wristDev: number;
  torso: number;
}

/**
 * Measurement and limiting for one arm.
 *
 * Holds its scratch vectors because it runs twice a frame for hours; the
 * measurement is a dozen dot products and allocating for it would be the
 * dominant cost.
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

  torso: MeasuredVolume | null;
  axisO: THREE.Vector3;
  private _hq: THREE.Quaternion;
  head: HeadVolume | null;
  private _rel: THREE.Vector3;
  private _trunkFrame: VolumeFrame;
  private _inVol: MeasuredVolume | null;
  private _inFrame: VolumeFrame;
  private _arm: ArmSegments;
  private _probe: THREE.Vector3;
  private _deep: DeepResult;
  private _hit: THREE.Vector3;
  private _want: THREE.Vector3;
  private _from: THREE.Vector3;
  private _swing2: THREE.Quaternion;
  private _elbow: THREE.Vector3;
  private _wrist: THREE.Vector3;
  private _radial: THREE.Vector3;

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

    /**
     * The torso, as a cylinder the elbow may not enter.
     *
     * Joint angles are not the whole of a range of motion. The reason you
     * cannot swing your elbow twenty centimetres to the left is not that a
     * shoulder runs out of rotation — it is that your ribcage is there. The
     * angular model approximates this at the top, through the elevation ceiling
     * that closes down across the midline, and misses it entirely at the
     * bottom: below about 25 degrees of elevation the ceiling permits any
     * plane, including pointing the upper arm straight into the chest.
     *
     * Radius is measured, not assumed: the shoulder joint sits at roughly the
     * outer edge of the trunk, so its horizontal offset from the spine is the
     * half-width. Taken at 0.9 to leave the arms their resting position, which
     * hangs slightly outboard of the shoulder on this avatar and slightly
     * inboard on others.
     *
     * In world units. Chest-local distances are not usable here — the armature
     * carries a 0.01 scale on this avatar — and the reach lengths this is
     * compared against are world-space.
     */
    this.torso = this.buildTorso();
    this.axisO = new THREE.Vector3(); // trunk axis origin, world, per frame
    this._hq = new THREE.Quaternion();
    const head = this.buildHead();
    this.head = head
      ? {
          ...head,
          O: new THREE.Vector3(),
          up: new THREE.Vector3(),
          right: new THREE.Vector3(),
          fwd: new THREE.Vector3(),
        }
      : null;
    this._rel = new THREE.Vector3();
    // The trunk's frame as one object, so a volume and its axes travel together.
    // The vectors are the live ones, refreshed in `update`.
    this._trunkFrame = { O: this.axisO, up: this.up, right: this.right, fwd: this.fwd };
    this._inVol = this.torso;
    this._inFrame = this._trunkFrame;
    this._arm = { S: new THREE.Vector3(), La: 0, Lf: 0, Lh: 0, set: false };
    this._probe = new THREE.Vector3();
    this._deep = { depth: 0, vol: null, frame: null };
    this._hit = new THREE.Vector3();
    this._want = new THREE.Vector3();
    this._from = new THREE.Vector3();
    this._swing2 = new THREE.Quaternion();
    this._elbow = new THREE.Vector3();
    this._wrist = new THREE.Vector3();
    this._radial = new THREE.Vector3();

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

  /**
   * Trunk half-width and vertical span, in world units, from the rest pose.
   */
  private measureTorso(): MeasuredVolume | null {
    const { bones } = this.p;
    const chest = bones.chest ?? bones.spine ?? bones.hips;
    // The upper arm and not the clavicle. `shoulder.*` is the clavicle root,
    // which sits beside the neck: measured from there the trunk came out with a
    // radius of 0.034 against an upper arm of 0.171, a torso a fifth as wide as
    // one arm segment, and nothing ever touched it. The glenohumeral joint is
    // where the arm actually hangs from, and it is at the edge of the trunk.
    const sL = bones['upperArm.L'] ?? bones['shoulder.L'];
    const sR = bones['upperArm.R'] ?? bones['shoulder.R'];
    if (!(chest && sL && sR && this.frame)) return null;
    const w = (b: THREE.Bone) => b.getWorldPosition(new THREE.Vector3());
    const q = chest.getWorldQuaternion(new THREE.Quaternion());
    const up = this.frame.up.clone().applyQuaternion(q);
    const O = w(chest);
    // Horizontal distance from the trunk axis to each shoulder.
    const off = (b: THREE.Bone) => {
      const v = w(b).sub(O);
      v.addScaledVector(up, -v.dot(up));
      return v.length();
    };
    const radius = ((off(sL) + off(sR)) / 2) * 0.9;
    // Only between the hips and the shoulders is there a trunk to hit.
    const hips = bones.hips ? w(bones.hips).sub(O).dot(up) : -radius * 3;
    const top = w(sR).sub(O).dot(up);
    return radius > 1e-6
      ? {
          r: null,
          bands: TORSO_BANDS,
          sectors: TORSO_SECTORS,
          radius,
          top,
          bottom: Math.min(hips, top - 1e-4),
        }
      : null;
  }

  /**
   * The trunk's actual surface, measured off the mesh.
   *
   * A cylinder sized from the shoulders is the wrong shape, and being the wrong
   * shape it cannot be tuned into the right answer: a chest is markedly wider
   * than it is deep, so one radius is simultaneously too small at the sides and
   * too large in front. Too small at the sides means an arm crossing the body
   * passes through the ribs with nothing reported; too large in front means a
   * hand deliberately placed on the sternum reads as buried, so the poses that
   * *should* touch the chest cannot be told from the ones that go through it.
   *
   * Stored as a radius per (height band, angular sector) in the chest's own
   * frame, which is the same frame the cylinder used — so it still follows the
   * chest when the spine turns, and the query is still a couple of lookups.
   *
   * Read at bind pose, where skinning is the identity and a vertex's world
   * position is just its position through the mesh's world matrix. This runs at
   * load, before anything is posed, which is the only time that holds.
   *
   * Only vertices whose *dominant* bone is part of the trunk are counted. The
   * arms rest inside the trunk's height band in a bind pose, and a maximum over
   * everything there would inflate the sides by an entire arm.
   */
  private buildTorso(): MeasuredVolume | null {
    const base = this.measureTorso();
    const root = this.p.root;
    const { bones } = this.p;
    const chest = bones.chest ?? bones.spine ?? bones.hips;
    if (!(base && root && this.frame && chest)) return base;

    // The trunk is the spine's whole subtree, stopping where the limbs and the
    // head begin. Taken as a subtree and not as the four named slots because a
    // rig puts the parts that stick out on their own bones — the bust is
    // `Breast_L`/`Breast_R` here — and those are exactly the parts a collision
    // surface exists to describe. Named-slot-only left the chest a smooth tube.
    const stop = new Set<THREE.Bone>();
    const stopSlots: BoneSlot[] = [
      'shoulder.L',
      'shoulder.R',
      'upperArm.L',
      'upperArm.R',
      'head',
      'neck',
    ];
    for (const slot of stopSlots) {
      const b = bones[slot];
      if (b) stop.add(b);
    }
    const trunk = new Set<THREE.Bone>();
    const walk = (b: THREE.Bone | undefined) => {
      if (!b || stop.has(b) || trunk.has(b)) return;
      trunk.add(b);
      for (const c of b.children) if (c instanceof THREE.Bone) walk(c);
    };
    if (bones.hips) trunk.add(bones.hips); // itself, not the legs below it
    walk(bones.spine ?? chest);
    walk(chest);

    const q = chest.getWorldQuaternion(new THREE.Quaternion());
    const up = this.frame.up.clone().applyQuaternion(q);
    const right = this.frame.right.clone().applyQuaternion(q);
    const fwd = this.frame.forward.clone().applyQuaternion(q);
    const O = chest.getWorldPosition(new THREE.Vector3());
    // The height range is fixed rather than taken from the vertices: the trunk
    // has to stop at the shoulders, or the neck stub raises its top and an arm
    // resting beside the neck reads as inside the body.
    const vol = measureVolume(root, trunk, O, up, right, fwd, {
      top: base.top,
      bottom: base.bottom,
    });
    return vol ? { ...base, ...vol } : base;
  }

  /**
   * The head, measured the same way as the trunk.
   *
   * A separate volume rather than an extension of the trunk because it moves
   * separately: a head turns and tips under the chest, so a surface stored in
   * the chest's frame would swing away from the skull it is meant to describe.
   * Its own frame is the one the face anchors already use.
   *
   * Without it the whole face is empty space to the arm. Every gesture in the
   * table that touches the face aims at a point *on* the head, so the hand
   * arrives at the surface and the fingers carry on into it.
   *
   * The extent is taken from the vertices rather than from bones, because there
   * is no second bone to measure a head against the way the shoulders measure
   * the trunk.
   *
   * Hair is excluded for free: it hangs off its own bones, so the dominant-bone
   * filter never sees it. That is the behaviour to want — a hand should be able
   * to touch hair, and pushing it out to the far side of a twintail would put it
   * a head's width away from the head.
   */
  private buildHead(): HeadMeasurement | null {
    const head = this.p.bones.head;
    const face = this.p.face;
    if (!(head && face && this.p.root)) return null;

    const set = new Set<THREE.Bone>();
    const walk = (b: THREE.Bone) => {
      if (!b || set.has(b)) return;
      set.add(b);
      for (const c of b.children) if (c instanceof THREE.Bone) walk(c);
    };
    walk(head);

    const q = head.getWorldQuaternion(new THREE.Quaternion());
    const up = face.up.clone().applyQuaternion(q).normalize();
    const right = face.right.clone().applyQuaternion(q).normalize();
    const fwd = face.forward.clone().applyQuaternion(q).normalize();
    const O = head.getWorldPosition(new THREE.Vector3());
    const vol = measureVolume(this.p.root, set, O, up, right, fwd);
    if (!vol) return null;
    return {
      ...vol,
      bone: head,
      local: { up: face.up, right: face.right, forward: face.forward },
    };
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
    chest.getWorldPosition(this.axisO);
    // The head carries its own frame: it turns and tips under the chest, so its
    // surface has to be queried in axes that turn with it.
    const h = this.head;
    if (h) {
      h.bone.updateWorldMatrix(true, false);
      const hq = h.bone.getWorldQuaternion(this._hq);
      h.up.copy(h.local.up).applyQuaternion(hq);
      h.fwd.copy(h.local.forward).applyQuaternion(hq);
      h.right.copy(h.local.right).applyQuaternion(hq);
      h.bone.getWorldPosition(h.O);
    }
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
    this._arm.S.copy(S);
    this._arm.La = La;
    this._arm.Lf = Lf;
    this._arm.Lh = Lh;
    this._arm.set = true;
  }

  clearArm(): void {
    this._arm.set = false;
  }

  /**
   * How deep a world point is inside one volume, as a fraction of its radius.
   * Zero when clear, or outside the volume's height.
   */
  private depthIn(
    vol: MeasuredVolume,
    O: THREE.Vector3,
    up: THREE.Vector3,
    right: THREE.Vector3,
    fwd: THREE.Vector3,
    P: THREE.Vector3,
  ): number {
    const rel = this._rel.copy(P).sub(O);
    const h = rel.dot(up);
    if (h > vol.top || h < vol.bottom) return 0;
    this._radial.copy(rel).addScaledVector(up, -h);
    const r = this._radial.length();
    const R = surfaceOf(vol, h, Math.atan2(this._radial.dot(fwd), this._radial.dot(right)));
    return R > 1e-9 ? (R - r) / R : 0;
  }

  /**
   * How deep a world point is inside the body — the worst of the parts it could
   * be inside. `this._inVol` records which one, so a clamp knows what to push
   * out of.
   */
  private depthAt(P: THREE.Vector3): number {
    const t = this.torso;
    let worst = t ? this.depthIn(t, this.axisO, this.up, this.right, this.fwd, P) : 0;
    let which: MeasuredVolume | null = t;
    let frame: VolumeFrame = this._trunkFrame;
    const hd = this.head;
    if (hd) {
      const d = this.depthIn(hd, hd.O, hd.up, hd.right, hd.fwd, P);
      if (d > worst) {
        worst = d;
        which = hd;
        frame = hd;
      }
    }
    this._inVol = which;
    this._inFrame = frame;
    return worst;
  }

  /**
   * How far the arm has pushed into the trunk, as a fraction of the radius.
   *
   * Sampled along both segments, not read off the elbow.
   *
   * Testing the elbow alone is what the first version did, and it misses the
   * case the constraint exists for. Bringing a hand to the chin puts the wrist
   * on the midline and the shoulder out at the side, so the arm crosses the
   * chest between them — with *both ends outside the trunk*. On the validation
   * avatar the elbow sat at 1.23 radii, comfortably clear, while the middle of
   * the upper arm was at 0.48 and the forearm went through the breast. The
   * measurement said no contact, so the elbow search had no reason to prefer
   * bringing the arm forward, and picked the pose that went straight through.
   *
   * Six samples per segment. The trunk is a cylinder approximating a ribcage;
   * resolving the deepest point to better than a sixth of a segment is precision
   * the shape does not have.
   */
  private torsoDepth(
    u: THREE.Vector3,
    l: THREE.Vector3 | null = null,
    h: THREE.Vector3 | null = null,
  ): number {
    const w = this.deepest(u, l, null, h);
    // A pose the clamp has pushed out sits exactly on the surface, and floating
    // point leaves it a hair inside. Without a tolerance every such pose is
    // reported as a contact, at a depth of zero.
    return w.depth > 0.01 ? w.depth : 0;
  }

  /**
   * The most buried point on the arm, in world space. `into`, if given, receives
   * that point, and `res.vol`/`res.frame` say which body part it is inside so
   * the clamp knows what to push out of.
   */
  private deepest(
    u: THREE.Vector3,
    l: THREE.Vector3 | null,
    into: THREE.Vector3 | null,
    h: THREE.Vector3 | null = null,
  ): DeepResult {
    const t = this.torso;
    const res = this._deep;
    res.depth = 0;
    res.vol = null;
    if (!(t && this._arm.set)) return res;
    const S = this._arm.S;
    const La = this._arm.La;
    const Lf = this._arm.Lf;
    const Lh = this._arm.Lh;
    const test = (base: THREE.Vector3, dir: THREE.Vector3, d: number) => {
      const P = this._probe.copy(base).addScaledVector(dir, d);
      const depth = this.depthAt(P);
      if (depth > res.depth) {
        res.depth = depth;
        res.vol = this._inVol;
        res.frame = this._inFrame;
        if (into) into.copy(P);
      }
    };
    const span = La * (1 - TORSO_ARM_START);
    for (let i = 0; i <= TORSO_SAMPLES; i++) {
      test(S, u, La * TORSO_ARM_START + (span * i) / TORSO_SAMPLES);
    }
    if (!l || Lf <= 0) return res;
    const E = this._elbow.copy(S).addScaledVector(u, La);
    for (let i = 1; i <= TORSO_SAMPLES; i++) test(E, l, (Lf * i) / TORSO_SAMPLES);
    // The hand, along the palm only. Testable at all because the surface is
    // measured: against a cylinder the front of the chest reads far too wide,
    // and a hand deliberately laid on the sternum could not be told from one
    // pushed through it.
    if (h && Lh > 0) {
      const W = this._wrist.copy(E).addScaledVector(l, Lf);
      for (let i = 1; i <= TORSO_SAMPLES; i++) test(W, h, (Lh * i) / TORSO_SAMPLES);
    }
    return res;
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
    m.torso = this.torsoDepth(u, l, h);

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
    const L = this.limits;
    const m = this.m;
    const s = this.strain;
    s.elevation = elevationStrain(m.elevation, elevationCeiling(m.plane));
    // Humeral rotation is read off where the elbow points, so a straight elbow
    // does not measure it: there is no bend to point anywhere, and what is left
    // is the direction of a vector that is almost entirely rounding error. This
    // is why the clinical test flexes the elbow to 90 first.
    //
    // Without the fade, an arm resting at the side — 11 degrees of elbow bend —
    // reported 50 degrees of rotation and was flagged strained. Every gesture
    // in the table was, including the ones that do not move the arms at all.
    s.rotation = strainOf(m.rotation, L.shoulder.dofs.rotation) * m.rotationRead;
    s.elbow = strainOf(m.elbow, L.elbow.dofs.flexion);
    s.forearm = strainOf(m.forearm, L.elbow.dofs.rotation);
    s.wristFlex = strainOf(m.wristFlex, L.wrist.dofs.flexion);
    s.wristDev = strainOf(m.wristDev, L.wrist.dofs.deviation);
    // Contact, not strain — but it belongs in the same table, because to
    // whoever is watching an elbow inside the ribcage and an elbow past its
    // rotation stop are the same defect. Any penetration at all is the limit;
    // there is no comfortable amount of being inside your own chest.
    s.torso = m.torso > 0 ? 1 : 0;
    return s;
  }

  /**
   * One number for how unlikely a pose is — what the elbow search minimises.
   *
   * Strain is only part of it. Range of motion says which poses are *possible*,
   * and for a fingertip target most of the elbow circle is: pointing straight
   * ahead can be done with the elbow hanging below the wrist or cocked above
   * it, and both are comfortably inside every joint's range. Scored on strain
   * alone the two are indistinguishable, and the search picked the raised elbow
   * — anatomically fine, and not what anybody does.
   *
   * So effort is scored as well. Holding an arm up costs something whether or
   * not any joint is near its limit, and that cost is what separates the pose a
   * person adopts from the set of poses a person could adopt.
   */
  cost(): number {
    const s = this.score();
    let total = 0;
    // Squared, so the search spreads strain rather than concentrating it: two
    // joints slightly outside comfortable beat one joint at its stop, which is
    // both how a person distributes a reach and what stops the solver parking a
    // single joint against a hard limit while the rest of the arm idles.
    //
    // Torso contact is excluded and charged below: it is not a strain that gets
    // gradually worse, and squaring a binary would leave the search no slope to
    // follow out of the chest.
    for (const k in s) {
      if (k !== 'torso') {
        const v = s[k as keyof ArmStrain];
        total += v * v;
      }
    }
    // The hard stop is not just an expensive place to be, it is a place the
    // result will be clamped out of — so a candidate that reaches one is worse
    // than its strain suggests, because the pose that comes back is not the
    // pose that was scored.
    for (const k in s) if (k !== 'torso' && s[k as keyof ArmStrain] >= 1) total += 4;
    // And how far past it. Strain stops at the stop; this does not, so where
    // nothing on the elbow circle is reachable the search can still tell the
    // least impossible pose from the worst one instead of choosing between
    // saturated equals. Charged steeply — being outside the range at all is
    // already the flat 4 above, and this only has to break the tie.
    const L = this.limits;
    const m = this.m;
    let over =
      excessOf(m.elbow, L.elbow.dofs.flexion) +
      excessOf(m.forearm, L.elbow.dofs.rotation) +
      excessOf(m.wristFlex, L.wrist.dofs.flexion) +
      excessOf(m.wristDev, L.wrist.dofs.deviation) +
      excessOf(m.rotation, L.shoulder.dofs.rotation) * m.rotationRead;
    const ceil = elevationCeiling(m.plane);
    if (m.elevation > ceil.max) over += (m.elevation - ceil.max) / Math.PI;
    total += 8 * over;
    // Being inside the body: a flat charge that outbids any joint, plus a slope
    // so the search can tell "just inside" from "buried" and walk out the
    // shallow side.
    //
    // The slope has to be much larger than the step, and was not. At 6 and 6, a
    // pose 83% inside the head cost 3.3 more than one 28% inside — less than a
    // single joint reaching its stop — so wherever the whole elbow circle was
    // penetrating, which is the case that matters, the search was choosing on
    // the joint terms and was very nearly blind to depth.
    if (this.m.torso > 0) total += BODY_HIT + BODY_DEPTH * this.m.torso;
    // Gravity: zero for an arm hanging, half at horizontal, one overhead.
    //
    // Charged from hanging and not from horizontal, which is the version this
    // started as. A horizontal upper arm costs a shoulder real effort, and
    // scoring it free let the search park the elbow out at shoulder height on
    // every point — anatomically fine, and a chicken wing. What holds it back
    // from the opposite mistake, tucking the elbow across the ribs to get it
    // low, is the elevation ceiling: that direction runs out of range at 45
    // degrees, so the strain term outbids the saving long before it gets there.
    const lift = (1 - Math.cos(this.m.elevation)) / 2;
    total += LIFT_COST * lift * lift;
    // Bringing the elbow inside the shoulder line. Anatomically available and
    // almost never used: a tucked-in elbow is a closed, guarded posture, and
    // outside of folding your arms nobody holds one to do something with their
    // hand. Everything else here is either a joint limit or gravity, and both
    // are indifferent to it — the ceiling table drops toward the midline, but
    // only bites *above* the ceiling, so an elbow tucked across the body at a
    // low elevation was free. It is what the search picked whenever a target
    // near the face made the honest solutions expensive.
    //
    // Weighted to outbid the saving it buys. Tucking the elbow in is usually
    // also tucking it *down*, so it collects a gravity discount, and at a lower
    // weight the search still took the trade.
    total += INBOARD_COST * this.m.inboard * this.m.inboard;
    return total;
  }

  /** A readable snapshot, for the panel. Allocates; not for the frame loop. */
  report(): JointReading[] {
    const s = this.score();
    const m = this.m;
    const ceil = elevationCeiling(m.plane);
    // `measured: false` marks a quantity that exists but is not determined by
    // the current pose — the plane of a hanging arm, the rotation of a straight
    // one. Showing a zone for those would be reporting noise as a judgement.
    const row = (
      id: string,
      label: Localized,
      value: number,
      strain: number,
      range: [number, number],
      measured = true,
    ): JointReading => ({
      id,
      label,
      deg: value / D,
      strain,
      zone: zoneOf(strain),
      range,
      measured,
    });
    const L = this.limits;
    const deg = (r: [number, number]): [number, number] => [r[0] / D, r[1] / D];
    return [
      row('elevation', { en: 'Shoulder elevation', ja: '肩 挙上' }, m.elevation, s.elevation, [
        0,
        ceil.max / D,
      ]),
      row('plane', { en: 'Shoulder plane', ja: '肩 挙上面' }, m.plane, 0, [-180, 180], false),
      row(
        'rotation',
        { en: 'Shoulder rotation', ja: '肩 回旋' },
        m.rotation,
        s.rotation,
        deg(L.shoulder.dofs.rotation.max),
        m.rotationRead > 0.01,
      ),
      row(
        'elbow',
        { en: 'Elbow flexion', ja: '肘 屈曲' },
        m.elbow,
        s.elbow,
        deg(L.elbow.dofs.flexion.max),
      ),
      row(
        'forearm',
        { en: 'Forearm rotation', ja: '前腕 回内外' },
        m.forearm,
        s.forearm,
        deg(L.elbow.dofs.rotation.max),
      ),
      row(
        'wristFlex',
        { en: 'Wrist flexion', ja: '手首 掌背屈' },
        m.wristFlex,
        s.wristFlex,
        deg(L.wrist.dofs.flexion.max),
      ),
      row(
        'wristDev',
        { en: 'Wrist deviation', ja: '手首 橈尺屈' },
        m.wristDev,
        s.wristDev,
        deg(L.wrist.dofs.deviation.max),
      ),
      // Reported as a percentage of the trunk radius rather than an angle,
      // because it is not one.
      {
        id: 'torso',
        label: { en: 'Arm inside the body', ja: '腕の身体貫通' },
        deg: m.torso * 100,
        unit: '%',
        strain: s.torso,
        zone: zoneOf(s.torso),
        range: [0, 100],
        measured: !!this.torso && this._arm.set,
      },
      // Not a limit — an elbow inside the shoulder line is available, it is just
      // not what people do. Reported because when a solved pose looks closed or
      // guarded, this is usually the number that says why.
      {
        id: 'inboard',
        label: { en: 'Elbow tucked in', ja: '肘の内寄り' },
        deg: m.inboard * 100,
        unit: '%',
        strain: 0,
        zone: 'natural',
        range: [0, 100],
        measured: true,
      },
    ];
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
    this.clearBody(u, l, h);
  }

  /**
   * Lift the arm out of the body, in place. Returns whether it moved.
   *
   * Each segment is relieved by the joint that actually controls it — the upper
   * arm by turning the whole arm about the shoulder, the forearm about the
   * elbow, the hand about the wrist — working proximal to distal so that fixing
   * one never re-buries the one above it.
   *
   * The previous version rotated the whole arm rigidly for every case. With one
   * volume that is fine. With two it deadlocks: lifting the hand out of the head
   * swings the upper arm into the chest, the next pass swings it back, and the
   * loop ping-pongs without converging. On the frames where it happened to
   * converge and the frames where it did not, the arm differed by the whole
   * escape rotation, so a held pose juddered by forty degrees.
   *
   * Turning the hand about the wrist moves nothing else, which is why the
   * deadlock goes away: the three constraints stop competing for one rotation.
   *
   * Two further things about how this is done, each of them a bug that was here.
   *
   * **The point pushed is the deepest one on the segment, not its end.** An arm
   * reaching across the body has both ends clear and its middle inside. On the
   * validation avatar the elbow sat at 1.23 radii while the middle of the upper
   * arm was at 0.48 — no contact reported, nothing corrected, and the forearm
   * through the breast.
   *
   * **The escape is a rotation, not a radial shove.** Moving one sample out
   * along the radius and re-deriving a direction from it works when the sample
   * is the far end of the segment and barely at all when it is near the pivot.
   */
  private clearBody(
    u: THREE.Vector3,
    l: THREE.Vector3 | null,
    h: THREE.Vector3 | null,
    only: 'hand' | null = null,
  ): boolean {
    if (!(this.torso && this._arm.set)) return false;
    const S = this._arm.S;
    const La = this._arm.La;
    const Lf = this._arm.Lf;
    const Lh = this._arm.Lh;
    let moved = false;

    // Turn `apply` by whatever takes the buried point out to the surface,
    // about `pivot`. Returns false when there is no rotation to make.
    const push = (pivot: THREE.Vector3, res: DeepResult, apply: (q: THREE.Quaternion) => void) => {
      const f = res.frame;
      if (!(f && res.vol)) return false;
      const rel = this._rel.copy(this._hit).sub(f.O);
      const y = rel.dot(f.up);
      const rad = this._radial.copy(rel).addScaledVector(f.up, -y);
      // Straight down the axis there is no radial direction to push along, so
      // use the arm's own side — outward is unambiguous there.
      if (rad.length() < 1e-6) rad.copy(this.lateral);
      rad.normalize();
      const R = surfaceOf(res.vol, y, Math.atan2(rad.dot(f.fwd), rad.dot(f.right)));
      this._want.copy(rad).multiplyScalar(R).addScaledVector(f.up, y).add(f.O);
      this._from.copy(this._hit).sub(pivot);
      this._want.sub(pivot);
      if (this._from.lengthSq() < 1e-12 || this._want.lengthSq() < 1e-12) return false;
      this._from.normalize();
      this._want.normalize();
      if (this._from.dot(this._want) > 1 - 1e-9) return false;
      this._swing2.setFromUnitVectors(this._from, this._want);
      apply(this._swing2);
      return true;
    };

    // The surface is curved and a segment is straight, so clearing the deepest
    // point can leave a neighbour as the new worst. The loop stops the moment
    // nothing is buried, so the passes cost nothing on a pose already clear.
    const relieve = (
      pivot: () => THREE.Vector3,
      base: () => THREE.Vector3,
      dir: THREE.Vector3,
      from: number,
      len: number,
      apply: (q: THREE.Quaternion) => void,
    ) => {
      if (!(len > 0)) return;
      for (let pass = 0; pass < TORSO_PASSES; pass++) {
        const res = this.deepestSeg(base(), dir, from, len, this._hit);
        if (res.depth <= 0) return;
        if (!push(pivot(), res, apply)) return;
        moved = true;
      }
    };

    const E = this._elbow;
    const W = this._wrist;
    const elbow = () => E.copy(S).addScaledVector(u, La);

    // The upper arm has only the shoulder above it, so the whole arm turns.
    if (only !== 'hand')
      relieve(
        () => S,
        () => S,
        u,
        La * TORSO_ARM_START,
        La,
        (q) => {
          u.applyQuaternion(q).normalize();
          if (l) l.applyQuaternion(q).normalize();
          if (h) h.applyQuaternion(q).normalize();
        },
      );

    // The forearm turns about the elbow, leaving the upper arm where it is.
    if (l && only !== 'hand')
      relieve(elbow, elbow, l, Lf / TORSO_SAMPLES, Lf, (q) => {
        l.applyQuaternion(q).normalize();
        if (h) h.applyQuaternion(q).normalize();
      });

    // The hand turns about the wrist and moves nothing else at all.
    if (h && l) {
      const wrist = () => W.copy(elbow()).addScaledVector(l, Lf);
      relieve(wrist, wrist, h, Lh / TORSO_SAMPLES, Lh, (q) => {
        h.applyQuaternion(q).normalize();
      });
    }

    return moved;
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
    return this.clearBody(u, l, h, 'hand');
  }

  /** The deepest sample on one straight run of the arm, in world space. */
  private deepestSeg(
    base: THREE.Vector3,
    dir: THREE.Vector3,
    from: number,
    len: number,
    into: THREE.Vector3 | null,
  ): DeepResult {
    const res = this._deep;
    res.depth = 0;
    res.vol = null;
    if (!(this.torso && len > from)) return res;
    for (let i = 0; i <= TORSO_SAMPLES; i++) {
      const d = from + ((len - from) * i) / TORSO_SAMPLES;
      const P = this._probe.copy(base).addScaledVector(dir, d);
      const depth = this.depthAt(P);
      if (depth > res.depth) {
        res.depth = depth;
        res.vol = this._inVol;
        res.frame = this._inFrame;
        if (into) into.copy(P);
      }
    }
    return res;
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
