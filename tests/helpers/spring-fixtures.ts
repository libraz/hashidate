import * as THREE from 'three';
import type { Spring } from '@/engine/secondary';
import type { AvatarDescriptor, ColliderSpec } from '@/engine/types';
import { must } from './must';
import { addBoneChain, buildRig, type SyntheticRig } from './scene';

/**
 * Deterministic rigs and motion for recording and checking the sway solver's per-frame hashes.
 *
 * Every number a frame applies is computed here, at module load, with the host's `Math`, so every
 * run receives the same values and only the solver runs under the fixed transcendentals.
 */

export interface FixtureRig {
  rig: SyntheticRig;
  descriptor: AvatarDescriptor;
}

/** What one frame does to the rig and the solver before `update(dt)`. */
export interface FrameScript {
  dt: number;
  /** XYZ Euler rotations by bone name; `root` names the armature. */
  rotations?: ReadonlyArray<readonly [string, number, number, number]>;
  rootPosition?: readonly [number, number, number];
  /** Scales by bone name. */
  scales?: ReadonlyArray<readonly [string, number, number, number]>;
  enabled?: boolean;
  groups?: ReadonlyArray<readonly [string, boolean]>;
  reset?: boolean;
  /** `stiffnessScale`, `inertiaScale`, `gravityScale`. */
  figures?: readonly [number, number, number];
  /** The rotation every driven joint is given. */
  drive?: readonly [number, number, number, number];
}

export interface SpringFixture {
  id: string;
  /** A fresh rig and the descriptor that matches it. */
  build(): FixtureRig;
  /** Calls made right after construction, on each solver. */
  setup?(spring: Spring): void;
  script: readonly FrameScript[];
}

const FRAMES = 600;
const STEP = 1 / 60;

/** Apply one frame's script to a rig and its solver. */
export function applyFrame(rig: SyntheticRig, spring: Spring, frame: FrameScript): void {
  const node = (name: string): THREE.Object3D =>
    name === 'root' ? rig.root : must(rig.bones.get(name), name);
  for (const [name, x, y, z] of frame.rotations ?? []) node(name).rotation.set(x, y, z);
  if (frame.rootPosition) rig.root.position.set(...frame.rootPosition);
  for (const [name, x, y, z] of frame.scales ?? []) node(name).scale.set(x, y, z);
  if (frame.enabled !== undefined) spring.enabled = frame.enabled;
  const groups = spring.groups as Array<{ id: string; enabled: boolean }>;
  for (const [id, enabled] of frame.groups ?? []) {
    const group = groups.find((g) => g.id === id);
    if (group) group.enabled = enabled;
  }
  if (frame.reset) spring.reset();
  if (frame.figures) {
    [spring.stiffnessScale, spring.inertiaScale, spring.gravityScale] = frame.figures;
  }
  if (frame.drive) for (const j of spring.drivenJoints) j.drive.set(...frame.drive);
}

/** `FRAMES` frames of `make(frame, t)`, with `t` the time at the end of each. */
function script(
  dts: readonly number[],
  make: (frame: number, t: number) => Omit<FrameScript, 'dt'>,
): FrameScript[] {
  const out: FrameScript[] = [];
  let t = 0;
  for (let frame = 0; frame < FRAMES; frame++) {
    const dt = frame === 0 ? 0 : dts[frame % dts.length];
    t += dt;
    out.push({ dt, ...make(frame, t) });
  }
  return out;
}

/** The trajectory fixture's body motion: Hips and Head on incommensurate sines. */
function trajectoryMotion(t: number): FrameScript['rotations'] {
  return [
    ['Hips', Math.sin(t * 2.1) * 0.3, Math.cos(t * 1.3) * 0.25, 0],
    ['Head', 0, Math.sin(t * 3.7) * 0.5, Math.sin(t * 2.9) * 0.2],
  ];
}

/** The rig of `makeTrajectoryFixture`: producers, an unattached chain and an attached one. */
function trajectoryRig(extra?: (rig: SyntheticRig) => void): SyntheticRig {
  const rig = buildRig({ armatureScale: 0.01 });
  addBoneChain(rig, { parent: 'Hips', root: 'ProducerA', joints: 3 });
  addBoneChain(rig, { parent: 'Head', root: 'Hair', joints: 3 });
  addBoneChain(rig, { parent: 'Hips', root: 'CharmRoot', joints: 3 });
  extra?.(rig);
  return rig;
}

