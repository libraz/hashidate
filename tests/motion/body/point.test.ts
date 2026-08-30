import type * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { DT, type Harness, harness } from './harness';

interface PointFrame {
  solverExtent: number;
  tip: THREE.Vector3;
  chest: [number, number, number];
  spine: [number, number, number];
}

function rotation(h: Harness, slot: 'chest' | 'spine'): [number, number, number] {
  const bone = h.profile.bones[slot];
  if (!bone) throw new Error(`synthetic rig is missing ${slot}`);
  return [bone.rotation.x, bone.rotation.y, bone.rotation.z];
}

/** Run a point long enough for both its solver request and torso offsets to settle. */
function pointFrame(requestedExtent: number): PointFrame {
  const h = harness();
  const solvePoint = h.rig.solvePoint.bind(h.rig);
  let solverExtent: number | undefined;
  let tip: THREE.Vector3 | undefined;
  vi.spyOn(h.rig, 'solvePoint').mockImplementation((side, spec, out) => {
    solverExtent = spec.extent;
    const solved = solvePoint(side, spec, out);
    if (solved) tip = out.tip.clone();
    return solved;
  });

  h.rig.reset();
  h.body.update(DT);
  h.body.point('R', { azimuth: 45, elevation: 20, extent: requestedExtent });
  for (let i = 0; i < 120; i++) {
    h.rig.reset();
    h.body.update(DT);
  }

  if (solverExtent === undefined || !tip) throw new Error('point did not reach the solver');
  return {
    solverExtent,
    tip,
    chest: rotation(h, 'chest'),
    spine: rotation(h, 'spine'),
  };
}

function expectSamePoint(a: PointFrame, b: PointFrame): void {
  expect(a.solverExtent).toBe(b.solverExtent);
  expect(a.tip.distanceTo(b.tip)).toBeLessThan(1e-12);
  for (const slot of ['chest', 'spine'] as const) {
    for (let i = 0; i < 3; i++) expect(a[slot][i]).toBeCloseTo(b[slot][i], 12);
  }
}

describe('point extent', () => {
  it('uses the upper clamp for both fingertip reach and torso turn', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const over = pointFrame(20);
      const limit = pointFrame(1);
      expect(over.solverExtent).toBe(1);
      expectSamePoint(over, limit);
    } finally {
      random.mockRestore();
    }
  });

  it('uses the lower clamp for both fingertip reach and torso turn', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const under = pointFrame(-1);
      const limit = pointFrame(0.1);
      expect(under.solverExtent).toBe(0.1);
      expectSamePoint(under, limit);
    } finally {
      random.mockRestore();
    }
  });
});
