import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Spring } from '@/engine/secondary';
import type { AvatarDescriptor, ColliderSpec, SwayGroupSpec } from '@/engine/types';
import { must } from '../helpers/must';
import { addBoneChain, buildRig, type SyntheticRig } from '../helpers/scene';
import { skinnedPoint } from '../helpers/skinned-point';
import trajectoryRecord from './spring-trajectory.json';

const STEP = 1 / 60;

interface ChainSpec {
  parent: string;
  root: string;
  joints?: number;
}

interface SpringFixture {
  rig: SyntheticRig;
  spring: Spring;
}

function makeSpring(
  groups: SwayGroupSpec[],
  chains: ChainSpec[],
  colliders: Record<string, ColliderSpec[]> = {},
): SpringFixture {
  const rig = buildRig();
  for (const chain of chains) addBoneChain(rig, chain);
  const descriptor: AvatarDescriptor = {
    ...rig.descriptor,
    sway: { groups, colliders },
  };
  const profile = buildProfile(rig.root, descriptor);
  return { rig, spring: new Spring(profile, descriptor) };
}

function snapshot(spring: Spring) {
  return spring.groups.flatMap((g) =>
    g.joints.map((j) => ({
      cur: j.cur.clone(),
      prev: j.prev.clone(),
      quaternion: j.bone.quaternion.clone(),
    })),
  );
}

function expectSameSnapshot(
  actual: ReturnType<typeof snapshot>,
  expected: ReturnType<typeof snapshot>,
) {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < actual.length; i++) {
    expect(actual[i].cur.distanceTo(expected[i].cur)).toBeLessThan(1e-6);
    expect(actual[i].prev.distanceTo(expected[i].prev)).toBeLessThan(1e-6);
    expect(actual[i].quaternion.angleTo(expected[i].quaternion)).toBeLessThan(1e-6);
  }
}

function expectFinite(spring: Spring): void {
  for (const group of spring.groups) {
    for (const joint of group.joints) {
      const values = [
        ...joint.cur.toArray(),
        ...joint.prev.toArray(),
        ...joint.bone.quaternion.toArray(),
        ...joint.drive.toArray(),
      ];
      expect(values.every((value) => Number.isFinite(value))).toBe(true);
    }
  }
}

function speed(spring: Spring): number {
  return spring.groups
    .flatMap((g) => g.joints)
    .reduce((total, joint) => total + joint.cur.distanceTo(joint.prev), 0);
}

function makeAnchorFixture(
  options: {
    attached?: boolean;
    metadata?: boolean;
    missingMetadata?: boolean;
    laterSource?: boolean;
    invalidSource?: string;
    duplicateSource?: boolean;
    simulatedAnchorParent?: boolean;
    measuredFloat32Charm?: boolean;
  } = {},
) {
  const rig = buildRig({ armatureScale: 0.01 });
  addBoneChain(rig, { parent: 'Hips', root: 'ProducerA', joints: 3 });
  addBoneChain(rig, { parent: 'Spine', root: 'ProducerB', joints: 3 });
  addBoneChain(rig, { parent: 'Hips', root: 'CharmRoot', joints: 3 });
  if (options.measuredFloat32Charm) {
    const root = must(rig.bones.get('CharmRoot'), 'CharmRoot');
    root.scale.set(1, Math.fround(0.9999998807907104), Math.fround(1.0000059604644775));
    for (const name of ['CharmRoot', 'CharmRoot_1', 'CharmRoot_2']) {
      must(rig.bones.get(name), name).quaternion.set(
        Math.fround(-0.5785567164421082),
        Math.fround(0.5854491591453552),
        Math.fround(-0.5619037747383118),
        Math.fround(-0.08237501978874207),
      );
    }
  }
  if (options.simulatedAnchorParent) {
    const mount = new THREE.Bone();
    mount.name = 'CharmMount';
    must(rig.bones.get('Hips'), 'Hips').add(mount);
    const charmRoot = must(rig.bones.get('CharmRoot'), 'CharmRoot');
    must(charmRoot.parent, 'parent').remove(charmRoot);
    mount.add(charmRoot);
    rig.bones.set('CharmMount', mount);
  }

  const anchor = {
    influences: [
      { bone: 'ProducerA_1', weight: 0.31, position: [0, -2, 0] as [number, number, number] },
      { bone: 'ProducerA_2', weight: 0.27, position: [1, -3, 0.5] as [number, number, number] },
      { bone: 'ProducerB_1', weight: 0.22, position: [-0.5, -2, 1] as [number, number, number] },
      { bone: 'ProducerB_2', weight: 0.2, position: [0, -1, -1] as [number, number, number] },
    ],
  };
  if (options.invalidSource)
    must(anchor.influences[0], 'influences[0]').bone = options.invalidSource;
  if (options.duplicateSource) {
    const duplicate = new THREE.Bone();
    duplicate.name = 'ProducerA_1';
    must(rig.bones.get('Hips'), 'Hips').add(duplicate);
  }
  const producerGroups: SwayGroupSpec[] = [
    {
      id: 'producerA',
      roots: ['ProducerA'],
      stiffness: 0.9,
      drag: 0.32,
      gravity: 0.11,
      gravityDir: [0, -1, 0],
    },
    {
      id: 'producerB',
      roots: ['ProducerB'],
      stiffness: 0.7,
      drag: 0.41,
      gravity: 0.07,
      gravityDir: [0, -1, 0],
    },
  ];
  const anchorGroup: SwayGroupSpec = {
    id: 'charm',
    roots: ['CharmRoot'],
    anchor: options.metadata ? { source: 'bone-metadata' } : anchor,
    stiffness: 0,
    drag: 0.45,
    gravity: 0.16,
    gravityDir: [0, -1, 0],
  };
  if (options.metadata && !options.missingMetadata) {
    must(rig.bones.get('CharmRoot'), 'CharmRoot').userData.skinPointAnchor = anchor;
  }
  const groups = options.laterSource
    ? [anchorGroup, ...producerGroups]
    : options.attached === false
      ? producerGroups
      : options.simulatedAnchorParent
        ? [
            ...producerGroups,
            {
              id: 'mountProducer',
              roots: ['CharmMount'],
              stiffness: 0.7,
              gravity: 0,
            },
            anchorGroup,
          ]
        : [...producerGroups, anchorGroup];
  const descriptor: AvatarDescriptor = {
    ...rig.descriptor,
    sway: { groups, colliders: {} },
  };
  const profile = buildProfile(rig.root, descriptor);
  return { rig, spring: new Spring(profile, descriptor), descriptor, anchor };
}