const charm = {
  id: 'charm',
  roots: ['CharmRoot'],
  anchor: {
    influences: [
      { bone: 'ProducerA_1', weight: 0.6, position: [0, -2, 0] as [number, number, number] },
      { bone: 'ProducerA_2', weight: 0.4, position: [1, -3, 0.5] as [number, number, number] },
    ],
  },
  stiffness: 0,
  drag: 0.45,
  gravity: 0.16,
};

/** The trajectory fixture's groups. */
const trajectoryGroups = [
  { id: 'producerA', roots: ['ProducerA'], stiffness: 0.9, drag: 0.32, gravity: 0.11 },
  { id: 'hair', roots: ['Hair'], stiffness: 1.2, drag: 0.5 },
  charm,
];

/** A quaternion of `angle` about the unit `axis`, as components. */
function axisAngle(axis: THREE.Vector3, angle: number): [number, number, number, number] {
  return new THREE.Quaternion().setFromAxisAngle(axis, angle).toArray() as [
    number,
    number,
    number,
    number,
  ];
}

const F1: SpringFixture = {
  id: 'F1 trajectory',
  build: () => {
    const rig = trajectoryRig();
    return {
      rig,
      descriptor: { ...rig.descriptor, sway: { groups: trajectoryGroups, colliders: {} } },
    };
  },
  script: script([STEP], (_, t) => ({ rotations: trajectoryMotion(t) })),
};

const F2: SpringFixture = {
  id: 'F2 colliders',
  build: () => {
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
    // Hangs just in front of the torso, so the swing grazes its colliders.
    addBoneChain(rig, {
      parent: 'UpperChest',
      root: 'Tie',
      joints: 3,
      rootOffset: [0, 0.02, 0.13],
      segmentOffset: [0, -0.07, 0.005],
    });
    const torso: ColliderSpec[] = [];
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2;
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
    return {
      rig,
      descriptor: {
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
              id: 'tie',
              roots: ['Tie'],
              stiffness: 0.2,
              drag: 0.15,
              gravity: 1.2,
              radius: 0.015,
              colliders: ['torso', 'hairc', 'missingSet'],
            },
          ],
          colliders: {
            head: [{ bone: 'Head', offset: [0, 0.08, 0], radius: 0.09 }],
            torso,
            arms: [
              { bone: 'UpperArm_L', tail: [0.2, 0, 0], radius: 0.04 },
              { bone: 'UpperArm_R', tail: [-0.2, 0, 0], radius: 0.04 },
              { bone: 'NoSuchBone', radius: 0.04 },
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
            ],
          },
        },
      },
    };
  },
  // Frames between steps, so a carried link is held clear of what it would enter.
  script: script([STEP, 1 / 144, 1 / 72, 1 / 144], (_, t) => ({
    rotations: [
      ['Hips', Math.sin(t * 2.1) * 0.6, Math.cos(t * 1.3) * 0.9, 0],
      ['UpperChest', Math.sin(t * 1.7) * 0.4, 0, Math.cos(t * 2.3) * 0.3],
      ['Head', Math.sin(t * 4.1) * 0.8, Math.sin(t * 3.7) * 1.2, 0],
      ['root', 0, Math.sin(t * 0.5) * 2, 0],
    ],
  })),
};

const TAIL_POSES: Array<[number, number, number, number]> = (() => {
  const swing = new THREE.Vector3(0, 1, 0);
  const lift = new THREE.Vector3(1, 0, 0);
  const out: Array<[number, number, number, number]> = [];
  for (const s of [-1.2, 0, 1.2]) {
    for (const l of [-1, 1]) {
      const q = new THREE.Quaternion().fromArray(axisAngle(swing, 0.45 * s));
      q.multiply(new THREE.Quaternion().fromArray(axisAngle(lift, 0.3 * l)));
      out.push(q.toArray() as [number, number, number, number]);
    }
  }
  return out;
})();

