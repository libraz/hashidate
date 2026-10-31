import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReachAnchors } from '@/engine/motion/anchors';
import { Body } from '@/engine/motion/body';
import { FingerLife } from '@/engine/motion/finger-life';
import { buildProfile } from '@/engine/profile';
import { handFrame, Rig } from '@/engine/rig';
import type { FingerSpec, ReachSpec, Side } from '@/engine/types';
import { buildRig } from '../../helpers/scene';

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('synthetic contact fixture is incomplete');
  return value;
}

const curls = { index: 0.64, middle: 0.38 };
const spread = { index: 0.17, middle: -0.09 };
const request: ReachSpec = {
  space: 'body',
  at: 'sternum',
  offset: [0.2, 0.1, 0.8],
  hand: [0.3, 0.7, 0.4],
  palm: [0.1, -0.4, 0.9],
  contact: { kind: 'finger', finger: 'index', segment: 1, fraction: 0.37 },
};

function setup(scale = 1, yaw = 0) {
  const built = buildRig({ armatureScale: scale });
  built.root.rotation.y = yaw;
  built.root.updateMatrixWorld(true);
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  const axes = rig.characterFrame;
  const anchors = new ReachAnchors(profile, rig, axes);
  return { profile, rig, axes, anchors };
}

describe('requested hand contact target', () => {
  afterEach(() => vi.restoreAllMocks());
  for (const scale of [1, 0.01])
    for (const yaw of [0, 0.73])
      for (const side of ['L', 'R'] as Side[]) {
        it(`places independently posed skeletal contact at anchor (${side}, ${scale}, ${yaw})`, () => {
          const h = setup(scale, yaw);
          const hand = required(h.profile.bones[`hand.${side}`]);
          const anchor = required(h.anchors.body(request.at, request.offset, side)).clone();
          const target = required(
            h.anchors.target(request, side, undefined, { curls, spread }),
          ).clone();
          // Independent live hierarchy: the rig's direct finger write, then rigidly place
          // its bone frame at the returned wrist. No predicted contact enters the oracle.
          h.rig.curlHandLegacy(side, curls, spread);
          hand.updateWorldMatrix(true, true);
          const chain = required(h.profile.fingerBones[`index.${side}`]);
          const contact = chain[1]
            .getWorldPosition(new THREE.Vector3())
            .lerp(chain[2].getWorldPosition(new THREE.Vector3()), 0.37);
          contact.applyMatrix4(hand.matrixWorld.clone().invert()).multiplyScalar(scale);
          const bind = required(
            handFrame(
              h.profile.restDir[`hand.${side}`].clone(),
              required(h.rig.palmLocal[side]).clone(),
              new THREE.Matrix3(),
            ),
          );
          const desired = required(
            handFrame(
              h.axes.toWorld(new THREE.Vector3(), required(request.hand), side),
              h.axes.toWorld(new THREE.Vector3(), required(request.palm), side),
              new THREE.Matrix3(),
            ),
          );
          contact.applyMatrix3(desired.multiply(bind.transpose())).add(target);
          expect(contact.distanceTo(anchor)).toBeLessThan(1e-10);
        });
      }

  it('ignores previously posed fingers', () => {
    const h = setup();
    const first = required(h.anchors.target(request, 'R', undefined, { curls, spread })).clone();
    h.rig.curlHandLegacy('R', { index: 1, middle: 1 }, { index: -0.3 });
    const second = required(h.anchors.target(request, 'R', undefined, { curls, spread })).clone();
    expect(second.toArray()).toEqual(first.toArray());
  });

  it('preserves the exact legacy target for invalid or unsupported annotations', () => {
    const h = setup();
    const legacy = { ...request, space: 'face' as const, at: 'mouth', contact: undefined };
    const expected = required(h.anchors.target(legacy, 'R')).clone();
    for (const contact of [
      { kind: 'finger', finger: 'index', segment: 1, fraction: 2 },
      { kind: 'unknown' },
    ]) {
      expect(
        required(
          h.anchors.target({ ...legacy, contact } as ReachSpec, 'R', undefined, { curls, spread }),
        ).toArray(),
      ).toEqual(expected.toArray());
    }
    h.profile.root.scale.multiplyScalar(2);
    const scaledLegacy = required(h.anchors.target(legacy, 'R')).clone();
    expect(
      required(
        h.anchors.target({ ...legacy, contact: request.contact }, 'R', undefined, {
          curls,
          spread,
        }),
      ).toArray(),
    ).toEqual(scaledLegacy.toArray());
  });
  it('never predicts unannotated targets and falls back for incomplete frames', () => {
    const h = setup();
    const predict = vi.spyOn(h.rig, 'predictHandContact');
    const legacy = { ...request, contact: undefined };
    const expected = required(h.anchors.target(legacy, 'R')).clone();
    expect(required(h.anchors.target(legacy, 'R', undefined, { curls, spread })).toArray()).toEqual(
      expected.toArray(),
    );
    expect(predict).not.toHaveBeenCalled();
    for (const frame of [
      { hand: undefined },
      { palm: undefined },
      { hand: [0, 0, 0] },
      { hand: [1, 0, 0], palm: [1, 0, 0] },
    ]) {
      const annotated = { ...request, ...frame } as ReachSpec;
      const fallback = required(
        h.anchors.target({ ...annotated, contact: undefined }, 'R'),
      ).clone();
      expect(
        required(h.anchors.target(annotated, 'R', undefined, { curls, spread })).toArray(),
      ).toEqual(fallback.toArray());
    }
    expect(predict).not.toHaveBeenCalled();
  });

  it('predicts with the limiter off and rejects a changed opposite arm frame without invalidating history', () => {
    const h = setup();
    expect(h.rig.predictHandContact('R', required(request.contact), curls, spread)).not.toBeNull();
    const revision = h.rig.externalArmRevision;
    required(h.profile.bones['upperArm.L']).scale.multiplyScalar(2);
    expect(h.rig.predictHandContact('R', required(request.contact), curls, spread)).toBeNull();
    expect(h.rig.externalArmRevision).toBe(revision);
    const other = setup();
    other.rig.limitsEnabled = false;
    expect(
      other.rig.predictHandContact('R', required(request.contact), curls, spread),
    ).not.toBeNull();
  });

  it.each([undefined, 'L', 'R'] as const)(
    'advances each hand once before targets, including clasp leader %s',
    (lead) => {
      const h = setup();
      const body = new Body(h.rig, h.profile);
      body.idleAmount = 0;
      body.breathDepth = 0;
      body.weightShift = 0;
      body.gazeAmount = 0;
      const sense = vi.spyOn(FingerLife.prototype, 'sense');
      const enslave = vi.spyOn(FingerLife.prototype, 'enslave');
      body.playDef(
        {
          label: { en: 'Contact', ja: '接触' },
          group: 'pose',
          lead: 0.3,
          hold: 1,
          sustain: true,
          build: () => ({
            reach: { L: request, R: request },
            fingers: { L: curls, R: { index: 0.21, middle: 0.79 } },
            fingerSpread: { L: spread, R: { index: -0.13, middle: 0.04 } },
            ...(lead ? { clasp: { lead, dihedral: 0.4 } } : {}),
          }),
        },
        'pose',
        'R',
      );
      expect(sense).not.toHaveBeenCalled();
      expect(enslave).not.toHaveBeenCalled();
      const calls: { side: Side; curls: FingerSpec; spread: FingerSpec; senseCount: number }[] = [];
      const target = ReachAnchors.prototype.target;
      vi.spyOn(ReachAnchors.prototype, 'target').mockImplementation(function (
        this: ReachAnchors,
        reach,
        side,
        ready,
        controls,
      ) {
        if (reach?.contact && controls)
          calls.push({
            side,
            curls: { ...controls.curls },
            spread: { ...controls.spread },
            senseCount: sense.mock.calls.length,
          });
        return target.call(this, reach, side, ready, controls);
      });
      const internal = body as unknown as {
        _fingerSpec: Record<Side, FingerSpec>;
        _fingerSpreadSpec: Record<Side, FingerSpec>;
      };
      for (let i = 0; i < 3; i++) {
        sense.mockClear();
        enslave.mockClear();
        calls.length = 0;
        h.rig.reset();
        body.update(1 / 60);
        expect(sense.mock.calls.map((call) => call[0])).toEqual(
          lead === 'R' ? ['R', 'L'] : ['L', 'R'],
        );
        expect(enslave.mock.calls.map((call) => call[0])).toEqual(
          lead === 'R' ? ['R', 'L'] : ['L', 'R'],
        );
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
          expect(call.senseCount).toBe(2);
          expect(call.curls).toEqual(internal._fingerSpec[call.side]);
          expect(call.spread).toEqual(internal._fingerSpreadSpec[call.side]);
        }
      }
    },
  );
  it('uses predicted metric shape and the contact rotation for annotated face clearance', () => {
    const h = setup(0.01, 0.73);
    const annotated: ReachSpec = { ...request, space: 'face', at: 'mouth' };
    const legacyShape = vi.spyOn(h.rig, 'fingerShape');
    const internal = h.anchors as unknown as { clearFace: (...args: unknown[]) => void };
    const clear = vi.spyOn(internal, 'clearFace');
    required(h.anchors.target(annotated, 'R', undefined, { curls, spread }));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(legacyShape).not.toHaveBeenCalled();
    const shape = clear.mock.calls[0][6] as readonly THREE.Vector3[];
    const rotation = (clear.mock.calls[0][7] as THREE.Matrix3).clone();
    expect(shape.length).toBe(20);
    // The driver's calibrated hand frame: the rest axis, and the palm made perpendicular to it.
    const axis = h.profile.restDir['hand.R'].clone().normalize();
    const palmLocal = required(h.rig.palmLocal.R);
    const palm = palmLocal.clone().addScaledVector(axis, -palmLocal.dot(axis)).normalize();
    const bind = required(handFrame(axis.clone(), palm.clone(), new THREE.Matrix3()));
    const desired = required(
      handFrame(
        h.axes.toWorld(new THREE.Vector3(), required(request.hand), 'R'),
        h.axes.toWorld(new THREE.Vector3(), required(request.palm), 'R'),
        new THREE.Matrix3(),
      ),
    );
    expect(rotation.elements).toEqual(desired.multiply(bind.transpose()).elements);
    h.rig.curlHandLegacy('R', curls, spread);
    const hand = required(h.profile.bones['hand.R']);
    hand.updateWorldMatrix(true, true);
    const inverse = hand.matrixWorld.clone().invert();
    const index = required(h.profile.fingerBones['index.R']);
    const point = index[1]
      .getWorldPosition(new THREE.Vector3())
      .applyMatrix4(inverse)
      .multiplyScalar(0.01);
    // Five fingers, each retaining its three real joints and virtual tip.
    expect(shape[5].distanceTo(point)).toBeLessThan(1e-12);
  });
});