function originalMotionState(spring: Spring) {
  return spring.groups
    .filter((group) => group.id.startsWith('producer'))
    .flatMap((group) =>
      group.joints.map((joint) => ({
        id: joint.bone.name,
        cur: joint.cur.toArray(),
        prev: joint.prev.toArray(),
        quaternion: joint.bone.quaternion.toArray(),
        matrix: joint.bone.matrix.toArray(),
        matrixWorld: joint.bone.matrixWorld.toArray(),
        dirty: joint.bone.matrixWorldNeedsUpdate,
      })),
    );
}

function originalDynamicsState(spring: Spring) {
  return spring.groups
    .filter((group) => group.id.startsWith('producer'))
    .flatMap((group) =>
      group.joints.map((joint) => ({
        id: joint.bone.name,
        cur: joint.cur.toArray(),
        prev: joint.prev.toArray(),
        quaternion: joint.bone.quaternion.toArray(),
      })),
    );
}

/** How far the attached root sits from the point its producers' bones put the skin at now. */
function anchorMiss(fixture: ReturnType<typeof makeAnchorFixture>): number {
  const diagnostics = fixture.spring.anchorDiagnostics[0];
  if (!diagnostics) throw new Error('fixture has no attached group');
  return new THREE.Vector3(...diagnostics.rootWorld).distanceTo(
    skinnedPoint(fixture.rig.root, fixture.anchor.influences, (name) =>
      fixture.rig.bones.get(name),
    ),
  );
}

function poseAnchorFixture(fixture: ReturnType<typeof makeAnchorFixture>, frame: number): void {
  const hips = must(fixture.rig.bones.get('Hips'), 'Hips');
  const spine = must(fixture.rig.bones.get('Spine'), 'Spine');
  fixture.rig.root.position.set(
    0.3 + Math.sin(frame * 0.13) * 0.04,
    Math.cos(frame * 0.07) * 0.03,
    -0.2 + Math.sin(frame * 0.11) * 0.02,
  );
  fixture.rig.root.quaternion.setFromEuler(
    new THREE.Euler(
      Math.sin(frame * 0.03) * 0.11,
      Math.cos(frame * 0.05) * 0.16,
      Math.sin(frame * 0.09) * 0.08,
    ),
  );
  hips.rotation.set(
    Math.sin(frame * 0.12) * 0.24,
    Math.cos(frame * 0.08) * 0.2,
    Math.sin(frame * 0.17) * 0.19,
  );
  spine.rotation.set(
    Math.cos(frame * 0.09) * 0.2,
    Math.sin(frame * 0.14) * 0.16,
    Math.cos(frame * 0.18) * 0.13,
  );
}