const F3: SpringFixture = {
  id: 'F3 drive',
  build: () => {
    const rig = buildRig();
    addBoneChain(rig, {
      parent: 'Hips',
      root: 'Tail',
      joints: 4,
      rootOffset: [0, -0.02, -0.08],
      segmentOffset: [0, -0.05, -0.06],
    });
    addBoneChain(rig, { parent: 'Head', root: 'Hair', joints: 2 });
    return {
      rig,
      descriptor: {
        ...rig.descriptor,
        sway: {
          groups: [
            {
              id: 'tail',
              roots: ['Tail'],
              stiffness: 1.4,
              drag: 0.35,
              gravity: 0.3,
              colliders: ['seat'],
            },
            { id: 'hair', roots: ['Hair'], stiffness: 1, drag: 0.4 },
          ],
          colliders: {
            // The tail starts inside it, so calibration has something to give way on.
            seat: [{ bone: 'Hips', offset: [0, -0.08, -0.1], radius: 0.12 }],
          },
        },
      },
    };
  },
  setup: (spring) => {
    spring.enableDrive('tail');
    spring.calibrateDrive(
      'tail',
      TAIL_POSES.map((q) => new THREE.Quaternion(...q)),
    );
  },
  script: script([STEP, 1 / 50, 1 / 144], (_, t) => {
    const q = new THREE.Quaternion().fromArray(
      axisAngle(new THREE.Vector3(0, 1, 0), Math.sin(t * 1.9) * 0.5),
    );
    q.multiply(
      new THREE.Quaternion().fromArray(
        axisAngle(new THREE.Vector3(1, 0, 0), 0.3 * Math.sin(t * 0.7)),
      ),
    );
    return {
      rotations: [['Hips', Math.sin(t * 1.1) * 0.1, Math.cos(t * 0.9) * 0.15, 0]],
      drive: q.toArray() as [number, number, number, number],
    };
  }),
};

const F4: SpringFixture = {
  id: 'F4 toggles',
  build: () => {
    const rig = trajectoryRig();
    return {
      rig,
      descriptor: {
        ...rig.descriptor,
        sway: {
          groups: trajectoryGroups.map((g) =>
            g.id === 'hair' ? { ...g, colliders: ['head'] } : g,
          ),
          colliders: { head: [{ bone: 'Head', offset: [0, 0.06, 0], radius: 0.08 }] },
        },
      },
    };
  },
  setup: (spring) => {
    spring.enableDrive('producerA');
  },
  script: script([STEP], (frame, t) => {
    const events: Record<number, Omit<FrameScript, 'dt'>> = {
      90: { enabled: false },
      120: { enabled: true },
      180: { groups: [['hair', false]] },
      240: { groups: [['hair', true]] },
      270: { groups: [['charm', false]] },
      300: { groups: [['producerA', false]] },
      330: { groups: [['charm', true]] },
      345: { groups: [['producerA', true]] },
      360: { reset: true },
      400: { figures: [1.6, 0.6, 2.5] },
      450: { groups: [['producerA', false]] },
      470: { enabled: false },
      500: { enabled: true },
      520: { groups: [['producerA', true]] },
      560: { reset: true, figures: [1, 1, 1] },
    };
    return {
      rotations: trajectoryMotion(t),
      drive: axisAngle(new THREE.Vector3(0, 0, 1), Math.sin(t * 2.3) * 0.4),
      ...events[frame],
    };
  }),
};

const F5: SpringFixture = {
  id: 'F5 dt schedule',
  build: () => {
    const rig = trajectoryRig();
    return {
      rig,
      descriptor: {
        ...rig.descriptor,
        sway: {
          groups: trajectoryGroups.map((g) =>
            g.id === 'hair' ? { ...g, colliders: ['head'] } : g,
          ),
          colliders: { head: [{ bone: 'Head', offset: [0, 0.06, 0], radius: 0.08 }] },
        },
      },
    };
  },
  script: script([1 / 60, 1 / 50, 1 / 72, 1 / 144, 0, 0.05, 0.2], (frame, t) => ({
    rotations: trajectoryMotion(t),
    rootPosition: [Math.sin(frame * 0.13) * 0.04, Math.cos(frame * 0.07) * 0.03, 0],
  })),
};

