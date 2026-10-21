import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Rig, solveFingerAxes } from '@/engine/rig';
import {
  captureHandGeometry,
  makeHandGeometrySample,
  sampleHandGeometry,
} from '@/engine/rig/hand-geometry';
import { Hands } from '@/engine/rig/hands';
import type { FingerName, FingerSpec, HandContact, Side } from '@/engine/types';
import { buildRig } from '../helpers/scene';

const FINGERS: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];
const SIDES: readonly Side[] = ['L', 'R'];
const CURLS: ReadonlyArray<{ name: string; curl: FingerSpec; spread?: FingerSpec }> = [
  { name: 'open', curl: {} },
  {
    name: 'fist',
    curl: { thumb: 0.8, index: 1, middle: 1, ring: 1, little: 1 },
  },
  { name: 'point', curl: { thumb: 0.25, index: 0, middle: 0.8, ring: 0.8, little: 0.8 } },
  {
    name: 'peace',
    curl: { thumb: 0.3, index: 0, middle: 0, ring: 0.85, little: 0.85 },
    spread: { index: 0.12, middle: -0.08 },
  },
];

function identity(point: { finger: FingerName; jointIndex: number; tip: boolean }): string {
  return `${point.finger}.${point.jointIndex}.${point.tip ? 'tip' : 'joint'}`;
}

function metricHandPoint(
  point: THREE.Vector3,
  hand: THREE.Bone,
  metricScale: number,
): THREE.Vector3 {
  return point.clone().applyMatrix4(hand.matrixWorld.clone().invert()).multiplyScalar(metricScale);
}

function liveGeometry(
  profile: ReturnType<typeof buildProfile>,
  side: Side,
  metricScale: number,
): Map<string, THREE.Vector3> {
  const hand = profile.bones[`hand.${side}`];
  if (!hand) throw new Error(`missing hand.${side}`);
  const points = new Map<string, THREE.Vector3>();
  for (const finger of FINGERS) {
    const chain = profile.fingerBones[`${finger}.${side}`];
    if (!chain) continue;
    for (let jointIndex = 0; jointIndex < chain.length; jointIndex++) {
      const world = chain[jointIndex].getWorldPosition(new THREE.Vector3());
      points.set(
        identity({ finger, jointIndex, tip: false }),
        metricHandPoint(world, hand, metricScale),
      );
    }
    if (chain.length < 2) continue;
    const previous = chain[chain.length - 2].getWorldPosition(new THREE.Vector3());
    const last = chain[chain.length - 1].getWorldPosition(new THREE.Vector3());
    const tip = last.clone().addScaledVector(last.clone().sub(previous), 0.75);
    points.set(
      identity({ finger, jointIndex: chain.length - 1, tip: true }),
      metricHandPoint(tip, hand, metricScale),
    );
  }
  return points;
}

function boneSnapshot(root: THREE.Object3D): string[] {
  const snapshot: string[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Bone)) return;
    snapshot.push(
      [
        object.name,
        ...object.position.toArray(),
        ...object.quaternion.toArray(),
        ...object.scale.toArray(),
      ].join(','),
    );
  });
  return snapshot;
}

