import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { BLOOM_DEFAULTS } from '@/engine/types';
import { type BloomPipeline, type BloomPipelineFactory, BloomStage } from '@/viewer/scene/bloom';

function harness(): {
  stage: BloomStage;
  renderer: THREE.WebGLRenderer;
  pipelines: BloomPipeline[];
  factory: BloomPipelineFactory;
} {
  const renderer = {
    getSize: (target: THREE.Vector2) => target.set(640, 360),
    render: vi.fn(),
  } as unknown as THREE.WebGLRenderer;
  const pipelines: BloomPipeline[] = [];
  const factory: BloomPipelineFactory = vi.fn(() => {
    const pipeline: BloomPipeline = {
      render: vi.fn(),
      resize: vi.fn(),
      setSettings: vi.fn(),
      dispose: vi.fn(),
    };
    pipelines.push(pipeline);
    return pipeline;
  });
  return { stage: new BloomStage(renderer, factory), renderer, pipelines, factory };
}

describe('BloomStage target', () => {
  it('is the pipeline target while bloom runs and null otherwise', () => {
    const target = new THREE.WebGLRenderTarget(1, 1);
    const renderer = {
      getSize: (v: THREE.Vector2) => v.set(64, 64),
      render: vi.fn(),
    } as unknown as THREE.WebGLRenderer;
    const stage = new BloomStage(renderer, () => ({
      target,
      render: vi.fn(),
      resize: vi.fn(),
      setSettings: vi.fn(),
      dispose: vi.fn(),
    }));
    expect(stage.target).toBeNull();
    stage.setBloom({ enabled: true });
    stage.render(new THREE.Scene(), new THREE.PerspectiveCamera());
    expect(stage.target).toBe(target);
    stage.setBloom({ enabled: false });
    expect(stage.target).toBeNull();
    target.dispose();
  });
});

describe('BloomStage', () => {
  it('keeps the default and zero-strength paths on direct rendering', () => {
    const { stage, renderer, factory } = harness();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();

    expect(stage.report()).toEqual(BLOOM_DEFAULTS);
    stage.render(scene, camera);
    stage.setBloom({ enabled: true, strength: 0 });
    stage.render(scene, camera);

    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(renderer.render).toHaveBeenNthCalledWith(1, scene, camera);
    expect(factory).not.toHaveBeenCalled();
  });

  it('creates the composer on the first active frame and resizes it in CSS pixels', () => {
    const { stage, pipelines, factory } = harness();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    stage.resize(900, 506);
    stage.setBloom({ enabled: true });

    expect(factory).not.toHaveBeenCalled();
    stage.render(scene, camera);

    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(
      expect.anything(),
      scene,
      camera,
      { ...BLOOM_DEFAULTS, enabled: true },
      { width: 900, height: 506 },
      true,
    );
    expect(pipelines[0].resize).not.toHaveBeenCalled();
    expect(pipelines[0].render).toHaveBeenCalledWith(scene, camera);

    stage.resize(1280, 720);
    stage.setBloom({ radius: 0.8, threshold: 1.1 });
    expect(pipelines[0].resize).toHaveBeenLastCalledWith(1280, 720);
    expect(pipelines[0].setSettings).toHaveBeenCalledWith({
      ...BLOOM_DEFAULTS,
      enabled: true,
      radius: 0.8,
      threshold: 1.1,
    });
  });

  it('releases resources when turned off and again when the stage is disposed', () => {
    const { stage, pipelines } = harness();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    stage.setBloom({ enabled: true });
    stage.render(scene, camera);

    stage.setBloom({ enabled: false });
    expect(pipelines[0].dispose).toHaveBeenCalledOnce();
    stage.render(scene, camera);

    stage.setBloom({ enabled: true });
    stage.render(scene, camera);
    expect(pipelines).toHaveLength(2);
    stage.dispose();
    expect(pipelines[1].dispose).toHaveBeenCalledOnce();

    stage.render(scene, camera);
    stage.setBloom({ enabled: false });
    expect(pipelines[1].render).toHaveBeenCalledOnce();
  });

  it('bounds numeric settings and returns independent report objects', () => {
    const { stage } = harness();
    stage.setBloom({ enabled: true, strength: 8, radius: -1, threshold: 9 });
    const report = stage.report();
    expect(report).toEqual({ enabled: true, strength: 3, radius: 0, threshold: 2 });
    report.enabled = false;
    expect(stage.report().enabled).toBe(true);
  });
});