function makeSimpleAnchor(stiffness: number) {
  const rig = buildRig({ armatureScale: 0.01 });
  addBoneChain(rig, { parent: 'Hips', root: 'GravityCharm', joints: 3 });
  const descriptor: AvatarDescriptor = {
    ...rig.descriptor,
    sway: {
      groups: [
        {
          id: 'gravityCharm',
          roots: ['GravityCharm'],
          anchor: {
            influences: [{ bone: 'Hips', weight: 1, position: [0, 0, 0] }],
          },
          stiffness,
          drag: 0.45,
          gravity: 0.16,
          gravityDir: [0, -1, 0],
        },
      ],
      colliders: {},
    },
  };
  const spring = new Spring(buildProfile(rig.root, descriptor), descriptor);
  return { rig, spring };
}

describe('Spring', () => {
  it('keeps a resting chain stable and finite, including a calibrated collider', () => {
    const { spring } = makeSpring(
      [
        {
          id: 'hair',
          stiffness: 1,
          drag: 0.4,
          colliders: ['head'],
          roots: ['Hair'],
        },
      ],
      [{ parent: 'Head', root: 'Hair', joints: 3 }],
      { head: [{ bone: 'Head', offset: [0, 0, 0], radius: 0.2 }] },
    );

    // The collider deliberately overlaps the bind pose. Calibration must keep
    // the artist's pose rather than throwing the chain out on its first frame.
    const group = spring.groups[0];
    expect(group).toBeDefined();
    expect(group.colliders).toHaveLength(1);

    spring.update(0);
    const seeded = snapshot(spring);
    for (let i = 0; i < 180; i++) spring.update(STEP);

    expectSameSnapshot(snapshot(spring), seeded);
    expectFinite(spring);
  });

  it('caps a long frame at four fixed steps instead of catching up unboundedly', () => {
    const build = () =>
      makeSpring(
        [{ id: 'hair', stiffness: 1.3, drag: 0.55, roots: ['Hair'] }],
        [{ parent: 'Head', root: 'Hair', joints: 3 }],
      );
    const capped = build();
    const reference = build();
    capped.spring.update(0);
    reference.spring.update(0);

    // Give the solver an actual response to integrate; a motionless rest pose
    // would also pass if the accumulator were accidentally ignored.
    capped.rig.bones.get('Head')?.rotateY(0.6);
    reference.rig.bones.get('Head')?.rotateY(0.6);
    capped.rig.root.updateMatrixWorld(true);
    reference.rig.root.updateMatrixWorld(true);

    capped.spring.update(10);
    reference.spring.update(STEP * 4);

    expect(capped.spring._acc).toBeCloseTo(0, 14);
    expectSameSnapshot(snapshot(capped.spring), snapshot(reference.spring));
    expectFinite(capped.spring);
  });

  it('makes seed and restore idempotent, including after a body teleport', () => {
    const { rig, spring } = makeSpring(
      [{ id: 'hair', stiffness: 1.1, drag: 0.5, roots: ['Hair'] }],
      [{ parent: 'Head', root: 'Hair', joints: 3 }],
    );
    spring.update(0);

    spring.reset();
    spring.update(0);
    const seededOnce = snapshot(spring);
    spring.reset();
    spring.update(0);
    const seededTwice = snapshot(spring);
    expectSameSnapshot(seededTwice, seededOnce);

    rig.bones.get('Head')?.rotateX(0.45);
    rig.root.updateMatrixWorld(true);
    for (let i = 0; i < 30; i++) spring.update(STEP);

    spring.enabled = false;
    spring.update(0);
    const restoredOnce = snapshot(spring);
    spring.update(0.8);
    const restoredTwice = snapshot(spring);
    expectSameSnapshot(restoredTwice, restoredOnce);
    for (const group of spring.groups) {
      for (const joint of group.joints) {
        expect(joint.bone.quaternion.angleTo(joint.rest)).toBeLessThan(1e-6);
      }
    }

    // Enabling after a large world-space move must seed the new pose rather
    // than carrying stale tail points across the teleport.
    rig.root.position.set(3, 0, -2);
    rig.bones.get('Head')?.rotateY(-0.35);
    rig.root.updateMatrixWorld(true);
    spring.enabled = true;
    spring.update(0);
    for (const joint of spring.groups.flatMap((group) => group.joints)) {
      expect(joint.cur.distanceTo(joint.prev)).toBeLessThan(1e-12);
    }
    expectFinite(spring);
  });

  it('lets independent side chains respond without contaminating one another', () => {
    const groups = [
      {
        id: 'sides',
        stiffness: 1.2,
        drag: 0.55,
        roots: ['LeftHair', 'RightHair'],
      },
    ];
    const baseline = makeSpring(groups, [
      { parent: 'Shoulder_L', root: 'LeftHair', joints: 3 },
      { parent: 'Shoulder_R', root: 'RightHair', joints: 3 },
    ]);
    const moved = makeSpring(groups, [
      { parent: 'Shoulder_L', root: 'LeftHair', joints: 3 },
      { parent: 'Shoulder_R', root: 'RightHair', joints: 3 },
    ]);
    baseline.spring.update(0);
    moved.spring.update(0);
    const leftBefore = moved.spring.groups[0].joints
      .filter((joint) => joint.bone.name.startsWith('LeftHair'))
      .map((joint) => joint.cur.clone());

    moved.rig.bones.get('Shoulder_L')?.rotateX(0.65);
    moved.rig.root.updateMatrixWorld(true);
    baseline.spring.update(STEP);
    moved.spring.update(STEP);

    const baselineRight = baseline.spring.groups[0].joints.filter((joint) =>
      joint.bone.name.startsWith('RightHair'),
    );
    const movedRight = moved.spring.groups[0].joints.filter((joint) =>
      joint.bone.name.startsWith('RightHair'),
    );
    expect(movedRight).toHaveLength(baselineRight.length);
    for (let i = 0; i < movedRight.length; i++) {
      expect(movedRight[i].cur.distanceTo(baselineRight[i].cur)).toBeLessThan(1e-6);
      expect(movedRight[i].bone.quaternion.angleTo(baselineRight[i].bone.quaternion)).toBeLessThan(
        1e-6,
      );
    }
    const leftAfter = moved.spring.groups[0].joints
      .filter((joint) => joint.bone.name.startsWith('LeftHair'))
      .map((joint) => joint.cur);
    expect(leftAfter.some((point, i) => point.distanceTo(leftBefore[i]) > 1e-6)).toBe(true);
    expectFinite(moved.spring);
  });

  it('responds to a moved parent and converges without stretching a link', () => {
    const { rig, spring } = makeSpring(
      [{ id: 'hair', stiffness: 1.4, drag: 0.6, roots: ['Hair'] }],
      [{ parent: 'Head', root: 'Hair', joints: 4 }],
    );
    spring.update(0);
    rig.bones.get('Head')?.rotateY(0.7);
    rig.root.updateMatrixWorld(true);

    spring.update(STEP);
    const firstSpeed = speed(spring);
    for (let i = 0; i < 240; i++) spring.update(STEP);
    const finalSpeed = speed(spring);

    expect(firstSpeed).toBeGreaterThan(0);
    expect(finalSpeed).toBeLessThan(firstSpeed);
    for (const joint of spring.groups.flatMap((group) => group.joints)) {
      const base = joint.bone.getWorldPosition(new THREE.Vector3());
      expect(joint.cur.distanceTo(base)).toBeCloseTo(joint.length, 9);
    }
    expectFinite(spring);
  });
});

