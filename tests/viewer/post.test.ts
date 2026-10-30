import * as THREE from 'three';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { describe, expect, it, vi } from 'vitest';
import { BLOOM_DEFAULTS } from '@/engine/types';
import type { Finish } from '@/viewer/scene/backdrop/patterns';
import {
  drawWithCompensatedBackground,
  FocusBlurPass,
  neutralInverse,
  type PostPipeline,
  type PostPipelineFactory,
  PostStage,
} from '@/viewer/scene/post';
import { buildRig } from '../helpers/scene';

/** What each composer was handed, captured at construction. */
const composers = vi.hoisted(
  () =>
    [] as Array<{
      target: THREE.WebGLRenderTarget;
      depthAtConstruction: unknown;
      passes: unknown[];
    }>,
);

// The real pipeline is built against a stand-in composer: it needs no GL
// context, and it records the order the target and its passes were set up in.
vi.mock('three/addons/postprocessing/EffectComposer.js', () => ({
  EffectComposer: class {
    readonly passes: unknown[] = [];
    constructor(_renderer: unknown, target: THREE.WebGLRenderTarget) {
      composers.push({ target, depthAtConstruction: target.depthTexture, passes: this.passes });
    }
    addPass(pass: unknown): void {
      this.passes.push(pass);
    }
    setSize(): void {}
    setPixelRatio(): void {}
    render(): void {}
    dispose(): void {}
  },
}));

/** The raw GL calls the direct path may make, in order. */
type GlCall = [string, ...unknown[]];

function harness(): {
  stage: PostStage;
  renderer: THREE.WebGLRenderer;
  pipelines: PostPipeline[];
  factory: PostPipelineFactory;
  gl: GlCall[];
  resetColor: ReturnType<typeof vi.fn>;
} {
  const gl: GlCall[] = [];
  const resetColor = vi.fn();
  const context = {
    COLOR_BUFFER_BIT: 0x4000,
    colorMask: (...args: unknown[]) => gl.push(['colorMask', ...args]),
    clearColor: (...args: unknown[]) => gl.push(['clearColor', ...args]),
    clear: (...args: unknown[]) => gl.push(['clear', ...args]),
  };
  const renderer = {
    getSize: (target: THREE.Vector2) => target.set(640, 360),
    render: vi.fn(() => gl.push(['render'])),
    getContext: () => context,
    state: { buffers: { color: { reset: resetColor } } },
  } as unknown as THREE.WebGLRenderer;
  const pipelines: PostPipeline[] = [];
  const factory: PostPipelineFactory = vi.fn(() => {
    const pipeline: PostPipeline = {
      render: vi.fn(),
      resize: vi.fn(),
      setSettings: vi.fn(),
      setOpaque: vi.fn(),
      setFinish: vi.fn(),
      setFocus: vi.fn(),
      dispose: vi.fn(),
    };
    pipelines.push(pipeline);
    return pipeline;
  });
  return { stage: new PostStage(renderer, factory), renderer, pipelines, factory, gl, resetColor };
}

