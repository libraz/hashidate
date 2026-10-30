import * as THREE from 'three';
import { allocating, core, views } from '../../core';
import {
  COLLIDER_OUT,
  CONTROL_HEAD,
  DIAGNOSTICS,
  DRIVE_ANCHORED,
  DRIVE_DONE,
  JOINT_OUT,
  LAYOUT,
  LAYOUT_COLLIDER_STATES,
  LAYOUT_CONTROL,
  LAYOUT_DIAGNOSTICS,
  LAYOUT_DRIVES,
  LAYOUT_GROUP_COUNT,
  LAYOUT_GROUP_STATES,
  LAYOUT_JOINT_STATES,
  LAYOUT_STATUSES,
  NO_NODE,
  STATUS,
  STATUS_ANCESTOR_SIMULATED,
  STATUS_ANCHOR_MODE_CHANGED,
  STATUS_ANCHOR_NONUNIFORM,
  STATUS_ANCHOR_NOT_AFFINE,
  STATUS_ANCHOR_PARENT_SINGULAR,
  STATUS_ANCHOR_SCALE_CHANGED,
  STATUS_ANCHOR_SHEAR,
  STATUS_ANCHOR_SINGULAR,
  STATUS_ANCHOR_WORLD_OVERRIDE,
  STATUS_SOURCE_DEPENDS,
  STATUS_SUBTREE_SIMULATED,
} from '../../core/abi/spring';
import { SceneGraph } from '../../core/scene';
import { type Localized, same } from '../../i18n/locale';
import { normaliseBoneName } from '../profile/candidates';
import type {
  AvatarDescriptor,
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
 *
 * ## The core
 *
 * The solver runs in the wasm core, on the avatar's scene graph (`SceneGraph.of(profile.root)`),
 * reading and writing its nodes in place. This side keeps what is about names — bone lookup,
 * descriptor defaults, the anchor spec's checks and every `missing` message — and hands the core
 * numbers only: graph indices of the colliders' bones and of each group's roots and anchor. Per
 * frame it runs its own world update, copies the switches, scales and drives in, runs one
 * `hd_spring_update`, and reads the joints, groups, diagnostics and colliders back. The layouts
 * are tabled in `src/core/abi/spring.ts`. `dispose` frees the core's half.
 */

const GROUP_DEFAULTS = {
  stiffness: 1, // restoring force toward the rest direction
  drag: 0.4, // fraction of velocity lost per step, 0..1
  gravity: 0, // constant acceleration along gravityDir
  gravityDir: [0, -1, 0],
  radius: 0.02, // the swinging tail's own radius, for collision
};

const boneChildren = (bone: THREE.Object3D): THREE.Bone[] =>
  bone.children.filter((c): c is THREE.Bone => c instanceof THREE.Bone);

/**
 * One simulated joint, mirrored from the core after every update and reset.
 *
 * The tail is stored in world space rather than as an angle: a bone is itself moving, so an angle
 * has no frame to be measured in, and a world-space point needs none.
 */
export class Joint {
  readonly bone: THREE.Bone;
  /** What the bone hangs from. Fixed at construction. */
  readonly parent: THREE.Object3D;
  readonly rest: THREE.Quaternion;
  readonly axis: THREE.Vector3;
  readonly length: number;
  driven = false;
  /** Written by a drive each frame; copied into the core while `driven`. */
  readonly drive = new THREE.Quaternion();
  readonly cur = new THREE.Vector3();
  readonly prev = new THREE.Vector3();
  readonly solvedQ = new THREE.Quaternion();
  readonly prevSolvedQ = new THREE.Quaternion();
  readonly swing = new THREE.Vector3();
  /** Clearance per collider of this joint's group, as calibrated (Float32, as in the core). */
  readonly limits: Float32Array;
  readonly spans: Float32Array;
  /** Position across every group's joints, which the core's joint buffers are indexed by. */
  readonly slot: number;

  constructor(
    bone: THREE.Bone,
    parent: THREE.Object3D,
    rest: THREE.Quaternion,
    axis: THREE.Vector3,
    length: number,
    colliders: number,
    slot: number,
  ) {
    this.bone = bone;
    this.parent = parent;
    this.rest = rest;
    this.axis = axis;
    this.length = length;
    this.limits = new Float32Array(colliders);
    this.spans = new Float32Array(colliders);
    this.slot = slot;
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
}

/** A collider of the core's pool, shared by every group that names it. */
export class Collider {
  readonly bone: THREE.Bone;
  readonly radius: number;
  readonly inside: boolean;
  /** The axis ends as last placed. */
  readonly a = new THREE.Vector3();
  readonly b = new THREE.Vector3();
  readonly #owner: Spring;
  readonly #index: number;

  constructor(owner: Spring, index: number, bone: THREE.Bone, radius: number, inside: boolean) {
    this.#owner = owner;
    this.#index = index;
    this.bone = bone;
    this.radius = radius;
    this.inside = inside;
  }

  /** Place on the bone's world matrix as the last update left it. */
  place(): void {
    core().hd_spring_collider_place(this.#owner.handle, this.#index);
    this.read(views().f64, this.#owner.colliderStates);
  }

  /** Distance from `point` to the axis as last placed. */
  nearest(point: THREE.Vector3): number {
    return core().hd_spring_collider_nearest(
      this.#owner.handle,
      this.#index,
      point.x,
      point.y,
      point.z,
    );
  }

  /** Distance from the axis as last placed to the segment `p0`–`p1`. */
  linkDistance(p0: THREE.Vector3, p1: THREE.Vector3): number {
    return core().hd_spring_collider_link_distance(
      this.#owner.handle,
      this.#index,
      p0.x,
      p0.y,
      p0.z,
      p1.x,
      p1.y,
      p1.z,
    );
  }

  /** @internal Refresh `a` and `b` from the collider state buffer at f64 index `base`. */
  read(f64: Float64Array, base: number): void {
    const at = base + COLLIDER_OUT * this.#index;
    this.a.set(f64[at], f64[at + 1], f64[at + 2]);
    this.b.set(f64[at + 3], f64[at + 4], f64[at + 5]);
  }
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
  /** The attached root, while its anchor holds. Placement is the core's, so it cannot be replaced. */
  anchor: { readonly root: THREE.Bone } | null;
}

/** What the TS side keeps of a group `hd_spring_group_end` kept, by key. */
interface Registered {
  id: string;
  label: Localized;
  stiffness: number;
  gravity: number;
  radius: number;
  colliders: Collider[];
  anchorRoot: THREE.Bone | null;
}

/** The message for a status the core reported. */
function statusText(kind: number, node: string, other: string): string {
  switch (kind) {
    case STATUS_ANCHOR_NOT_AFFINE:
      return `anchor:${node} requires a finite affine local transform`;
    case STATUS_ANCHOR_SINGULAR:
      return `anchor:${node} has a singular local transform`;
    case STATUS_ANCHOR_NONUNIFORM:
      return `anchor:${node} does not support nonuniform scale`;
    case STATUS_ANCHOR_SHEAR:
      return `anchor:${node} does not support shear`;
    case STATUS_ANCHOR_MODE_CHANGED:
      return `anchor:${node} transform mode changed after resolution`;
    case STATUS_ANCHOR_SCALE_CHANGED:
      return `anchor:${node} scale changed after resolution`;
    case STATUS_ANCHOR_WORLD_OVERRIDE:
      return `anchor:${node} has a manual matrixWorld override`;
    case STATUS_ANCHOR_PARENT_SINGULAR:
      return 'anchor parent world is singular';
    case STATUS_ANCESTOR_SIMULATED:
      return `root ancestor is simulated by another group: ${node}`;
    case STATUS_SUBTREE_SIMULATED:
      return `root subtree is simulated by another group: ${node}`;
    case STATUS_SOURCE_DEPENDS:
      return `source ${node} depends on group ${other} at or after this group`;
    default:
      throw new Error(`unknown spring status ${kind}`);
  }
}

/** f64 and u32 element index of a byte pointer. */
const f64At = (ptr: number): number => ptr >>> 3;
const u32At = (ptr: number): number => ptr >>> 2;

export class Spring {
  readonly p: Profile;
  readonly root: THREE.Object3D;
  readonly groups: SpringGroup[] = [];
  readonly missing: string[] = [];
  readonly drivenJoints: Joint[] = [];

  enabled = true;
  stiffnessScale = 1;
  inertiaScale = 1;
  gravityScale = 1;

  #handle = 0;
  #graph: SceneGraph | null = null;
  /** Every node of the graph by its index. */
  #nodes: THREE.Object3D[] = [];
  #layout = new Uint32Array(LAYOUT);
  #registered: Registered[] = [];
  #pool: Collider[] = [];
  #joints: Joint[] = [];
  #diagnostics = new Float64Array(0);

  /**
   * @param profile  the avatar profile; only `root` is used
   * @param avatar   the avatar descriptor. No `sway` field means no secondary motion.
   */
  constructor(profile: Profile, avatar?: AvatarDescriptor) {
    this.p = profile;
    this.root = profile.root;

    const spec = avatar?.sway;
    if (!spec?.groups?.length) return;

    const graph = SceneGraph.of(this.root);
    const byName = new Map<string, THREE.Bone>();
    const bonesByName = new Map<string, THREE.Bone[]>();
    this.root.traverse((o) => {
      if (!(o instanceof THREE.Bone)) return;
      const key = normaliseBoneName(o.name);
      if (!byName.has(key)) byName.set(key, o);
      const matches = bonesByName.get(key) ?? [];
      matches.push(o);
      bonesByName.set(key, matches);
    });
    this.root.updateMatrixWorld(true);

    const nodes: THREE.Object3D[] = [];
    this.root.traverse((o) => {
      const i = graph.indexOf(o);
      if (i !== NO_NODE) nodes[i] = o;
    });
    const at = (node: THREE.Object3D): number => {
      const i = graph.indexOf(node);
      if (i === NO_NODE) throw new Error(`spring node outside the avatar: ${node.name}`);
      return i;
    };

    const c = core();
    const h = allocating(() => c.hd_spring_new(graph.handle));
    const scratch = f64At(c.hd_spring_scratch(h));

    const colliders = new Map<string, Collider[]>();
    for (const [id, list] of Object.entries(spec.colliders ?? {})) {
      const built: Collider[] = [];
      for (const cs of list) {
        const bone = byName.get(normaliseBoneName(cs.bone));
        if (!bone) {
          this.missing.push(`collider:${cs.bone}`);
          continue;
        }
        const offset = cs.offset ?? [0, 0, 0];
        const tail = cs.tail;
        const radius = cs.radius ?? 0.05;
        const inside = !!cs.inside;
        const k = allocating(() =>
          c.hd_spring_collider(
            h,
            at(bone),
            offset[0],
            offset[1],
            offset[2],
            tail ? 1 : 0,
            tail ? tail[0] : 0,
            tail ? tail[1] : 0,
            tail ? tail[2] : 0,
            radius,
            inside ? 1 : 0,
          ),
        );
        const collider = new Collider(this, k, bone, radius, inside);
        this.#pool.push(collider);
        built.push(collider);
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

      // The spec is checked, and its names resolved, by the TS anchor; the core takes the result.
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

      const dir = def.gravityDir;
      c.hd_spring_group_begin(
        h,
        def.stiffness,
        def.drag,
        def.gravity,
        dir[0],
        dir[1],
        dir[2],
        def.radius,
      );
      for (const r of roots) allocating(() => c.hd_spring_group_root(h, at(r)));
      if (anchor) {
        c.hd_spring_group_anchor(h, at(anchor.root));
        for (const { bone, weight, position } of anchor.influences) {
          allocating(() =>
            c.hd_spring_anchor_influence(h, at(bone), weight, position.x, position.y, position.z),
          );
        }
      }
      // Measuring a joint climbs into the root's ancestors, so this and the build run mirrored.
      if (!graph.run(() => allocating(() => c.hd_spring_group_end(h)))) {
        if (anchor) this.missing.push(`sway:${g.id} anchor: root has no simulated descendants`);
        continue;
      }
      const groupColliders = (g.colliders ?? []).flatMap((id) => {
        const list = colliders.get(id);
        if (!list) this.missing.push(`collider group:${id}`);
        return list ?? [];
      });
      for (const collider of groupColliders) {
        allocating(() => c.hd_spring_group_collider(h, this.#pool.indexOf(collider)));
      }
      this.#registered.push({
        id: g.id,
        label: g.label ?? same(g.id),
        stiffness: def.stiffness,
        gravity: def.gravity,
        radius: def.radius,
        colliders: groupColliders,
        anchorRoot: anchor?.root ?? null,
      });
    }

    const statuses = graph.run(() => allocating(() => c.hd_spring_build(h)));
    this.#handle = h;
    this.#graph = graph;
    this.#nodes = nodes;
    this.#layout.set(new Uint32Array(core().memory.buffer, c.hd_spring_layout(h), LAYOUT));
    this.#report(statuses);

    const groupCount = this.#layout[LAYOUT_GROUP_COUNT];
    for (let g = 0; g < groupCount; g++) {
      c.hd_spring_group_info(h, g);
      const { f64 } = views();
      const reg = this.#registered[f64[scratch]];
      const count = f64[scratch + 1];
      const drag = f64[scratch + 2];
      const gravityDir = new THREE.Vector3(f64[scratch + 3], f64[scratch + 4], f64[scratch + 5]);
      const joints: Joint[] = [];
      const rootJoints: Joint[] = [];
      for (let k = 0; k < count; k++) {
        c.hd_spring_joint_info(h, g, k);
        const v = views().f64;
        const joint = new Joint(
          nodes[v[scratch]] as THREE.Bone,
          this.#node(v[scratch + 1]) as THREE.Object3D,
          new THREE.Quaternion(v[scratch + 7], v[scratch + 8], v[scratch + 9], v[scratch + 10]),
          new THREE.Vector3(v[scratch + 4], v[scratch + 5], v[scratch + 6]),
          v[scratch + 3],
          reg.colliders.length,
          this.#joints.length,
        );
        joints.push(joint);
        if (v[scratch + 2]) rootJoints.push(joint);
        this.#joints.push(joint);
      }
      this.groups.push({
        id: reg.id,
        label: reg.label,
        enabled: true,
        joints,
        rootJoints,
        stiffness: reg.stiffness,
        drag,
        gravity: reg.gravity,
        gravityDir,
        radius: reg.radius,
        colliders: reg.colliders,
        anchor: reg.anchorRoot ? { root: reg.anchorRoot } : null,
      });
    }
    this.#diagnostics = new Float64Array(DIAGNOSTICS * groupCount);
    if (!groupCount) {
      this.dispose();
      return;
    }
    this.#readLimits(this.groups);
    this.#readOutputs();
  }

  /** @internal The core handle, 0 once disposed. */
  get handle(): number {
    return this.#handle;
  }

  /** @internal f64 index of the collider state buffer. */
  get colliderStates(): number {
    return f64At(this.#layout[LAYOUT_COLLIDER_STATES]);
  }

  /** The step accumulator. */
  get _acc(): number {
    return this.#handle ? core().hd_spring_acc(this.#handle) : 0;
  }

  /** Current weighted target and root residual for attachment diagnostics. */
  get anchorDiagnostics(): Array<{ groupId: string } & SkinPointAnchorDiagnostics> {
    const d = this.#diagnostics;
    return this.groups.flatMap((group, g) => {
      if (!group.anchor) return [];
      const at = DIAGNOSTICS * g;
      return [
        {
          groupId: group.id,
          targetWorld: [d[at], d[at + 1], d[at + 2]] as [number, number, number],
          rootWorld: [d[at + 3], d[at + 4], d[at + 5]] as [number, number, number],
          error: d[at + 6],
        },
      ];
    });
  }

  /** Whether this avatar has any secondary motion at all. */
  get active(): boolean {
    return this.groups.length > 0;
  }

  /** Simulated joints, across every group. Reported in the panel. */
  get count(): number {
    return this.groups.reduce((n, g) => n + g.joints.length, 0);
  }

  /**
   * Drop everything back to the rest pose, on the next update.
   *
   * Deferred rather than done here, because the caller is usually a button on the
   * panel and the pose at that moment is whatever the last frame left — seeding
   * from it would bake a mid-swing pose in as the thing the hair returns to.
   */
  reset(): void {
    if (this.#handle) core().hd_spring_reset(this.#handle);
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
    const index = this.groups.findIndex((x) => x.id === id);
    const g = this.groups[index];
    if (!g?.rootJoints.length) return null;
    const h = this.#handle;
    if (allocating(() => core().hd_spring_enable_drive(h, index)) === DRIVE_ANCHORED) {
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

  /**
   * Widen a driven group's clearance to cover the poses it will actually be put
   * in, given as the extremes of the drive's range. Sampled rather than solved;
   * this runs once at load.
   */
  calibrateDrive(id: string, poses: THREE.Quaternion[]): void {
    const index = this.groups.findIndex((x) => x.id === id);
    const g = this.groups[index];
    const graph = this.#graph;
    if (!(g && graph)) return;
    const c = core();
    const h = this.#handle;
    for (const q of poses ?? []) allocating(() => c.hd_spring_drive_pose(h, q.x, q.y, q.z, q.w));
    this.#writeInputs();
    const outcome = graph.run(() => allocating(() => c.hd_spring_calibrate_drive(h, index)));
    this.#readOutputs();
    if (outcome === DRIVE_ANCHORED) {
      this.missing.push(`drive:${id} cannot own an attached spring root`);
      return;
    }
    if (outcome !== DRIVE_DONE) return;
    for (const j of g.rootJoints) j.drive.identity();
    this.#readLimits([g]);
  }

  /**
   * Advance the simulation and write the result onto the bones. Must run after everything else
   * has posed the body for this frame.
   */
  update(dt: number): void {
    const graph = this.#graph;
    if (!(this.groups.length && this.#handle && graph)) return;
    // The core reads world matrices only when the simulation is on, as `Spring` does.
    if (this.enabled) this.root.updateMatrixWorld(true);
    this.#writeInputs();
    const h = this.#handle;
    const statuses = graph.run(() => core().hd_spring_update(h, dt));
    this.#readOutputs();
    this.#report(statuses);
  }

  /** Free the core's half. The instance does nothing afterwards. */
  dispose(): void {
    const h = this.#handle;
    if (!h) return;
    allocating(() => core().hd_spring_free(h));
    this.#handle = 0;
    this.#graph = null;
  }

  /** The node at core index `i`: a graph node, or past the graph one of the root's ancestors. */
  #node(i: number): THREE.Object3D | null {
    if (i < this.#nodes.length) return this.#nodes[i];
    let node = this.root.parent;
    for (let k = i - this.#nodes.length; k > 0 && node; k--) node = node.parent;
    return node;
  }

  /** Copy the switches, scales and drives into the core. */
  #writeInputs(): void {
    const { f64 } = views();
    const L = this.#layout;
    const control = f64At(L[LAYOUT_CONTROL]);
    f64[control] = this.enabled ? 1 : 0;
    f64[control + 1] = this.stiffnessScale;
    f64[control + 2] = this.inertiaScale;
    f64[control + 3] = this.gravityScale;
    for (let g = 0; g < this.groups.length; g++) {
      f64[control + CONTROL_HEAD + g] = this.groups[g].enabled ? 1 : 0;
    }
    const drives = f64At(L[LAYOUT_DRIVES]);
    for (const j of this.drivenJoints) {
      const at = drives + 4 * j.slot;
      f64[at] = j.drive.x;
      f64[at + 1] = j.drive.y;
      f64[at + 2] = j.drive.z;
      f64[at + 3] = j.drive.w;
    }
  }

  /** Read the core's joints, groups, diagnostics and colliders back; the nodes are its own. */
  #readOutputs(): void {
    const { f64, u32 } = views();
    const L = this.#layout;
    const joints = f64At(L[LAYOUT_JOINT_STATES]);
    for (const j of this.#joints) {
      const at = joints + JOINT_OUT * j.slot;
      j.cur.set(f64[at], f64[at + 1], f64[at + 2]);
      j.prev.set(f64[at + 3], f64[at + 4], f64[at + 5]);
      j.solvedQ.set(f64[at + 6], f64[at + 7], f64[at + 8], f64[at + 9]);
      j.prevSolvedQ.set(f64[at + 10], f64[at + 11], f64[at + 12], f64[at + 13]);
      j.swing.set(f64[at + 14], f64[at + 15], f64[at + 16]);
    }
    const states = u32At(L[LAYOUT_GROUP_STATES]);
    for (let g = 0; g < this.groups.length; g++) {
      const group = this.groups[g];
      group.enabled = u32[states + 2 * g] !== 0;
      if (!u32[states + 2 * g + 1]) group.anchor = null;
    }
    this.#diagnostics.set(
      f64.subarray(
        f64At(L[LAYOUT_DIAGNOSTICS]),
        f64At(L[LAYOUT_DIAGNOSTICS]) + this.#diagnostics.length,
      ),
    );
    const colliders = this.colliderStates;
    for (const c of this.#pool) c.read(f64, colliders);
  }

  /** Turn the core's statuses into `missing` entries; the core has switched those groups off. */
  #report(count: number): void {
    if (!count) return;
    const { u32 } = views();
    const at = u32At(this.#layout[LAYOUT_STATUSES]);
    for (let k = 0; k < count; k++) {
      const [kind, key, node, other] = u32.subarray(at + STATUS * k, at + STATUS * (k + 1));
      const name = node === NO_NODE ? '' : (this.#node(node)?.name ?? '');
      const owner = other === NO_NODE ? '' : this.#registered[other].id;
      this.missing.push(
        `sway:${this.#registered[key].id} anchor: ${statusText(kind, name, owner)}`,
      );
    }
  }

  /** Copy calibrated clearances out of the core. */
  #readLimits(groups: readonly SpringGroup[]): void {
    const c = core();
    for (const group of groups) {
      const g = this.groups.indexOf(group);
      group.joints.forEach((joint, k) => {
        const n = joint.limits.length;
        if (!n) return;
        const { buffer } = c.memory;
        joint.limits.set(new Float32Array(buffer, c.hd_spring_joint_limits(this.#handle, g, k), n));
        joint.spans.set(new Float32Array(buffer, c.hd_spring_joint_spans(this.#handle, g, k), n));
      });
    }
  }
}