describe('Spring step inputs', () => {
  /** Producers, an unattached chain and an attached one on one rig. */
  function makeTrajectoryFixture() {
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

  function state(spring: Spring): number[][] {
    return spring.groups.flatMap((group) =>
      group.joints.map((joint) => [...joint.cur.toArray(), ...joint.bone.quaternion.toArray()]),
    );
  }

  it('is the single-step solver unchanged at one step per frame', () => {
    // Recorded from the solver before steps read an interpolated body.
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
    // Close to 12 places rather than equal: x64 and arm64 libm round the last bit differently.
    const actual = state(spring);
    expect(actual.map((joint) => joint.length)).toEqual(
      trajectoryRecord.sixtyHz.map((joint) => joint.length),
    );
    for (const [i, joint] of actual.entries()) {
      for (const [k, value] of joint.entries()) {
        expect(value).toBeCloseTo(trajectoryRecord.sixtyHz[i][k], 12);
      }
    }
  });

  it('feeds each step of a two-step frame the body at its own place in the frame', () => {
    // A yaw about the spine's own axis is exact under slerp, so a frame of two
    // steps must land where two frames of one step, posed at each, land.
    const pose = (rig: SyntheticRig, t: number) => {
      must(rig.bones.get('Hips'), 'Hips').rotation.y = 1.3 * t;
      must(rig.bones.get('Head'), 'Head').rotation.y = -2.1 * t;
    };
    const double = makeTrajectoryFixture();
    const single = makeTrajectoryFixture();
    double.spring.update(0);
    single.spring.update(0);
    for (let frame = 1; frame <= 30; frame++) {
      pose(single.rig, (2 * frame - 1) * STEP);
      single.spring.update(STEP);
      pose(single.rig, 2 * frame * STEP);
      single.spring.update(STEP);
      pose(double.rig, 2 * frame * STEP);
      double.spring.update(2 * STEP);
    }
    const a = state(double.spring);
    const b = state(single.spring);
    for (let i = 0; i < a.length; i++) {
      for (let k = 0; k < 7; k++)
        expect(must(must(a[i], 'a[i]')[k], 'a[i][k]')).toBeCloseTo(
          must(must(b[i], 'b[i]')[k], 'b[i][k]'),
          9,
        );
    }
  });

  it('advances a chain evenly at 50 Hz instead of in 1-1-1-1-2 steps', () => {
    const { rig, spring } = makeSpring(
      [{ id: 'hair', stiffness: 1.2, drag: 0.5, roots: ['Hair'] }],
      [{ parent: 'Head', root: 'Hair', joints: 3 }],
    );
    const head = must(rig.bones.get('Head'), 'Head');
    const root = must(must(spring.groups[0], 'groups[0]').joints[0], 'joints[0]').bone;
    const world = new THREE.Quaternion();
    const last = new THREE.Quaternion();
    const advance: number[] = [];
    spring.update(0);
    for (let frame = 1; frame <= 200; frame++) {
      head.rotation.y = 0.6 * Math.sin(frame * 0.02 * Math.PI);
      spring.update(0.02);
      root.getWorldQuaternion(world);
      if (frame > 1) advance.push(world.angleTo(last));
      last.copy(world);
    }
    // Two seconds past the start-up transient. Measured 0.008 with each step
    // reading the body at its own time, 0.061 with every step fed the frame's pose.
    const steady = advance.slice(50, 150);
    const mean = steady.reduce((sum, value) => sum + value, 0) / steady.length;
    let roughness = 0;
    for (let i = 1; i < steady.length - 1; i++) {
      roughness += Math.abs(
        must(steady[i], 'steady[i]') -
          (must(steady[i - 1], 'steady[i - 1]') + must(steady[i + 1], 'steady[i + 1]')) / 2,
      );
    }
    roughness /= (steady.length - 2) * mean;
    expect(mean).toBeGreaterThan(1e-3);
    expect(roughness).toBeLessThan(0.03);
  });

  it('interpolates nothing across a reset and teleport', () => {
    const pose = (rig: SyntheticRig) => {
      rig.root.position.set(1.7, 0, -0.9);
      must(rig.bones.get('Hips'), 'Hips').rotation.y = 0.4;
      must(rig.bones.get('Head'), 'Head').rotation.y = -0.3;
    };
    const moved = makeTrajectoryFixture();
    moved.spring.update(0);
    for (let frame = 1; frame <= 20; frame++) {
      must(moved.rig.bones.get('Head'), 'Head').rotation.y = Math.sin(frame * 0.3) * 0.6;
      moved.spring.update(0.02);
    }
    moved.spring.reset();
    pose(moved.rig);
    moved.spring.update(0.02);

    const fresh = makeTrajectoryFixture();
    pose(fresh.rig);
    fresh.spring.update(0);
    // Two steps each, so the first step of every frame reads an interpolated body.
    for (let frame = 0; frame < 5; frame++) {
      moved.spring.update(2 * STEP);
      fresh.spring.update(2 * STEP);
    }
    expect(state(moved.spring)).toEqual(state(fresh.spring));
  });

  it('restarts an attached group switched back on mid-motion without a fling', () => {
    const fixture = makeAnchorFixture();
    const attached = must(
      fixture.spring.groups.find((group) => group.id === 'charm'),
      'charm group',
    );
    const hips = must(fixture.rig.bones.get('Hips'), 'Hips');
    fixture.spring.update(0);
    for (let frame = 1; frame <= 8; frame++) {
      hips.rotation.y = frame * 0.12;
      if (frame === 6) attached.enabled = false;
      if (frame === 8) attached.enabled = true;
      // Two steps a frame, so the first reads a body between frames.
      fixture.spring.update(2 * STEP);
    }
    for (const joint of attached.joints) {
      expect(joint.cur.distanceTo(joint.prev)).toBeLessThan(0.005);
    }
    expect(anchorMiss(fixture)).toBeLessThan(1e-6);
  });

  it('keeps an attachment on the producers at 50 Hz', () => {
    const fixture = makeAnchorFixture();
    fixture.spring.update(0);
    for (let frame = 1; frame <= 60; frame++) {
      poseAnchorFixture(fixture, frame);
      fixture.spring.update(0.02);
      expect(anchorMiss(fixture)).toBeLessThan(1e-6);
    }
  });
});

describe('Spring weighted root attachments', () => {
  it('resolves root metadata and disables the whole group for missing, duplicate or later sources', () => {
    const valid = makeAnchorFixture({ metadata: true });
    expect(valid.spring.groups.map((group) => group.id)).toEqual([
      'producerA',
      'producerB',
      'charm',
    ]);
    expect(valid.spring.groups.at(-1)?.anchor).toBeDefined();
    expect(valid.spring.anchorDiagnostics).toHaveLength(1);

    const missing = makeAnchorFixture({ metadata: true, missingMetadata: true });
    expect(missing.spring.groups.map((group) => group.id)).toEqual(['producerA', 'producerB']);
    expect(missing.spring.missing.join('\n')).toMatch(/missing root userData\.skinPointAnchor/);

    const duplicate = makeAnchorFixture({ duplicateSource: true });
    expect(duplicate.spring.groups.map((group) => group.id)).toEqual(['producerA', 'producerB']);
    expect(duplicate.spring.missing.join('\n')).toMatch(/resolve uniquely: ProducerA_1/);

    const later = makeAnchorFixture({ laterSource: true });
    expect(later.spring.groups.map((group) => group.id)).toEqual(['producerA', 'producerB']);
    expect(later.spring.missing.join('\n')).toMatch(
      /depends on group producerA at or after this group/,
    );

    const absent = makeAnchorFixture({ invalidSource: 'NotInTheRig' });
    expect(absent.spring.groups.map((group) => group.id)).toEqual(['producerA', 'producerB']);
    expect(absent.spring.missing.join('\n')).toMatch(/resolve uniquely: NotInTheRig/);

    const cycle = makeAnchorFixture({ invalidSource: 'CharmRoot_1' });
    expect(cycle.spring.groups.map((group) => group.id)).toEqual(['producerA', 'producerB']);
    expect(cycle.spring.missing.join('\n')).toMatch(/root or descendant: CharmRoot_1/);

    const movingParent = makeAnchorFixture({ simulatedAnchorParent: true });
    expect(movingParent.spring.groups.map((group) => group.id)).toContain('mountProducer');
    expect(movingParent.spring.groups.map((group) => group.id)).not.toContain('charm');
    expect(movingParent.spring.missing.join('\n')).toMatch(/root ancestor is simulated/);

    expect(valid.spring.enableDrive('charm')).toBeNull();
    expect(valid.spring.missing.join('\n')).toMatch(/cannot own an attached spring root/);
  });

  it('keeps one multi-influence attachment at the actual point through lifecycle changes', () => {
    const fixture = makeAnchorFixture();
    const attached = must(
      fixture.spring.groups.find((group) => group.id === 'charm'),
      'charm group',
    );
    fixture.spring.update(0);

    const initialTarget = must(
      fixture.spring.anchorDiagnostics[0],
      'anchorDiagnostics[0]',
    ).targetWorld;
    const initialJoints = attached.joints.map((joint) => ({
      cur: joint.cur.toArray(),
      prev: joint.prev.toArray(),
    }));
    fixture.rig.root.position.x += 0.73;
    must(fixture.rig.bones.get('Hips'), 'Hips').rotation.z += 0.31;
    fixture.spring.update(0);
    const zeroStep = must(fixture.spring.anchorDiagnostics[0], 'anchorDiagnostics[0]');
    expect(zeroStep.targetWorld).not.toEqual(initialTarget);
    expect(zeroStep.error).toBeLessThan(1e-8);
    expect(
      attached.joints.map((joint) => ({ cur: joint.cur.toArray(), prev: joint.prev.toArray() })),
    ).toEqual(initialJoints);

    fixture.spring.update(STEP);
    fixture.spring.reset();
    fixture.rig.root.position.z -= 0.42;
    fixture.spring.update(0);
    expect(must(fixture.spring.anchorDiagnostics[0], 'anchorDiagnostics[0]').error).toBeLessThan(
      1e-8,
    );
    expect(attached.joints.every((joint) => joint.cur.equals(joint.prev))).toBe(true);

    const producerBeforeDisable = originalDynamicsState(fixture.spring);
    attached.enabled = false;
    fixture.rig.root.position.y += 0.36;
    fixture.spring.update(0);
    expect(originalDynamicsState(fixture.spring)).toEqual(producerBeforeDisable);
    expect(must(fixture.spring.anchorDiagnostics[0], 'anchorDiagnostics[0]').error).toBeLessThan(
      1e-8,
    );
    expect(attached.joints.every((joint) => joint.bone.quaternion.angleTo(joint.rest) < 1e-8)).toBe(
      true,
    );

    const producerBeforeEnable = originalDynamicsState(fixture.spring);
    attached.enabled = true;
    fixture.spring.update(0);
    expect(originalDynamicsState(fixture.spring)).toEqual(producerBeforeEnable);
    expect(attached.joints.every((joint) => joint.cur.distanceTo(joint.prev) < 1e-12)).toBe(true);
    expect(must(fixture.spring.anchorDiagnostics[0], 'anchorDiagnostics[0]').error).toBeLessThan(
      1e-8,
    );

    fixture.spring.enabled = false;
    fixture.rig.root.position.x -= 0.51;
    fixture.spring.update(0);
    expect(must(fixture.spring.anchorDiagnostics[0], 'anchorDiagnostics[0]').error).toBeLessThan(
      1e-8,
    );
    expect(attached.joints.every((joint) => joint.bone.quaternion.angleTo(joint.rest) < 1e-8)).toBe(
      true,
    );
    fixture.spring.enabled = true;
    fixture.spring.update(0);
    expect(must(fixture.spring.anchorDiagnostics[0], 'anchorDiagnostics[0]').error).toBeLessThan(
      1e-8,
    );
    expect(
      fixture.spring.groups.every((group) =>
        group.joints.every((joint) => joint.cur.equals(joint.prev)),
      ),
    ).toBe(true);
  });

  it('places a disabled accessory after its producers in every fixed substep', () => {
    const fixture = makeAnchorFixture();
    const attached = must(
      fixture.spring.groups.find((group) => group.id === 'charm'),
      'charm group',
    );
    fixture.spring.update(0);
    const before = must(fixture.spring.anchorDiagnostics[0], 'anchorDiagnostics[0]').targetWorld;
    poseAnchorFixture(fixture, 7);
    attached.enabled = false;
    fixture.spring.update(STEP);
    const after = must(fixture.spring.anchorDiagnostics[0], 'anchorDiagnostics[0]');
    expect(after.targetWorld).not.toEqual(before);
    expect(after.error).toBeLessThan(1e-8);
    expect(anchorMiss(fixture)).toBeLessThan(1e-6);
  });

  it.each([true, false])(
    'sits at the skin point of the producers final substep after a multi-substep update, accessory enabled=%s',
    (enabled) => {
      const fixture = makeAnchorFixture();
      const attached = fixture.spring.groups.find((group) => group.id === 'charm');
      if (!attached) throw new Error('fixture has no attached group');
      fixture.spring.update(0);
      attached.enabled = enabled;
      for (let frame = 1; frame <= 12; frame++) {
        poseAnchorFixture(fixture, frame * 5);
        // Three and a half steps: several substeps, and a remainder carried over.
        fixture.spring.update(STEP * 3.5);
        expect(anchorMiss(fixture)).toBeLessThan(1e-6);
      }
    },
  );

  it('uses the solved parent for every attached link and settles world-down with zero stiffness', () => {
    const loose = makeSimpleAnchor(0);
    const tilted = makeSimpleAnchor(1.8);
    must(loose.rig.bones.get('Hips'), 'Hips').rotation.z = 0.72;
    must(tilted.rig.bones.get('Hips'), 'Hips').rotation.z = 0.72;
    loose.spring.update(0);
    tilted.spring.update(0);

    for (let i = 0; i < 360; i++) {
      loose.spring.update(STEP);
      tilted.spring.update(STEP);
    }

    const direction = (fixture: ReturnType<typeof makeSimpleAnchor>) => {
      const group = must(fixture.spring.groups[0], 'groups[0]');
      const base = new THREE.Vector3().setFromMatrixPosition(
        must(group.joints[0], 'joints[0]').bone.matrixWorld,
      );
      return must(group.joints[0], 'joints[0]').cur.clone().sub(base).normalize();
    };
    const worldDown = new THREE.Vector3(0, -1, 0);
    const looseDot = direction(loose).dot(worldDown);
    const tiltedDot = direction(tilted).dot(worldDown);
    expect(looseDot).toBeGreaterThan(0.995);
    expect(tiltedDot).toBeLessThan(looseDot - 0.2);

    const group = must(loose.spring.groups[0], 'groups[0]');
    for (let index = 0; index < group.joints.length - 1; index++) {
      const parentJoint = must(group.joints[index], 'joints[index]');
      const childJoint = must(group.joints[index + 1], 'joints[index + 1]');
      const childHead = new THREE.Vector3().setFromMatrixPosition(childJoint.bone.matrixWorld);
      expect(childHead.distanceTo(parentJoint.cur)).toBeLessThan(1e-6);
    }
  });

  it('normalizes animated measured Float32 charm rotations while preserving ppm TRS scale', () => {
    const fixture = makeAnchorFixture({ measuredFloat32Charm: true });
    const group = must(
      fixture.spring.groups.find((candidate) => candidate.id === 'charm'),
      'charm group',
    );
    const rootScale = must(fixture.rig.bones.get('CharmRoot'), 'CharmRoot').scale.toArray();
    const encodedQ = must(group.joints[0], 'joints[0]').bone.quaternion;
    expect(Math.abs(encodedQ.length() - 1)).toBeGreaterThan(4e-8);
    expect(Math.abs(encodedQ.length() - 1)).toBeLessThan(5e-8);

    fixture.spring.update(0); // Initial seed preserves the encoded rest pose.
    const durations = [STEP, 1 / 30, 0.05, STEP, 0.007, 0];
    for (let frame = 0; frame < 120; frame++) {
      poseAnchorFixture(fixture, frame);
      fixture.spring.update(
        must(durations[frame % durations.length], 'durations[frame % durations.length]'),
      );
      expect(must(fixture.rig.bones.get('CharmRoot'), 'CharmRoot').scale.toArray()).toEqual(
        rootScale,
      );
      if (durations[frame % durations.length] !== 0) {
        for (const joint of group.joints) {
          expect(Math.abs(joint.bone.quaternion.length() - 1)).toBeLessThan(1e-12);
        }
      }
    }
  });

  it('leaves every legacy trajectory bit-identical with multiple producer groups and fixed-step sizes', () => {
    const plain = makeAnchorFixture({ attached: false });
    const anchored = makeAnchorFixture();
    plain.spring.update(0);
    anchored.spring.update(0);

    const durations = [STEP, 1 / 30, 0.05, STEP, 0.007, 1 / 30, 0.05, 0];
    for (let frame = 0; frame < 240; frame++) {
      poseAnchorFixture(plain, frame);
      poseAnchorFixture(anchored, frame);
      const dt = must(durations[frame % durations.length], 'durations[frame % durations.length]');
      plain.spring.update(dt);
      anchored.spring.update(dt);
      expect(originalMotionState(anchored.spring)).toEqual(originalMotionState(plain.spring));

      if (frame % 53 === 0) {
        plain.spring.reset();
        anchored.spring.reset();
        plain.spring.update(0);
        anchored.spring.update(0);
        expect(originalMotionState(anchored.spring)).toEqual(originalMotionState(plain.spring));
      }
      if (frame % 79 === 0) {
        plain.spring.enabled = false;
        anchored.spring.enabled = false;
        plain.spring.update(0);
        anchored.spring.update(0);
        expect(originalMotionState(anchored.spring)).toEqual(originalMotionState(plain.spring));
        plain.spring.enabled = true;
        anchored.spring.enabled = true;
        plain.spring.update(0);
        anchored.spring.update(0);
        expect(originalMotionState(anchored.spring)).toEqual(originalMotionState(plain.spring));
      }
    }
  });

  it('catches a negative-control source.updateWorldMatrix between legacy fixed steps', () => {
    const plain = makeAnchorFixture({ attached: false });
    const broken = makeAnchorFixture();
    plain.spring.update(0);
    broken.spring.update(0);

    const group = must(
      broken.spring.groups.find((candidate) => candidate.id === 'charm'),
      'charm group',
    );
    const source = must(broken.rig.bones.get('ProducerA_1'), 'ProducerA_1');
    const place = must(group.anchor, 'anchor').place.bind(group.anchor);
    must(group.anchor, 'anchor').place = () => {
      place();
      source.updateWorldMatrix(true, false);
    };

    for (let frame = 0; frame < 80; frame++) {
      poseAnchorFixture(plain, frame);
      poseAnchorFixture(broken, frame);
      plain.spring.update(0.05);
      broken.spring.update(0.05);
    }
    expect(originalMotionState(broken.spring)).not.toEqual(originalMotionState(plain.spring));
  });
});
