import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { SpeechBeats } from '@/engine/motion/speech-beats';
import { BEAT_RISE } from '@/engine/motion/speech-beats';
import type { ArmSlot, Side } from '@/engine/types';
import {
  canonicalDirection,
  canonicalHandDirection,
  DT,
  type Harness,
  harness,
  twistGesture,
} from './harness';

/**
 * The phrase-head beat: a lift of the forearm and hand that rides only what
 * rest still holds of each link, so a gesture that owns the arm silences it.
 */

interface ComposeView {
  _fading: unknown[];
  _beats: SpeechBeats;
  composeArmTarget(
    slot: ArmSlot,
    side: Side,
    env: { br: number; d: number; armDrift: number; dt: number },
    cDir: THREE.Vector3 | undefined,
    cw: number,
    outgoing: boolean,
    cParent?: THREE.Vector3,
  ): THREE.Vector3;
}

const twin = (): Harness => harness(0, { random: () => 0.5 });

function frame(h: Harness, onset = false): void {
  h.body.speaking = true;
  h.body.speechOnset = onset;
  h.rig.reset();
  h.body.update(DT);
}

const forearmY = (h: Harness, side: Side) =>
  canonicalDirection(h, side, `lowerArm.${side}`, `hand.${side}`).y;
const handY = (h: Harness, side: Side) => canonicalHandDirection(h, side).y;

describe('speech beats on the body', () => {
  it('lifts the forearm and hand after a phrase head, the right more than the left', () => {
    const beat = twin();
    const still = twin();
    for (let i = 0; i < 30; i++) {
      frame(beat);
      frame(still);
    }
    frame(beat, true);
    frame(still);
    let lift: Record<Side, number> = { L: 0, R: 0 };
    let handLift = 0;
    for (let i = 0; i < 18; i++) {
      frame(beat);
      frame(still);
      lift = {
        L: Math.max(lift.L, forearmY(beat, 'L') - forearmY(still, 'L')),
        R: Math.max(lift.R, forearmY(beat, 'R') - forearmY(still, 'R')),
      };
      handLift = Math.max(handLift, handY(beat, 'R') - handY(still, 'R'));
    }
    expect(lift.R).toBeGreaterThan(5e-3);
    expect(handLift).toBeGreaterThan(5e-3);
    expect(lift.L).toBeGreaterThan(0);
    expect(lift.L).toBeLessThan(lift.R);
    // And it is gone again once the pulse has run out.
    for (let i = 0; i < 90; i++) {
      frame(beat);
      frame(still);
    }
    expect(Math.abs(forearmY(beat, 'R') - forearmY(still, 'R'))).toBeLessThan(1e-4);
  });

  it('does not fire while the line is not being spoken', () => {
    const beat = twin();
    const still = twin();
    beat.body.speechOnset = true;
    for (let i = 0; i < 20; i++) {
      beat.rig.reset();
      beat.body.update(DT);
      still.rig.reset();
      still.body.update(DT);
    }
    expect(forearmY(beat, 'R')).toBe(forearmY(still, 'R'));
  });

  it('adds nothing while a gesture holds the whole arm', () => {
    const beat = twin();
    const still = twin();
    for (const h of [beat, still]) {
      frame(h);
      h.body.playDef(twistGesture(0), 'twist', 'R');
      for (let i = 0; i < 120; i++) frame(h);
    }
    frame(beat, true);
    frame(still);
    for (let i = 0; i < 18; i++) {
      frame(beat);
      frame(still);
      for (const side of ['L', 'R'] as const) {
        expect(forearmY(beat, side)).toBe(forearmY(still, side));
        expect(handY(beat, side)).toBe(handY(still, side));
      }
    }
  });

  it('scales the lift by what rest keeps under two half-weight fades', () => {
    const h = twin();
    const view = h.body as unknown as ComposeView;
    const env = { br: 0, d: 0, armDrift: 0, dt: DT };
    const compose = () =>
      view.composeArmTarget.call(h.body, 'lowerArm', 'R', env, undefined, 0, true).clone();
    const fade = (dir: THREE.Vector3) => ({
      w: 0.5,
      arm: { L: null, R: { upperArm: new THREE.Vector3(0.2, -1, 0.1).normalize(), lowerArm: dir } },
    });

    const lifted = (): number => {
      view._beats.trigger();
      view._beats.step(0);
      const base = compose();
      view._beats.step(BEAT_RISE);
      const up = compose();
      expect(up.y).toBeGreaterThan(base.y);
      const angle = base.angleTo(up);
      // Back to rest for the next probe.
      view._beats.step(10);
      return angle;
    };

    const full = view._beats;
    full.trigger();
    full.step(BEAT_RISE);
    const peak = full.angle('R', 'lowerArm');
    full.step(10);
    expect(lifted()).toBeCloseTo(peak, 9);

    view._fading.push(
      fade(new THREE.Vector3(0.3, -0.4, 0.86).normalize()),
      fade(new THREE.Vector3(-0.1, -0.2, 0.97).normalize()),
    );
    expect(lifted()).toBeCloseTo(peak * 0.25, 9);
    view._fading.length = 0;
  });

  it('scales the lift by what an incoming pose leaves to rest', () => {
    const h = twin();
    const view = h.body as unknown as ComposeView;
    const env = { br: 0, d: 0, armDrift: 0, dt: DT };
    const cDir = new THREE.Vector3(0.2, -0.3, 0.93).normalize();
    const angle = (cw: number, outgoing: boolean) => {
      view._beats.step(10);
      const base = view.composeArmTarget.call(h.body, 'hand', 'R', env, cDir, cw, outgoing).clone();
      view._beats.trigger();
      view._beats.step(BEAT_RISE);
      const up = view.composeArmTarget.call(h.body, 'hand', 'R', env, cDir, cw, outgoing).clone();
      return { lift: base.angleTo(up), peak: view._beats.angle('R', 'hand') };
    };
    for (const outgoing of [true, false]) {
      const half = angle(0.5, outgoing);
      expect(half.lift).toBeCloseTo(half.peak * 0.5, 9);
      expect(angle(1, outgoing).lift).toBe(0);
    }
  });
});
