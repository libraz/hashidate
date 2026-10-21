import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { type Joint, Spring } from '@/engine/secondary';
import type { AvatarDescriptor, SwayGroupSpec } from '@/engine/types';
import { must } from '../helpers/must';
import { addBoneChain, buildRig } from '../helpers/scene';

const STEP = 1 / 60;

/** A joint's tail with `local` as its rotation, under its parent as drawn this frame. */
function tailAt(joint: Joint, local: THREE.Quaternion): THREE.Vector3 {
  const q = new THREE.Quaternion()
    .setFromRotationMatrix(new THREE.Matrix4().extractRotation(joint.parent.matrixWorld))
    .multiply(local);
  return joint.axis
    .clone()
    .multiplyScalar(joint.length)
    .applyQuaternion(q)
    .add(new THREE.Vector3().setFromMatrixPosition(joint.bone.matrixWorld));
}

/**
 * Hair pressed by a sideways gravity against a sphere that rides on the same
 * head, so the sphere and the chain's parent move rigidly together and any
 * penetration on screen is the solver's own.
 */
function contactFixture() {
  const rig = buildRig();
  addBoneChain(rig, { parent: 'Head', root: 'Hair', joints: 2 });
  const group: SwayGroupSpec = {
    id: 'hair',
    roots: ['Hair'],
    stiffness: 0.4,
    drag: 0.2,
    gravity: 1.5,
    gravityDir: [0, 0, 1],
    radius: 0.01,
    colliders: ['face'],
  };
  const descriptor: AvatarDescriptor = {
    ...rig.descriptor,
    sway: {
      groups: [group],
      colliders: { face: [{ bone: 'Head', offset: [0, -0.12, 0.16], radius: 0.06 }] },
    },
  };
  const spring = new Spring(buildProfile(rig.root, descriptor), descriptor);
  return { rig, spring, head: must(rig.bones.get('Head'), 'Head') };
}

/**
 * How much deeper inside its clearance any drawn tail sits than the last solved
 * step put it, in metres. The step's own depth is the solver's business; what is
 * drawn between steps must not add to it.
 */
function overshoot(spring: Spring): number {
  let worst = 0;
  for (const g of spring.groups) {
    for (const c of g.colliders) c.place();
    for (const j of g.joints) {
      const drawn = tailAt(j, j.bone.quaternion);
      const solved = tailAt(j, j.solvedQ);
      for (const [i, c] of g.colliders.entries()) {
        const depth = (p: THREE.Vector3) => Math.max(0, j.limits[i] - c.nearest(p));
        worst = Math.max(worst, depth(drawn) - depth(solved));
      }
    }
  }
  return worst;
}

/** Whether the solver's own state has a tail lying on its clearance. */
function resting(spring: Spring): boolean {
  return spring.groups.some((g) =>
    g.joints.some((j) => g.colliders.some((c, i) => c.nearest(j.cur) - j.limits[i] < 1e-4)),
  );
}

describe('Spring / contact between steps', () => {
  it('does not carry a collided step forward into the collider at 144 Hz', () => {
    const { rig, spring, head } = contactFixture();
    spring.update(0);
    let worst = 0;
    let touched = 0;
    for (let i = 0; i < 144 * 3; i++) {
      head.rotation.x = 0.5 * Math.sin((i / 144) * Math.PI * 2 * 1.3);
      head.rotation.y = 0.4 * Math.sin((i / 144) * Math.PI * 2 * 0.9);
      rig.root.updateMatrixWorld(true);
      spring.update(1 / 144);
      if (resting(spring)) touched++;
      worst = Math.max(worst, overshoot(spring));
    }
    expect(touched).toBeGreaterThan(50);
    expect(worst).toBeLessThan(1e-9);
  });
});

