import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Body } from '@/engine/motion/body';
import { saturate } from '@/engine/motion/idle';
import * as Look from '@/engine/motion/look';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { GestureDef, Side } from '@/engine/types';
import { buildRig } from '../../helpers/scene';

const DT = 1 / 60;

function fixture({ transformed = false, rebased = false, eyes = true, constrained = false } = {}) {
  const built = buildRig({ eyes });
  const resolved = buildProfile(built.root, built.descriptor);
  const markers = new Map<Side, THREE.Object3D>();
  for (const side of ['L', 'R'] as const) {
    const eye = resolved.bones[`eye.${side}`];
    if (!eye) continue;
    const marker = new THREE.Object3D();
    marker.position.set(0, 0, 0.02);
    eye.add(marker);
    markers.set(side, marker);
  }
  if (rebased) {
    for (const slot of ['neck', 'head', 'eye.L', 'eye.R'] as const) {
      const bone = resolved.bones[slot];
      if (!bone) continue;
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, -0.08, 0.1));
      bone.quaternion.multiply(rotation);
      const inverse = rotation.clone().invert();
      for (const child of bone.children) {
        child.position.applyQuaternion(inverse);
        child.quaternion.premultiply(inverse);
      }
    }
  }
  if (transformed) {
    built.root.position.set(0.2, -0.1, 0.3);
    built.root.rotation.set(0.08, 0.4, -0.06);
    built.root.scale.set(0.8, 1.2, 1.1);
  }
  built.root.updateMatrixWorld(true);
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  if (!constrained) rig.limitsEnabled = false;
  const body = new Body(rig, profile, { random: () => 0.5 });
  body.idleAmount = 0;
  body.breathDepth = 0;
  body.weightShift = 0;
  body.gazeAmount = 0;
  const relativeQ = (bone: THREE.Bone) => {
    bone.updateWorldMatrix(true, false);
    const matrix = new THREE.Matrix4()
      .copy(profile.root.matrixWorld)
      .invert()
      .multiply(bone.matrixWorld);
    const q = new THREE.Quaternion();
    matrix.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    return q;
  };
  const bind = new Map<THREE.Bone, THREE.Quaternion>();
  for (const slot of ['head', 'eye.L', 'eye.R'] as const) {
    const bone = profile.bones[slot];
    if (bone) bind.set(bone, relativeQ(bone));
  }
  const delta = (slot: 'head' | `eye.${Side}`) => {
    const bone = profile.bones[slot];
    const rest = bone && bind.get(bone);
    if (!(bone && rest)) throw new Error(`missing ${slot}`);
    return relativeQ(bone).multiply(rest.clone().invert()).normalize();
  };
  const eyeDirection = (side: Side, world = false) => {
    const eye = profile.bones[`eye.${side}`];
    const marker = markers.get(side);
    if (!(eye && marker)) throw new Error('missing eye marker');
    const origin = eye.getWorldPosition(new THREE.Vector3());
    const point = marker.getWorldPosition(new THREE.Vector3());
    if (!world) {
      const inverse = new THREE.Matrix4().copy(profile.root.matrixWorld).invert();
      origin.applyMatrix4(inverse);
      point.applyMatrix4(inverse);
    }
    return point.sub(origin).normalize();
  };
  const bindDirections = new Map<Side, THREE.Vector3>();
  for (const side of markers.keys()) bindDirections.set(side, eyeDirection(side));
  const target = (yaw = 0, pitch = 0) => {
    const head = profile.bones.head;
    if (!head) throw new Error('missing head');
    const direction = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch),
    );
    direction.applyQuaternion(profile.root.getWorldQuaternion(new THREE.Quaternion()));
    return head.getWorldPosition(new THREE.Vector3()).addScaledVector(direction, 10);
  };
  const step = (point: THREE.Vector3 | null) => {
    rig.reset();
    body.update(DT, { headWorldTarget: point });
  };
  return { built, profile, rig, body, delta, target, step, eyeDirection, bindDirections };
}

function expectedEye(
  head: THREE.Quaternion,
  gazeHead: THREE.Quaternion,
  yaw: number,
  pitch: number,
  limits: { eyePitch: number; eyeYaw: number },
) {
  const raw = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-pitch * 0.5, yaw * 0.5, 0, 'XYZ'),
  );
  const residual = head.clone().invert().multiply(gazeHead).multiply(raw);
  const angles = new THREE.Euler().setFromQuaternion(residual, 'XYZ');
  const eye = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      saturate(angles.x, limits.eyePitch),
      saturate(angles.y, limits.eyeYaw),
      0,
      'XYZ',
    ),
  );
  return head.clone().multiply(eye);
}

