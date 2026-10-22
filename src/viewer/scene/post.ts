import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { BloomPatch, BloomSettings } from '@/engine/types';
import { BLOOM_DEFAULTS, BLOOM_RANGES } from '@/engine/types';
import type { Finish } from './backdrop/patterns';

/** The sphere the background blur keeps sharp: the avatar, in world space. */
export interface Focus {
  centre: THREE.Vector3;
  radius: number;
}

/** The renderer resources owned by one active postprocess configuration. */
export interface PostPipeline {
  /** The target the scene is drawn into, for compiling against the right program keys. */
  readonly target?: THREE.WebGLRenderTarget;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  resize(width: number, height: number): void;
  setSettings(settings: BloomSettings): void;
  /** Whether the stage behind the scene is opaque. See {@link PostStage.setOpaque}. */
  setOpaque(opaque: boolean): void;
  /** The room's finish, or null for bloom alone. See {@link PostStage.setFinish}. */
  setFinish(finish: Finish | null): void;
  /** The focus for the next frame, or null when there is no avatar to keep sharp. */
  setFocus(focus: Focus | null): void;
  dispose(): void;
}

/** A narrow construction seam so lifecycle tests do not need a WebGL context. */
export type PostPipelineFactory = (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  settings: BloomSettings,
  size: { width: number; height: number },
  multisample: boolean,
) => PostPipeline;

/** Construction options for {@link PostStage}. */
export interface PostStageOptions {
  /** Multisample the scene target. Off for the panel preview, which is a monitor. */
  multisample?: boolean;
}

/**
 * Applies optional postprocessing to the WebGL canvas: bloom, and the finish a
 * room declares — background blur, grade and vignette.
 *
 * The composer and its render targets do not exist until the first frame on
 * which either is active. With both off, `render` calls the renderer's
 * ordinary path directly, preserving its output and cost.
 *
 * It is also where the canvas alpha is decided. Alpha-to-coverage cutouts are
 * opaque draws that store their fractional edge alpha in every sample they
 * cover, and WebGL has no sample-alpha-to-one to stop them, so the alpha the
 * scene leaves is not coverage. Over an opaque stage the colour is already
 * the finished composite and the output writes alpha 1.
 */
export class PostStage {
  private settings: BloomSettings = { ...BLOOM_DEFAULTS };
  private finish: Finish | null = null;
  /** Set by `setFocus` and spent by the next `render`, so a frame without it has no blur. */
  private readonly focus: Focus = { centre: new THREE.Vector3(), radius: 0 };
  private focused = false;
  private pipeline: PostPipeline | null = null;
  private width: number;
  private height: number;
  private disposed = false;
  private opaque = false;
  private readonly multisample: boolean;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly createPipeline: PostPipelineFactory = createPostPipeline,
    { multisample = true }: PostStageOptions = {},
  ) {
    this.multisample = multisample;
    const size = renderer.getSize(new THREE.Vector2());
    this.width = size.x;
    this.height = size.y;
  }

  /** Resize in CSS pixels; the composer applies the renderer's pixel ratio. */
  resize(width: number, height: number): void {
    if (this.disposed || width <= 0 || height <= 0) return;
    this.width = width;
    this.height = height;
    this.pipeline?.resize(width, height);
  }

  /** Merge and bound a settings patch, releasing GPU resources when inactive. */
  setBloom(patch: BloomPatch): void {
    if (this.disposed) return;

    const next: BloomSettings = {
      enabled: patch.enabled ?? this.settings.enabled,
      strength: bounded(patch.strength ?? this.settings.strength, BLOOM_RANGES.strength),
      radius: bounded(patch.radius ?? this.settings.radius, BLOOM_RANGES.radius),
      threshold: bounded(patch.threshold ?? this.settings.threshold, BLOOM_RANGES.threshold),
    };
    this.settings = next;

    if (!this.active()) {
      this.releasePipeline();
      return;
    }

    this.pipeline?.setSettings({ ...next });
  }

  /**
   * The finish of the room on stage, or null when no room is shown. Only a
   * room is ever finished: without one the stage is flat, keyed or a document,
   * and compositing it is somebody else's job.
   */
  setFinish(finish: Finish | null): void {
    if (this.disposed) return;
    this.finish = finish;
    if (!this.active()) {
      this.releasePipeline();
      return;
    }
    this.pipeline?.setFinish(finish);
  }

  /** Where the avatar is for the next frame. Called every frame there is one. */
  setFocus(centreWorld: THREE.Vector3, radius: number): void {
    if (this.disposed) return;
    this.focus.centre.copy(centreWorld);
    this.focus.radius = radius;
    this.focused = true;
  }

  /**
   * Whether a room or a flat colour fills the stage, so the output is opaque.
   * False while a document or a keyed source shows through the canvas, where
   * the scene's own premultiplied alpha is passed on.
   */
  setOpaque(opaque: boolean): void {
    if (this.disposed) return;
    this.opaque = opaque;
    this.pipeline?.setOpaque(opaque);
  }

  /** Where the scene is drawn while the composer runs, or null when it goes to the canvas. */
  get target(): THREE.WebGLRenderTarget | null {
    return this.pipeline?.target ?? null;
  }

  /** The complete settings used by the runtime and its control surfaces. */
  report(): BloomSettings {
    return { ...this.settings };
  }

  /** Render through the composer only while an effect can contribute. */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.disposed) return;
    const focused = this.focused;
    this.focused = false;
    if (!this.active()) {
      this.renderer.render(scene, camera);
      if (this.opaque) fillAlpha(this.renderer);
      return;
    }

    if (!this.pipeline) {
      this.pipeline = this.createPipeline(
        this.renderer,
        scene,
        camera,
        { ...this.settings },
        { width: this.width, height: this.height },
        this.multisample,
      );
      this.pipeline.setOpaque(this.opaque);
      this.pipeline.setFinish(this.finish);
    }
    this.pipeline.setFocus(focused ? this.focus : null);
    this.pipeline.render(scene, camera);
  }

  /** Release all postprocessing resources before the WebGL renderer is torn down. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releasePipeline();
  }

  private active(): boolean {
    return blooming(this.settings) || this.finish !== null;
  }

  private releasePipeline(): void {
    this.pipeline?.dispose();
    this.pipeline = null;
  }
}

/** Set every sample's alpha in the bound framebuffer to 1, leaving colour alone. */
function fillAlpha(renderer: THREE.WebGLRenderer): void {
  const gl = renderer.getContext();
  gl.colorMask(false, false, false, true);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.colorMask(true, true, true, true);
  // Both calls went around three's state cache; make it re-issue its own.
  renderer.state.buffers.color.reset();
}

