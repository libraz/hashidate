import * as THREE from 'three';
import { type Localized, same } from '../../i18n/locale';
import { normaliseBoneName } from '../profile/candidates';
import type {
  AvatarDescriptor,
  ColliderSpec,
  Profile,
  SkinPointAnchorMetadataSpec,
  SkinPointAnchorSpec,
} from '../types';
import { SkinPointAnchor, type SkinPointAnchorDiagnostics } from './skin-point-anchor';

/**
 * Secondary motion — the parts that swing because the body moved, not because
 * anything drove them.
 *
 * Hair, a skirt hem, a ribbon, a tail, an animal ear: bones with no animation
 * of their own, whose entire behaviour is lag behind their parent. Commercial
 * avatars ship them configured, and the configuration is the first thing lost on
 * the way out of Unity — `PhysBone` is VRChat SDK, `Magica Cloth` is an asset,
 * and neither survives an FBX. What does survive is the *bones*, which is why
 * this layer exists at all: the chains are in the model, and only the numbers
 * describing how they move have to be restated.
 *
 * The numbers themselves are avatar data and live in the avatar descriptor. They
 * were tuned against two avatars: manuka, whose figures are the ones its author
 * set, and yoka, whose were tuned here by eye. The difference between the two is
 * the whole story of this layer; see `docs/en/avatars.md` (Sway tuning).
 *
 * ## The solver
 *
 * Verlet, one point per joint, following VRM SpringBone. Each joint tracks where
 * its *tail* — the point the next bone down sits at — was on the last two steps.
 * Every step the tail keeps some of its velocity, is pulled back toward the
 * direction the bone rests in, takes gravity, is snapped back to the bone's
 * length and pushed out of anything it is inside. The bone is then rotated to
 * point at it.
 *
 * A rotation is all that is ever written, so a chain cannot stretch, and the
 * whole thing is a fixed cost per joint per step no matter how the avatar moves.
 *
 * ## The one chain that is not purely passive
 *
 * "No animation of its own" holds for every chain here except a tail, and the
 * exception is not a special case in the solver — it is a hole deliberately
 * left in the definition, because a tail hangs off the hips and a standing
 * character's hips are almost still. `enableDrive` hands a group's roots to a
 * layer that poses them; the simulation runs underneath unchanged. See
 * `tail.ts`.
 *
 * ## Why a fixed timestep
 *
 * The drag term is a fraction of velocity lost *per step*, not per second,
 * so running it on the frame delta makes an avatar swing further on a slow
 * machine than on a fast one — and the difference is not subtle, it is the
 * difference between hair that settles and hair that oscillates. Stepping at a
 * fixed 60 Hz and accumulating the remainder makes the motion a property of the
 * avatar rather than of the frame rate. The accumulator is capped, because a tab
 * returning from the background must not try to catch up on a minute of
 * simulation in one frame.
 *
 * A step's state stands for its own moment, so it reads the body at that moment:
 * interpolated between the previous frame and this one. Fed the frame's pose
 * instead, steps sample the body at uneven times — 1, 1, 1, 1, 2 per frame at
 * 50 Hz. A step landing on the frame's end reads the frame as posed, so one step
 * per frame at 60 Hz is unchanged.
 *
 * What is written to a bone is the last solved rotation carried forward along
 * the last step's motion by the accumulator's remainder. Above 60 Hz most frames
 * take no step, and writing the last solved rotation again would hold the hair
 * still while the head keeps moving. Interpolating between the last two steps
 * instead would show the hair a step late on every frame, including at 60 Hz.
 */

/**
 * Simulation step, seconds. Every group's figures assume it stays 1/60: drag is
 * lost per step, and stiffness and gravity move the tail `figure * STEP` per step
 * rather than being integrated, so another step would retune every avatar.
 */
const STEP = 1 / 60;

/**
 * Steps allowed in one frame.
 *
 * The viewer caps a frame at 50 ms, which runs at most three steps even with a
 * carried remainder, so four is reached only by a caller passing a longer dt.
 * Past the cap the simulation deliberately falls
 * behind rather than spending the frame catching up — hair lagging for a moment
 * after a stall is invisible, and a frame that takes twice as long because the
 * last one did is how a stall becomes permanent.
 */
const MAX_STEPS = 4;

/** Relative slack on `Collider#beyond`; far above rounding, far below a millimetre. */
const CULL_MARGIN = 1 + 1e-4;

const GROUP_DEFAULTS = {
  stiffness: 1, // restoring force toward the rest direction
  drag: 0.4, // fraction of velocity lost per step, 0..1
  gravity: 0, // constant acceleration along gravityDir
  gravityDir: [0, -1, 0],
  radius: 0.02, // the swinging tail's own radius, for collision
};

// Scratch. This runs a few hundred joints twice a frame for hours at a time, and
// allocating per joint per step is the kind of steady garbage that surfaces as a
// dropped frame in the third hour rather than in the first minute.
const _p = new THREE.Vector3();
const _bp = new THREE.Vector3();
const _next = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _aim = new THREE.Quaternion();
const _flip = new THREE.Quaternion();
// A bone's quaternion resyncs its Euler on every write, so a result is built here
// and written once.
const _solved = new THREE.Quaternion();
const _ax = new THREE.Vector3();
const _back = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _ip = new THREE.Vector3();
const _iq = new THREE.Quaternion();
const _is = new THREE.Vector3();
const _lc = new THREE.Vector3();
const _lw = new THREE.Vector3();
const _lu = new THREE.Vector3();
const _le = new THREE.Vector3();
const _lr = new THREE.Vector3();

const boneChildren = (bone: THREE.Object3D): THREE.Bone[] =>
  bone.children.filter((c): c is THREE.Bone => c instanceof THREE.Bone);

/**
 * Origin of `bone` hung from its parent's world matrix `parent`, formed term for
 * term as `updateMatrix` and `multiplyMatrices` would form it. A pivot moves the
 * origin with the rotation, so a bone with one returns false and is left alone.
 */
function hungOrigin(bone: THREE.Object3D, parent: THREE.Matrix4, out: THREE.Vector3): boolean {
  if (bone.pivot !== null) return false;
  const e = parent.elements;
  const { x, y, z } = bone.position;
  out.set(
    e[0] * x + e[4] * y + e[8] * z + e[12],
    e[1] * x + e[5] * y + e[9] * z + e[13],
    e[2] * x + e[6] * y + e[10] * z + e[14],
  );
  return true;
}

/** World rotation of a node, with any scale on the hierarchy divided out. */
function worldQuat(node: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromRotationMatrix(_m.extractRotation(node.matrixWorld));
}

/**
 * One simulated joint.
 *
 * The tail is stored in world space rather than as an angle. Angles need a
 * reference frame, and the reference frame here is a bone that is itself moving
 * — the whole point of the exercise. A world-space point needs none, and falls
 * out of the constraint that the bone cannot stretch.
 */
