import * as THREE from 'three';
import type { AvatarDescriptor, ColliderSpec, Profile } from '../types';

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
 * The numbers themselves are avatar data and live in the avatar descriptor. See
 * `avatars/manuka.ts`, whose figures are the ones its author set, and
 * `avatars/yoka.ts`, whose are not — the difference between the two is the whole
 * story of this layer and is written up there.
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
 * The drag term is a fraction of velocity retained *per step*, not per second,
 * so running it on the frame delta makes an avatar swing further on a slow
 * machine than on a fast one — and the difference is not subtle, it is the
 * difference between hair that settles and hair that oscillates. Stepping at a
 * fixed 60 Hz and accumulating the remainder makes the motion a property of the
 * avatar rather than of the frame rate. The accumulator is capped, because a tab
 * returning from the background must not try to catch up on a minute of
 * simulation in one frame.
 */

/** Simulation step, seconds. */
const STEP = 1 / 60;

/**
 * Steps allowed in one frame.
 *
 * Four covers a 15 fps frame. Past that the simulation deliberately falls
 * behind rather than spending the frame catching up — hair lagging for a moment
 * after a stall is invisible, and a frame that takes twice as long because the
 * last one did is how a stall becomes permanent.
 */
const MAX_STEPS = 4;

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
const _seg = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _aim = new THREE.Quaternion();
const _m = new THREE.Matrix4();