// Neutral tone mapping's StartCompression: below it the curve is only the toe offset.
const NEUTRAL_SHOULDER = 0.8 - 0.04;

const compensated = new THREE.Color();
let cacheKey: [number, number, number, number] | null = null;
let cacheValid = false;

/**
 * Writes into `out` the linear colour that three's Neutral tone map turns back
 * into `source` at `exposure`, and returns whether one exists. A target whose
 * peak reaches the shoulder is refused rather than approximated.
 */
export function neutralInverse(source: THREE.Color, exposure: number, out: THREE.Color): boolean {
  const peak = Math.max(source.r, source.g, source.b);
  if (!(exposure > 0) || peak >= NEUTRAL_SHOULDER) return false;
  const low = Math.min(source.r, source.g, source.b);
  // The toe maps a minimum m below 0.08 to 6.25 m^2, so the offset it removed is m - low.
  const offset = low < 0.04 ? 0.4 * Math.sqrt(Math.max(low, 0)) - low : 0.04;
  out.setRGB(
    (source.r + offset) / exposure,
    (source.g + offset) / exposure,
    (source.b + offset) / exposure,
  );
  return true;
}

/**
 * Draws with a flat background pre-compensated for the output pass's tone map.
 * Without bloom three writes a Color background as an untouched clear; here the
 * output pass would tone map it, so it is replaced for the draw and restored.
 */
export function drawWithCompensatedBackground(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  draw: () => void,
): void {
  const original = scene.background;
  if (!(original instanceof THREE.Color) || renderer.toneMapping !== THREE.NeutralToneMapping) {
    draw();
    return;
  }
  const exposure = renderer.toneMappingExposure;
  const key = cacheKey;
  if (
    !key ||
    key[0] !== original.r ||
    key[1] !== original.g ||
    key[2] !== original.b ||
    key[3] !== exposure
  ) {
    cacheKey = [original.r, original.g, original.b, exposure];
    cacheValid = neutralInverse(original, exposure, compensated);
  }
  if (!cacheValid) {
    draw();
    return;
  }
  scene.background = compensated;
  try {
    draw();
  } finally {
    scene.background = original;
  }
}

function bounded(value: number, range: { min: number; max: number }): number {
  if (!Number.isFinite(value)) return range.min;
  return Math.min(range.max, Math.max(range.min, value));
}

const blooming = (settings: BloomSettings): boolean => settings.enabled && settings.strength !== 0;