describe('pure hand geometry', () => {
  it.each([1, 0.01])('matches the actual Hands curl at armature scale %s', (scale) => {
    const built = buildRig({ armatureScale: scale });
    built.root.rotation.y = 0.7;
    built.root.updateMatrixWorld(true);
    const profile = buildProfile(built.root, built.descriptor);
    const rig = new Rig(profile);
    const axes = solveFingerAxes(profile);
    const hands = new Hands(profile, rig.joints, (bone) => rig.rest.get(bone) ?? bone.quaternion);

    for (const side of SIDES) {
      const hand = profile.bones[`hand.${side}`];
      if (!hand) throw new Error(`missing hand.${side}`);
      const metricScale = hand.getWorldScale(new THREE.Vector3()).x;
      const beforeCapture = boneSnapshot(profile.root);
      const calibration = captureHandGeometry(
        profile,
        side,
        rig.rest,
        axes,
        rig.joints,
        metricScale,
      );
      expect(boneSnapshot(profile.root), `${side} bones after capture`).toEqual(beforeCapture);
      const sample = makeHandGeometrySample(calibration);
      const vectors = sample.points.map(({ position }) => position);
      let firstOpen: THREE.Vector3[] | undefined;

      for (const { name, curl, spread = {} } of CURLS) {
        hands.curlHand(side, curl, spread);
        profile.root.updateMatrixWorld(true);
        const before = boneSnapshot(profile.root);
        sampleHandGeometry(calibration, curl, spread, sample);
        expect(boneSnapshot(profile.root), `${side} bones after pure ${name} sample`).toEqual(
          before,
        );
        sample.points.forEach((point, index) => {
          expect(point.position).toBe(vectors[index]);
        });

        const actual = liveGeometry(profile, side, metricScale);
        expect(sample.points.map(identity)).toEqual([...actual.keys()]);
        for (const point of sample.points) {
          expect(
            point.position.distanceTo(actual.get(identity(point)) as THREE.Vector3),
            `${side} ${name} ${identity(point)}`,
          ).toBeLessThan(1e-9);
        }

        if (name === 'open') firstOpen = sample.points.map(({ position }) => position.clone());
        if (name === 'peace') {
          sampleHandGeometry(calibration, {}, {}, sample);
          expect(sample.points.map(({ position }) => position.toArray())).toEqual(
            firstOpen?.map((position) => position.toArray()),
          );
        }
      }
    }
  });

  it('uses copied hierarchy and calibrated thumb axes after live bones change', () => {
    const built = buildRig({
      armatureScale: 0.01,
      fingerGeometry: {
        thumb: {
          rootOffset: [0.018, 0.004, 0.024],
          segmentOffsets: [
            [0, 0, 0],
            [-0.008, 0.006, -0.012],
            [0.006, -0.004, 0.009],
          ],
        },
      },
    });
    const thumbProximal = built.bones.get('ThumbProximal_R');
    const thumbIntermediate = built.bones.get('ThumbIntermediate_R');
    if (!(thumbProximal && thumbIntermediate)) throw new Error('missing synthetic thumb bones');
    const helper = new THREE.Object3D();
    helper.position.set(0.003, -0.004, 0.002);
    helper.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.2);
    helper.scale.set(1.1, 0.9, 1.05);
    thumbProximal.add(helper);
    helper.add(thumbIntermediate);
    built.root.rotation.y = 0.7;
    built.root.updateMatrixWorld(true);
    const profile = buildProfile(built.root, built.descriptor);
    const rig = new Rig(profile);
    const axes = solveFingerAxes(profile);
    const hand = profile.bones['hand.R'];
    if (!hand) throw new Error('missing hand.R');
    const metricScale = hand.getWorldScale(new THREE.Vector3()).x;
    const hands = new Hands(profile, rig.joints, (bone) => rig.rest.get(bone) ?? bone.quaternion);
    const calibration = captureHandGeometry(profile, 'R', rig.rest, axes, rig.joints, metricScale);
    const sample = makeHandGeometrySample(calibration);

    hands.curlHand('R', { thumb: 0 }, {});
    profile.root.updateMatrixWorld(true);
    sampleHandGeometry(calibration, { thumb: 0 }, {}, sample);
    const openActual = liveGeometry(profile, 'R', metricScale);
    for (const point of sample.points) {
      expect(
        point.position.distanceTo(openActual.get(identity(point)) as THREE.Vector3),
      ).toBeLessThan(1e-9);
    }

    sampleHandGeometry(calibration, { thumb: 0 }, {}, sample);
    const open = sample.points.map(({ position }) => position.clone());
    sampleHandGeometry(calibration, { thumb: 0.8 }, {}, sample);
    const closed = sample.points.map(({ position }) => position.clone());
    hands.curlHand('R', { thumb: 0.8 }, {});
    profile.root.updateMatrixWorld(true);
    const closedActual = liveGeometry(profile, 'R', metricScale);
    for (const point of sample.points) {
      expect(
        point.position.distanceTo(closedActual.get(identity(point)) as THREE.Vector3),
      ).toBeLessThan(1e-9);
    }
    const thumbChain = profile.fingerBones['thumb.R'];
    expect(thumbChain).toBeDefined();
    expect(axes.axes.get(thumbChain?.[0] as THREE.Bone)?.length()).toBeGreaterThan(0.99);
    expect(
      closed[0].distanceTo(open[0]) + closed[1].distanceTo(open[1]) + closed[2].distanceTo(open[2]),
    ).toBeGreaterThan(1e-3);

    const before = boneSnapshot(profile.root);
    for (const chain of Object.values(profile.fingerBones)) {
      for (const bone of chain ?? []) {
        bone.position.x += 0.2;
        bone.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.1);
        bone.scale.set(1.2, 0.8, 1.1);
      }
    }
    const changedLiveBones = boneSnapshot(profile.root);
    expect(changedLiveBones).not.toEqual(before);

    sampleHandGeometry(calibration, { thumb: 0.8 }, {}, sample);
    expect(sample.points.map(({ position }) => position.toArray())).toEqual(
      closed.map((position) => position.toArray()),
    );
    expect(boneSnapshot(profile.root)).toEqual(changedLiveBones);
    sampleHandGeometry(calibration, { thumb: 0 }, {}, sample);
    expect(sample.points.map(({ position }) => position.toArray())).toEqual(
      open.map((position) => position.toArray()),
    );
  });

  it('omits missing finger chains without shifting the remaining identities', () => {
    const built = buildRig();
    const profile = buildProfile(built.root, built.descriptor);
    const rig = new Rig(profile);
    const axes = solveFingerAxes(profile);
    delete profile.fingerBones['ring.R'];
    const hand = profile.bones['hand.R'];
    if (!hand) throw new Error('missing hand.R');

    const calibration = captureHandGeometry(
      profile,
      'R',
      rig.rest,
      axes,
      rig.joints,
      hand.getWorldScale(new THREE.Vector3()).x,
    );
    const sample = makeHandGeometrySample(calibration);
    sampleHandGeometry(calibration, {}, {}, sample);

    expect(sample.points.some(({ finger }) => finger === 'ring')).toBe(false);
    expect(sample.points.some(({ finger }) => finger === 'middle')).toBe(true);
    expect(sample.points.filter(({ finger }) => finger === 'middle').map(identity)).toEqual([
      'middle.0.joint',
      'middle.1.joint',
      'middle.2.joint',
      'middle.2.tip',
    ]);
  });
});