describe('PostStage target', () => {
  it('is the pipeline target while the composer runs and null otherwise', () => {
    const target = new THREE.WebGLRenderTarget(1, 1);
    const renderer = {
      getSize: (v: THREE.Vector2) => v.set(64, 64),
      render: vi.fn(),
    } as unknown as THREE.WebGLRenderer;
    const stage = new PostStage(renderer, () => ({
      target,
      render: vi.fn(),
      resize: vi.fn(),
      setSettings: vi.fn(),
      setOpaque: vi.fn(),
      setFinish: vi.fn(),
      setFocus: vi.fn(),
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

describe('PostStage', () => {
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

describe('PostStage output alpha', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();

  it('leaves a transparent stage as the scene drew it', () => {
    const { stage, gl } = harness();
    stage.render(scene, camera);
    expect(gl).toEqual([['render']]);
  });

  it('fills the alpha channel after drawing straight to an opaque canvas', () => {
    const { stage, gl, resetColor } = harness();
    stage.setOpaque(true);
    stage.render(scene, camera);

    expect(gl).toEqual([
      ['render'],
      ['colorMask', false, false, false, true],
      ['clearColor', 0, 0, 0, 1],
      ['clear', 0x4000],
      ['colorMask', true, true, true, true],
    ]);
    // The raw calls bypass three's cache, which has to re-issue its own state.
    expect(resetColor).toHaveBeenCalledOnce();

    stage.setOpaque(false);
    gl.length = 0;
    stage.render(scene, camera);
    expect(gl).toEqual([['render']]);
  });

  it('hands the decision to the composer, which writes its own alpha', () => {
    const { stage, pipelines, gl } = harness();
    stage.setOpaque(true);
    stage.setBloom({ enabled: true });
    stage.render(scene, camera);

    expect(pipelines[0].setOpaque).toHaveBeenLastCalledWith(true);
    expect(gl).toEqual([]);
    stage.setOpaque(false);
    expect(pipelines[0].setOpaque).toHaveBeenLastCalledWith(false);
  });
});

const FINISH: Finish = {
  blur: { radius: 6, ramp: 2 },
  grade: { gain: [1.04, 1, 0.95], saturation: 1.05, contrast: 1.04 },
  vignette: 0.22,
};

describe('PostStage finish', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();

  it('stays on direct rendering with no finish and bloom off', () => {
    const { stage, renderer, factory } = harness();
    stage.setFinish(null);
    stage.render(scene, camera);
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(factory).not.toHaveBeenCalled();
    expect(stage.target).toBeNull();
  });

  it('builds the composer for a finish alone and releases it when the finish goes', () => {
    const { stage, renderer, pipelines, factory } = harness();
    stage.setFinish(FINISH);
    stage.render(scene, camera);

    expect(factory).toHaveBeenCalledOnce();
    expect(renderer.render).not.toHaveBeenCalled();
    expect(pipelines[0].setFinish).toHaveBeenLastCalledWith(FINISH);

    stage.setFinish(null);
    expect(pipelines[0].dispose).toHaveBeenCalledOnce();
    stage.render(scene, camera);
    expect(renderer.render).toHaveBeenCalledOnce();
  });

  it('keeps the composer for bloom when the finish goes', () => {
    const { stage, pipelines } = harness();
    stage.setBloom({ enabled: true });
    stage.setFinish(FINISH);
    stage.render(scene, camera);
    stage.setFinish(null);

    expect(pipelines[0].dispose).not.toHaveBeenCalled();
    expect(pipelines[0].setFinish).toHaveBeenLastCalledWith(null);
    // And turning bloom off with a finish up keeps it too.
    stage.setFinish(FINISH);
    stage.setBloom({ enabled: false });
    expect(pipelines[0].dispose).not.toHaveBeenCalled();
  });

  it('hands a focus to one frame, copied, and none to the frame after', () => {
    const { stage, pipelines } = harness();
    stage.setFinish(FINISH);
    const centre = new THREE.Vector3(0, 1.2, 0.1);
    const avatar = new THREE.Group();
    stage.setFocus(centre, 0.8, avatar);
    centre.set(9, 9, 9);
    stage.render(scene, camera);

    expect(pipelines[0].setFocus).toHaveBeenLastCalledWith({
      centre: new THREE.Vector3(0, 1.2, 0.1),
      radius: 0.8,
      avatar,
    });
    stage.render(scene, camera);
    expect(pipelines[0].setFocus).toHaveBeenLastCalledWith(null);
  });
});

describe('the post pipeline', () => {
  /** Enough of a renderer to build the real pipeline against the stand-in composer. */
  function real(): PostStage {
    composers.length = 0;
    const renderer = {
      getSize: (v: THREE.Vector2) => v.set(640, 360),
      getPixelRatio: () => 1,
      capabilities: { maxSamples: 4 },
      toneMapping: THREE.NoToneMapping,
      render: vi.fn(),
    } as unknown as THREE.WebGLRenderer;
    return new PostStage(renderer);
  }

  /** The passes of the one composer built, by kind. */
  function passes() {
    const [render, focus, bloom, output] = composers[0].passes;
    expect(render).toBeInstanceOf(RenderPass);
    expect(focus).toBeInstanceOf(FocusBlurPass);
    expect(bloom).toBeInstanceOf(UnrealBloomPass);
    expect(output).toBeInstanceOf(ShaderPass);
    return {
      focus: focus as FocusBlurPass,
      bloom: bloom as UnrealBloomPass,
      output: (output as ShaderPass).uniforms,
    };
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 16 / 9, 0.1, 50);

  it('attaches the depth texture before the composer clones the target', () => {
    const stage = real();
    stage.setFinish(FINISH);
    stage.render(scene, camera);

    expect(composers).toHaveLength(1);
    const { target, depthAtConstruction } = composers[0];
    expect(depthAtConstruction).toBeInstanceOf(THREE.DepthTexture);
    expect(depthAtConstruction).toBe(target.depthTexture);
    expect((depthAtConstruction as THREE.DepthTexture).type).toBe(THREE.UnsignedIntType);
    expect(stage.target).toBe(target);
    stage.dispose();
  });

  it('runs the blur and the grade for a finish, with the bloom pass off', () => {
    const stage = real();
    stage.setFinish(FINISH);
    stage.setFocus(new THREE.Vector3(0, 1.3, 0), 0.6, new THREE.Group());
    stage.render(scene, camera);

    const { focus, bloom, output } = passes();
    expect(focus.enabled).toBe(true);
    expect(bloom.enabled).toBe(false);
    expect(output.finished.value).toBe(true);
    expect(output.gain.value.toArray()).toEqual(FINISH.grade.gain);
    expect(output.saturation.value).toBe(FINISH.grade.saturation);
    expect(output.contrast.value).toBe(FINISH.grade.contrast);
    expect(output.vignette.value).toBe(FINISH.vignette);
    stage.dispose();
  });

  it('does not blur a frame with no avatar to keep sharp', () => {
    const stage = real();
    stage.setFinish(FINISH);
    stage.setFocus(new THREE.Vector3(0, 1.3, 0), 0.6, new THREE.Group());
    stage.render(scene, camera);
    stage.render(scene, camera);
    expect(passes().focus.enabled).toBe(false);
    stage.dispose();
  });

  it('leaves the blur and the grade out for bloom alone', () => {
    const stage = real();
    stage.setBloom({ enabled: true });
    stage.setFocus(new THREE.Vector3(0, 1.3, 0), 0.6, new THREE.Group());
    stage.render(scene, camera);

    const { focus, bloom, output } = passes();
    expect(focus.enabled).toBe(false);
    expect(bloom.enabled).toBe(true);
    expect(output.finished.value).toBe(false);
    stage.dispose();
  });

  it('writes alpha 1 for a finish over an opaque stage', () => {
    const stage = real();
    stage.setOpaque(true);
    stage.setFinish(FINISH);
    stage.render(scene, camera);
    expect(passes().output.opaque.value).toBe(true);
    stage.dispose();
  });
});

/** A transcription of three's NeutralToneMapping for one colour. */
function neutral(c: [number, number, number], exposure: number): [number, number, number] {
  const startCompression = 0.8 - 0.04;
  const desaturation = 0.15;
  const v = c.map((x) => x * exposure);
  const x = Math.min(...v);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  const w = v.map((y) => y - offset);
  const peak = Math.max(...w);
  if (peak < startCompression) return w as [number, number, number];
  const d = 1 - startCompression;
  const newPeak = 1 - (d * d) / (peak + d - startCompression);
  const g = 1 - 1 / (desaturation * (peak - newPeak) + 1);
  return w.map((y) => {
    const scaled = (y * newPeak) / peak;
    return scaled + (newPeak - scaled) * g;
  }) as [number, number, number];
}

describe('focus blur over blended avatar meshes', () => {
  /** A blended material the scene pass draws without writing depth. */
  const sheer = (map: THREE.Texture | null = null) =>
    new THREE.MeshToonMaterial({ transparent: true, depthWrite: false, opacity: 0.7, map });

  function staged() {
    const rig = buildRig({ arkit: false });
    const avatar = rig.root;
    const sleeveMap = new THREE.Texture();
    const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), sheer(sleeveMap));
    avatar.add(sleeve);
    // One group blended, one opaque: only the first may be drawn.
    const cuff = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), [
      sheer(),
      new THREE.MeshToonMaterial(),
    ]);
    avatar.add(cuff);
    const unworn = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), sheer());
    unworn.visible = false;
    avatar.add(unworn);
    const hull = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), sheer());
    hull.userData.outline = true;
    sleeve.add(hull);
    const scene = new THREE.Scene();
    scene.add(avatar);
    // A room's see-through finish writes no depth either, and has to keep blurring.
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.01), sheer());
    scene.add(glass);
    scene.updateMatrixWorld(true);
    return { rig, avatar, sleeve, sleeveMap, cuff, unworn, hull, glass };
  }

  /** Records what the avatar depth draw would put on screen, and where. */
  function recorder() {
    let target: THREE.WebGLRenderTarget | null = null;
    const draws: {
      root: THREE.Object3D;
      target: THREE.WebGLRenderTarget | null;
      drawn: Map<THREE.Mesh, THREE.Material | THREE.Material[]>;
    }[] = [];
    const renderer = {
      autoClear: true,
      setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
        target = t;
      },
      clear: vi.fn(),
      render: (root: THREE.Object3D, camera: THREE.Camera) => {
        const drawn = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
        root.traverseVisible((o) => {
          if (o instanceof THREE.Mesh && o.layers.test(camera.layers)) drawn.set(o, o.material);
        });
        draws.push({ root, target, drawn });
      },
    } as unknown as THREE.WebGLRenderer;
    return { renderer, draws };
  }

  function run(avatar: THREE.Object3D) {
    const pass = new FocusBlurPass();
    const camera = new THREE.PerspectiveCamera(28, 16 / 9, 0.1, 50);
    camera.position.set(0, 1.2, 3);
    camera.updateMatrixWorld(true);
    pass.aim(camera, { centre: new THREE.Vector3(0, 1, 0), radius: 0.8, avatar }, FINISH.blur);
    pass.setSize(640, 360);
    const { renderer, draws } = recorder();
    const read = new THREE.WebGLRenderTarget(640, 360);
    read.depthTexture = new THREE.DepthTexture(640, 360);
    pass.render(renderer, new THREE.WebGLRenderTarget(640, 360), read);
    return { pass, draws, renderer };
  }

  it("draws the depth of exactly the avatar's drawn blended meshes, colour off", () => {
    const { avatar, sleeve, sleeveMap, cuff, unworn, hull, glass } = staged();
    const { draws } = run(avatar);
    const depth = draws.find((d) => d.root === avatar);
    if (!depth) throw new Error('no avatar depth draw');

    expect([...depth.drawn.keys()]).toEqual([sleeve, cuff]);
    const sleeveDepth = depth.drawn.get(sleeve) as THREE.MeshDepthMaterial;
    expect(sleeveDepth).toBeInstanceOf(THREE.MeshDepthMaterial);
    expect(sleeveDepth.colorWrite).toBe(false);
    expect(sleeveDepth.depthWrite).toBe(true);
    // Its coverage follows the fabric's, so a cut-away edge stays the background's.
    expect(sleeveDepth.map).toBe(sleeveMap);
    expect(sleeveDepth.opacity).toBe(0.7);
    expect(sleeveDepth.alphaTest).toBeGreaterThan(0);
    const [blended, opaque] = depth.drawn.get(cuff) as THREE.Material[];
    expect(blended).toBeInstanceOf(THREE.MeshDepthMaterial);
    expect(opaque.visible).toBe(false);
    expect(depth.drawn.has(unworn)).toBe(false);
    expect(depth.drawn.has(hull)).toBe(false);
    // The room is not the avatar: its see-through finish keeps reading as the wall.
    expect(draws.some((d) => d.drawn.has(glass))).toBe(false);
  });

  it('reads the drawn depth in both the blur taps and the composite', () => {
    const { avatar } = staged();
    const { pass, draws } = run(avatar);
    const depth = draws.find((d) => d.root === avatar);
    const drawnInto = depth?.target?.depthTexture;
    expect(drawnInto).toBeInstanceOf(THREE.DepthTexture);
    const materials = pass as unknown as {
      blurMaterial: THREE.ShaderMaterial;
      compositeMaterial: THREE.ShaderMaterial;
    };
    for (const material of [materials.blurMaterial, materials.compositeMaterial]) {
      expect(material.uniforms.tAvatarDepth.value).toBe(drawnInto);
      expect(material.fragmentShader).toMatch(
        /min\(texture2D\(tDepth, uv\)\.x, texture2D\(tAvatarDepth, uv\)\.x\)/,
      );
    }
    pass.dispose();
  });

  it("puts the avatar's own materials and layers back after the draw", () => {
    const { avatar, sleeve, cuff } = staged();
    const sleeveMaterial = sleeve.material;
    const cuffMaterials = cuff.material;
    const sleeveLayers = sleeve.layers.mask;
    run(avatar);
    expect(sleeve.material).toBe(sleeveMaterial);
    expect(cuff.material).toBe(cuffMaterials);
    expect(sleeve.layers.mask).toBe(sleeveLayers);
    expect(cuff.layers.mask).toBe(sleeveLayers);
  });

  it('clears the avatar depth even when nothing blended is worn', () => {
    const rig = buildRig({ arkit: false });
    const { draws, renderer } = run(rig.root);
    // A stale depth from the last frame would keep a garment taken off sharp.
    expect(renderer.clear).toHaveBeenCalledWith(false, true, false);
    expect(draws.some((d) => d.root === rig.root)).toBe(false);
  });
});

