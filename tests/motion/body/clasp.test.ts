import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FINGER_WIDTH, INTERLACE_GAP } from '@/engine/anatomy';
import { Body } from '@/engine/motion/body';
import { type ClaspLeader, type ClaspPlacement, placeFollower } from '@/engine/motion/clasp';
import { GESTURES } from '@/engine/motion/gestures';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { FingerName, GestureDef, Side } from '@/engine/types';
import { buildRig } from '../../helpers/scene';
import { canonicalDirection, DT, type Harness, harness, wristOf } from './harness';

/**
 * The interlaced clasp, measured on the posed bones of the synthetic rig.
 *
 * Every property is read off world positions after the hold has settled, with
 * the lead hand pinned so both arrangements of leader and follower are run.
 */

const SIDES: readonly Side[] = ['L', 'R'];
const FOUR: readonly FingerName[] = ['index', 'middle', 'ring', 'little'];
const FRAMES = 150;

const other = (s: Side): Side => (s === 'L' ? 'R' : 'L');

function settle(h: Harness, side: Side, frames = FRAMES): void {
  h.rig.reset();
  h.body.update(DT);
  h.body.play('handsClasp', side);
  for (let i = 0; i < frames; i++) {
    h.rig.reset();
    h.body.update(DT);
  }
}

const chain = (h: Harness, f: FingerName, side: Side): THREE.Vector3[] => {
  const bones = h.profile.fingerBones[`${f}.${side}`];
  if (!bones || bones.length < 3) throw new Error(`synthetic rig lacks ${f}.${side}`);
  return bones.slice(0, 3).map((b) => {
    b.updateWorldMatrix(true, false);
    return b.getWorldPosition(new THREE.Vector3());
  });
};

const pitchOf = (h: Harness, side: Side): number => h.profile.limb[`pitch.${side}`];

