import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { lensShift } from '@/viewer/scene/runtime/camera';

/**
 * Moving the figure across its picture without moving the camera.
 *
 * `shift` is a fraction of the picture's width, so the point the camera looks
 * straight at has to land that far off the middle — measured in normalised
 * device coordinates, where the picture is 2 wide — whatever the picture's
 * shape, and nothing about the framing may change on the way.
 */

/** Where the point straight ahead of the camera lands, across the picture, -1 to 1. */
function ahead(aspect: number, shift: number): number {
  const camera = new THREE.PerspectiveCamera(28, aspect, 0.01, 100);
  lensShift(camera, shift);
  camera.updateMatrixWorld();
  return new THREE.Vector3(0, 0, -5).project(camera).x;
}

describe('lensShift', () => {
  it.each([16 / 9, 1, 9 / 16])(
    'moves the middle by the fraction asked for at aspect %f',
    (aspect) => {
      expect(ahead(aspect, 0)).toBeCloseTo(0, 6);
      expect(ahead(aspect, 0.25)).toBeCloseTo(0.5, 6);
      expect(ahead(aspect, -0.1)).toBeCloseTo(-0.2, 6);
    },
  );

  it('keeps the height of the world in shot, so the framing still means what it says', () => {
    const camera = new THREE.PerspectiveCamera(28, 16 / 9, 0.01, 100);
    const top = () => new THREE.Vector3(0, 1, -5).project(camera).y;
    camera.updateMatrixWorld();
    const before = top();
    lensShift(camera, 0.3);
    expect(top()).toBeCloseTo(before, 6);
  });
});