async function contactFixture(scale = 1, helpers = false) {
  const module = await import('@/engine/rig/hand-geometry');
  const capture = Reflect.get(module, 'captureHandContactGeometry');
  const sample = Reflect.get(module, 'sampleHandContact');
  expect(typeof capture).toBe('function');
  expect(typeof sample).toBe('function');
  const built = buildRig({ armatureScale: scale });
  if (helpers) {
    for (const side of SIDES) {
      const first = built.bones.get(`MiddleProximal_${side}`);
      const second = built.bones.get(`MiddleIntermediate_${side}`);
      if (!(first && second)) throw new Error('missing helper fixture joints');
      const helper = new THREE.Object3D();
      helper.position.set(0.002 / scale, -0.003 / scale, 0.004 / scale);
      helper.rotation.set(0.2, -0.15, 0.13);
      helper.scale.set(1.2, 0.8, 1.1);
      first.add(helper);
      helper.add(second);
    }
  }
  built.root.rotation.set(0.1, 0.7, -0.1);
  built.root.updateMatrixWorld(true);
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  const axes = solveFingerAxes(profile);
  const hands = new Hands(profile, rig.joints, (bone) => rig.rest.get(bone) ?? bone.quaternion);
  const captureSide = (side: Side) => {
    const hand = profile.bones[`hand.${side}`];
    const metricScale = hand?.getWorldScale(new THREE.Vector3()).x ?? scale;
    const base = captureHandGeometry(profile, side, rig.rest, axes, rig.joints, metricScale);
    const palm = axes.palmLocal[side] ?? new THREE.Vector3(0, 1, 0);
    const contact = Reflect.apply(capture, undefined, [base, palm]);
    return { base, contact, palm, metricScale };
  };
  return {
    profile,
    rig,
    hands,
    captureSide,
    sample: (
      calibration: unknown,
      curls: FingerSpec,
      spread: FingerSpec,
      selector: unknown,
      clearance: number,
      out: THREE.Vector3,
    ): boolean =>
      Reflect.apply(sample, undefined, [calibration, curls, spread, selector, clearance, out]),
  };
}

