import * as THREE from 'three';
import type { BodyFrame, BoneSlot, Profile } from '../types';
import { TORSO_ARM_START, TORSO_BANDS, TORSO_PASSES, TORSO_SAMPLES, TORSO_SECTORS } from './joints';
import { type MeasuredVolume, measureVolume, surfaceOf } from './volume';

/**
 * The body an arm is in the way of.
 *
 * Joint angles are not the whole of a range of motion: the reason you cannot
 * swing your elbow twenty centimetres to the left is not that a shoulder runs
 * out of rotation, it is that your ribcage is there. This is that ribcage —
 * the trunk and the head, each measured off the mesh as a radius per height
 * band and angular sector — plus everything that asks a question of it: how
 * deep a point is inside, which part of the arm is deepest, and how to turn the
 * arm back out.
 *
 * Kept apart from the joint measurement because it is a different kind of
 * problem. Everything else in `arm.ts` works on directions, which is what keeps
 * it portable across rigs; this works on *positions*, and no amount of angle
 * says whether an arm is inside a chest.
 */

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
export interface DeepResult {
  depth: number;
  vol: MeasuredVolume | null;
  frame: VolumeFrame | null;
}

export class BodyVolumes {
  readonly torso: MeasuredVolume | null;
  readonly head: HeadVolume | null;
  /** Trunk axis origin, world, per frame. */
  readonly axisO = new THREE.Vector3();

  private readonly _hq = new THREE.Quaternion();
  private readonly _rel = new THREE.Vector3();
  private readonly _trunkFrame: VolumeFrame;
  private _inVol: MeasuredVolume | null;
  private _inFrame: VolumeFrame;
  private readonly _arm: ArmSegments = {
    S: new THREE.Vector3(),
    La: 0,
    Lf: 0,
    Lh: 0,
    set: false,
  };
  private readonly _probe = new THREE.Vector3();
  private readonly _deep: DeepResult = { depth: 0, vol: null, frame: null };
  private readonly _hit = new THREE.Vector3();
  private readonly _want = new THREE.Vector3();
  private readonly _from = new THREE.Vector3();
  private readonly _swing2 = new THREE.Quaternion();
  private readonly _elbow = new THREE.Vector3();
  private readonly _wrist = new THREE.Vector3();
  private readonly _radial = new THREE.Vector3();

  /**
   * The three world-frame vectors are the *live* ones the caller refreshes each
   * frame, held by reference so a volume and its axes travel together.
   */
  constructor(
    private readonly p: Profile,
    private readonly frame: BodyFrame | null,
    up: THREE.Vector3,
    right: THREE.Vector3,
    fwd: THREE.Vector3,
  ) {
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
    this._trunkFrame = { O: this.axisO, up, right, fwd };
    this._inVol = this.torso;
    this._inFrame = this._trunkFrame;
  }

  /** Whether an arm has been placed. See `setArm`. */
  get armSet(): boolean {
    return this._arm.set;
  }

  /**
   * Refresh what moves with the body: the trunk origin, and the head's own
   * frame — it turns and tips under the chest, so its surface has to be queried
   * in axes that turn with it.
   */
  update(chest: THREE.Bone): void {
    chest.getWorldPosition(this.axisO);
    const h = this.head;
    if (!h) return;
    h.bone.updateWorldMatrix(true, false);
    const hq = h.bone.getWorldQuaternion(this._hq);
    h.up.copy(h.local.up).applyQuaternion(hq);
    h.fwd.copy(h.local.forward).applyQuaternion(hq);
    h.right.copy(h.local.right).applyQuaternion(hq);
    h.bone.getWorldPosition(h.O);
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
    let worst = t
      ? this.depthIn(
          t,
          this.axisO,
          this._trunkFrame.up,
          this._trunkFrame.right,
          this._trunkFrame.fwd,
          P,
        )
      : 0;
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
  torsoDepth(
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
  deepest(
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
  clear(
    u: THREE.Vector3,
    l: THREE.Vector3 | null,
    h: THREE.Vector3 | null,
    lateral: THREE.Vector3,
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
      if (rad.length() < 1e-6) rad.copy(lateral);
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

  /** The deepest sample on one straight run of the arm, in world space. */
  deepestSeg(
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
}
