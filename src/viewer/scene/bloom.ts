import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { BloomPatch, BloomSettings } from '@/engine/types';
import { BLOOM_DEFAULTS, BLOOM_RANGES } from '@/engine/types';

/** The renderer resources owned by one active bloom configuration. */
export interface BloomPipeline {
  /** The target the scene is drawn into, for compiling against the right program keys. */
  readonly target?: THREE.WebGLRenderTarget;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  resize(width: number, height: number): void;
  setSettings(settings: BloomSettings): void;
  /** Whether the stage behind the scene is opaque. See {@link BloomStage.setOpaque}. */
  setOpaque(opaque: boolean): void;
  dispose(): void;
}

/** A narrow construction seam so lifecycle tests do not need a WebGL context. */
export type BloomPipelineFactory = (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  settings: BloomSettings,
  size: { width: number; height: number },
  multisample: boolean,
) => BloomPipeline;

/** Construction options for {@link BloomStage}. */
export interface BloomStageOptions {
  /** Multisample the scene target. Off for the panel preview, which is a monitor. */
  multisample?: boolean;
}

/**
 * Applies an optional bloom pass to the WebGL canvas.
 *
 * The composer and its render targets do not exist until the first enabled,
 * nonzero-strength frame. With bloom off, `render` calls the renderer's
 * ordinary path directly, preserving its output and cost.
 *
 * It is also where the canvas alpha is decided. Alpha-to-coverage cutouts are
 * opaque draws that store their fractional edge alpha in every sample they
 * cover, and WebGL has no sample-alpha-to-one to stop them, so the alpha the
 * scene leaves is not coverage. Over an opaque stage the colour is already
 * the finished composite and the output writes alpha 1.
 */
export class BloomStage {
  private settings: BloomSettings = { ...BLOOM_DEFAULTS };
  private pipeline: BloomPipeline | null = null;
  private width: number;
  private height: number;
  private disposed = false;
  private opaque = false;
  private readonly multisample: boolean;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly createPipeline: BloomPipelineFactory = createBloomPipeline,
    { multisample = true }: BloomStageOptions = {},
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

    if (!next.enabled || next.strength === 0) {
      this.releasePipeline();
      return;
    }

    this.pipeline?.setSettings({ ...next });
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

  /** Where the scene is drawn while bloom is on, or null when it goes to the canvas. */
  get target(): THREE.WebGLRenderTarget | null {
    return this.pipeline?.target ?? null;
  }

  /** The complete settings used by the runtime and its control surfaces. */
  report(): BloomSettings {
    return { ...this.settings };
  }

  /** Render through the composer only while the effect can contribute. */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.disposed) return;
    if (!this.settings.enabled || this.settings.strength === 0) {
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
    }
    this.pipeline.render(scene, camera);
  }

  /** Release all postprocessing resources before the WebGL renderer is torn down. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releasePipeline();
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

function bounded(value: number, range: { min: number; max: number }): number {
  if (!Number.isFinite(value)) return range.min;
  return Math.min(range.max, Math.max(range.min, value));
}

function createBloomPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  settings: BloomSettings,
  size: { width: number; height: number },
  multisample: boolean,
): BloomPipeline {
  const samples = multisample ? Math.min(4, renderer.capabilities.maxSamples) : 0;
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    samples,
  });
  target.texture.name = 'BloomStage.rt1';

  const composer = new EffectComposer(renderer, target);
  const renderPass = new RenderPass(scene, camera);
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(
      size.width * renderer.getPixelRatio(),
      size.height * renderer.getPixelRatio(),
    ),
    settings.strength,
    settings.radius,
    settings.threshold,
  );
  const outputPass = new ShaderPass(
    new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, opaque: { value: false } },
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
  composer.addPass(bloomPass);
  composer.addPass(outputPass);
  // EffectComposer's custom-target constructor starts with a one-pixel logical
  // size; setSize converts the current CSS size to physical pixels.
  composer.setSize(size.width, size.height);
  let pixelRatio = renderer.getPixelRatio();

  return {
    target,
    render(nextScene, nextCamera) {
      // Keep the pass current if its caller changes the scene or camera.
      renderPass.scene = nextScene;
      renderPass.camera = nextCamera;
      composer.render();
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
      bloomPass.strength = next.strength;
      bloomPass.radius = next.radius;
      bloomPass.threshold = next.threshold;
    },
    setOpaque(opaque) {
      outputPass.uniforms.opaque.value = opaque;
    },
    dispose() {
      // UnrealBloomPass 0.186 leaves this one shader material out of its own
      // dispose method; release it explicitly with the rest of the pass.
      bloomPass.materialHighPassFilter.dispose();
      bloomPass.dispose();
      outputPass.dispose();
      composer.dispose();
    },
  };
}