describe('Spring / a link swung round to face away from its rest', () => {
  it('keeps the roll steady while the tail circles the exact opposite of rest', () => {
    const rig = buildRig();
    addBoneChain(rig, { parent: 'Head', root: 'Hair', joints: 1 });
    const descriptor: AvatarDescriptor = {
      ...rig.descriptor,
      sway: { groups: [{ id: 'hair', roots: ['Hair'], stiffness: 0, drag: 0.99, gravity: 0 }] },
    };
    const spring = new Spring(buildProfile(rig.root, descriptor), descriptor);
    spring.update(0);
    const joint = must(spring.groups[0]?.joints[0], 'joint');
    const parentQ = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().extractRotation(joint.parent.matrixWorld),
    );
    const dir = joint.restDir(parentQ, new THREE.Vector3());
    const base = new THREE.Vector3().setFromMatrixPosition(joint.bone.matrixWorld);
    const u = new THREE.Vector3(1, 0, 0).cross(dir).normalize();
    const v = dir.clone().cross(u).normalize();

    const seen: THREE.Quaternion[] = [];
    for (let i = 0; i < 32; i++) {
      // A 20 mrad circle about straight back, crossing every side of it.
      const a = (i / 8) * Math.PI * 2;
      const to = dir
        .clone()
        .negate()
        .addScaledVector(u, 0.02 * Math.cos(a))
        .addScaledVector(v, 0.02 * Math.sin(a))
        .normalize();
      joint.cur.copy(base).addScaledVector(to, joint.length);
      joint.prev.copy(joint.cur);
      spring.update(STEP);
      seen.push(
        new THREE.Quaternion().setFromRotationMatrix(
          new THREE.Matrix4().extractRotation(joint.bone.matrixWorld),
        ),
      );
    }
    const steps = seen.slice(1).map((q, i) => q.angleTo(seen[i]));
    // The tail moves 16 mrad per step; a roll flip turns the bone by most of a half turn.
    expect(Math.max(...steps)).toBeLessThan(0.05);
  });
});

describe('Spring / a chain hanging from a node another chain carries', () => {
  /** Hair on the head, and a ribbon hung off a plain node that rides on the hair's first link. */
  function bridged() {
    const rig = buildRig();
    addBoneChain(rig, { parent: 'Head', root: 'Hair', joints: 2 });
    const mount = new THREE.Object3D();
    mount.name = 'RibbonMount';
    mount.position.set(0.02, -0.03, 0.01);
    must(rig.bones.get('Hair'), 'Hair').add(mount);
    const ribbon = new THREE.Bone();
    ribbon.name = 'Ribbon';
    mount.add(ribbon);
    rig.bones.set('Ribbon', ribbon);
    addBoneChain(rig, { parent: 'Ribbon', root: 'Ribbon_A', joints: 1 });
    const descriptor: AvatarDescriptor = {
      ...rig.descriptor,
      sway: {
        groups: [
          { id: 'hair', roots: ['Hair'], stiffness: 0.6, drag: 0.3 },
          { id: 'ribbon', roots: ['Ribbon'], stiffness: 0.8, drag: 0.4 },
        ],
      },
    };
    const spring = new Spring(buildProfile(rig.root, descriptor), descriptor);
    return { rig, spring, mount, head: must(rig.bones.get('Head'), 'Head') };
  }

  it.each([60, 50])('reads the carried node as the hair has just left it, at %i Hz', (hz) => {
    const { rig, spring, mount, head } = bridged();
    spring.update(0);
    const ribbon = must(spring.groups[1]?.joints[0], 'ribbon root');
    expect(ribbon.parent).toBe(mount);
    const fresh = new THREE.Matrix4();
    let worst = 0;
    for (let i = 0; i < hz; i++) {
      head.rotation.y = 0.6 * Math.sin((i / hz) * Math.PI * 2);
      rig.root.updateMatrixWorld(true);
      spring.update(1 / hz);
      // Where the mount really is under the hair as drawn now.
      fresh.multiplyMatrices(must(mount.parent, 'mount parent').matrixWorld, mount.matrix);
      const base = new THREE.Vector3().setFromMatrixPosition(
        new THREE.Matrix4().multiplyMatrices(fresh, ribbon.bone.matrix),
      );
      worst = Math.max(
        worst,
        base.distanceTo(new THREE.Vector3().setFromMatrixPosition(ribbon.bone.matrixWorld)),
      );
      // The step solved the ribbon from that base, so its tail is one length from it.
      if (hz === 60) worst = Math.max(worst, Math.abs(ribbon.cur.distanceTo(base) - ribbon.length));
    }
    expect(worst).toBeLessThan(1e-6);
  });
});
