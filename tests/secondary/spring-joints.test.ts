import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { allocating, core, views } from '@/core';
import { JOINT_OUT, LAYOUT, LAYOUT_JOINT_STATES } from '@/core/abi/spring';
import { SceneGraph } from '@/core/scene';
import { buildProfile } from '@/engine/profile';
import { type Joint, Spring } from '@/engine/secondary';
import { must } from '../helpers/must';
import { addBoneChain, buildRig } from '../helpers/scene';

/**
 * A joint's outputs are read from the core when first asked for after an update, not copied on
 * every update.
 */

const STEP = 1 / 60;
const FIELDS = ['cur', 'prev', 'solvedQ', 'prevSolvedQ', 'swing'] as const;

function mount() {
  const rig = buildRig();
  addBoneChain(rig, { parent: 'Head', root: 'Hair', joints: 3 });
  const descriptor = {
    ...rig.descriptor,
    sway: { groups: [{ id: 'Hair', roots: ['Hair'], gravity: 0.1 }] },
  };
  const spring = new Spring(buildProfile(rig.root, descriptor), descriptor);
  const head = must(rig.bones.get('Head'), 'Head');
  const joint = must(spring.groups[0]?.joints[1], 'joint');
  return { root: rig.root, spring, head, joint };
}

/** f64 index of `joint`'s output record in the core's joint states. */
function stateAt(spring: Spring, joint: Joint): number {
  const c = core();
  const layout = new Uint32Array(c.memory.buffer, c.hd_spring_layout(spring.handle), LAYOUT);
  return (layout[LAYOUT_JOINT_STATES] >>> 3) + JOINT_OUT * joint.slot;
}

function step(spring: Spring, head: THREE.Bone, k: number): void {
  head.rotation.y = 0.1 * Math.sin(k);
  spring.update(STEP);
}

describe('Spring joint outputs', () => {
  it('lives on the prototype as getters', () => {
    const { root, spring, joint } = mount();
    const proto = Object.getPrototypeOf(joint) as object;
    for (const field of FIELDS) {
      expect(Object.hasOwn(joint, field), field).toBe(false);
      expect(Object.getOwnPropertyDescriptor(proto, field)?.get, field).toBeTypeOf('function');
    }
    spring.dispose();
    SceneGraph.of(root).dispose();
  });

  it('reads the core state as the last update left it, once per update', () => {
    const { root, spring, head, joint } = mount();
    for (let k = 0; k < 5; k++) step(spring, head, k);
    const at = stateAt(spring, joint);
    views().f64[at] = 12.5;
    expect(joint.cur.x).toBe(12.5);
    // Already read for this update.
    views().f64[at] = 13.5;
    expect(joint.cur.x).toBe(12.5);
    step(spring, head, 5);
    const { f64 } = views();
    expect(joint.cur.toArray()).toEqual([f64[at], f64[at + 1], f64[at + 2]]);
    expect(joint.prev.toArray()).toEqual([f64[at + 3], f64[at + 4], f64[at + 5]]);
    expect(joint.solvedQ.toArray()).toEqual([f64[at + 6], f64[at + 7], f64[at + 8], f64[at + 9]]);
    expect(joint.prevSolvedQ.toArray()).toEqual([
      f64[at + 10],
      f64[at + 11],
      f64[at + 12],
      f64[at + 13],
    ]);
    expect(joint.swing.toArray()).toEqual([f64[at + 14], f64[at + 15], f64[at + 16]]);
    spring.dispose();
    SceneGraph.of(root).dispose();
  });

  it('reads through views made after the memory grew', () => {
    const { root, spring, head, joint } = mount();
    step(spring, head, 0);
    const before = core().memory.buffer;
    allocating(() => core().memory.grow(4));
    expect(core().memory.buffer).not.toBe(before);
    const at = stateAt(spring, joint);
    views().f64[at + 1] = -7.25;
    expect(joint.cur.y).toBe(-7.25);
    expect(joint.cur.toArray().every(Number.isFinite)).toBe(true);
    step(spring, head, 1);
    expect(joint.prev.toArray().every(Number.isFinite)).toBe(true);
    spring.dispose();
    SceneGraph.of(root).dispose();
  });

  it('keeps the outputs of the last update after dispose', () => {
    const { root, spring, head, joint } = mount();
    for (let k = 0; k < 3; k++) step(spring, head, k);
    const at = stateAt(spring, joint);
    views().f64[at + 2] = 3.75;
    const { f64 } = views();
    const swing = [f64[at + 14], f64[at + 15], f64[at + 16]];
    spring.dispose();
    SceneGraph.of(root).dispose();
    expect(joint.cur.z).toBe(3.75);
    expect(joint.swing.toArray()).toEqual(swing);
    expect(joint.solvedQ).toBeInstanceOf(THREE.Quaternion);
  });
});
