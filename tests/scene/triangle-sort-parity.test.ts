import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { core } from '@/core';
import { TransparentTriangleController } from '@/engine/scene/transparent-triangles';
import { TriangleKernel } from '@/engine/scene/triangle-sort-core';
import { must } from '../helpers/must';
import {
  applyTriangleFrame,
  NAN_FRAME,
  type SpecialFrame,
  TRIANGLE_FIXTURES,
  TRIANGLE_FRAMES,
  type TriangleFixture,
} from '../helpers/triangle-fixtures';

/**
 * The core triangle kernel against the controller it ports, bit for bit.
 *
 * Both read the same mesh each frame. The controller's shell index is compared with the index
 * the kernel's order implies, then the controller's posed positions, centroids and depths (read
 * from its private record) with the kernel's, all with `Object.is`. The NaN-depth frame is not
 * compared: there the kernel keeps its previous order, which is checked instead.
 */

/** The fields of the controller's record this test reads. */
interface ControllerRecord {
  posedPositions: Float64Array | null;
  centroids: Float64Array | null;
  cameraDepths: Float64Array | null;
}

function record(controller: TransparentTriangleController, key: string): ControllerRecord {
  const records = (controller as unknown as { records: Map<string, ControllerRecord> }).records;
  return must(records.get(key), `record ${key}`);
}

/** The first index at which the two disagree under `Object.is`, or -1. */
function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i;
  return -1;
}

/** Edge conditions the kernel's depths actually reached. */
function conditions(depths: Float64Array, seen: Set<SpecialFrame | 'tie'>): void {
  let positiveZero = -1;
  let negativeZero = -1;
  let positiveInfinity = false;
  let negativeInfinity = false;
  const values = new Set<number>();
  for (let face = 0; face < depths.length; face++) {
    const d = depths[face];
    if (Object.is(d, 0) && positiveZero < 0) positiveZero = face;
    if (Object.is(d, -0)) negativeZero = face;
    if (d === Number.POSITIVE_INFINITY) positiveInfinity = true;
    if (d === Number.NEGATIVE_INFINITY) negativeInfinity = true;
    if (Number.isFinite(d) && values.has(d)) seen.add('tie');
    values.add(d);
  }
  // The −0 face after the +0 one: a sign-aware sort would put it first.
  if (positiveZero >= 0 && negativeZero > positiveZero) seen.add('signed-zero');
  if (positiveInfinity && negativeInfinity) seen.add('infinite');
}

interface Run {
  frames: number;
  mismatch: string | null;
  seen: Set<SpecialFrame | 'tie'>;
}

function run(
  fixture: TriangleFixture,
  tamper?: (kernel: TriangleKernel, frame: number) => void,
): Run {
  const rig = fixture.build();
  const camera = new THREE.PerspectiveCamera();
  const controller = new TransparentTriangleController();
  controller.reconcile([{ key: fixture.id, mesh: rig.mesh }]);
  const kernel = new TriangleKernel(rig.mesh);
  const indexCount = must(rig.mesh.geometry.index, 'index').count;
  const expected = new Uint32Array(indexCount);
  const actual = new Uint32Array(indexCount);
  const seen = new Set<SpecialFrame | 'tie'>();
  let previous = new Uint32Array(0);
  const fail = (frame: number, what: string): Run => ({
    frames: frame,
    mismatch: `${fixture.id} frame ${frame}: ${what}`,
    seen,
  });
  try {
    for (const [frame, step] of fixture.script.entries()) {
      applyTriangleFrame(rig, camera, step);
      const reason = kernel.update(camera);
      if (step.special === 'nan') {
        if (reason !== 'non-finite-depth') return fail(frame, `reason ${reason}`);
        if (firstDifference(previous, kernel.order()) >= 0) return fail(frame, 'order moved');
        seen.add('nan');
        continue;
      }
      if (reason !== null) return fail(frame, `kernel reason ${reason}`);
      controller.withDraw(camera, () => {
        expected.set(must(rig.mesh.geometry.index, 'shell index').array);
      });
      const target = must(controller.inspect().targets[0], 'target');
      if (!target.active) return fail(frame, `controller inactive: ${target.reason}`);
      tamper?.(kernel, frame);
      kernel.writeIndex(actual);
      const at = firstDifference(expected, actual);
      if (at >= 0) return fail(frame, `index[${at}]: ${expected[at]} against ${actual[at]}`);

      const r = record(controller, fixture.id);
      const depths = kernel.depths();
      const d = firstDifference(must(r.cameraDepths, 'depths'), depths);
      if (d >= 0) return fail(frame, `depth[${d}]: ${r.cameraDepths?.[d]} against ${depths[d]}`);
      const centroids = kernel.centroids();
      const c = firstDifference(must(r.centroids, 'centroids'), centroids);
      if (c >= 0) return fail(frame, `centroid[${c}]: ${r.centroids?.[c]} against ${centroids[c]}`);
      const posed = must(r.posedPositions, 'positions');
      const positions = kernel.positions();
      for (const [slot, vertex] of kernel.vertices.entries()) {
        for (let k = 0; k < 3; k++) {
          const a = posed[3 * vertex + k];
          const b = positions[3 * slot + k];
          if (!Object.is(a, b)) return fail(frame, `vertex ${vertex}[${k}]: ${a} against ${b}`);
        }
      }
      conditions(depths, seen);
      if (step.special && !seen.has(step.special))
        return fail(frame, `${step.special} not reached`);
      previous = kernel.order().slice();
    }
    return { frames: fixture.script.length, mismatch: null, seen };
  } finally {
    kernel.dispose();
    controller.dispose();
  }
}

