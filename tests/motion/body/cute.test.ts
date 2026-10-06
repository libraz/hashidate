import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Side } from '@/engine/types';
import { type Harness, harness, wristOf } from './harness';

/**
 * A small catalogue that crosses the cute motions' actual mechanisms: face and
 * body reaches, two-handed poses, and authored arm oscillations. The table
 * tests cover every id; this is the runtime pass for the motions a viewer
 * reads as a mannerism.
 */
const CUTE_PATTERNS = [
  'cheekPoke',
  'catPaw',
  'beg',
  'heartHands',
  'bunnyEars',
  'pawBounce',
  'tinyDance',
  'cheekPeace',
] as const;

const SIDES: Side[] = ['L', 'R'];
const FRAME_RATES = [20, 30, 60] as const;
const WRIST_SPEED_LIMIT = 8;

function frame(h: Harness, dt: number): void {
  h.rig.reset();
  h.body.update(dt);
}

function configureIdle(h: Harness): void {
  h.body.breathDepth = 1;
  h.body.weightShift = 1;
  h.body.idleAmount = 0;
  h.body.gazeAmount = 0;
}

function assertFiniteRig(h: Harness): void {
  for (const bone of Object.values(h.profile.bones)) {
    if (!bone) continue;
    expect(bone.position.toArray().every(Number.isFinite)).toBe(true);
    expect(bone.quaternion.toArray().every(Number.isFinite)).toBe(true);
  }
  for (const chain of Object.values(h.profile.fingerBones)) {
    for (const bone of chain ?? []) {
      expect(bone.position.toArray().every(Number.isFinite)).toBe(true);
      expect(bone.quaternion.toArray().every(Number.isFinite)).toBe(true);
    }
  }
}

function wrists(h: Harness): Record<Side, THREE.Vector3> {
  return { L: wristOf(h.profile, 'L'), R: wristOf(h.profile, 'R') };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cute gesture runtime', () => {
  it.each(CUTE_PATTERNS)('%s remains finite and returns continuously at 20/30/60 fps', (id) => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const next = CUTE_PATTERNS[(CUTE_PATTERNS.indexOf(id) + 1) % CUTE_PATTERNS.length];

    for (const side of SIDES) {
      for (const fps of FRAME_RATES) {
        const dt = 1 / fps;
        const h = harness();
        const idle = harness();
        configureIdle(h);
        configureIdle(idle);
        frame(h, dt);
        frame(idle, dt);
        h.body.play(id, side);

        let previous = wrists(h);
        let fastest = 0;
        const entranceFrames = Math.ceil(1.2 / dt);
        for (let i = 0; i < entranceFrames; i++) {
          frame(h, dt);
          frame(idle, dt);
          const current = wrists(h);
          for (const hand of SIDES) {
            fastest = Math.max(fastest, previous[hand].distanceTo(current[hand]) / dt);
          }
          previous = current;
          assertFiniteRig(h);
        }

        // Exercise a real handoff between unlike cute mechanisms before
        // releasing, so continuity covers the reach/direct boundary as well.
        h.body.play(next, side);
        for (let i = 0; i < entranceFrames; i++) {
          frame(h, dt);
          frame(idle, dt);
          const current = wrists(h);
          for (const hand of SIDES) {
            fastest = Math.max(fastest, previous[hand].distanceTo(current[hand]) / dt);
          }
          previous = current;
          assertFiniteRig(h);
        }
        const releaseFrames = Math.ceil(2.5 / dt);
        h.body.stopGesture();
        for (let i = 0; i < releaseFrames; i++) {
          frame(h, dt);
          frame(idle, dt);
          const current = wrists(h);
          for (const hand of SIDES) {
            fastest = Math.max(fastest, previous[hand].distanceTo(current[hand]) / dt);
          }
          previous = current;
          assertFiniteRig(h);
        }

        // Eight metres per second is the existing physical continuity limit for
        // a wrist on these avatars; a gesture transition must stay below it.
        expect(fastest).toBeLessThan(WRIST_SPEED_LIMIT);
        for (const hand of SIDES) {
          expect(wristOf(h.profile, hand).distanceTo(wristOf(idle.profile, hand))).toBeLessThan(
            0.02,
          );
        }
      }
    }
  });

  it('keeps breathing and weight transfer alive while a gesture is active', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const breathing = harness();
    const flat = harness();
    const shifting = harness();
    const still = harness();
    for (const h of [breathing, flat, shifting, still]) configureIdle(h);
    flat.body.breathDepth = 0;
    still.body.weightShift = 0;

    const dt = 1 / 60;
    for (const h of [breathing, flat, shifting, still]) frame(h, dt);
    for (const h of [breathing, flat, shifting, still]) h.body.play('catPaw', 'L');

    let breathMin = Number.POSITIVE_INFINITY;
    let breathMax = Number.NEGATIVE_INFINITY;
    let maxBreathChestDelta = 0;
    let maxWeightHipsDelta = 0;
    for (let i = 0; i < 180; i++) {
      for (const h of [breathing, flat, shifting, still]) frame(h, dt);
      for (const h of [breathing, flat, shifting, still]) {
        expect(h.body.gesture?.id).toBe('catPaw');
      }
      breathMin = Math.min(breathMin, breathing.body.breath);
      breathMax = Math.max(breathMax, breathing.body.breath);

      const chest = breathing.profile.bones.chest;
      const flatChest = flat.profile.bones.chest;
      const hips = shifting.profile.bones.hips;
      const stillHips = still.profile.bones.hips;
      if (!(chest && flatChest && hips && stillHips)) throw new Error('synthetic rig lacks torso');
      maxBreathChestDelta = Math.max(
        maxBreathChestDelta,
        chest.quaternion.angleTo(flatChest.quaternion),
      );
      hips.updateWorldMatrix(true, false);
      stillHips.updateWorldMatrix(true, false);
      maxWeightHipsDelta = Math.max(
        maxWeightHipsDelta,
        hips
          .getWorldPosition(new THREE.Vector3())
          .distanceTo(stillHips.getWorldPosition(new THREE.Vector3())),
      );
    }

    expect(breathMax - breathMin).toBeGreaterThan(0.2);
    // The counterfactual has the same active gesture and timing, with only
    // breath depth removed, so this witnesses a torso change rather than just
    // the public breath readout changing.
    expect(maxBreathChestDelta).toBeGreaterThan(0.01);
    // Weight transfer is a separate slow term and moves the hips independently
    // of the gesture's arms.
    expect(maxWeightHipsDelta).toBeGreaterThan(0.001);
  });

  it.each(SIDES)('wave moves the requested %s wrist while leaving the other at rest', (side) => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const h = harness();
    const dt = 1 / 60;
    frame(h, dt);
    const rest = wrists(h);
    h.body.play('wave', side);

    const travelled: Record<Side, number> = { L: 0, R: 0 };
    const excursion: Record<Side, number> = { L: 0, R: 0 };
    let previous = rest;
    for (let i = 0; i < 120; i++) {
      frame(h, dt);
      const current = wrists(h);
      for (const hand of SIDES) {
        travelled[hand] += previous[hand].distanceTo(current[hand]);
        excursion[hand] = Math.max(excursion[hand], rest[hand].distanceTo(current[hand]));
      }
      previous = current;
    }

    const other: Side = side === 'L' ? 'R' : 'L';
    expect(travelled[side]).toBeGreaterThan(0.1);
    expect(excursion[side]).toBeGreaterThan(0.1);
    expect(excursion[other]).toBeLessThan(0.02);
  });
});
