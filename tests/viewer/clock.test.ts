import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { frameStep, MAX_DT } from '@/viewer/scene/runtime/clock';

describe('frameStep', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the delta off the frame timestamp, not the wall clock', () => {
    const timer = new THREE.Timer();
    frameStep(timer, 1_000);
    const step = frameStep(timer, 1_016.5);
    expect(step.elapsed).toBeCloseTo(0.0165, 12);
    expect(step.dt).toBeCloseTo(0.0165, 12);
  });

  it('caps dt but leaves elapsed unbounded', () => {
    const timer = new THREE.Timer();
    frameStep(timer, 1_000);
    const step = frameStep(timer, 1_400);
    expect(step.elapsed).toBeCloseTo(0.4, 12);
    expect(step.dt).toBe(MAX_DT);
  });

  it('never goes negative when a reset read the wall clock after the frame began', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(2_000);
    const timer = new THREE.Timer();
    frameStep(timer, 1_990);
    now.mockReturnValue(2_010);
    timer.reset();
    const step = frameStep(timer, 2_005);
    expect(step.elapsed).toBe(0);
    expect(step.dt).toBe(0);
  });
});
