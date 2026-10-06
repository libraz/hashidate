import { buildProfile } from '@/engine/profile';
import { Spring } from '@/engine/secondary';
import type { AvatarDescriptor } from '@/engine/types';
import { must } from './must';
import { addBoneChain, buildRig } from './scene';

const STEP = 1 / 60;

/** Producers, an unattached chain and an attached one on one rig. */
export function makeTrajectoryFixture() {
  const rig = buildRig({ armatureScale: 0.01 });
  addBoneChain(rig, { parent: 'Hips', root: 'ProducerA', joints: 3 });
  addBoneChain(rig, { parent: 'Head', root: 'Hair', joints: 3 });
  addBoneChain(rig, { parent: 'Hips', root: 'CharmRoot', joints: 3 });
  const descriptor: AvatarDescriptor = {
    ...rig.descriptor,
    sway: {
      groups: [
        { id: 'producerA', roots: ['ProducerA'], stiffness: 0.9, drag: 0.32, gravity: 0.11 },
        { id: 'hair', roots: ['Hair'], stiffness: 1.2, drag: 0.5 },
        {
          id: 'charm',
          roots: ['CharmRoot'],
          anchor: {
            influences: [
              { bone: 'ProducerA_1', weight: 0.6, position: [0, -2, 0] },
              { bone: 'ProducerA_2', weight: 0.4, position: [1, -3, 0.5] },
            ],
          },
          stiffness: 0,
          drag: 0.45,
          gravity: 0.16,
        },
      ],
      colliders: {},
    },
  };
  return { rig, spring: new Spring(buildProfile(rig.root, descriptor), descriptor) };
}

/** Each joint's tail and local rotation, flattened in group order. */
export function trajectoryState(spring: Spring): number[][] {
  return spring.groups.flatMap((group) =>
    group.joints.map((joint) => [...joint.cur.toArray(), ...joint.bone.quaternion.toArray()]),
  );
}

/**
 * Ninety frames of one step each on the fixture, the run the recorded
 * trajectory in `tests/secondary/spring-trajectory.json` was taken from.
 */
export function runTrajectory(): number[][] {
  const { rig, spring } = makeTrajectoryFixture();
  spring.update(0);
  for (let frame = 1; frame <= 90; frame++) {
    const t = frame / 60;
    must(rig.bones.get('Hips'), 'Hips').rotation.set(
      Math.sin(t * 2.1) * 0.3,
      Math.cos(t * 1.3) * 0.25,
      0,
    );
    must(rig.bones.get('Head'), 'Head').rotation.set(
      0,
      Math.sin(t * 3.7) * 0.5,
      Math.sin(t * 2.9) * 0.2,
    );
    spring.update(STEP);
  }
  return trajectoryState(spring);
}