describe('TriangleKernel against TransparentTriangleController', () => {
  for (const fixture of TRIANGLE_FIXTURES) {
    it(`matches bit for bit: ${fixture.id}`, () => {
      const result = run(fixture);
      expect(result.mismatch).toBeNull();
      expect(result.frames).toBe(TRIANGLE_FRAMES);
      expect(result.seen.has('tie')).toBe(true);
      expect(result.seen.has('nan')).toBe(true);
      if (fixture.id === 'rigid') {
        expect(result.seen.has('signed-zero')).toBe(true);
        expect(result.seen.has('infinite')).toBe(true);
      }
    });
  }

  it('keeps the previous order and reports a NaN depth', () => {
    const fixture = must(TRIANGLE_FIXTURES[2], 'skinned-relative');
    const rig = fixture.build();
    const camera = new THREE.PerspectiveCamera();
    const kernel = new TriangleKernel(rig.mesh);
    applyTriangleFrame(rig, camera, must(fixture.script[NAN_FRAME - 1], 'frame'));
    expect(kernel.update(camera)).toBeNull();
    const before = kernel.order().slice();
    expect([...before].sort((a, b) => a - b)).toEqual([...before.keys()]);
    applyTriangleFrame(rig, camera, must(fixture.script[NAN_FRAME], 'frame'));
    expect(kernel.update(camera)).toBe('non-finite-depth');
    expect(Number.isNaN(kernel.depths()[0])).toBe(true);
    expect(kernel.order()).toEqual(before);
    kernel.dispose();
  });

  it('fails when one face of the kernel order is moved', () => {
    const result = run(must(TRIANGLE_FIXTURES[2], 'skinned-relative'), (kernel, frame) => {
      if (frame !== 150) return;
      const order = kernel.order();
      const last = order.length - 1;
      [order[0], order[last]] = [order[last], order[0]];
    });
    expect(result.mismatch).toMatch(/^skinned-relative frame 150: index\[/);
  });

  it('does not grow memory over 1,000 frames, and frees it on dispose', () => {
    const fixture = must(TRIANGLE_FIXTURES[3], 'skinned-normalized');
    const rig = fixture.build();
    const camera = new THREE.PerspectiveCamera();
    const kernel = new TriangleKernel(rig.mesh);
    applyTriangleFrame(rig, camera, must(fixture.script[0], 'frame'));
    kernel.update(camera);
    const before = core().memory.buffer.byteLength;
    for (let frame = 0; frame < 1000; frame++) {
      applyTriangleFrame(rig, camera, must(fixture.script[frame % TRIANGLE_FRAMES], 'frame'));
      kernel.update(camera);
    }
    const after = core().memory.buffer.byteLength;
    kernel.dispose();
    for (let k = 0; k < 300; k++) {
      const again = new TriangleKernel(fixture.build().mesh);
      again.update(camera);
      again.dispose();
    }
    const rebuilt = core().memory.buffer.byteLength;
    expect(after).toBe(before);
    expect(rebuilt).toBe(before);
  });
});