describe('background compensation', () => {
  const colors = [0x0f1115, 0x131a2a, 0x8e97a0, 0x000000, 0x010203, 0x202020, 0x050a30];

  it('inverts the Neutral tone map for flat and room colours', () => {
    for (const hex of colors) {
      for (const exposure of [1, 1.1, 0.8]) {
        const source = new THREE.Color(hex);
        const out = new THREE.Color();
        expect(neutralInverse(source, exposure, out), hex.toString(16)).toBe(true);
        const back = neutral([out.r, out.g, out.b], exposure);
        expect(back[0]).toBeCloseTo(source.r, 6);
        expect(back[1]).toBeCloseTo(source.g, 6);
        expect(back[2]).toBeCloseTo(source.b, 6);
      }
    }
  });

  it('leaves a background that reaches the shoulder uncompensated', () => {
    expect(neutralInverse(new THREE.Color(0xffffff), 1, new THREE.Color())).toBe(false);
  });

  it('swaps the background for the draw and restores the original object', () => {
    const renderer = {
      toneMapping: THREE.NeutralToneMapping,
      toneMappingExposure: 1.1,
    } as unknown as THREE.WebGLRenderer;
    const scene = new THREE.Scene();
    const flat = new THREE.Color(0x0f1115);
    scene.background = flat;
    let during: THREE.Color | null = null;
    drawWithCompensatedBackground(renderer, scene, () => {
      during = scene.background as THREE.Color;
    });
    expect(scene.background).toBe(flat);
    expect(flat.getHex()).toBe(0x0f1115);
    expect(during).not.toBeNull();
    expect(during).not.toBe(flat);
    expect((during as unknown as THREE.Color).r).toBeGreaterThan(flat.r);
  });

  it('leaves the background alone without Neutral tone mapping or a Color', () => {
    const scene = new THREE.Scene();
    const flat = new THREE.Color(0x0f1115);
    scene.background = flat;
    const seen: unknown[] = [];
    const none = { toneMapping: THREE.NoToneMapping, toneMappingExposure: 1 };
    drawWithCompensatedBackground(none as unknown as THREE.WebGLRenderer, scene, () =>
      seen.push(scene.background),
    );
    scene.background = null;
    const neutralRenderer = { toneMapping: THREE.NeutralToneMapping, toneMappingExposure: 1 };
    drawWithCompensatedBackground(neutralRenderer as unknown as THREE.WebGLRenderer, scene, () =>
      seen.push(scene.background),
    );
    expect(seen).toEqual([flat, null]);
  });
});
