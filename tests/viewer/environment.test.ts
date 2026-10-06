import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioEnvironment } from '@/viewer/scene/environment';

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
