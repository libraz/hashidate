import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Collider, Spring } from '@/engine/secondary/spring';
import type { AvatarDescriptor, ColliderSpec } from '@/engine/types';
import { must } from '../helpers/must';
import { addBoneChain, buildRig } from '../helpers/scene';

/**
 * Hair, a skirt and a bow hanging from a plain node on the hair, against a
 * torso carrying enough colliders on one bone to be clustered, capsules on the
 * legs, colliders riding the hair itself and an inside sphere.
 */
function cullFixture() {
  const rig = buildRig({ armatureScale: 0.01 });
  addBoneChain(rig, {
    parent: 'Head',
    root: 'Hair',
    joints: 3,
    rootOffset: [0.02, 0.05, -0.06],
    segmentOffset: [0, -0.07, -0.03],
  });
  addBoneChain(rig, {
    parent: 'Hair_1',
    root: 'HairB',
    joints: 2,
    segmentOffset: [0.03, -0.06, 0],
  });
  addBoneChain(rig, { parent: 'Hips', root: 'SkirtHub', joints: 1, rootOffset: [0, 0, 0] });
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    addBoneChain(rig, {
      parent: 'SkirtHub',
      root: `Skirt${k}`,
      joints: 3,
      rootOffset: [Math.cos(a) * 0.12, -0.02, Math.sin(a) * 0.1],
      segmentOffset: [Math.cos(a) * 0.02, -0.09, Math.sin(a) * 0.02],
    });
  }
  const clip = new THREE.Object3D();
  clip.name = 'Clip';
  clip.position.set(1, -1, 0);
  clip.rotation.set(0.2, 0.1, -0.3);
  must(rig.bones.get('Hair_3'), 'Hair_3').add(clip);
  rig.bones.set('Clip', clip as THREE.Bone);
  addBoneChain(rig, { parent: 'Clip', root: 'Bow', joints: 2, segmentOffset: [0.02, -0.05, 0.01] });

  const torso: ColliderSpec[] = [];
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    const at: [number, number, number] = [
      Math.cos(a) * 0.1,
      (k % 3) * 0.05 - 0.05,
      Math.sin(a) * 0.08,
    ];
    torso.push(
      k % 2
        ? { bone: 'UpperChest', offset: at, radius: 0.04 }
        : { bone: 'UpperChest', offset: at, tail: [at[0], at[1] + 0.1, at[2]], radius: 0.03 },
    );
  }
  const descriptor: AvatarDescriptor = {
    ...rig.descriptor,
    sway: {
      groups: [
        {
          id: 'hair',
          roots: ['Hair'],
          stiffness: 0.4,
          drag: 0.2,
          gravity: 1,
          colliders: ['head', 'torso', 'arms'],
        },
        {
          id: 'skirt',
          childrenOf: ['SkirtHub'],
          stiffness: 0.3,
          drag: 0.25,
          gravity: 0.8,
          colliders: ['legs', 'torso', 'ribbon'],
        },
        {
          id: 'bow',
          roots: ['Bow'],
          stiffness: 0.2,
          drag: 0.1,
          gravity: 0.5,
          colliders: ['hairc', 'head'],
        },
      ],
      colliders: {
        head: [{ bone: 'Head', offset: [0, 0.08, 0], radius: 0.09 }],
        torso,
        arms: [
          { bone: 'UpperArm_L', tail: [0.2, 0, 0], radius: 0.04 },
          { bone: 'UpperArm_R', tail: [-0.2, 0, 0], radius: 0.04 },
        ],
        legs: [
          { bone: 'Hips', offset: [0.09, -0.05, 0], tail: [0.09, -0.45, 0.02], radius: 0.07 },
          { bone: 'Hips', offset: [-0.09, -0.05, 0], tail: [-0.09, -0.45, 0.02], radius: 0.07 },
          { bone: 'Hips', offset: [0, -0.1, 0.02], radius: 0.12 },
        ],
        ribbon: [{ bone: 'Hips', offset: [0, -0.2, 0], radius: 0.45, inside: true }],
        hairc: [
          { bone: 'Hair_2', tail: [0, -0.05, 0], radius: 0.02 },
          { bone: 'Hair_2', offset: [0.02, 0, 0], radius: 0.015 },
          { bone: 'Hair_2', offset: [-0.02, -0.02, 0], radius: 0.015 },
        ],
      },
    },
  };
  return { rig, spring: new Spring(buildProfile(rig.root, descriptor), descriptor) };
}

const DTS = [1 / 72, 1 / 72, 1 / 50, 1 / 144, 1 / 60, 1 / 30, 0.05, 1 / 90];

/** Every frame's bones and tails, bit for bit, over a run that swings the body hard. */
function run(disableCulling: boolean): number[][] {
  const { rig, spring } = cullFixture();
  if (disableCulling) {
    for (const g of spring.groups)
      for (const j of g.joints) j.clusterReach.fill(Number.POSITIVE_INFINITY);
  }
  const bone = (name: string) => must(rig.bones.get(name), name);
  const frames: number[][] = [];
  let t = 0;
  for (let frame = 0; frame < 360; frame++) {
    const dt = DTS[frame % DTS.length];
    t += dt;
    bone('Hips').rotation.set(Math.sin(t * 2.1) * 0.6, Math.cos(t * 1.3) * 0.9, 0);
    bone('UpperChest').rotation.set(Math.sin(t * 1.7) * 0.4, 0, Math.cos(t * 2.3) * 0.3);
    bone('Head').rotation.set(Math.sin(t * 4.1) * 0.8, Math.sin(t * 3.7) * 1.2, 0);
    rig.root.rotation.y = Math.sin(t * 0.5) * 2;
    spring.update(dt);
    const state: number[] = [];
    rig.root.traverse((o) => {
      state.push(...o.quaternion.toArray(), o.rotation.x, o.rotation.y, o.rotation.z);
      state.push(...o.matrixWorld.elements);
    });
    for (const g of spring.groups) for (const j of g.joints) state.push(...j.cur.toArray());
    frames.push(state);
  }
  return frames;
}

describe('collider culling', () => {
  it('changes no bit of any bone against testing every pair in full', () => {
    const proto = Collider.prototype;
    const { beyond, push, clearLink } = proto;
    const counts = { beyond: 0, culled: 0, contacts: 0 };
    const counted = (disable: boolean) => {
      proto.beyond = function (root, reach) {
        counts.beyond++;
        const far = !disable && beyond.call(this, root, reach);
        if (far) counts.culled++;
        return far;
      };
    };
    proto.push = function (point, min) {
      const moved = push.call(this, point, min);
      if (moved) counts.contacts++;
      return moved;
    };
    proto.clearLink = function (root, tip, length, min) {
      const moved = clearLink.call(this, root, tip, length, min);
      if (moved) counts.contacts++;
      return moved;
    };
    try {
      counted(true);
      const full = run(true);
      const fullBeyond = counts.beyond;
      expect(counts.contacts).toBeGreaterThan(0);
      counts.beyond = 0;
      counted(false);
      const culled = run(false);
      // Pairs were culled one by one, and whole clusters without a test each.
      expect(counts.culled).toBeGreaterThan(0);
      expect(counts.beyond).toBeLessThan(fullBeyond);
      expect(culled).toHaveLength(full.length);
      for (let f = 0; f < full.length; f++) {
        const i = full[f].findIndex((v, k) => !Object.is(v, culled[f][k]));
        expect({ frame: f, at: i }).toEqual({ frame: f, at: -1 });
      }
    } finally {
      Object.assign(proto, { beyond, push, clearLink });
    }
  });
});