function expectEyes(h: ReturnType<typeof fixture>, expected: THREE.Quaternion) {
  for (const side of ['L', 'R'] as const) {
    const bind = h.bindDirections.get(side);
    if (!bind) throw new Error('missing bind eye direction');
    const direction = bind.clone().applyQuaternion(expected);
    expect(h.eyeDirection(side).distanceTo(direction)).toBeLessThan(1e-8);
    const world = direction
      .applyMatrix3(new THREE.Matrix3().setFromMatrix4(h.profile.root.matrixWorld))
      .normalize();
    expect(h.eyeDirection(side, true).distanceTo(world)).toBeLessThan(1e-8);
  }
}

afterEach(() => vi.restoreAllMocks());

describe('eye compensation after the displayed head pose', () => {
  it.each([
    { transformed: false, rebased: false },
    { transformed: true, rebased: false },
    { transformed: false, rebased: true },
    { transformed: true, rebased: true },
  ])('opposes a phrase nod in the actual eye direction with %j', (options) => {
    const h = fixture(options);
    const bindHead = new THREE.Quaternion();
    expect(h.rig.readHeadOffset(bindHead)).toBe(true);
    expect(bindHead.angleTo(new THREE.Quaternion())).toBeLessThan(1e-7);
    const point = h.target();
    h.body.speechNod = 0.02;
    h.step(point);
    const head = h.delta('head');
    expect(head.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.01);
    const expected = expectedEye(head, new THREE.Quaternion(), 0, 0, h.profile.gaze);
    expectEyes(h, expected);
    expect(expected.angleTo(new THREE.Quaternion())).toBeLessThan(0.003);
  });

  it('compensates an authored held head pose', () => {
    const h = fixture();
    const point = h.target();
    const pose: GestureDef = {
      label: { en: 'Head pose', ja: '頭のポーズ' },
      group: 'pose',
      lead: 0,
      hold: 1,
      sustain: true,
      build: () => ({ spine: { head: [0.02, 0.025, 0] } }),
    };
    h.body.playDef(pose, 'head');
    // Body applies its authored entrance floor even when the definition's lead is zero.
    for (let frame = 0; frame < 60; frame++) h.step(point);
    const head = h.delta('head');
    expect(head.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.02);
    expectEyes(h, expectedEye(head, new THREE.Quaternion(), 0, 0, h.profile.gaze));
  });

  it('preserves the existing gaze-only head shares and saturated eye range', () => {
    const h = fixture();
    const yaw = 0.2;
    const pitch = 0.12;
    const point = h.target(yaw, pitch);
    h.step(point);
    const gazeHead = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(-pitch * 0.16, yaw * 0.16, 0))
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch * 0.28, yaw * 0.28, 0)));
    expect(h.delta('head').angleTo(gazeHead)).toBeLessThan(1e-7);
    expectEyes(h, expectedEye(gazeHead, gazeHead, yaw, pitch, h.profile.gaze));
  });

  it.each([
    { sign: 1, pitch: 0 },
    { sign: -1, pitch: 0 },
    { sign: 1, pitch: 0.08 },
    { sign: -1, pitch: -0.08 },
  ])('preserves gaze-only saturation across the Euler yaw branch with %j', ({ sign, pitch }) => {
    const h = fixture();
    const yaw = sign * 3.14;
    const wander = sign * 0.02;
    const frame = Look.makeGazeFrame();
    const gaze = {
      offset: new THREE.Vector2(wander, 0),
      micro: new THREE.Vector2(),
      settled: new THREE.Vector2(),
    };
    h.rig.reset();
    Reflect.apply(Look.prepareGaze, undefined, [
      h.rig,
      h.profile,
      gaze,
      { lookAt: 1, gazeAmount: 1 },
      h.target(yaw, pitch),
      frame,
      DT,
      false,
    ]);
    h.rig.commitSpine();
    const head = h.delta('head');
    Look.aimEyes(h.rig, h.profile, frame);
    h.rig.commitEyes();
    // Independent old gaze-only result: saturate the authored half angles directly.
    const eye = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        saturate(-pitch * 0.5, h.profile.gaze.eyePitch),
        saturate((yaw + wander) * 0.5, h.profile.gaze.eyeYaw),
        0,
        'XYZ',
      ),
    );
    expectEyes(h, head.multiply(eye));
  });

  it('does not add compensation when the target is absent', () => {
    const h = fixture();
    h.body.speechNod = 0.02;
    h.step(null);
    expectEyes(h, h.delta('head'));
  });

  it('tolerates missing eye bones', () => {
    const h = fixture({ eyes: false });
    h.body.speechNod = 0.02;
    expect(() => h.step(h.target())).not.toThrow();
    expect(h.delta('head').angleTo(new THREE.Quaternion())).toBeGreaterThan(0.01);
  });

  it('does not add gaze offsets without a resolved head', () => {
    const h = fixture();
    const point = h.target();
    delete h.profile.bones.head;
    expect(() => h.step(point)).not.toThrow();
    for (const side of ['L', 'R'] as const)
      expect(h.delta(`eye.${side}`).angleTo(new THREE.Quaternion())).toBeLessThan(1e-7);
  });
});

