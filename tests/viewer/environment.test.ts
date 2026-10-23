import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetalEnvironment, StudioEnvironment } from '@/viewer/scene/environment';

const renderer = {} as THREE.WebGLRenderer;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('studio environment', () => {
  it('does not build a PMREM map outside a browser document', () => {
    const fromScene = vi.spyOn(THREE.PMREMGenerator.prototype, 'fromScene');

    expect(new StudioEnvironment(renderer).texture).toBeNull();
    expect(fromScene).not.toHaveBeenCalled();
  });

  it('caches the generated texture and disposes its owning render target', () => {
    vi.stubGlobal('document', {});
    const target = new THREE.WebGLRenderTarget(16, 8);
    const fromScene = vi.spyOn(THREE.PMREMGenerator.prototype, 'fromScene').mockReturnValue(target);
    const generatorDispose = vi.spyOn(THREE.PMREMGenerator.prototype, 'dispose');
    const targetDispose = vi.spyOn(target, 'dispose');

    const environment = new StudioEnvironment(renderer);

    expect(environment.texture).toBe(target.texture);
    expect(environment.texture).toBe(target.texture);
    expect(fromScene).toHaveBeenCalledOnce();
    expect(generatorDispose).toHaveBeenCalledOnce();

    environment.dispose();
    environment.dispose();

    expect(targetDispose).toHaveBeenCalledOnce();
  });

  it('can build a fresh map after disposal', () => {
    vi.stubGlobal('document', {});
    const first = new THREE.WebGLRenderTarget(16, 8);
    const second = new THREE.WebGLRenderTarget(16, 8);
    const fromScene = vi
      .spyOn(THREE.PMREMGenerator.prototype, 'fromScene')
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const firstDispose = vi.spyOn(first, 'dispose');
    const secondDispose = vi.spyOn(second, 'dispose');
    const environment = new StudioEnvironment(renderer);

    expect(environment.texture).toBe(first.texture);
    environment.dispose();
    expect(environment.texture).toBe(second.texture);
    environment.dispose();

    expect(fromScene).toHaveBeenCalledTimes(2);
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
  });

  it('releases temporary PMREM resources when generation fails', () => {
    vi.stubGlobal('document', {});
    const failure = new Error('PMREM failed');
    const fromScene = vi
      .spyOn(THREE.PMREMGenerator.prototype, 'fromScene')
      .mockImplementation(() => {
        throw failure;
      });
    const generatorDispose = vi.spyOn(THREE.PMREMGenerator.prototype, 'dispose');
    const roomDispose = vi.spyOn(RoomEnvironment.prototype, 'dispose');

    expect(() => new StudioEnvironment(renderer).texture).toThrow(failure);
    expect(fromScene).toHaveBeenCalledOnce();
    expect(generatorDispose).toHaveBeenCalledOnce();
    expect(roomDispose).toHaveBeenCalledOnce();
  });
});

describe('metal environment', () => {
  /** Each emissive panel by intensity, with the direction it lies in from the origin. */
  const panels = (scene: THREE.Scene) => {
    const found: Array<{ intensity: number; at: THREE.Vector3; side: THREE.Side }> = [];
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const material = object.material as THREE.MeshLambertMaterial;
      found.push({
        intensity: material.emissiveIntensity,
        at: object.position.clone().normalize(),
        side: material.side,
      });
    });
    return found.sort((a, b) => b.intensity - a.intensity);
  };

  it('is a dark room whose brightest softbox lies on the default key light', () => {
    const [key, ...rest] = panels(new MetalEnvironment());
    const room = rest.find((p) => p.side === THREE.BackSide);

    expect(key?.at.dot(new THREE.Vector3(1, 1.6, 2.5).normalize())).toBeCloseTo(1, 6);
    expect(room?.intensity).toBeLessThan(0.1);
    expect(rest.filter((p) => p.side !== THREE.BackSide)).toHaveLength(2);
  });

  it('faces every softbox toward the point the map is rendered from', () => {
    const scene = new MetalEnvironment();
    scene.updateMatrixWorld(true);
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || object.scale.z !== 0.1) return;
      const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(object.quaternion);
      expect(facing.dot(object.position.clone().negate().normalize())).toBeCloseTo(1, 6);
    });
  });

  it('frees its shared geometry once and each panel material', () => {
    const scene = new MetalEnvironment();
    const disposed = new Map<unknown, number>();
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const resource of [object.geometry, object.material as THREE.Material]) {
        vi.spyOn(resource, 'dispose').mockImplementation(() => {
          disposed.set(resource, (disposed.get(resource) ?? 0) + 1);
        });
      }
    });

    scene.dispose();

    expect(disposed.size).toBe(5);
    expect([...disposed.values()].every((n) => n === 1)).toBe(true);
  });

  it('is what a studio environment renders and releases when built with it', () => {
    vi.stubGlobal('document', {});
    const target = new THREE.WebGLRenderTarget(16, 8);
    const fromScene = vi.spyOn(THREE.PMREMGenerator.prototype, 'fromScene').mockReturnValue(target);
    const sceneDispose = vi.spyOn(MetalEnvironment.prototype, 'dispose');
    const roomDispose = vi.spyOn(RoomEnvironment.prototype, 'dispose');

    const environment = new StudioEnvironment(renderer, () => new MetalEnvironment());

    expect(environment.texture).toBe(target.texture);
    expect(fromScene.mock.calls[0]?.[0]).toBeInstanceOf(MetalEnvironment);
    expect(sceneDispose).toHaveBeenCalledOnce();
    expect(roomDispose).not.toHaveBeenCalled();
    environment.dispose();
  });
});
