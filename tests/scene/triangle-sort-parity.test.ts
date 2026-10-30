import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { core } from '@/core';
import { SceneGraph } from '@/core/scene';
import { TriangleKernel } from '@/engine/scene/triangle-sort-core';
import { must } from '../helpers/must';
import {
  applyTriangleFrame,
  NAN_FRAME,
  TRIANGLE_FIXTURES,
  TRIANGLE_FRAMES,
  triangleFrameHashes,
} from '../helpers/triangle-fixtures';
import recorded from './triangle-sort-parity.json';

/**
 * The transparent-triangle controller's shell index, frame by frame, against recorded hashes.
 *
 * Regenerate with `yarn tsx tools/record-triangle-parity.ts`, and only for a deliberate change
 * in how triangles are posed or ordered; a mismatch is otherwise a regression.
 */

describe('TransparentTriangleController against the recorded frame hashes', () => {
  for (const fixture of TRIANGLE_FIXTURES) {
    it(`matches every frame: ${fixture.id}`, () => {
      const expected = must(
        (recorded.fixtures as Record<string, { frames: number; hashes: string[] }>)[fixture.id],
        `recorded ${fixture.id}`,
      );
      const hashes = triangleFrameHashes(fixture);
      expect(hashes).toHaveLength(TRIANGLE_FRAMES);
      expect(expected.frames).toBe(TRIANGLE_FRAMES);
      const at = hashes.findIndex((hash, frame) => hash !== expected.hashes[frame]);
      expect(at).toBe(-1);
    });
  }

  it('keeps the previous order and reports a NaN depth', () => {
    const fixture = must(TRIANGLE_FIXTURES[2], 'skinned-relative');
    const rig = fixture.build();
    const camera = new THREE.PerspectiveCamera();
    const kernel = new TriangleKernel(rig.root, rig.mesh);
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

  it('does not grow memory over 1,000 frames, and frees it on dispose', () => {
    const fixture = must(TRIANGLE_FIXTURES[3], 'skinned-normalized');
    const rig = fixture.build();
    const camera = new THREE.PerspectiveCamera();
    const kernel = new TriangleKernel(rig.root, rig.mesh);
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
      const built = fixture.build();
      const again = new TriangleKernel(built.root, built.mesh);
      again.update(camera);
      again.dispose();
      SceneGraph.of(built.root).dispose();
    }
    const rebuilt = core().memory.buffer.byteLength;
    expect(after).toBe(before);
    expect(rebuilt).toBe(before);
  });
});