/** Closest approach of segments p1-q1 and p2-q2. */
function segDist(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3) {
  const d1 = q1.clone().sub(p1);
  const d2 = q2.clone().sub(p2);
  const r = p1.clone().sub(p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  const c = d1.dot(r);
  const b = d1.dot(d2);
  const den = a * e - b * b;
  let s = den > 1e-12 ? THREE.MathUtils.clamp((b * f - c * e) / den, 0, 1) : 0;
  let t = (b * s + f) / e;
  if (t < 0) {
    t = 0;
    s = THREE.MathUtils.clamp(-c / a, 0, 1);
  } else if (t > 1) {
    t = 1;
    s = THREE.MathUtils.clamp((b - c) / a, 0, 1);
  }
  return p1.clone().addScaledVector(d1, s).distanceTo(p2.clone().addScaledVector(d2, t));
}

describe.each(SIDES)('handsClasp, lead %s', (lead) => {
  const follow = other(lead);

  it('S1: the eight knuckles alternate along the leader row, a pitch apart', () => {
    const h = harness();
    settle(h, lead);
    const pitch = pitchOf(h, lead);
    const mcp = (s: Side) => FOUR.map((f) => chain(h, f, s)[0]);
    const L = mcp(lead);
    const F = mcp(follow);
    const ell = L[3].clone().sub(L[0]).normalize();
    const items = [
      ...L.map((p) => ({ x: p.dot(ell), own: 'lead' })),
      ...F.map((p) => ({ x: p.dot(ell), own: 'follow' })),
    ].sort((a, b) => a.x - b.x);
    for (let i = 1; i < items.length; i++) {
      expect(items[i].own).not.toBe(items[i - 1].own);
      expect(items[i].x - items[i - 1].x).toBeGreaterThanOrEqual(0.4 * pitch);
    }
    const bound = INTERLACE_GAP * pitch + 0.5 * pitch;
    for (const p of F) {
      const off = p.clone().sub(L[0]);
      off.addScaledVector(ell, -off.dot(ell));
      expect(off.length()).toBeLessThanOrEqual(bound);
    }
  });

  it('S2: intermediate and distal phalanges clear each other', () => {
    const h = harness();
    settle(h, lead);
    const pitch = pitchOf(h, lead);
    const need = 0.8 * FINGER_WIDTH * pitch;
    const segs = (s: Side) =>
      FOUR.map((f) => {
        const [c0, c1, c2] = chain(h, f, s);
        const tip = c2.clone().add(c2.clone().sub(c1).multiplyScalar(0.75));
        return { prox: [c0, c1], mid: [c1, c2], dist: [c2, tip] };
      });
    const A = segs(lead);
    const B = segs(follow);
    let worst = Number.POSITIVE_INFINITY;
    const take = (x: THREE.Vector3[], y: THREE.Vector3[]) => {
      worst = Math.min(worst, segDist(x[0], x[1], y[0], y[1]));
    };
    for (const a of A) {
      for (const b of B) {
        take(a.mid, b.mid);
        take(a.mid, b.dist);
        take(a.dist, b.mid);
        take(a.dist, b.dist);
        take(a.mid, b.prox);
        take(b.mid, a.prox);
      }
    }
    expect(worst).toBeGreaterThanOrEqual(need);
  });

  it('S3: the follower lands where it was placed', () => {
    const h = harness();
    settle(h, lead);
    const bones = (f: FingerName) => chain(h, f, lead)[0];
    const hand = h.profile.bones[`hand.${lead}`];
    const palmLocal = h.rig.palmLocal[lead];
    if (!(hand && palmLocal)) throw new Error('synthetic rig lacks a hand');
    const q = hand.getWorldQuaternion(new THREE.Quaternion());
    const leader: ClaspLeader = {
      wrist: wristOf(h.profile, lead),
      index: bones('index'),
      middle: bones('middle'),
      ring: bones('ring'),
      little: bones('little'),
      palm: palmLocal.clone().applyQuaternion(q).normalize(),
    };
    const placed: ClaspPlacement = {
      wrist: new THREE.Vector3(),
      hand: new THREE.Vector3(),
      palm: new THREE.Vector3(),
    };
    const pitch = pitchOf(h, lead);
    const measure = { pitch, proximal: h.profile.limb[`proximal.${lead}`] };
    expect(placeFollower(leader, measure, 0.3, placed)).toBe(true);
    const fh = h.profile.bones[`hand.${follow}`];
    const fp = h.rig.palmLocal[follow];
    if (!(fh && fp)) throw new Error('synthetic rig lacks a hand');
    const palm = fp
      .clone()
      .applyQuaternion(fh.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();
    expect(palm.angleTo(placed.palm)).toBeLessThanOrEqual(THREE.MathUtils.degToRad(10));
    expect(wristOf(h.profile, follow).distanceTo(placed.wrist)).toBeLessThanOrEqual(0.1 * pitch);
    // The wrist limiter can bend the hand off its axis while the palm stays put.
    const axis = chain(h, 'middle', follow)[0].sub(wristOf(h.profile, follow)).normalize();
    expect(axis.angleTo(placed.hand)).toBeLessThanOrEqual(THREE.MathUtils.degToRad(3));
  });

  // Placed against a leader still on its way in, the follower swung a straight
  // arm low across the belly and folded the elbow late.
  it('rises as the mirror of the leader until the leader has arrived', () => {
    const h = harness();
    h.rig.reset();
    h.body.update(DT);
    h.body.play('handsClasp', lead);
    const upper = (s: Side) => canonicalDirection(h, s, `upperArm.${s}`, `lowerArm.${s}`);
    let worst = 0;
    for (let i = 0; i < 30; i++) {
      h.rig.reset();
      h.body.update(DT);
      worst = Math.max(worst, upper(lead).angleTo(upper(follow)));
    }
    expect(worst).toBeLessThanOrEqual(THREE.MathUtils.degToRad(5));
  });

  it('S5: a released clasp unthreads by the time the exit is under half over', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const h = harness();
    const seen: Record<Side, { index: number; spread: number }[]> = { L: [], R: [] };
    const curl = h.rig.curlHand.bind(h.rig);
    vi.spyOn(h.rig, 'curlHand').mockImplementation((side, spec, spread) => {
      seen[side].push({ index: spec.index ?? 0, spread: spread?.index ?? 0 });
      curl(side, spec, spread);
    });
    settle(h, lead);
    h.body.stopGesture();
    let at = -1;
    for (let i = 0; i < 200 && at < 0; i++) {
      seen.L.length = 0;
      seen.R.length = 0;
      h.rig.reset();
      h.body.update(DT);
      const g = h.body.gesture;
      if (!g) break;
      if ((g.time - g.exitAt) / (g.lead * 1.25) >= 0.45) at = i;
    }
    expect(at).toBeGreaterThanOrEqual(0);
    for (const side of SIDES) {
      const last = seen[side][seen[side].length - 1];
      expect(last.index).toBeLessThanOrEqual(0.3);
      expect(Math.abs(last.spread)).toBeLessThanOrEqual(0.08);
    }
  });
});

describe('handsClasp without fingers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const bare = (): Harness => {
    const built = buildRig({ fingers: false });
    built.root.updateMatrixWorld(true);
    const profile = buildProfile(built.root, built.descriptor);
    const rig = new Rig(profile);
    const body = new Body(rig, profile);
    body.breathDepth = 0;
    body.idleAmount = 0;
    body.weightShift = 0;
    body.gazeAmount = 0;
    return { body, profile, rig };
  };

  const trace = (def: GestureDef, side: Side): THREE.Vector3[] => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const h = bare();
    h.rig.reset();
    h.body.update(DT);
    h.body.playDef(def, 'handsClasp', side);
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < FRAMES; i++) {
      h.rig.reset();
      h.body.update(DT);
      out.push(wristOf(h.profile, 'L'), wristOf(h.profile, 'R'));
    }
    vi.restoreAllMocks();
    return out;
  };

  it.each(SIDES)('S4: falls back to the plain mirrored reach, lead %s', (lead) => {
    const def: GestureDef = GESTURES.handsClasp;
    const stripped: GestureDef = {
      ...def,
      build: (t, v) => {
        const { clasp: _clasp, ...pose } = def.build(t, v);
        return pose;
      },
    };
    const a = trace(def, lead);
    const b = trace(stripped, lead);
    for (let i = 0; i < a.length; i++) expect(a[i].distanceTo(b[i])).toBeLessThan(1e-9);
  });
});