/** Branches, bridges, pivots and manual matrices, at one armature scale. */
function branching(scale: number): SpringFixture {
  return {
    id: `F6 branching (armature ${scale})`,
    build: () => {
      const rig = buildRig({ armatureScale: scale });
      addBoneChain(rig, { parent: 'Hips', root: 'Hub', joints: 1, rootOffset: [0, -0.02, 0] });
      const hub = must(rig.bones.get('Hub'), 'Hub');
      // The chain's own leaf would be a seventeenth child.
      hub.remove(must(rig.bones.get('Hub_1'), 'Hub_1'));
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        addBoneChain(rig, {
          parent: 'Hub',
          root: `Hem${k}`,
          joints: 2,
          rootOffset: [Math.cos(a) * 0.1, -0.01, Math.sin(a) * 0.08],
          segmentOffset: [Math.cos(a) * 0.015, -0.07, Math.sin(a) * 0.015],
        });
      }
      addBoneChain(rig, {
        parent: 'Head',
        root: 'Hair',
        joints: 3,
        segmentOffset: [0.01, -0.06, -0.02],
      });
      // An unsimulated node between two simulated chains, with a pivot.
      const clip = new THREE.Object3D();
      clip.name = 'Clip';
      clip.position.set(0.005 / scale, -0.01 / scale, 0);
      clip.rotation.set(0.2, 0.1, -0.3);
      clip.pivot = new THREE.Vector3(0.002 / scale, 0.001 / scale, 0);
      must(rig.bones.get('Hair_2'), 'Hair_2').add(clip);
      rig.bones.set('Clip', clip as THREE.Bone);
      addBoneChain(rig, {
        parent: 'Clip',
        root: 'Bow',
        joints: 2,
        segmentOffset: [0.02, -0.04, 0],
      });
      // A joint whose origin moves with its rotation.
      must(rig.bones.get('Hair_1'), 'Hair_1').pivot = new THREE.Vector3(0, 0.005 / scale, 0);
      // A node posed by its own matrix, carrying a chain, and a joint that is too.
      const mount = new THREE.Object3D();
      mount.name = 'Mount';
      mount.matrixAutoUpdate = false;
      mount.matrix.compose(
        new THREE.Vector3(0.04 / scale, 0.05 / scale, 0),
        new THREE.Quaternion(0.1, 0.2, 0, 0.9746794344808963),
        new THREE.Vector3(1, 1, 1),
      );
      must(rig.bones.get('Head'), 'Head').add(mount);
      rig.bones.set('Mount', mount as THREE.Bone);
      addBoneChain(rig, {
        parent: 'Mount',
        root: 'Ear',
        joints: 2,
        segmentOffset: [0.01, 0.04, 0],
      });
      const ear = must(rig.bones.get('Ear_1'), 'Ear_1');
      ear.updateMatrix();
      ear.matrixAutoUpdate = false;
      rig.root.updateMatrixWorld(true);
      return {
        rig,
        descriptor: {
          ...rig.descriptor,
          sway: {
            groups: [
              { id: 'hem', childrenOf: ['Hub'], stiffness: 0.5, drag: 0.3, gravity: 0.6 },
              { id: 'hair', roots: ['Hair'], stiffness: 0.8, drag: 0.4, gravity: 0.2 },
              {
                id: 'bow',
                roots: ['Bow'],
                stiffness: 0.3,
                drag: 0.2,
                gravity: 0.5,
                colliders: ['head'],
              },
              { id: 'ear', roots: ['Ear'], stiffness: 2, drag: 0.5 },
            ],
            colliders: { head: [{ bone: 'Head', offset: [0, 0.07, 0], radius: 0.09 }] },
          },
        },
      };
    },
    script: script([STEP, 1 / 50], (_, t) => ({
      rotations: [
        ['Hips', Math.sin(t * 2.3) * 0.5, Math.cos(t * 1.1) * 0.7, Math.sin(t * 0.8) * 0.2],
        ['Head', Math.sin(t * 3.1) * 0.6, Math.sin(t * 2.7) * 0.9, 0],
      ],
    })),
  };
}

const F7: SpringFixture = {
  id: 'F7 anchor failure',
  build: () => {
    const rig = trajectoryRig((r) =>
      addBoneChain(r, { parent: 'Spine', root: 'CharmB', joints: 3 }),
    );
    return {
      rig,
      descriptor: {
        ...rig.descriptor,
        sway: {
          groups: [
            ...trajectoryGroups,
            {
              id: 'charmB',
              roots: ['CharmB'],
              anchor: {
                influences: [
                  { bone: 'Spine', weight: 0.5, position: [0, -1, 0] },
                  { bone: 'Hips', weight: 0.5, position: [2, -4, 1] },
                ],
              },
              stiffness: 0.2,
              drag: 0.4,
              gravity: 0.3,
            },
          ],
          colliders: {},
        },
      },
    };
  },
  script: script([STEP, 0.05], (frame, t) => ({
    rotations: trajectoryMotion(t),
    ...(frame === 200 ? { scales: [['ProducerA_1', 1.001, 1.001, 1.001]] as const } : {}),
  })),
};

/** Every parity fixture, in order. */
export const SPRING_FIXTURES: readonly SpringFixture[] = [
  F1,
  F2,
  F3,
  F4,
  F5,
  branching(0.01),
  branching(1),
  F7,
];
