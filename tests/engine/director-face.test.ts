import type * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { buildRig } from '../helpers/scene';

const DT = 1 / 60;

/** Deterministic draws for a replayable run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function influence(mesh: THREE.SkinnedMesh | undefined, id: string): number {
  const index = mesh?.morphTargetDictionary?.[id];
  return index === undefined ? 0 : (mesh?.morphTargetInfluences?.[index] ?? 0);
}

/** An avatar with neither ARKit nor a composition table: the VRM-preset fallback. */
function vrmAvatar() {
  const rig = buildRig({ arkit: false, ungrouped: ['happy', 'surprised'] });
  const director = new Director(buildProfile(rig.root, rig.descriptor));
  const body = rig.meshes.get('Body');
  const weight = (id: string) => influence(body, id);
  return { director, weight };
}

/** Pin the body's saccade so the saccade-blink path runs every frame. */
function forceSaccade(director: Director): void {
  Object.defineProperty(director.body, 'saccade', { get: () => 1, set: () => {} });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Director / the single-preset fallback', () => {
  it('fades one preset out before the next fades in rather than jumping', () => {
    const { director, weight } = vrmAvatar();
    director.setEmotion({ joy: 0.8 });
    for (let i = 0; i < 240; i++) director.update(DT);
    expect(weight('happy')).toBeGreaterThan(0.7);

    director.setEmotion({ surprise: 0.8 });
    let prev = { happy: weight('happy'), surprised: weight('surprised') };
    let largest = 0;
    for (let i = 0; i < 240; i++) {
      director.update(DT);
      const now = { happy: weight('happy'), surprised: weight('surprised') };
      largest = Math.max(
        largest,
        Math.abs(now.happy - prev.happy),
        Math.abs(now.surprised - prev.surprised),
      );
      // Two sculpts are never on the face at once.
      expect(Math.min(now.happy, now.surprised)).toBeLessThan(0.02);
      prev = now;
    }
    expect(weight('surprised')).toBeGreaterThan(0.7);
    // A one-frame swap would move the whole ~0.4 crossing weight at once.
    expect(largest).toBeLessThan(0.1);
  }, 30_000);

  it('yields a preset to the visemes while speaking', () => {
    const { director, weight } = vrmAvatar();
    director.setEmotion({ joy: 1 });
    for (let i = 0; i < 240; i++) director.update(DT);
    const rest = weight('happy');
    expect(rest).toBeGreaterThan(0.9);

    director.speak('あいうえおあいうえおあいうえお');
    for (let i = 0; i < 60; i++) director.update(DT);
    expect(director.mouth.busy).toBeGreaterThan(0.95);
    expect(weight('happy')).toBeLessThan(rest * 0.45);
  });
});

describe('Director / saccade blinks', () => {
  it('blinks off a saccade normally', () => {
    const rig = buildRig();
    const director = new Director(buildProfile(rig.root, rig.descriptor), undefined, {
      random: () => 0.1,
    });
    forceSaccade(director);
    let peak = 0;
    for (let i = 0; i < 90; i++) {
      director.update(DT);
      peak = Math.max(peak, director.blink);
    }
    expect(peak).toBeGreaterThan(0.5);
  });

  it('refuses a saccade blink while surprise holds the eyes open', () => {
    const rig = buildRig();
    const director = new Director(buildProfile(rig.root, rig.descriptor), undefined, {
      random: () => 0.1,
    });
    director.setEmotion({ surprise: 1 });
    // Settle with no saccades, so no blink is already in flight.
    for (let i = 0; i < 120 && (director.emotion.surprise ?? 0) < 0.5; i++) director.update(DT);
    while (director.blink > 0) director.update(DT);
    forceSaccade(director);
    for (let i = 0; i < 180; i++) {
      director.update(DT);
      expect(director.blink).toBe(0);
    }
  });
});

describe('Director / injected random', () => {
  function run(seed: number): string[] {
    const rig = buildRig();
    const director = new Director(buildProfile(rig.root, rig.descriptor), undefined, {
      random: mulberry32(seed),
    });
    director.auto = true;
    const seen: string[] = [];
    for (let i = 0; i < 60 * 10; i++) {
      director.update(DT);
      seen.push(`${director.performance}:${director.blink.toFixed(6)}`);
    }
    return seen;
  }

  it('replays a seeded run exactly', () => {
    // The body layer still draws from Math.random; pin it so only the director's source varies.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const a = run(7);
    expect(run(7)).toEqual(a);
    expect(run(8)).not.toEqual(a);
  }, 60_000);
});