const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** How far behind the focus a pixel is, as 0 (sharp) to 1 (fully blurred). */
const COC = /* glsl */ `
  #include <packing>
  uniform sampler2D tDepth;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform float focusFar;
  uniform float ramp;

  float coc(vec2 uv) {
    float viewZ = perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
    return smoothstep(focusFar, focusFar + ramp, -viewZ);
  }
`;

/**
 * Blurs what lies behind the avatar's bounding sphere, by depth.
 *
 * A separable 13-tap gaussian at half resolution, each tap weighted by its own
 * circle of confusion, so the sharp foreground never bleeds into the blurred
 * background around it — including through the gaps in the hair. Reads the
 * depth the scene left in `readBuffer.depthTexture`.
 */
export class FocusBlurPass extends Pass {
  private readonly depth = {
    tDepth: { value: null as THREE.Texture | null },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 100 },
    focusFar: { value: 0 },
    ramp: { value: 1 },
  };
  private readonly blurMaterial = new THREE.ShaderMaterial({
    uniforms: {
      ...this.depth,
      tColor: { value: null },
      stride: { value: new THREE.Vector2() },
    },
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: /* glsl */ `
      ${COC}
      uniform sampler2D tColor;
      uniform vec2 stride;
      varying vec2 vUv;

      void main() {
        vec4 sum = vec4(0.0);
        float total = 0.0;
        for (int i = -6; i <= 6; i++) {
          float x = float(i);
          vec2 uv = vUv + stride * x;
          // Sigma is half the radius and a tap is a sixth of it: three taps.
          float w = exp(-x * x / 18.0) * coc(uv);
          sum += texture2D(tColor, uv) * w;
          total += w;
        }
        gl_FragColor = total < 1e-4 ? texture2D(tColor, vUv) : sum / total;
      }
    `,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  private readonly compositeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      ...this.depth,
      tSharp: { value: null },
      tBlur: { value: null },
    },
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: /* glsl */ `
      ${COC}
      uniform sampler2D tSharp;
      uniform sampler2D tBlur;
      varying vec2 vUv;

      void main() {
        gl_FragColor = mix(texture2D(tSharp, vUv), texture2D(tBlur, vUv), coc(vUv));
      }
    `,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  private readonly quad = new FullScreenQuad(this.blurMaterial);
  /** Half resolution, blurred across, then down. */
  private readonly across = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  private readonly down = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  private readonly eye = new THREE.Vector3();
  /** The room's blur radius, in pixels of a 1080-line frame. */
  private radius = 0;

  /** Point the blur at a focus for the coming frame. */
  aim(camera: THREE.PerspectiveCamera, focus: Focus, blur: Finish['blur']): void {
    const eye = camera.getWorldPosition(this.eye);
    this.depth.cameraNear.value = camera.near;
    this.depth.cameraFar.value = camera.far;
    this.depth.focusFar.value = eye.distanceTo(focus.centre) + 0.5 * focus.radius;
    this.depth.ramp.value = blur.ramp;
    this.radius = blur.radius;
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width / 2));
    const h = Math.max(1, Math.round(height / 2));
    this.across.setSize(w, h);
    this.down.setSize(w, h);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.depth.tDepth.value = readBuffer.depthTexture;
    // Half-resolution pixels, so the blur reads the same at any output size.
    const tap = (this.radius * readBuffer.height) / 1080 / 2 / 6;
    const blur = this.blurMaterial.uniforms;

    this.quad.material = this.blurMaterial;
    blur.tColor.value = readBuffer.texture;
    blur.stride.value.set(tap / this.across.width, 0);
    renderer.setRenderTarget(this.across);
    this.quad.render(renderer);

    blur.tColor.value = this.across.texture;
    blur.stride.value.set(0, tap / this.down.height);
    renderer.setRenderTarget(this.down);
    this.quad.render(renderer);

    this.quad.material = this.compositeMaterial;
    this.compositeMaterial.uniforms.tSharp.value = readBuffer.texture;
    this.compositeMaterial.uniforms.tBlur.value = this.down.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.blurMaterial.dispose();
    this.compositeMaterial.dispose();
    this.quad.dispose();
    this.across.dispose();
    this.down.dispose();
  }
}

function createPostPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  settings: BloomSettings,
  size: { width: number; height: number },
  multisample: boolean,
): PostPipeline {
  const samples = multisample ? Math.min(4, renderer.capabilities.maxSamples) : 0;
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    samples,
  });
  target.texture.name = 'PostStage.rt1';
  // Before the composer, which clones this target for its read buffer: the
  // clone then carries a depth texture of its own for the focus blur to read.
  target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);

  const composer = new EffectComposer(renderer, target);
  const renderPass = new RenderPass(scene, camera);
  const focusPass = new FocusBlurPass();
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(
      size.width * renderer.getPixelRatio(),
      size.height * renderer.getPixelRatio(),
    ),
    settings.strength,
    settings.radius,
    settings.threshold,
  );
  bloomPass.enabled = blooming(settings);
  const outputPass = new ShaderPass(
    new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        opaque: { value: false },
        finished: { value: false },
        gain: { value: new THREE.Vector3(1, 1, 1) },
        saturation: { value: 1 },
        contrast: { value: 1 },
        vignette: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;

        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform bool opaque;
        uniform bool finished;
        uniform vec3 gain;
        uniform float saturation;
        uniform float contrast;
        uniform float vignette;
        varying vec2 vUv;

        void main() {
          vec4 color = texture2D(tDiffuse, vUv);
          // Over an opaque stage the colour is already composited and the alpha
          // is cutout edge residue, so it is neither divided out nor kept.
          float alpha = opaque ? 1.0 : clamp(color.a, 0.0, 1.0);
          vec3 rgb = opaque ? color.rgb : alpha > 0.0 ? color.rgb / alpha : vec3(0.0);
          gl_FragColor = vec4(rgb, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          // The room's grade, on display-referred values. Skipped rather than
          // run with neutral numbers, so an unfinished frame is bit-identical.
          if (finished) {
            vec3 graded = gl_FragColor.rgb * gain;
            graded = mix(vec3(dot(graded, vec3(0.2126, 0.7152, 0.0722))), graded, saturation);
            graded = (graded - 0.5) * contrast + 0.5;
            float r = length((vUv - 0.5) * 2.0) / sqrt(2.0);
            gl_FragColor.rgb = graded * (1.0 - vignette * smoothstep(0.35, 0.95, r));
          }
          // The canvas stores normalized channels. Clip straight output before
          // premultiplying so HDR edge colors cannot exceed their coverage.
          gl_FragColor.rgb = clamp(gl_FragColor.rgb, 0.0, 1.0) * alpha;
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: true,
    }),
  );

  composer.addPass(renderPass);
  composer.addPass(focusPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);
  // EffectComposer's custom-target constructor starts with a one-pixel logical
  // size; setSize converts the current CSS size to physical pixels.
  composer.setSize(size.width, size.height);
  let pixelRatio = renderer.getPixelRatio();
  let finish: Finish | null = null;
  let focus: Focus | null = null;
  const draw = () => composer.render();

  return {
    target,
    render(nextScene, nextCamera) {
      // Keep the pass current if its caller changes the scene or camera.
      renderPass.scene = nextScene;
      renderPass.camera = nextCamera;
      // No blur without a room, an avatar to keep sharp, and a depth to read.
      const lens = nextCamera instanceof THREE.PerspectiveCamera ? nextCamera : null;
      focusPass.enabled = finish !== null && focus !== null && lens !== null;
      if (finish && focus && lens) focusPass.aim(lens, focus, finish.blur);
      drawWithCompensatedBackground(renderer, nextScene, draw);
    },
    resize(width, height) {
      // The composer keeps the ratio it was built with; a window moved to
      // another display changes the renderer's.
      const ratio = renderer.getPixelRatio();
      if (ratio !== pixelRatio) {
        pixelRatio = ratio;
        composer.setPixelRatio(ratio);
      }
      composer.setSize(width, height);
    },
    setSettings(next) {
      bloomPass.enabled = blooming(next);
      bloomPass.strength = next.strength;
      bloomPass.radius = next.radius;
      bloomPass.threshold = next.threshold;
    },
    setOpaque(opaque) {
      outputPass.uniforms.opaque.value = opaque;
    },
    setFinish(next) {
      finish = next;
      const u = outputPass.uniforms;
      u.finished.value = next !== null;
      if (!next) return;
      u.gain.value.fromArray(next.grade.gain);
      u.saturation.value = next.grade.saturation;
      u.contrast.value = next.grade.contrast;
      u.vignette.value = next.vignette;
    },
    setFocus(next) {
      focus = next;
    },
    dispose() {
      // UnrealBloomPass 0.186 leaves this one shader material out of its own
      // dispose method; release it explicitly with the rest of the pass.
      bloomPass.materialHighPassFilter.dispose();
      bloomPass.dispose();
      focusPass.dispose();
      outputPass.dispose();
      composer.dispose();
    },
  };
}
