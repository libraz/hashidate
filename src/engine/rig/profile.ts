/**
 * The numeric profile the core's rig is made from, assembled from a TS `Profile` through
 * `hd_profile_*` (tabled in `src/core/abi/profile.ts`).
 *
 * Bones become the scene graph's indices. What construction measures off the mesh — the trunk and
 * head volumes and the face's skin — is measured here, at the pose the rig is built in, and handed
 * over as arrays.
 */

import type * as THREE from 'three';
import { allocating, core } from '../../core';
import {
  ARM_SLOTS,
  ARM_TWIST_SLOTS,
  BONE_SLOTS,
  FINGERS,
  JOINT_DOFS,
  JOINT_FINGER_PROXIMAL,
  JOINT_THUMB_DISTAL,
  LIMB_LOWER,
  LIMB_PITCH,
  LIMB_PROXIMAL,
  LIMB_SHIN,
  LIMB_THIGH,
  LIMB_TIP,
  LIMB_UPPER,
  PART_HEAD,
  PART_TORSO,
  SIDES,
} from '../../core/abi/profile';
import type { SceneGraph } from '../../core/scene';
import { type MeasuredVolume, measureBodyVolumes } from '../anatomy/volume';
import type { Profile } from '../types';

const LIMB_KEYS: Record<string, number> = {
  upper: LIMB_UPPER,
  lower: LIMB_LOWER,
  thigh: LIMB_THIGH,
  shin: LIMB_SHIN,
  pitch: LIMB_PITCH,
  proximal: LIMB_PROXIMAL,
};

function f32At(address: number, n: number): Float32Array {
  return new Float32Array(core().memory.buffer, address, n);
}

function f64At(address: number, n: number): Float64Array {
  return new Float64Array(core().memory.buffer, address, n);
}

function writeVolume(p: number, part: number, v: MeasuredVolume): void {
  const c = core();
  const { r } = v;
  const cells = allocating(() =>
    c.hd_profile_volume(
      p,
      part,
      r ? 1 : 0,
      r?.length ?? 0,
      v.bands,
      v.sectors,
      v.top,
      v.bottom,
      v.radius,
    ),
  );
  if (r) f32At(cells, r.length).set(r);
}

/**
 * A profile pointer for `hd_rig_new`, which consumes it. `graph` must be `SceneGraph.of` the
 * profile's root, and the avatar posed as `Rig`'s constructor leaves it.
 */
export function buildCoreProfile(profile: Profile, graph: SceneGraph): number {
  const c = core();
  const p = allocating(() => c.hd_profile_new());
  try {
    fill(p, profile, graph);
  } catch (error) {
    allocating(() => c.hd_profile_free(p));
    throw error;
  }
  return p;
}

function fill(p: number, profile: Profile, graph: SceneGraph): void {
  const c = core();
  const at = (bone: THREE.Object3D | undefined) => (bone ? graph.indexOf(bone) : undefined);

  for (const [code, slot] of BONE_SLOTS.entries()) {
    const node = at(profile.bones[slot]);
    if (node !== undefined) c.hd_profile_bone(p, code, node);
    const dir = profile.restDir[slot];
    if (dir) c.hd_profile_rest_dir(p, code, dir.x, dir.y, dir.z);
  }
  for (const [s, side] of SIDES.entries()) {
    for (const [f, finger] of FINGERS.entries()) {
      const chain = profile.fingerBones[`${finger}.${side}`];
      if (!chain) continue;
      allocating(() => c.hd_profile_finger(p, s, f, chain.length));
      for (const [i, bone] of chain.entries()) {
        const dir = profile.restDir[`${finger}.${side}.${i}`];
        c.hd_profile_finger_bone(p, s, f, i, graph.indexOf(bone), dir.x, dir.y, dir.z);
      }
    }
  }
  c.hd_profile_side_sign(p, profile.sideSign);
  for (const [key, value] of Object.entries(profile.limb)) {
    const [name, side, finger] = key.split('.');
    const s = SIDES.indexOf(side as (typeof SIDES)[number]);
    const code =
      name === 'tip'
        ? LIMB_TIP + FINGERS.indexOf(finger as (typeof FINGERS)[number])
        : LIMB_KEYS[name];
    if (s < 0 || code === undefined || code < 0) throw new Error(`Rig: unknown limb ${key}`);
    c.hd_profile_limb(p, s, code, value);
  }

  const scratch = f64At(c.hd_profile_scratch(p), 16);
  const face = profile.face;
  if (face) {
    scratch.set([
      ...face.origin.toArray(),
      ...face.right.toArray(),
      ...face.up.toArray(),
      ...face.forward.toArray(),
      face.ipd,
      ...(face.mouth?.toArray() ?? [0, 0, 0]),
    ]);
    c.hd_profile_face(p, face.mouth ? 1 : 0);
  }
  const body = profile.body;
  if (body) {
    const span = typeof body.span === 'number' ? body.span : null;
    scratch.set([
      ...body.right.toArray(),
      ...body.up.toArray(),
      ...body.forward.toArray(),
      span ?? 0,
    ]);
    c.hd_profile_body(p, span === null ? 0 : 1);
  }

  const table = profile.anatomy;
  if (table) {
    const rows = table.shoulder.elevation;
    allocating(() => c.hd_profile_anatomy(p, rows.length));
    for (const [code, [joint, name]] of JOINT_DOFS.entries()) {
      const dof = table[joint].dofs[name];
      if (dof) {
        c.hd_profile_joint(p, code, 1, dof.free[0], dof.free[1], dof.max[0], dof.max[1]);
      } else if (code >= JOINT_FINGER_PROXIMAL && code <= JOINT_THUMB_DISTAL) {
        c.hd_profile_joint(p, code, 0, 0, 0, 0, 0);
      } else {
        throw new Error(`Rig: the joint table override has no ${joint}.${name}`);
      }
    }
    for (const [plane, free, max] of rows) c.hd_profile_elevation(p, plane, free, max);
  }
  for (const [code, slot] of ARM_TWIST_SLOTS.entries()) {
    const twist = profile.armTwists?.[slot];
    if (!twist) continue;
    c.hd_profile_arm_twist(
      p,
      code,
      graph.indexOf(twist.primary),
      graph.indexOf(twist.next),
      graph.indexOf(twist.helper),
    );
  }
  for (const [code, slot] of ARM_SLOTS.entries()) {
    const dir = profile.avatar.armRest?.[slot];
    if (dir) c.hd_profile_arm_rest(p, code, dir[0], dir[1], dir[2]);
  }

  const volumes = measureBodyVolumes(profile);
  if (volumes.torso) writeVolume(p, PART_TORSO, volumes.torso);
  const head = volumes.head;
  if (head) {
    writeVolume(p, PART_HEAD, head);
    const skin = head.face;
    if (skin) {
      const n = skin.pos.length;
      f32At(
        allocating(() => c.hd_profile_face_skin(p, n / 3)),
        n,
      ).set(skin.pos);
      f32At(c.hd_profile_face_normals(p), n).set(skin.nrm);
    }
  }
}
