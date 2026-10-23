import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DefaultRig, KEY_FROM } from '@/viewer/scene/rig';

const lightDirection = (rig: DefaultRig) => {
  rig.updateMatrixWorld(true);
  const from = new THREE.Vector3().setFromMatrixPosition(rig.key.matrixWorld);
  const to = new THREE.Vector3().setFromMatrixPosition(rig.key.target.matrixWorld);
  return from.sub(to).normalize();
};

describe('default rig', () => {
  it('casts from the key alone', () => {
    const rig = new DefaultRig();
    const casters: THREE.Light[] = [];
    rig.traverse((o) => {
      if (o instanceof THREE.Light && o.castShadow) casters.push(o);
    });
    expect(casters).toEqual([rig.key]);
  });

  it('keeps the key target in the rig so its world matrix follows the scene', () => {
    const rig = new DefaultRig();
    expect(rig.key.target.parent).toBe(rig);
  });

  it('fits the shadow to the avatar without turning the key', () => {
    const rig = new DefaultRig();
    const before = lightDirection(rig);
    rig.fitShadow(new THREE.Vector3(0.3, 1.2, -0.4), 0.9);
    expect(lightDirection(rig).dot(before)).toBeCloseTo(1, 6);
    expect(before.dot(KEY_FROM.clone().normalize())).toBeCloseTo(1, 6);
    expect(rig.key.target.position.toArray()).toEqual([0.3, 1.2, -0.4]);
  });

  it('frames the whole sphere in the shadow camera, near to far', () => {
    const rig = new DefaultRig();
    const centre = new THREE.Vector3(0, 1, 0);
    const radius = 0.9;
    rig.fitShadow(centre, radius);
    const cam = rig.key.shadow.camera;
    expect(cam.right - cam.left).toBeGreaterThanOrEqual(2 * radius);
    expect(cam.top - cam.bottom).toBeGreaterThanOrEqual(2 * radius);
    const distance = rig.key.position.distanceTo(centre);
    expect(cam.near).toBeLessThanOrEqual(distance - radius);
    expect(cam.far).toBeGreaterThanOrEqual(distance + radius);
  });

  it('refits when the avatar changes size', () => {
    const rig = new DefaultRig();
    rig.fitShadow(new THREE.Vector3(), 0.5);
    const small = rig.key.shadow.camera.right;
    rig.fitShadow(new THREE.Vector3(), 1);
    expect(rig.key.shadow.camera.right).toBeCloseTo(small * 2, 6);
  });
});