describe('contact landmark', () => {
  it.each([1, 0.01])(
    'matches actual posed bones and transported surface normals at scale %s',
    async (scale) => {
      const h = await contactFixture(scale, true);
      let maximumError = 0;
      for (const side of SIDES) {
        const hand = h.profile.bones[`hand.${side}`];
        if (!hand) throw new Error('missing hand');
        const beforeCapture = boneSnapshot(h.profile.root);
        const { base, contact, palm, metricScale } = h.captureSide(side);
        expect(boneSnapshot(h.profile.root)).toEqual(beforeCapture);
        const captured = JSON.stringify(contact);
        const collision = makeHandGeometrySample(base);
        const ids = collision.points.map(identity);
        const bind = new Map<
          string,
          { inverse: THREE.Matrix4; tangent: THREE.Vector3; across: THREE.Vector3 }
        >();
        for (const finger of FINGERS)
          for (const segment of [0, 1] as const) {
            const chain = h.profile.fingerBones[`${finger}.${side}`];
            if (!chain) throw new Error('missing finger');
            const matrix = hand.matrixWorld.clone().invert().multiply(chain[segment].matrixWorld);
            const start = metricHandPoint(
              chain[segment].getWorldPosition(new THREE.Vector3()),
              hand,
              metricScale,
            );
            const end = metricHandPoint(
              chain[segment + 1].getWorldPosition(new THREE.Vector3()),
              hand,
              metricScale,
            );
            const tangent = end.sub(start).normalize();
            const normal = palm.clone().addScaledVector(tangent, -palm.dot(tangent)).normalize();
            bind.set(`${finger}.${segment}`, {
              inverse: matrix.invert(),
              tangent,
              across: normal.clone().cross(tangent).normalize(),
            });
          }
        for (const { curl, spread = {} } of CURLS) {
          h.hands.curlHand(side, curl, spread);
          h.profile.root.updateMatrixWorld(true);
          const before = boneSnapshot(h.profile.root);
          for (const finger of FINGERS)
            for (const segment of [0, 1] as const)
              for (const surface of ['center', 'pad', 'back'] as const) {
                const chain = h.profile.fingerBones[`${finger}.${side}`];
                const b = bind.get(`${finger}.${segment}`);
                if (!(chain && b)) throw new Error('missing oracle');
                const start = metricHandPoint(
                  chain[segment].getWorldPosition(new THREE.Vector3()),
                  hand,
                  metricScale,
                );
                const end = metricHandPoint(
                  chain[segment + 1].getWorldPosition(new THREE.Vector3()),
                  hand,
                  metricScale,
                );
                const expected = start.lerp(end, 0.37);
                const deformation = hand.matrixWorld
                  .clone()
                  .invert()
                  .multiply(chain[segment].matrixWorld)
                  .multiply(b.inverse);
                const linear = new THREE.Matrix3().setFromMatrix4(deformation);
                const normal = b.tangent
                  .clone()
                  .applyMatrix3(linear)
                  .cross(b.across.clone().applyMatrix3(linear))
                  .normalize();
                const clearance = h.rig.fingerClearance(side);
                if (surface !== 'center')
                  expected.addScaledVector(normal, surface === 'pad' ? clearance : -clearance);
                const out = new THREE.Vector3(9, 8, 7);
                expect(
                  h.sample(
                    contact,
                    curl,
                    spread,
                    { kind: 'finger', finger, segment, fraction: 0.37, surface },
                    clearance,
                    out,
                  ),
                ).toBe(true);
                maximumError = Math.max(maximumError, out.distanceTo(expected));
                expect(
                  out.distanceTo(expected),
                  `${side} ${finger} ${segment} ${surface}`,
                ).toBeLessThan(1e-9);
              }
          sampleHandGeometry(base, curl, spread, collision);
          expect(collision.points.map(identity)).toEqual(ids);
          expect(JSON.stringify(contact)).toBe(captured);
          expect(boneSnapshot(h.profile.root)).toEqual(before);
        }
      }
      expect(maximumError).toBeLessThan(1e-9);
      console.info(`contact landmark scale=${scale} maximum position error=${maximumError}`);
    },
  );

  it('samples palm heel and center independently of live bone history', async () => {
    const h = await contactFixture();
    for (const side of SIDES) {
      const { contact, palm, metricScale } = h.captureSide(side);
      const hand = h.profile.bones[`hand.${side}`];
      if (!hand) throw new Error('missing hand');
      const center = new THREE.Vector3();
      for (const finger of FINGERS.slice(1)) {
        const bone = h.profile.fingerBones[`${finger}.${side}`]?.[0];
        if (!bone) throw new Error('missing MCP');
        center.add(metricHandPoint(bone.getWorldPosition(new THREE.Vector3()), hand, metricScale));
      }
      center.multiplyScalar(1 / 8);
      const out = new THREE.Vector3();
      for (const point of ['heel', 'center'] as const)
        for (const surface of ['center', 'pad', 'back'] as const) {
          const selector: HandContact = { kind: 'palm', region: point, surface };
          const clearance = h.rig.fingerClearance(side);
          const expected = point === 'heel' ? new THREE.Vector3() : center.clone();
          if (surface !== 'center')
            expected.addScaledVector(palm, surface === 'pad' ? clearance : -clearance);
          expect(
            h.sample(contact, { middle: 0.8 }, { middle: 0.1 }, selector, clearance, out),
          ).toBe(true);
          expect(out.distanceTo(expected)).toBeLessThan(1e-9);
        }
      const selector: HandContact = {
        kind: 'finger',
        finger: 'middle',
        segment: 1,
        fraction: 0.6,
        surface: 'pad',
      };
      h.sample(contact, { middle: 0.8 }, {}, selector, h.rig.fingerClearance(side), out);
      const expected = out.clone();
      for (const bone of h.profile.fingerBones[`middle.${side}`] ?? []) {
        bone.position.set(2, 3, 4);
        bone.rotation.set(0.7, 0.4, 0.2);
        bone.scale.set(2, 1, 3);
      }
      const changed = boneSnapshot(h.profile.root);
      expect(
        h.sample(contact, { middle: 0.8 }, {}, selector, h.rig.fingerClearance(side), out),
      ).toBe(true);
      expect(out.equals(expected)).toBe(true);
      expect(boneSnapshot(h.profile.root)).toEqual(changed);
    }
  });

  it('rejects invalid selectors and absent real joints without changing output', async () => {
    const h = await contactFixture();
    h.profile.fingerBones['middle.R'] = h.profile.fingerBones['middle.R']?.slice(0, 2);
    delete h.profile.fingerBones['ring.R'];
    const { contact } = h.captureSide('R');
    const sentinel = new THREE.Vector3(9, 8, 7);
    for (const selector of [
      undefined,
      { kind: 'finger', finger: 'middle', segment: 1, fraction: 0.5 },
      { kind: 'palm', region: 'center' },
      ...[-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY].map((fraction) => ({
        kind: 'finger',
        finger: 'index',
        segment: 0,
        fraction,
      })),
      { kind: 'finger', finger: 'index', segment: 2, fraction: 0.5 },
      { kind: 'finger', finger: 'index', segment: 0, fraction: 0.5, surface: 'invalid' },
    ]) {
      const out = sentinel.clone();
      expect(h.sample(contact, {}, {}, selector, h.rig.fingerClearance('R'), out)).toBe(false);
      expect(out.equals(sentinel)).toBe(true);
    }
    delete h.profile.bones['hand.R'];
    const missing = h.captureSide('R').contact;
    const out = sentinel.clone();
    expect(h.sample(missing, {}, {}, { kind: 'palm', region: 'heel' }, 0, out)).toBe(false);
    expect(out.equals(sentinel)).toBe(true);
  });

  it('rejects singular or degenerate surface normals without replacing the output', async () => {
    const h = await contactFixture();
    const chain = h.profile.fingerBones['middle.R'];
    if (!chain) throw new Error('missing middle');
    chain[0].scale.y = 0;
    const { contact } = h.captureSide('R');
    const out = new THREE.Vector3(9, 8, 7);
    expect(
      h.sample(
        contact,
        { middle: 0.8 },
        {},
        { kind: 'finger', finger: 'middle', segment: 0, fraction: 0.5, surface: 'pad' },
        h.rig.fingerClearance('R'),
        out,
      ),
    ).toBe(false);
    expect(out.toArray()).toEqual([9, 8, 7]);
    chain[0].scale.y = 1;
    chain[1].position.set(0, 0, 0);
    const degenerate = h.captureSide('R').contact;
    expect(
      h.sample(
        degenerate,
        {},
        {},
        { kind: 'finger', finger: 'middle', segment: 0, fraction: 0.5, surface: 'back' },
        h.rig.fingerClearance('R'),
        out,
      ),
    ).toBe(false);
    expect(out.toArray()).toEqual([9, 8, 7]);
    // The center remains meaningful even though the surface normal is unavailable.
    expect(
      h.sample(
        degenerate,
        {},
        {},
        { kind: 'finger', finger: 'middle', segment: 0, fraction: 0.5 },
        0,
        out,
      ),
    ).toBe(true);
  });

  it('requires captured hand provenance and a nondegenerate palm for surfaces', async () => {
    const h = await contactFixture();
    const { base, palm } = h.captureSide('R');
    const { captureHandContactGeometry: capture } = await import('@/engine/rig/hand-geometry');
    const noProvenance = capture({ ...base, handPresent: undefined }, palm);
    const out = new THREE.Vector3(9, 8, 7);
    expect(h.sample(noProvenance, {}, {}, { kind: 'palm', region: 'heel' }, 0, out)).toBe(false);
    expect(out.toArray()).toEqual([9, 8, 7]);
    const noNormal = capture(base, new THREE.Vector3());
    expect(
      h.sample(
        noNormal,
        {},
        {},
        { kind: 'palm', region: 'center', surface: 'pad' },
        h.rig.fingerClearance('R'),
        out,
      ),
    ).toBe(false);
    expect(out.toArray()).toEqual([9, 8, 7]);
    expect(h.sample(noNormal, {}, {}, { kind: 'palm', region: 'center' }, 0, out)).toBe(true);
  });

  it('uses exact real endpoints with the default center surface', async () => {
    const h = await contactFixture(0.01, true);
    const { contact, metricScale } = h.captureSide('R');
    const hand = h.profile.bones['hand.R'];
    const chain = h.profile.fingerBones['middle.R'];
    if (!(hand && chain)) throw new Error('missing hand or finger');
    const curls = { middle: 0.7 };
    const spread = { middle: 0.1 };
    h.hands.curlHand('R', curls, spread);
    h.profile.root.updateMatrixWorld(true);
    for (const segment of [0, 1] as const)
      for (const fraction of [0, 1]) {
        const out = new THREE.Vector3();
        expect(
          h.sample(
            contact,
            curls,
            spread,
            { kind: 'finger', finger: 'middle', segment, fraction },
            0,
            out,
          ),
        ).toBe(true);
        const expected = metricHandPoint(
          chain[segment + fraction].getWorldPosition(new THREE.Vector3()),
          hand,
          metricScale,
        );
        expect(out.distanceTo(expected)).toBeLessThan(1e-9);
      }
  });
});