const boneChildren = (bone: THREE.Object3D): THREE.Bone[] =>
  bone.children.filter((c): c is THREE.Bone => c instanceof THREE.Bone);

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
  readonly valid: boolean;
  /** Clearance per collider of this joint's group, filled in by calibration. */
  limits: Float32Array;

  constructor(bone: THREE.Bone, parent: THREE.Object3D, kids: THREE.Bone[]) {
    this.bone = bone;
    this.parent = parent;
    this.rest = bone.quaternion.clone();
    this.limits = new Float32Array(0);

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

  constructor(bone: THREE.Bone, spec: ColliderSpec) {
    this.bone = bone;
    this.offset = new THREE.Vector3().fromArray(spec.offset ?? [0, 0, 0]);
    this.tailOffset = spec.tail ? new THREE.Vector3().fromArray(spec.tail) : null;
    this.radius = spec.radius ?? 0.05;
    this.inside = !!spec.inside;
    this.a = new THREE.Vector3();
    this.b = new THREE.Vector3();
  }

  /** Refresh world-space geometry. Once per step, before any joint reads it. */
  place(): void {
    worldQuat(this.bone, _q);
    _p.setFromMatrixPosition(this.bone.matrixWorld);
    this.a.copy(this.offset).applyQuaternion(_q).add(_p);
    if (this.tailOffset) this.b.copy(this.tailOffset).applyQuaternion(_q).add(_p);
    else this.b.copy(this.a);
  }

  /**
   * Nearest point on the capsule's axis, into `_p`, returning the distance from
   * `point` to it. For a sphere the two ends coincide and this collapses to the
   * centre without a special case.
   */
  nearest(point: THREE.Vector3): number {
    _seg.subVectors(this.b, this.a);
    const len2 = _seg.lengthSq();
    let t = 0;
    if (len2 > 1e-12) {
      t = _d.subVectors(point, this.a).dot(_seg) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    _p.copy(this.a).addScaledVector(_seg, t);
    return _d.subVectors(point, _p).length();
  }

  /**
   * Hold `point` at or beyond `min` from the axis — or at or within it, for an
   * inside collider.
   *
   * `min` is calibrated per joint rather than being `radius + tail radius`. See
   * `#calibrate`.
   */
  push(point: THREE.Vector3, min: number): void {
    const dist = this.nearest(point);
    if (this.inside ? dist <= min : dist >= min) return;
    // Dead centre has no direction to leave by. Any is as good as any other,
    // and picking one beats leaving the point buried forever.
    if (dist < 1e-9) _d.set(0, 1, 0);
    else _d.multiplyScalar(1 / dist);
    point.copy(_p).addScaledVector(_d, min);
  }
}

/** One link of a chain: a bone, and the children the run continues into. */
interface RunLink {
  bone: THREE.Bone;
  kids: THREE.Bone[];
}

/** One simulated chain, with the descriptor's figures resolved onto it. */
export interface SpringGroup {
  id: string;
  label: string;
  enabled: boolean;
  joints: Joint[];
  rootJoints: Joint[];
  stiffness: number;
  drag: number;
  gravity: number;
  gravityDir: THREE.Vector3;
  radius: number;
  colliders: Collider[];
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
    this.root.traverse((o) => {
      if (o instanceof THREE.Bone && !byName.has(o.name)) byName.set(o.name, o);
    });
    this.root.updateMatrixWorld(true);

    const colliders = new Map<string, Collider[]>();
    for (const [id, list] of Object.entries(spec.colliders ?? {})) {
      const built: Collider[] = [];
      for (const c of list) {
        const bone = byName.get(c.bone);
        if (bone) built.push(new Collider(bone, c));
        else this.missing.push(`collider:${c.bone}`);
      }
      if (built.length) colliders.set(id, built);
    }

    for (const g of spec.groups) {
      const def = { ...GROUP_DEFAULTS, ...g };
      const roots: THREE.Bone[] = [];
      for (const name of g.roots ?? []) {
        const bone = byName.get(name);
        if (bone) roots.push(bone);
        else this.missing.push(`sway:${name}`);
      }
      // A hub — one bone carrying a whole hem or frill — is an anchor, not a
      // joint. Naming its sixteen children individually would be a list nobody
      // can check against the model, so the descriptor names the hub and the
      // children are read off the rig.
      for (const name of g.childrenOf ?? []) {
        const hub = byName.get(name);
        if (!hub) {
          this.missing.push(`sway:${name}`);
          continue;
        }
        const kids = boneChildren(hub);
        if (!kids.length) this.missing.push(`sway:${name} (子ボーンなし)`);
        roots.push(...kids);
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
      if (!joints.length) continue;

      const rootBones = new Set<THREE.Bone>(roots);
      this.groups.push({
        id: g.id,
        label: g.label ?? g.id,
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
        colliders: (g.colliders ?? []).flatMap((id) => {
          const c = colliders.get(id);
          if (!c) this.missing.push(`collider group:${id}`);
          return c ?? [];
        }),
      });
    }

    this.#calibrate();
    this.reset();
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
      for (const j of g.joints) j.seed();
    }
    for (const g of this.groups) {
      if (!g.colliders.length) continue;
      for (const c of g.colliders) c.place();
      for (const j of g.joints) {
        j.limits = new Float32Array(g.colliders.length);
        for (let i = 0; i < g.colliders.length; i++) {
          const c = g.colliders[i];
          const dist = c.nearest(j.cur);
          j.limits[i] = c.inside
            ? Math.max(c.radius - g.radius, dist)
            : Math.min(c.radius + g.radius, dist);
        }
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
    if (!(g?.colliders.length && g.rootJoints.length && poses?.length)) return;

    for (const q of poses) {
      for (const j of g.rootJoints) j.drive.copy(q);
      this.root.updateMatrixWorld(true);
      for (const j of g.joints) j.seed();
      for (const c of g.colliders) c.place();
      for (const j of g.joints) {
        for (let i = 0; i < g.colliders.length; i++) {
          const c = g.colliders[i];
          const dist = c.nearest(j.cur);
          j.limits[i] = c.inside ? Math.max(j.limits[i], dist) : Math.min(j.limits[i], dist);
        }
      }
    }

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
    for (const g of this.groups) {
      for (const j of g.joints) j.seed();
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

    if (this._pending) {
      this.#seed();
      this._pending = false;
      this._acc = 0;
      return;
    }

    this._acc = Math.min(this._acc + dt, STEP * MAX_STEPS);
    while (this._acc >= STEP) {
      this.#step(STEP);
      this._acc -= STEP;
    }
  }

  #step(dt: number): void {
    for (const g of this.groups) {
      if (!g.enabled) continue;
      for (const c of g.colliders) c.place();

      const stiffness = g.stiffness * this.stiffnessScale * dt;
      const gravity = g.gravity * this.gravityScale * dt;
      // Velocity retained per step. Scaled rather than the drag itself so the
      // control reads the way it behaves: more is a longer swing.
      const retain = Math.min(0.995, Math.max(0, (1 - g.drag) * this.inertiaScale));

      for (const j of g.joints) {
        const bone = j.bone;
        const parent = j.parent;
        worldQuat(parent, _pq);
        _bp.setFromMatrixPosition(bone.matrixWorld);
        j.restDir(_pq, _dir);

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
          for (let i = 0; i < g.colliders.length; i++) g.colliders[i].push(_next, j.limits[i]);
          // Collision moved the point off the sphere the length constraint put
          // it on, so the constraint is reapplied. Doing it once at the end
          // rather than after every collider costs a little accuracy where two
          // colliders overlap and saves a square root per collider per joint.
          _to.subVectors(_next, _bp);
          if (_to.lengthSq() > 1e-12) {
            _next.copy(_bp).addScaledVector(_to.normalize(), j.length);
          }
        }

        j.prev.copy(j.cur);
        j.cur.copy(_next);

        // Rotate the bone from where it rests to where its tail ended up. The
        // rest rotation is carried through rather than replaced, so a bone with
        // an axis that is not its local Y — which is most of them — is handled
        // without knowing anything about how the rig was built.
        _to.subVectors(j.cur, _bp).normalize();
        _aim.setFromUnitVectors(_dir, _to);
        _q.copy(_pq);
        if (j.driven) _q.multiply(j.drive);
        _q.multiply(j.rest).premultiply(_aim);
        bone.quaternion.copy(_pq).invert().multiply(_q);

        // The next joint down reads this bone's world matrix, and three will not
        // refresh it until render. Propagating one link by hand is cheaper than
        // an `updateMatrixWorld` per joint, which would walk the whole subtree
        // once per joint and turn a linear pass into a quadratic one.
        bone.updateMatrix();
        bone.matrixWorld.multiplyMatrices(parent.matrixWorld, bone.matrix);
      }
    }
  }
}
