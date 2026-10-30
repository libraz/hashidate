// @vitest-environment happy-dom

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { buildProfile } from '@/engine/profile';
import type { WornState } from '@/engine/scene';
import type { AvatarDescriptor, Profile } from '@/engine/types';
import { same } from '@/i18n/locale';
import { buildFramings, type Framings } from '@/viewer/scene/framing';
import { FULL_AVATAR } from '@/viewer/scene/placement';
import { AvatarRuntime, FOV } from '@/viewer/scene/runtime';
import type { RuntimeStatus } from '@/viewer/scene/runtime/types';
import { buildRig } from '../helpers/scene';

/** What the mocked mount hands back: the real profile, and a wardrobe reduced to its worn state. */
const mounted = vi.hoisted(() => ({
  profile: null as unknown,
  wardrobe: { state: {} as Record<string, string | null> },
}));

vi.mock('@/viewer/scene/runtime/mount', async (importActual) => ({
  ...(await importActual<typeof import('@/viewer/scene/runtime/mount')>()),
  mountAvatar: () => ({
    profile: mounted.profile,
    director: { update: vi.fn() },
    wardrobe: mounted.wardrobe,
    materials: { apply: vi.fn(), dispose: vi.fn() },
    transparentTriangles: {
      withDraw: (_camera: THREE.Camera, draw: () => unknown) => draw(),
      dispose: vi.fn(),
    },
    problems: [],
  }),
}));
vi.mock('@/engine/session', () => ({
  Session: class {
    update(): void {}
    dispose(): void {}
  },
}));

const avatar: AvatarDescriptor = { id: 'measure', label: same('measure'), url: '/measure.glb' };

function staged() {
  const rig = buildRig({ arkit: false });
  const profile: Profile = buildProfile(rig.root, rig.descriptor);
  // An unworn hat, well above the crown: the wardrobe has it hidden.
  const hat = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial());
  hat.position.set(0, 3, 0);
  hat.visible = false;
  rig.root.add(hat);
  const state: WornState = { head: null };
  mounted.profile = profile;
  mounted.wardrobe = { state };

  const rebuilt: Framings[] = [];
  const focus: { radius: number; avatar: THREE.Object3D }[] = [];
  const camera = new THREE.PerspectiveCamera();
  const runtime = Object.create(AvatarRuntime.prototype) as AvatarRuntime;
  Object.assign(runtime as object, {
    loader: { loadAsync: async () => ({ scene: rig.root }) },
    current: null,
    loading: null,
    queued: null,
    warming: null,
    disposed: false,
    loadGeneration: 0,
    toon: true,
    avatarPlacement: FULL_AVATAR,
    status: { phase: 'idle' } satisfies RuntimeStatus,
    statusListeners: new Set<(status: RuntimeStatus) => void>(),
    hudListeners: new Set(),
    frameListeners: new Set(),
    scene: new THREE.Scene(),
    host: { clientWidth: 0, clientHeight: 0 },
    shotCamera: {
      rebuild: (f: Framings) => rebuilt.push(f),
      camera,
      update: vi.fn(),
      takeCut: () => false,
    },
    environment: { texture: null },
    backdrop: { prewarm: async () => {}, update: vi.fn() },
    timer: { update: vi.fn(), getDelta: () => 1 / 60 },
    slides: { up: false },
    documentUp: false,
    fpsAcc: 0,
    fpsFrames: 0,
    hudAcc: 0,
    camWorld: new THREE.Vector3(),
    focusWorld: new THREE.Vector3(),
    defaultRig: { fitShadow: vi.fn() },
    postStage: {
      target: null,
      render: vi.fn(),
      setFocus: (_centre: THREE.Vector3, radius: number, root: THREE.Object3D) =>
        focus.push({ radius, avatar: root }),
    },
    warmedTarget: null,
  });
  const tick = () => (runtime as unknown as { tick(): void }).tick();
  return { rig, profile, hat, state, runtime, rebuilt, focus, tick };
}

const crownOf = (f: Framings) => f.bust.target.y + f.bust.height / 2;

describe('measuring the worn state', () => {
  it('leaves an unworn garment out of the shots and the focus', async () => {
    const { rig, hat, runtime, rebuilt, focus, tick } = staged();
    await runtime.load(avatar);
    tick();

    expect(rebuilt).toHaveLength(1);
    // The avatar as it would be without the hat in the file at all.
    rig.root.remove(hat);
    const sphere = new THREE.Box3().setFromObject(rig.root).getBoundingSphere(new THREE.Sphere());
    rig.root.add(hat);
    expect(focus[0].radius).toBeCloseTo(sphere.radius, 9);
    // The post stage is handed the avatar, so its blended meshes keep their focus.
    expect(focus[0].avatar).toBe(rig.root);
  });

  it('re-measures when a garment goes on, in the pose it was first measured in', async () => {
    const { rig, profile, hat, state, runtime, rebuilt, focus, tick } = staged();
    await runtime.load(avatar);
    tick();
    const [loaded] = rebuilt;
    const bare = focus[0].radius;

    // Worn, measured standing: the shots the runtime has to arrive at.
    hat.visible = true;
    const expected = buildFramings(rig.root, profile, FOV);
    // Mid-gesture when it goes on: the arm is up, and that is not the shot.
    const arm = profile.bones['upperArm.L'];
    if (!arm) throw new Error('synthetic rig has no left upper arm');
    arm.rotation.z = 1.2;
    const live = arm.quaternion.clone();
    state.head = 'hat';
    tick();

    expect(rebuilt).toHaveLength(2);
    expect(crownOf(rebuilt[1])).toBeGreaterThan(crownOf(loaded));
    expect(rebuilt[1].bust.halfWidth).toBe(expected.bust.halfWidth);
    expect(rebuilt[1].bust.target.toArray()).toEqual(expected.bust.target.toArray());
    expect(focus.at(-1)?.radius).toBeGreaterThan(bare);
    expect(arm.quaternion.equals(live)).toBe(true);

    // Nothing changed, nothing re-measured.
    tick();
    expect(rebuilt).toHaveLength(2);

    // Taken off again, the shots come back to the bare ones.
    hat.visible = false;
    state.head = null;
    tick();
    expect(rebuilt).toHaveLength(3);
    expect(crownOf(rebuilt[2])).toBe(crownOf(loaded));
    expect(focus.at(-1)?.radius).toBe(bare);
  });
});