it('keeps a large nod correction inside the existing eye limits', () => {
  const h = fixture();
  h.body.speechNod = 0.3;
  h.step(h.target());
  const head = h.delta('head');
  expectEyes(h, expectedEye(head, new THREE.Quaternion(), 0, 0, h.profile.gaze));
  const correction = new THREE.Euler().setFromQuaternion(
    head.clone().invert().multiply(h.delta('eye.L')),
    'XYZ',
  );
  expect(correction.x).toBeLessThan(0);
  expect(Math.abs(correction.x)).toBeLessThanOrEqual(h.profile.gaze.eyePitch);
  expect(Math.abs(correction.y)).toBeLessThanOrEqual(h.profile.gaze.eyeYaw);
});

it('reads the actual later head pose when the eye phase runs', () => {
  const h = fixture();
  const make = Reflect.get(Look, 'makeGazeFrame');
  const prepare = Reflect.get(Look, 'prepareGaze');
  const aim = Reflect.get(Look, 'aimEyes');
  expect(typeof make).toBe('function');
  const frame = Reflect.apply(make, undefined, []);
  const gaze = {
    offset: new THREE.Vector2(),
    micro: new THREE.Vector2(),
    settled: new THREE.Vector2(),
  };
  Reflect.apply(prepare, undefined, [
    h.rig,
    h.profile,
    gaze,
    { lookAt: 1, gazeAmount: 0 },
    h.target(),
    frame,
    DT,
    false,
  ]);
  h.rig.addOffset('head', 0.01, 0, 0);
  h.rig.commitSpine();
  h.rig.addOffset('head', 0.02, 0, 0);
  h.rig.commitSpine();
  const finalHead = h.delta('head');
  expect(finalHead.angleTo(new THREE.Quaternion())).toBeCloseTo(0.03, 10);
  Reflect.apply(aim, undefined, [h.rig, h.profile, frame]);
  Reflect.apply(Reflect.get(h.rig, 'commitEyes'), h.rig, []);
  expectEyes(h, expectedEye(finalHead, new THREE.Quaternion(), 0, 0, h.profile.gaze));
});

it.each([false])(
  'commits eyes after the final body context with constrained arms=%s',
  (constrained) => {
    const h = fixture({ constrained });
    const events: string[] = [];
    for (const name of [
      'applyBodyContext',
      'commitArmFrame',
      'finishLegacyBodyFrame',
      'commitArmTransport',
      'readHeadOffset',
      'commitEyes',
    ] as const) {
      const method = Reflect.get(h.rig, name);
      if (typeof method !== 'function') continue;
      Reflect.set(h.rig, name, (...args: unknown[]) => {
        events.push(name);
        return Reflect.apply(method, h.rig, args);
      });
    }
    h.body.speechNod = 0.02;
    h.step(h.target());
    const bodyEvents = [
      'applyBodyContext',
      'commitArmFrame',
      'finishLegacyBodyFrame',
      'commitArmTransport',
    ];
    const lastBody = events.reduce(
      (last, event, index) => (bodyEvents.includes(event) ? index : last),
      -1,
    );
    // The frame-closing commit of the path actually taken must be reached, and be the last body step.
    expect(events[lastBody]).toBe(constrained ? 'commitArmFrame' : 'finishLegacyBodyFrame');
    expect(events.indexOf('readHeadOffset')).toBeGreaterThan(lastBody);
    expect(events.indexOf('commitEyes')).toBeGreaterThan(events.indexOf('readHeadOffset'));
    const head = h.delta('head');
    expect(head.angleTo(new THREE.Quaternion())).toBeGreaterThan(0);
    expectEyes(h, expectedEye(head, new THREE.Quaternion(), 0, 0, h.profile.gaze));
  },
);

it('keeps active and absent-target frames independent across interleaved bodies', () => {
  const first = fixture();
  const second = fixture();
  first.body.speechNod = 0.02;
  second.body.speechNod = -0.015;
  first.step(first.target());
  second.step(second.target());
  expectEyes(
    first,
    expectedEye(first.delta('head'), new THREE.Quaternion(), 0, 0, first.profile.gaze),
  );
  expectEyes(
    second,
    expectedEye(second.delta('head'), new THREE.Quaternion(), 0, 0, second.profile.gaze),
  );
  first.step(null);
  expectEyes(first, first.delta('head'));
});