export class Joint {
  readonly bone: THREE.Bone;
  /** What the bone hangs from. Fixed at construction; see `Spring`'s chain walk. */
  readonly parent: THREE.Object3D;
  readonly rest: THREE.Quaternion;
  driven: boolean;
  readonly drive: THREE.Quaternion;
  readonly axis: THREE.Vector3;
  readonly length: number;
  readonly cur: THREE.Vector3;
  readonly prev: THREE.Vector3;
  /** Local rotation solved by the last step, and by the one before it. */
  readonly solvedQ = new THREE.Quaternion();
  readonly prevSolvedQ = new THREE.Quaternion();
  /** World axis of the last swing toward the tail, zero until there is one. */
  readonly swing = new THREE.Vector3();
  /** A direction square to `axis`, in this bone's own coordinates. */
  readonly side: THREE.Vector3;
  readonly valid: boolean;
  /** Clearance per collider of this joint's group, filled in by calibration. */
  limits: Float32Array;
  /** The same for the whole link, root to tail, against outside colliders. */
  spans: Float32Array;
  /** Squared cull distance per collider, from `limits` and `spans`; see `Collider#beyond`. */
  reach: Float64Array;
  /** The parent's world rotation, refreshed once per step, if no chain moves the parent. */
  parentQuat: THREE.Quaternion | null = null;

  constructor(bone: THREE.Bone, parent: THREE.Object3D, kids: THREE.Bone[]) {
    this.bone = bone;
    this.parent = parent;
    this.rest = bone.quaternion.clone();
    this.limits = new Float32Array(0);
    this.spans = new Float32Array(0);
    this.reach = new Float64Array(0);

    // An additive rotation an outside layer may put on this joint's rest pose,
    // in the *parent's* frame. Only the root of a driven group carries one —
    // see `Spring#enableDrive` — and the flag keeps the extra work off the
    // several hundred joints that are pure secondary motion.
    this.driven = false;
    this.drive = new THREE.Quaternion();

    // Where the chain continues, in this bone's own coordinates. A branch point
    // aims at the average of its children, which is the only answer that does
    // not privilege one branch over another.
    const tail = new THREE.Vector3();
    for (const k of kids) tail.add(k.position);
    tail.divideScalar(kids.length);
    this.axis = tail.clone();

    // Length is measured in world units, not from the local translation. A
    // local translation is in the parent's units and this project has one avatar
    // authored in centimetres under a 0.01 armature scale — see the note in
    // `profile/bones.ts`. The solver works entirely in world space, so this must too.
    bone.updateWorldMatrix(true, false);
    this.length = _p
      .copy(tail)
      .applyMatrix4(bone.matrixWorld)
      .distanceTo(_bp.setFromMatrixPosition(bone.matrixWorld));

    this.cur = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.valid = this.length > 1e-6 && this.axis.lengthSq() > 1e-12;
    if (this.valid) this.axis.normalize();
    this.side = new THREE.Vector3()
      .crossVectors(this.axis, Math.abs(this.axis.x) < 0.9 ? _p.set(1, 0, 0) : _p.set(0, 1, 0))
      .normalize();
  }

  /** This joint's local rotation at rest, drive included. */
  restQuat(out: THREE.Quaternion): THREE.Quaternion {
    return this.driven ? out.copy(this.drive).multiply(this.rest) : out.copy(this.rest);
  }

  /** Rest direction of this bone in world space, given its parent's rotation. */
  restDir(parentQ: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.axis).applyQuaternion(this.rest);
    if (this.driven) out.applyQuaternion(this.drive);
    return out.applyQuaternion(parentQ);
  }

  /** Drop the tail back onto the rest pose, killing all velocity. */
  seed(): void {
    this.restQuat(this.bone.quaternion);
    this.bone.updateMatrix();
    this.bone.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.bone.matrix);
    this.cur
      .copy(this.axis)
      .multiplyScalar(this.length)
      .applyQuaternion(worldQuat(this.bone, _q))
      .add(_p.setFromMatrixPosition(this.bone.matrixWorld));
    this.prev.copy(this.cur);
    this.solvedQ.copy(this.bone.quaternion);
    this.prevSolvedQ.copy(this.solvedQ);
    this.swing.set(0, 0, 0);
  }

  /**
   * Write the rotation `s` of the way from the previous step's result to the last
   * one's. Above 1 it continues past the last result along the same arc.
   */
  present(s: number): void {
    this.bone.quaternion.copy(_solved.slerpQuaternions(this.prevSolvedQ, this.solvedQ, s));
    this.bone.updateMatrix();
  }

  /** Recompute `reach` after calibration has changed `limits` or `spans`. */
  fitReach(): void {
    this.reach = new Float64Array(this.limits.length);
    for (let i = 0; i < this.limits.length; i++) {
      const r = (this.length + Math.max(this.limits[i], this.spans[i])) * CULL_MARGIN;
      this.reach[i] = r * r;
    }
  }
}

/**
 * A node no chain moves whose world transform a step reads — what a chain
 * hangs from, a collider's bone, an attachment's body side — held for this
 * frame and the last so a step between them can read the body between them.
 */
class Input {
  readonly node: THREE.Object3D;
  /** This frame's world matrix, exactly as the frame posed it. */
  readonly world = new THREE.Matrix4();
  /** The world matrix a step between the two frames reads. */
  readonly between = new THREE.Matrix4();
  /** World rotation of the node's current matrix, refreshed once per step. */
  readonly quat = new THREE.Quaternion();
  readonly #pos = new THREE.Vector3();
  readonly #quat = new THREE.Quaternion();
  readonly #scale = new THREE.Vector3();
  readonly #prevPos = new THREE.Vector3();
  readonly #prevQuat = new THREE.Quaternion();
  readonly #prevScale = new THREE.Vector3();

  constructor(node: THREE.Object3D) {
    this.node = node;
  }

  /** Take this frame's transform, keeping the last one as the start of the interval. */
  capture(): void {
    this.snap();
    this.world.copy(this.node.matrixWorld);
    this.world.decompose(this.#pos, this.#quat, this.#scale);
  }

  /** Drop the last frame, so nothing is interpolated across a discontinuity. */
  snap(): void {
    this.#prevPos.copy(this.#pos);
    this.#prevQuat.copy(this.#quat);
    this.#prevScale.copy(this.#scale);
  }

  /** Pose the node `s` of the way from the last frame to this one. */
  at(s: number): void {
    this.between.compose(
      _ip.lerpVectors(this.#prevPos, this.#pos, s),
      _iq.slerpQuaternions(this.#prevQuat, this.#quat, s),
      _is.lerpVectors(this.#prevScale, this.#scale, s),
    );
    this.node.matrixWorld.copy(this.between);
  }

  /** Put this frame's transform back. */
  end(): void {
    this.node.matrixWorld.copy(this.world);
  }
}

/**
 * A sphere or capsule the swinging parts cannot enter.
 *
 * Positioned relative to a bone, so it follows the body. `offset` and `tail` are
 * in **metres along the bone's own axes** — the bone's rotation is applied and
 * its scale is not, which makes one number mean the same distance on an avatar
 * authored in metres and on one authored in centimetres. Radii are metres for
 * the same reason.
 *
 * `inside: true` inverts it: the point is kept *within* the sphere instead of
 * out of it. That is how a ribbon is stopped from flaring off the body without
 * also being stopped from lying against it.
 */
export class Collider {
  readonly bone: THREE.Bone;
  readonly offset: THREE.Vector3;
  readonly tailOffset: THREE.Vector3 | null;
  readonly radius: number;
  readonly inside: boolean;
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  /** `b - a` and its squared length, as of the last `place`. */
  readonly #seg = new THREE.Vector3();
  #len2 = 0;

  constructor(bone: THREE.Bone, spec: ColliderSpec) {
    this.bone = bone;
    this.offset = new THREE.Vector3().fromArray(spec.offset ?? [0, 0, 0]);
    this.tailOffset = spec.tail ? new THREE.Vector3().fromArray(spec.tail) : null;
    this.radius = spec.radius ?? 0.05;
    this.inside = !!spec.inside;
    this.a = new THREE.Vector3();
    this.b = new THREE.Vector3();
  }

  /**
   * Refresh world-space geometry. Once per step, before any joint reads it.
   *
   * @param rotation  the bone's world rotation, if the caller already has it
   */
  place(rotation: THREE.Quaternion = worldQuat(this.bone, _q)): void {
    _p.setFromMatrixPosition(this.bone.matrixWorld);
    this.a.copy(this.offset).applyQuaternion(rotation).add(_p);
    if (this.tailOffset) this.b.copy(this.tailOffset).applyQuaternion(rotation).add(_p);
    else this.b.copy(this.a);
    this.#len2 = this.#seg.subVectors(this.b, this.a).lengthSq();
  }

  /**
   * Nearest point on the capsule's axis, into `_p`, returning the distance from
   * `point` to it. For a sphere the two ends coincide and this collapses to the
   * centre without a special case.
   */
  nearest(point: THREE.Vector3): number {
    const len2 = this.#len2;
    let t = 0;
    if (len2 > 1e-12) {
      t = _d.subVectors(point, this.a).dot(this.#seg) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    _p.copy(this.a).addScaledVector(this.#seg, t);
    return _d.subVectors(point, _p).length();
  }

  /**
   * Whether `push` and `clearLink` are sure to leave a link alone: an outside
   * sphere further from `root` than the link's length plus either clearance
   * (`Joint#reach`, squared), with the tip at that length. Neither test is run
   * on a culled pair, so the margin keeps the cull clear of their rounding.
   */
  beyond(root: THREE.Vector3, reach: number): boolean {
    if (this.inside || this.#len2 > 1e-12) return false;
    return this.a.distanceToSquared(root) > reach;
  }

  /**
   * Point on the capsule's axis nearest the segment `p0`–`p1`, into `out`.
   * For a sphere, its centre.
   */
  nearestToLink(p0: THREE.Vector3, p1: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const seg = this.#seg;
    const e = this.#len2;
    if (e <= 1e-12) return out.copy(this.a);
    _d.subVectors(p1, p0);
    _lr.subVectors(p0, this.a);
    const a = _d.lengthSq();
    const b = _d.dot(seg);
    const c = _d.dot(_lr);
    const f = seg.dot(_lr);
    // Closest points of two segments (Ericson 5.1.9). Only the axis point is
    // wanted, so the link parameter is not re-clamped after the axis one.
    const denom = a * e - b * b;
    const s = denom > 1e-12 ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
    const t = THREE.MathUtils.clamp((b * s + f) / e, 0, 1);
    return out.copy(this.a).addScaledVector(seg, t);
  }

  /** Distance from the axis to the segment `p0`–`p1`. */
  linkDistance(p0: THREE.Vector3, p1: THREE.Vector3): number {
    this.nearestToLink(p0, p1, _lc);
    _lw.subVectors(p1, p0);
    const len2 = _lw.lengthSq();
    const t =
      len2 > 1e-12 ? THREE.MathUtils.clamp(_lu.subVectors(_lc, p0).dot(_lw) / len2, 0, 1) : 0;
    return _lu.copy(p0).addScaledVector(_lw, t).distanceTo(_lc);
  }

  /**
   * Swing the link from `root` to `tip` about its root, by the least angle that
   * holds the whole link at or beyond `min` from the axis. Length is kept. A
   * tail-only test lets a long link pass through a collider with both ends
   * outside it. Returns whether the tip had to be moved. Outside colliders only:
   * a link with both ends inside a convex shape is inside it along its length.
   */
  clearLink(root: THREE.Vector3, tip: THREE.Vector3, length: number, min: number): boolean {
    if (this.inside) return false;
    this.nearestToLink(root, tip, _lc);
    _lw.subVectors(_lc, root);
    const dist = _lw.length();
    // A root already that close cannot be helped by turning the link.
    if (dist <= min) return false;
    _lu.subVectors(tip, root).multiplyScalar(1 / length);
    const along = _lu.dot(_lw);
    if (along <= 0) return false;
    // The widest angle to the axis point that still clears: the tangent from the
    // root if the link reaches it, otherwise where the tip alone touches.
    const tangent = Math.sqrt(dist * dist - min * min);
    const cosMax =
      length >= tangent
        ? tangent / dist
        : (dist * dist + length * length - min * min) / (2 * length * dist);
    if (along / dist <= cosMax) return false;
    _lw.multiplyScalar(1 / dist);
    _le.copy(_lu).addScaledVector(_lw, -_lu.dot(_lw));
    if (_le.lengthSq() < 1e-12) {
      _le.crossVectors(_lw, Math.abs(_lw.x) < 0.9 ? _lr.set(1, 0, 0) : _lr.set(0, 1, 0));
    }
    _le.normalize();
    const sinMax = Math.sqrt(Math.max(0, 1 - cosMax * cosMax));
    tip
      .copy(root)
      .addScaledVector(_lw, cosMax * length)
      .addScaledVector(_le, sinMax * length);
    return true;
  }

  /**
   * Hold `point` at or beyond `min` from the axis — or at or within it, for an
   * inside collider. Returns whether the point had to be moved.
   *
   * `min` is calibrated per joint rather than being `radius + tail radius`. See
   * `#calibrate`.
   */
  push(point: THREE.Vector3, min: number): boolean {
    const dist = this.nearest(point);
    if (this.inside ? dist <= min : dist >= min) return false;
    // Dead centre has no direction to leave by. Any is as good as any other,
    // and picking one beats leaving the point buried forever.
    if (dist < 1e-9) _d.set(0, 1, 0);
    else _d.multiplyScalar(1 / dist);
    point.copy(_p).addScaledVector(_d, min);
    return true;
  }
}

/** A node hung from its parent by hand, as a world update would. */
interface Hung {
  readonly bone: THREE.Object3D;
  readonly parent: THREE.Object3D;
}

/** One link of a chain: a bone, and the children the run continues into. */
interface RunLink {
  bone: THREE.Bone;
  kids: THREE.Bone[];
}

/** One simulated chain, with the descriptor's figures resolved onto it. */
export interface SpringGroup {
  id: string;
  label: Localized;
  enabled: boolean;
  joints: Joint[];
  rootJoints: Joint[];
  stiffness: number;
  drag: number;
  gravity: number;
  gravityDir: THREE.Vector3;
  radius: number;
  colliders: Collider[];
  /** Optional root placement driven by a skinned point on earlier groups. */
  anchor: SkinPointAnchor | null;
  /** Internal edge state, so toggling a group restores or reseeds only its own chain. */
  wasEnabled: boolean;
}

/**
 * Walk a chain from `root`, collecting one array of joints per unbranched run.
 *
 * A branch ends the run it is in — the bone that branches is still simulated,
 * aiming at the average of its children — and each branch continues as a run of
 * its own. Without this a forked chain would simulate down one arbitrary side
 * and leave the rest rigid, which is exactly what a skirt hem is.
 */
function collectRuns(root: THREE.Bone, out: RunLink[][]): void {
  const run: RunLink[] = [];
  let bone = root;
  for (;;) {
    const kids = boneChildren(bone);
    if (!kids.length) break;
    run.push({ bone, kids });
    if (kids.length > 1) {
      out.push(run);
      for (const k of kids) collectRuns(k, out);
      return;
    }
    bone = kids[0];
  }
  if (run.length) out.push(run);
}

export class Spring {
  readonly p: Profile;
  readonly root: THREE.Object3D;
  readonly groups: SpringGroup[];
  readonly missing: string[];
  readonly drivenJoints: Joint[];

  enabled: boolean;
  stiffnessScale: number;
  inertiaScale: number;
  gravityScale: number;

  _acc: number;
  _pending: boolean;
  _live: boolean;

  readonly #inputs: Input[] = [];
  /** Each input's `between` matrix by node, for attachments composing from it. */
  readonly #inputWorld = new Map<THREE.Object3D, THREE.Matrix4>();
  /** Unattached joints and bridges, shallowest first, for re-hanging chains on an interpolated body. */
  readonly #rebase: Hung[] = [];
  /**
   * Unsimulated nodes between a simulated joint and something a step reads, such
   * as a chain hung from a plain node riding on another chain. Shallowest first.
   */
  readonly #bridges: Hung[] = [];
  /**
   * The part of `#rebase` a step reads before it re-hangs it itself, and what
   * that hangs from: a step re-hangs every other entry before anything reads it.
   */
  readonly #stepRebase: Hung[] = [];
  /**
   * Per group, the bridges its pass can move: those hanging from a joint it
   * simulates or inside the subtree its attachment rewrites. Any other bridge
   * would be re-hung onto an unchanged parent, to the same matrix.
   */
  readonly #bridgesMovedBy: Hung[][] = [];
  /**
   * Colliders on a node no chain moves, which holds still through a step and so
   * is placed once per step rather than once per group sharing it.
   */
  readonly #fixedColliders: Array<{ collider: Collider; input: Input }> = [];
  /** Each group's colliders on a node a chain moves, placed in turn. */
  readonly #movingColliders = new Map<SpringGroup, Collider[]>();

  /**
   * @param profile  the avatar profile; only `root` is used, since sway chains
   *                 are named by the avatar and have no canonical slots
   * @param avatar   the avatar descriptor. No `sway` field means no secondary
   *                 motion, which is a valid state and not an error.
   */
  constructor(profile: Profile, avatar?: AvatarDescriptor) {
    this.p = profile;
    this.root = profile.root;
    this.groups = [];
    this.missing = [];
    // Every joint currently under an external drive, flattened. Walked on the
    // frames the simulation is switched off, and empty on most avatars.
    this.drivenJoints = [];

    this.enabled = true;
    // Operator-facing multipliers over the authored figures. They exist because
    // "does this avatar swing too much" is a judgement made by watching it, and
    // the answer has to be reachable without editing a descriptor and reloading.
    this.stiffnessScale = 1;
    this.inertiaScale = 1;
    this.gravityScale = 1;

    this._acc = 0;
    this._pending = false;
    this._live = false;

    const spec = avatar?.sway;
    if (!spec?.groups?.length) return;

    const byName = new Map<string, THREE.Bone>();
    const bonesByName = new Map<string, THREE.Bone[]>();
    this.root.traverse((o) => {
      if (!(o instanceof THREE.Bone)) return;
      // Preserve the legacy first-name-wins lookup for unanchored groups. The
      // attachment resolver below uses the strict all-matches map instead.
      // Keyed by the loader-sanitised name, as descriptor names are looked up.
      const key = normaliseBoneName(o.name);
      if (!byName.has(key)) byName.set(key, o);
      const matches = bonesByName.get(key) ?? [];
      matches.push(o);
      bonesByName.set(key, matches);
    });
    this.root.updateMatrixWorld(true);

    const colliders = new Map<string, Collider[]>();
    for (const [id, list] of Object.entries(spec.colliders ?? {})) {
      const built: Collider[] = [];
      for (const c of list) {
        const bone = byName.get(normaliseBoneName(c.bone));
        if (bone) built.push(new Collider(bone, c));
        else this.missing.push(`collider:${c.bone}`);
      }
      if (built.length) colliders.set(id, built);
    }

    for (const g of spec.groups) {
      const def = { ...GROUP_DEFAULTS, ...g };
      const roots: THREE.Bone[] = [];
      for (const name of g.roots ?? []) {
        const bone = byName.get(normaliseBoneName(name));
        if (bone) roots.push(bone);
        else this.missing.push(`sway:${name}`);
      }
      // A hub — one bone carrying a whole hem or frill — is an anchor, not a
      // joint. Naming its sixteen children individually would be a list nobody
      // can check against the model, so the descriptor names the hub and the
      // children are read off the rig.
      for (const name of g.childrenOf ?? []) {
        const hub = byName.get(normaliseBoneName(name));
        if (!hub) {
          this.missing.push(`sway:${name}`);
          continue;
        }
        const kids = boneChildren(hub);
        if (!kids.length) this.missing.push(`sway:${name} (no child bones)`);
        roots.push(...kids);
      }

      let anchor: SkinPointAnchor | null = null;
      if (g.anchor !== undefined) {
        try {
          const rootName = Array.isArray(g.roots) && g.roots.length === 1 ? g.roots[0] : undefined;
          if (rootName === undefined || (g.childrenOf?.length ?? 0) > 0) {
            throw new Error('requires exactly one explicit root and no childrenOf');
          }
          const rootMatches = bonesByName.get(normaliseBoneName(rootName)) ?? [];
          const rootBone = roots.length === 1 ? roots[0] : undefined;
          if (rootMatches.length !== 1 || rootBone === undefined) {
            throw new Error(`root bone must resolve uniquely: ${rootName}`);
          }
          let anchorSpec: SkinPointAnchorSpec;
          const declaration = g.anchor as SkinPointAnchorSpec | SkinPointAnchorMetadataSpec;
          if (typeof declaration === 'object' && declaration !== null && 'source' in declaration) {
            if (declaration.source !== 'bone-metadata' || Object.keys(declaration).length !== 1) {
              throw new Error('has an unsupported metadata source declaration');
            }
            anchorSpec = rootBone.userData.skinPointAnchor as SkinPointAnchorSpec;
            if (!anchorSpec) throw new Error('is missing root userData.skinPointAnchor metadata');
          } else {
            anchorSpec = declaration as SkinPointAnchorSpec;
          }
          anchor = new SkinPointAnchor(rootBone, anchorSpec, bonesByName);
        } catch (error) {
          this.missing.push(
            `sway:${g.id} anchor: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
      }

      const runs: RunLink[][] = [];
      for (const r of roots) collectRuns(r, runs);

      const joints: Joint[] = [];
      for (const run of runs) {
        for (const { bone, kids } of run) {
          // A collected joint always has a parent by construction: every run is
          // walked down from a bone found by traversing the avatar root, so the
          // solver dereferences the parent per step without a check. This is
          // the one place that is established.
          const parent = bone.parent;
          if (!parent) continue;
          const j = new Joint(bone, parent, kids);
          if (j.valid) joints.push(j);
        }
      }
      if (!joints.length) {
        if (anchor) this.missing.push(`sway:${g.id} anchor: root has no simulated descendants`);
        continue;
      }

      const rootBones = new Set<THREE.Bone>(roots);
      this.groups.push({
        id: g.id,
        label: g.label ?? same(g.id),
        enabled: true,
        joints,
        // The joints an external drive is allowed to reach. Only the tops of
        // the chains: a drive is a pose for the base of an appendage, and the
        // rest of it is meant to trail behind rather than be posed too.
        rootJoints: joints.filter((j) => rootBones.has(j.bone)),
        stiffness: def.stiffness,
        drag: Math.min(0.99, Math.max(0, def.drag)),
        gravity: def.gravity,
        gravityDir: new THREE.Vector3().fromArray(def.gravityDir).normalize(),
        radius: def.radius,
        anchor,
        wasEnabled: true,
        colliders: (g.colliders ?? []).flatMap((id) => {
          const c = colliders.get(id);
          if (!c) this.missing.push(`collider group:${id}`);
          return c ?? [];
        }),
      });
    }

    this.#validateAnchors();
    this.#collectInputs();
    this.#calibrate();
    this.reset();
  }

  #validateAnchors(): void {
    if (!this.groups.some((group) => group.anchor)) return;
    const owners = new Map<THREE.Object3D, SpringGroup[]>();
    for (const group of this.groups) {
      for (const joint of group.joints) {
        const groups = owners.get(joint.bone) ?? [];
        groups.push(group);
        owners.set(joint.bone, groups);
      }
    }

    const removed = new Set<SpringGroup>();
    const earlier = new Set<SpringGroup>();
    for (const group of this.groups) {
      const anchor = group.anchor;
      if (!anchor) {
        earlier.add(group);
        continue;
      }
      let problem: string | null = null;
      const hasOtherOwner = (node: THREE.Object3D): boolean =>
        (owners.get(node) ?? []).some((owner) => owner !== group && !removed.has(owner));

      for (let current: THREE.Object3D | null = anchor.root; current; current = current.parent) {
        if (hasOtherOwner(current)) {
          problem = `root ancestor is simulated by another group: ${current.name}`;
          break;
        }
      }
      if (!problem) {
        anchor.root.traverse((node) => {
          if (!problem && hasOtherOwner(node)) {
            problem = `root subtree is simulated by another group: ${node.name}`;
          }
        });
      }
      if (!problem) {
        for (const influence of anchor.influences) {
          for (
            let current: THREE.Object3D | null = influence.bone;
            current;
            current = current.parent
          ) {
            for (const owner of owners.get(current) ?? []) {
              if (removed.has(owner)) continue;
              if (!earlier.has(owner)) {
                problem = `source ${influence.bone.name} depends on group ${owner.id} at or after this group`;
                break;
              }
            }
            if (problem) break;
          }
          if (problem) break;
        }
      }
      if (problem) {
        this.missing.push(`sway:${group.id} anchor: ${problem}`);
        removed.add(group);
      }
      earlier.add(group);
    }
    if (removed.size) {
      const kept = this.groups.filter((group) => !removed.has(group));
      this.groups.splice(0, this.groups.length, ...kept);
    }
  }

  #collectInputs(): void {
    const simulated = new Set<THREE.Object3D>();
    for (const g of this.groups) for (const j of g.joints) simulated.add(j.bone);
    // The deepest node at or above `node` with no simulated node at or above it.
    const outside = (node: THREE.Object3D | null): THREE.Object3D | null => {
      let found: THREE.Object3D | null = null;
      for (let n = node; n; n = n.parent) {
        if (simulated.has(n)) found = null;
        else if (!found) found = n;
      }
      return found;
    };
    const inputOf = new Map<THREE.Object3D, Input>();
    const add = (node: THREE.Object3D): Input => {
      const known = inputOf.get(node);
      if (known) return known;
      const input = new Input(node);
      this.#inputs.push(input);
      this.#inputWorld.set(node, input.between);
      inputOf.set(node, input);
      return input;
    };
    const depth = new Map<THREE.Object3D, number>();
    const depthOf = (node: THREE.Object3D): number => {
      let d = 0;
      for (let n: THREE.Object3D | null = node.parent; n; n = n.parent) d++;
      return d;
    };
    // Every unsimulated node from `node` up to the simulated joint carrying it.
    const bridge = (node: THREE.Object3D): void => {
      if (outside(node) === node) return;
      for (let n: THREE.Object3D | null = node; n && !simulated.has(n); n = n.parent) {
        if (depth.has(n) || !n.parent) continue;
        depth.set(n, depthOf(n));
        this.#bridges.push({ bone: n, parent: n.parent });
      }
    };
    for (const g of this.groups) {
      for (const j of g.joints) {
        if (outside(j.parent) === j.parent) j.parentQuat = add(j.parent).quat;
        if (g.anchor) continue;
        if (!simulated.has(j.parent)) bridge(j.parent);
        depth.set(j.bone, depthOf(j.bone));
        this.#rebase.push(j);
      }
      const moving: Collider[] = [];
      for (const c of g.colliders) {
        const input = outside(c.bone) === c.bone ? add(c.bone) : undefined;
        if (input) {
          if (!this.#fixedColliders.some((f) => f.collider === c)) {
            this.#fixedColliders.push({ collider: c, input });
          }
        } else {
          if (!simulated.has(c.bone)) bridge(c.bone);
          moving.push(c);
        }
      }
      this.#movingColliders.set(g, moving);
      if (g.anchor) {
        const parent = outside(g.anchor.root.parent);
        if (parent) add(parent);
        for (const influence of g.anchor.influences) {
          const source = outside(influence.bone);
          if (source) add(source);
        }
      }
    }
    const byDepth = (a: Hung, b: Hung): number =>
      (depth.get(a.bone) ?? 0) - (depth.get(b.bone) ?? 0);
    this.#bridges.sort(byDepth);
    const groupsOf = new Map<THREE.Object3D, number[]>();
    this.groups.forEach((g, k) => {
      for (const j of g.joints) groupsOf.set(j.bone, [...(groupsOf.get(j.bone) ?? []), k]);
    });
    this.#bridgesMovedBy.push(...this.groups.map((): Hung[] => []));
    for (const b of this.#bridges) {
      let owner = b.bone.parent;
      while (owner && !simulated.has(owner)) owner = owner.parent;
      const movers = new Set(owner ? groupsOf.get(owner) : []);
      this.groups.forEach((g, k) => {
        const root = g.anchor?.root;
        for (let n: THREE.Object3D | null = b.bone; root && n; n = n.parent) {
          if (n === root) movers.add(k);
        }
      });
      for (const k of movers) this.#bridgesMovedBy[k].push(b);
    }
    this.#rebase.push(...this.#bridges);
    this.#rebase.sort(byDepth);
    this.#collectStepRebase();
  }

  /**
   * Walk a step in `#step`'s order and keep what is read before it is written.
   * An attached group is taken to write nothing and to read as if running, as
   * either may change at runtime.
   */
  #collectStepRebase(): void {
    const parentOf = new Map<THREE.Object3D, THREE.Object3D>();
    for (const h of this.#rebase) parentOf.set(h.bone, h.parent);
    const written = new Set<THREE.Object3D>();
    const read = new Set<THREE.Object3D>();
    const reads = (node: THREE.Object3D): void => {
      if (parentOf.has(node) && !written.has(node)) read.add(node);
    };
    for (const g of this.groups) {
      for (const b of this.#bridges) {
        reads(b.parent);
        written.add(b.bone);
      }
      for (const c of this.#movingColliders.get(g) ?? []) reads(c.bone);
      for (const j of g.joints) {
        reads(j.parent);
        if (!g.anchor) written.add(j.bone);
      }
    }
    for (const node of [...read]) {
      for (let n = parentOf.get(node); n && parentOf.has(n); n = parentOf.get(n)) read.add(n);
    }
    for (const h of this.#rebase) if (read.has(h.bone)) this.#stepRebase.push(h);
  }

  /** Current weighted target and root residual for attachment diagnostics. */
  get anchorDiagnostics(): Array<{ groupId: string } & SkinPointAnchorDiagnostics> {
    return this.groups.flatMap((group) =>
      group.anchor ? [{ groupId: group.id, ...group.anchor.diagnostics }] : [],
    );
  }

  /**
   * Decide, per joint and per collider, how much clearance to actually enforce.
   *
   * The obvious answer is the sum of the two radii, and it is wrong often enough
   * to matter. Both avatars here carry collider sets that were machine-converted
   * from another system — `PhysBone` on one, and on the other a VRM produced by
   * a converter rather than by hand — and a converted collider routinely ends up
   * larger or further forward than the one it stands for. The result is a
   * collider that the model's *own bind pose* is already deep inside: this
   * avatar's apron sits 5 cm inside a 10 cm sphere at the hip, and its tail
   * starts 13 cm inside the 20 cm sphere behind it.
   *
   * Enforced literally, the first frame throws the apron out to the horizontal
   * and stands the tail up. Neither is secondary motion — it is the simulation
   * rejecting the shape the model was drawn in.
   *
   * So the bind pose wins. Where a joint already sits closer than the radii say
   * it may, the clearance for that pair is reduced to exactly where the artist
   * put it. Nothing moves at rest, and the collider still does its job in the
   * direction that matters — the part can swing away freely and cannot swing any
   * further *in* than the model was drawn.
   *
   * Dropping such colliders instead would be simpler and gives up more than it
   * needs to: a hair strand that rests against the skull is not bad data, and it
   * still wants the skull there when the head turns.
   */
  #calibrate(): void {
    this.root.updateMatrixWorld(true);
    for (const g of this.groups) {
      this.#place(g);
      for (const j of g.joints) j.seed();
    }
    for (const g of this.groups) {
      if (!g.colliders.length) continue;
      for (const c of g.colliders) c.place();
      for (const j of g.joints) {
        j.limits = new Float32Array(g.colliders.length);
        j.spans = new Float32Array(g.colliders.length);
        _bp.setFromMatrixPosition(j.bone.matrixWorld);
        for (let i = 0; i < g.colliders.length; i++) {
          const c = g.colliders[i];
          const dist = c.nearest(j.cur);
          j.limits[i] = c.inside
            ? Math.max(c.radius - g.radius, dist)
            : Math.min(c.radius + g.radius, dist);
          if (!c.inside) j.spans[i] = Math.min(c.radius + g.radius, c.linkDistance(_bp, j.cur));
        }
        j.fitReach();
      }
    }
  }

  /**
   * Widen a driven group's clearance to cover the poses it will actually be put
   * in, given as the extremes of the drive's range.
   *
   * The same argument as `#calibrate`, one step further along. That pass lets
   * the bind pose overrule a converted collider because the shape the model was
   * drawn in is not negotiable. A driven range is the same kind of statement:
   * the descriptor says how far this appendage may be posed, and a collider
   * that was machine-converted from another system does not get to veto it.
   *
   * The case that forced it is one avatar's `Tail_C`, a 20 cm sphere the tail
   * already starts 13 cm inside. Calibrated against the bind pose alone, the
   * tail may move away from it and not one millimetre back, so the tail rises
   * for joy exactly as intended and cannot drop for sadness at all — half the
   * performance, silently, on one avatar out of two. Sampling the range instead
   * leaves the collider doing the job it is there for: the tail still cannot be
   * *swung* into the backside by the simulation, it just is not stopped from
   * being *posed* where the avatar data says it may go.
   *
   * Sampled rather than solved. The drive is two rotations at stated maxima, so
   * the corners of that box bound everything between them closely enough, and
   * this runs once at load.
   */
  calibrateDrive(id: string, poses: THREE.Quaternion[]): void {
    const g = this.groups.find((x) => x.id === id);
    if (g?.anchor) {
      this.missing.push(`drive:${id} cannot own an attached spring root`);
      return;
    }
    if (!(g?.colliders.length && g.rootJoints.length && poses?.length)) return;

    for (const q of poses) {
      for (const j of g.rootJoints) j.drive.copy(q);
      this.root.updateMatrixWorld(true);
      for (const j of g.joints) j.seed();
      for (const c of g.colliders) c.place();
      for (const j of g.joints) {
        _bp.setFromMatrixPosition(j.bone.matrixWorld);
        for (let i = 0; i < g.colliders.length; i++) {
          const c = g.colliders[i];
          const dist = c.nearest(j.cur);
          j.limits[i] = c.inside ? Math.max(j.limits[i], dist) : Math.min(j.limits[i], dist);
          if (!c.inside) j.spans[i] = Math.min(j.spans[i], c.linkDistance(_bp, j.cur));
        }
      }
    }

    for (const j of g.joints) j.fitReach();
    for (const j of g.rootJoints) j.drive.identity();
    this.root.updateMatrixWorld(true);
    for (const grp of this.groups) {
      for (const j of grp.joints) j.seed();
    }
    this.reset();
  }

  /** Whether this avatar has any secondary motion at all. */
  get active(): boolean {
    return this.groups.length > 0;
  }

  /**
   * Hand a group's roots to a layer that wants to *drive* them.
   *
   * Secondary motion is defined by what nothing drives, so this is a deliberate
   * hole in that definition rather than an oversight. A tail is the case that
   * needs it: it is a swinging chain like the hair, but its only parent is the
   * hips, and a standing character's hips barely move — so left purely passive
   * it is not slow, it is *still*. Hair gets away with being passive because it
   * hangs off a head that looks around.
   *
   * Driving the rest pose rather than the bone is what keeps the two layers
   * from fighting. The base is posed, the simulation still runs underneath it,
   * and the rest of the chain arrives late and overshoots exactly as it would
   * if the body had swung the tail. The authored stiffness and drag keep
   * meaning what they meant.
   *
   * @returns the joints to write, or null if this avatar has no such group —
   *          which is the normal answer for an avatar without a tail.
   */
  enableDrive(id: string): Joint[] | null {
    const g = this.groups.find((x) => x.id === id);
    if (!g?.rootJoints.length) return null;
    if (g.anchor) {
      this.missing.push(`drive:${id} cannot own an attached spring root`);
      return null;
    }
    for (const j of g.rootJoints) {
      if (j.driven) continue;
      j.driven = true;
      this.drivenJoints.push(j);
    }
    return g.rootJoints;
  }

  /** Simulated joints, across every group. Reported in the panel. */
  get count(): number {
    return this.groups.reduce((n, g) => n + g.joints.length, 0);
  }

  /**
   * Drop everything back to the rest pose.
   *
   * Deferred to the next update rather than done here, because the caller is
   * usually a button on the panel and the pose at that moment is whatever the
   * last frame left — seeding from it would bake a mid-swing pose in as the
   * thing the hair returns to.
   */
  reset(): void {
    this._pending = true;
  }

  #seed(): void {
    this.root.updateMatrixWorld(true);
    for (const input of this.#inputs) input.snap();
    for (const g of this.groups) {
      if (g.enabled) {
        this.#place(g);
        for (const j of g.joints) j.seed();
      } else {
        for (const j of g.joints) {
          j.restQuat(j.bone.quaternion);
          j.bone.updateMatrix();
        }
      }
      g.wasEnabled = g.enabled;
    }
    // A disabled anchor is placed once more after enabled producers have been
    // reseeded. Its first placement above may have read their pre-reset pose.
    this.#rehang();
    for (const g of this.groups) {
      if (g.anchor && !g.enabled) this.#place(g);
    }
  }

  /**
   * Place a group's anchor. An anchor guards its contract on every placement
   * (a bone's scale can change at runtime), and a violation must not escape
   * into the render loop: the group is switched off and the reason recorded.
   */
  #place(g: SpringGroup, inputs?: ReadonlyMap<THREE.Object3D, THREE.Matrix4>): void {
    if (!g.anchor) return;
    try {
      g.anchor.place(inputs);
    } catch (error) {
      this.missing.push(
        `sway:${g.id} anchor: ${error instanceof Error ? error.message : String(error)}`,
      );
      g.enabled = false;
      g.wasEnabled = false;
      g.anchor = null;
    }
  }

  #placeAnchors(): void {
    for (const g of this.groups) this.#place(g);
  }

  #syncGroupToggles(): void {
    // Restore every disabled group on every frame, rather than only on the
    // edge. A driven rest pose can change while a group is off, and its local
    // rotations must follow that drive before an attachment reads its bones.
    let rehang = false;
    for (const g of this.groups) {
      if (!g.enabled) {
        for (const joint of g.joints) {
          joint.restQuat(joint.bone.quaternion);
          joint.bone.updateMatrix();
        }
        if (!g.anchor) rehang = true;
      }
    }
    if (rehang) this.#rehang();

    for (const g of this.groups) {
      if (g.wasEnabled === g.enabled) {
        if (!g.enabled && g.anchor) this.#place(g);
        continue;
      }
      g.wasEnabled = g.enabled;
      if (g.enabled) {
        this.#place(g);
        for (const joint of g.joints) joint.seed();
      } else if (g.anchor) {
        this.#place(g);
      }
    }
  }

  /**
   * Put every chain back where the model has it and leave it there.
   *
   * Switching the simulation off has to do this. A spring writes local
   * rotations and nothing else writes them back — so simply *stopping* leaves
   * the last solved frame on the bones forever, and what looks like the model's
   * own pose is a mid-swing snapshot. That is worse than either state, and it
   * makes an off/on comparison meaningless.
   */
  #restore(): void {
    for (const g of this.groups) {
      for (const j of g.joints) j.restQuat(j.bone.quaternion);
    }
  }

  /**
   * Advance the simulation and write the result onto the bones.
   *
   * Must run after everything else has posed the body for this frame: the input
   * to a spring is where its parent ended up, so anything that moves a shoulder
   * after this has run is a frame of lag the hair never sees.
   */
  update(dt: number): void {
    if (!this.groups.length) return;

    if (!this.enabled) {
      if (this._live) {
        this.#restore();
        this._live = false;
      }
      // A drive is animation, not physics, so switching the simulation off must
      // not freeze it — that would make the tail stop dead on a control whose
      // label promises nothing of the kind. Only the driven roots are rewritten;
      // everything below them stays where `#restore` left it and the chain moves
      // as one rigid piece, which is the honest picture of the sway being off.
      for (const j of this.drivenJoints) j.restQuat(j.bone.quaternion);
      this.#placeAnchors();
      return;
    }
    // Coming back on, the chains have been standing still while the body moved
    // out from under them. Carrying that stale state forward would read as a
    // flick on the first frame, so the simulation restarts from the pose.
    if (!this._live) {
      this._live = true;
      this._pending = true;
    }

    // The pose was written into local quaternions and nothing has propagated it
    // yet — the renderer would, but not until after this. Every world position
    // read below would otherwise be one frame stale, which reads as hair that
    // anticipates the head instead of following it.
    this.root.updateMatrixWorld(true);
    for (const input of this.#inputs) input.capture();
    this.#syncGroupToggles();

    if (this._pending) {
      this.#seed();
      this._pending = false;
      this._acc = 0;
      return;
    }

    const start = this._acc;
    this._acc = Math.min(this._acc + dt, STEP * MAX_STEPS);
    const span = this._acc - start;
    let between = false;
    while (this._acc >= STEP) {
      this._acc -= STEP;
      // What is left of the frame after this step says where in it the step
      // falls; a remainder that is only rounding is the frame's end.
      if (this._acc > span * 1e-9) {
        const s = 1 - this._acc / span;
        for (const input of this.#inputs) input.at(s);
        this.#step(STEP, this.#inputWorld, true);
        between = true;
      } else {
        if (between) for (const input of this.#inputs) input.end();
        this.#step(STEP, undefined, between);
        between = false;
      }
    }
    if (between) {
      // Hand the frame's own body back, and hang what is drawn on it.
      for (const input of this.#inputs) input.end();
    }
    // The solver is up to a step behind the frame. Carry the last step's motion
    // forward by the unspent remainder: nothing moves on a frame that lands on a
    // step, and frames between steps keep moving with the head.
    const carry = 1 + this._acc / STEP;
    this.#present(carry);
    this.#rehang();
    if (carry > 1 && this.#keepClear()) this.#rehang();
    this.#placeAnchors();
  }

  /**
   * Hold back any carried-forward link that would enter a collider, at its
   * solved rotation. The carry is never collision-checked otherwise, and a link
   * swinging in is carried through the surface the next step will stop it at.
   * Returns whether anything was held back.
   */
  #keepClear(): boolean {
    let held = false;
    let placed = false;
    for (const g of this.groups) {
      if (!(g.enabled && g.colliders.length) || g.anchor) continue;
      if (!placed) {
        this.#placeFixed();
        placed = true;
      }
      for (const c of this.#movingColliders.get(g) ?? []) c.place();
      for (const j of g.joints) {
        // An earlier link may have been held back, so hang this one again first.
        j.bone.matrixWorld.multiplyMatrices(j.parent.matrixWorld, j.bone.matrix);
        _next
          .copy(j.axis)
          .multiplyScalar(j.length)
          .applyQuaternion(worldQuat(j.bone, _q))
          .add(_bp.setFromMatrixPosition(j.bone.matrixWorld));
        let inside = false;
        for (let i = 0; i < g.colliders.length; i++) {
          const c = g.colliders[i];
          if (!inside && c.beyond(_bp, j.reach[i])) continue;
          if (c.push(_next, j.limits[i])) inside = true;
          if (c.clearLink(_bp, _next, j.length, j.spans[i])) inside = true;
        }
        if (!inside) continue;
        j.present(1);
        j.bone.matrixWorld.multiplyMatrices(j.parent.matrixWorld, j.bone.matrix);
        held = true;
      }
    }
    return held;
  }

  /** Read every input's rotation off its current matrix, and place the colliders on them. */
  #placeFixed(): void {
    for (const input of this.#inputs) worldQuat(input.node, input.quat);
    for (const { collider, input } of this.#fixedColliders) collider.place(input.quat);
  }

  /** Write every running group's rotations at `s`; see `Joint#present`. */
  #present(s: number): void {
    for (const g of this.groups) {
      if (!g.enabled) continue;
      for (const j of g.joints) j.present(s);
    }
  }

  /** Recompute unattached joints' world matrices from their parents, as a world update would. */
  #rehang(nodes: readonly Hung[] = this.#rebase): void {
    for (const j of nodes) {
      j.bone.matrixWorld.multiplyMatrices(j.parent.matrixWorld, j.bone.matrix);
    }
  }

  /**
   * @param inputs  interpolated body transforms, for a step before the frame's last
   * @param rebase  re-hang unattached chains on the body this step reads, as the
   *                frame's own world update does before its first step
   */
  #step(
    dt: number,
    inputs: ReadonlyMap<THREE.Object3D, THREE.Matrix4> | undefined,
    rebase: boolean,
  ): void {
    if (rebase) this.#rehang(this.#stepRebase);
    this.#placeFixed();
    for (let k = 0; k < this.groups.length; k++) {
      const g = this.groups[k];
      // A group may hang from a node an earlier group just moved: the first
      // re-hangs every bridge, each later one what the group before could move.
      for (const b of k === 0 ? this.#bridges : this.#bridgesMovedBy[k - 1])
        b.bone.matrixWorld.multiplyMatrices(b.parent.matrixWorld, b.bone.matrix);
      // Place after prior cloth/producer groups in this same fixed step, even
      // when this accessory group itself is switched off.
      this.#place(g, inputs);
      if (!g.enabled) {
        // An ordinary disabled group can still be a producer for an attached
        // group later in this pass. Keep its world matrices on its current
        // parent after an earlier group has solved it.
        if (!g.anchor) {
          for (const j of g.joints)
            j.bone.matrixWorld.multiplyMatrices(j.parent.matrixWorld, j.bone.matrix);
        }
        continue;
      }
      for (const c of this.#movingColliders.get(g) ?? []) c.place();

      const stiffness = g.stiffness * this.stiffnessScale * dt;
      const gravity = g.gravity * this.gravityScale * dt;
      // Velocity retained per step. Scaled rather than the drag itself so the
      // control reads the way it behaves: more is a longer swing.
      const retain = Math.min(0.995, Math.max(0, (1 - g.drag) * this.inertiaScale));

      for (const j of g.joints) {
        const bone = j.bone;
        const parent = j.parent;
        // Every joint may have a solved parent from the preceding link. Read
        // this bone's origin from that fresh parent before integrating it;
        // only an attached root keeps the placement written by its anchor.
        // Nothing reads the rest of its world matrix before the end of this
        // link rewrites it, so only the origin is formed.
        if (g.anchor && bone === g.anchor.root) {
          _bp.setFromMatrixPosition(bone.matrixWorld);
        } else if (!hungOrigin(bone, parent.matrixWorld, _bp)) {
          bone.updateMatrix();
          bone.matrixWorld.multiplyMatrices(parent.matrixWorld, bone.matrix);
          _bp.setFromMatrixPosition(bone.matrixWorld);
        }
        if (j.parentQuat) _pq.copy(j.parentQuat);
        else worldQuat(parent, _pq);
        if (g.anchor) _pq.normalize();
        j.restDir(_pq, _dir);
        if (g.anchor) _dir.normalize();

        _vel.subVectors(j.cur, j.prev);
        _next
          .copy(j.cur)
          .addScaledVector(_vel, retain)
          .addScaledVector(_dir, stiffness)
          .addScaledVector(g.gravityDir, gravity);

        // The bone cannot stretch, so the tail is only ever allowed to change
        // direction. Everything above is a force; this is the constraint.
        _to.subVectors(_next, _bp);
        if (_to.lengthSq() < 1e-12) _to.copy(_dir);
        _next.copy(_bp).addScaledVector(_to.normalize(), j.length);

        if (g.colliders.length) {
          // A moved tip is off its length, which `beyond` assumes, so the
          // rest of the joint's colliders are tested in full.
          let moved = false;
          for (let i = 0; i < g.colliders.length; i++) {
            const c = g.colliders[i];
            if (!moved && c.beyond(_bp, j.reach[i])) continue;
            if (c.push(_next, j.limits[i])) moved = true;
          }
          // Collision moved the point off the sphere the length constraint put
          // it on, so the constraint is reapplied. Doing it once at the end
          // rather than after every collider costs a little accuracy where two
          // colliders overlap and saves a square root per collider per joint.
          _to.subVectors(_next, _bp);
          if (_to.lengthSq() > 1e-12) {
            _next.copy(_bp).addScaledVector(_to.normalize(), j.length);
          }
          // Then the rest of the link. This swing keeps the length by itself.
          moved = false;
          for (let i = 0; i < g.colliders.length; i++) {
            const c = g.colliders[i];
            if (!moved && c.beyond(_bp, j.reach[i])) continue;
            if (c.clearLink(_bp, _next, j.length, j.spans[i])) moved = true;
          }
        }

        j.prev.copy(j.cur);
        j.cur.copy(_next);

        // Rotate the bone from where it rests to where its tail ended up. The
        // rest rotation is carried through rather than replaced, so a bone with
        // an axis that is not its local Y — which is most of them — is handled
        // without knowing anything about how the rig was built.
        _to.subVectors(j.cur, _bp).normalize();
        if (_dir.dot(_to) < -0.999) {
          // Nearly a half turn, where the shortest swing's axis is the cross of two
          // almost opposite vectors and spins with any wobble, rolling the bone.
          // Keep the last axis (or the rest pose's side) and flip about it instead.
          _ax.copy(j.swing).addScaledVector(_dir, -j.swing.dot(_dir));
          if (_ax.lengthSq() < 1e-12) {
            _ax.copy(j.side).applyQuaternion(j.rest);
            if (j.driven) _ax.applyQuaternion(j.drive);
            _ax.applyQuaternion(_pq);
          }
          j.swing.copy(_ax.normalize());
          _aim
            .setFromAxisAngle(_ax, Math.PI)
            .premultiply(_flip.setFromUnitVectors(_back.copy(_dir).negate(), _to));
        } else {
          _aim.setFromUnitVectors(_dir, _to);
          _ax.crossVectors(_dir, _to);
          if (_ax.lengthSq() > 1e-12) j.swing.copy(_ax.normalize());
        }
        _q.copy(_pq);
        if (j.driven) _q.multiply(j.drive);
        _q.multiply(j.rest).premultiply(_aim);
        _solved.copy(_pq).invert().multiply(_q);
        if (g.anchor) _solved.normalize();
        bone.quaternion.copy(_solved);
        j.prevSolvedQ.copy(j.solvedQ);
        j.solvedQ.copy(_solved);

        // The next joint down reads this bone's world matrix, and three will not
        // refresh it until render. Propagating one link by hand is cheaper than
        // an `updateMatrixWorld` per joint, which would walk the whole subtree
        // once per joint and turn a linear pass into a quadratic one.
        // The next joint reads this fresh world matrix, including the solved
        // origin and orientation of this link.
        bone.updateMatrix();
        bone.matrixWorld.multiplyMatrices(parent.matrixWorld, bone.matrix);
      }
    }
  }
}
