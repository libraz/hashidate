import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { LabelledId } from '@/engine/types';
import type { BuiltBackdrop, Pattern } from './patterns';
import { PATTERNS } from './patterns';
import type { TextureBin } from './textures';

/**
 * Putting the avatar in a room, and taking it out again exactly.
 *
 * ## Why a backdrop owns the lighting
 *
 * The viewer's own three lights are tuned for a character floating in front of
 * a flat colour, and they are correct for that. They are also wrong for every
 * room here, because a room decides where its light comes from — that is what a
 * room *is*, as far as a render is concerned. So a backdrop does not add light
 * to the existing rig, it replaces it: the default lights are hidden while one
 * is mounted and shown again when it is cleared.
 *
 * Hidden rather than removed, and this is the point of the class. The tuned
 * values are not read, not scaled and not copied anywhere — `visible` is
 * toggled and nothing else, so clearing a backdrop cannot drift them. Anything
 * else would eventually mean someone reconciling two sets of numbers.
 *
 * ## What else it has to put back
 *
 * Tone mapping, exposure, fog, the environment map and the scene background are
 * all renderer- or scene-wide, all changed here, and all captured on the way in
 * and restored on the way out. Missing one is not a visual bug in the room; it
 * is a visual bug in the *next* thing rendered, which is much harder to trace.
 *
 * ## Shadows
 *
 * Left on permanently. With no backdrop mounted nothing declares itself a
 * receiver, so the shadow pass has nothing to draw and costs a state change —
 * whereas toggling `shadowMap.enabled` invalidates every compiled program in
 * the scene, which is a visible hitch at exactly the moment the operator is
 * looking at the render.
 */

/** A mounted backdrop, and everything needed to take it apart. */
interface Mounted {
  pattern: Pattern;
  built: BuiltBackdrop;
  textures: TextureBin;
}

/** What the renderer and scene looked like before any of this touched them. */
interface Baseline {
  toneMapping: THREE.ToneMapping;
  exposure: number;
  background: THREE.Scene['background'];
  environment: THREE.Scene['environment'];
  environmentIntensity: number;
  fog: THREE.Scene['fog'];
}

export const backdropList = (): LabelledId[] => PATTERNS.map((p) => ({ id: p.id, label: p.label }));

/** The note shown under the picker, or null for an id that is not one of ours. */
export const backdropNote = (id: string): string | null =>
  PATTERNS.find((p) => p.id === id)?.note ?? null;

export class BackdropStage {
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  /** The viewer's own rig, hidden while a backdrop is up. */
  private readonly defaultLights: THREE.Object3D[];
  private readonly baseline: Baseline;

  private mounted: Mounted | null = null;
  /**
   * Built once and shared by every pattern.
   *
   * This is not the room's lighting — the patterns provide that. It is the
   * faint everything-else that a `MeshStandardMaterial` needs before its
   * specular term means anything: without it, glass is a black pane and a
   * varnished desk is a matte one, because a reflection with nothing to reflect
   * returns nothing. Each pattern scales it down to almost nothing via
   * `environmentIntensity`; what matters is that it is not zero.
   *
   * `MeshToonMaterial` ignores environment maps entirely, so the avatar is
   * untouched by this — which is the reason it can be left on the scene rather
   * than assigned per material.
   */
  private environment: THREE.Texture | null = null;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, defaultLights: THREE.Object3D[]) {
    this.scene = scene;
    this.renderer = renderer;
    this.defaultLights = defaultLights;
    this.baseline = {
      toneMapping: renderer.toneMapping,
      exposure: renderer.toneMappingExposure,
      background: scene.background,
      environment: scene.environment,
      environmentIntensity: scene.environmentIntensity,
      fog: scene.fog,
    };
    renderer.shadowMap.enabled = true;
    // `PCFShadowMap`, not `PCFSoftShadowMap`, which three deprecated in 0.185 —
    // it silently falls back to this one and warns. Worth having rather than
    // worth silencing: the soft variant used a fixed kernel and ignored
    // `LightShadow.radius`, so with this one every light can choose how soft its
    // own shadow is. An overcast morning and a bare bulb do not blur alike.
    renderer.shadowMap.type = THREE.PCFShadowMap;
  }

  get current(): string | null {
    return this.mounted?.pattern.id ?? null;
  }

  /**
   * The `Scenery` the engine is handed.
   *
   * A getter over the module's own table rather than a stored copy: the list is
   * the patterns that exist, and a second copy of it is a second thing to keep
   * in step for no benefit — nothing here is hot enough for the allocation to
   * matter, since it is read when an orchestrator asks for the vocabulary.
   */
  get backdrops(): LabelledId[] {
    return backdropList();
  }

  /** Mount a pattern by id, or pass null for the plain background. */
  setBackdrop(id: string | null): void {
    if (id === this.current) return;
    this.clear();
    if (id === null) return;

    const pattern = PATTERNS.find((p) => p.id === id);
    if (!pattern) return;

    const textures: TextureBin = [];
    const built = pattern.build(textures);

    for (const light of this.defaultLights) light.visible = false;
    this.scene.add(built.root);
    this.scene.fog = built.fog;
    this.scene.environment = this.ensureEnvironment();
    this.scene.environmentIntensity = built.environmentIntensity;
    // The room encloses the camera at every framing the viewer offers, so the
    // clear colour is never seen. It is set to the fog colour anyway, because
    // "never" here means "until somebody drags the orbit control past a wall".
    this.scene.background = new THREE.Color(built.fog ? built.fog.color : 0x0f1115);
    this.renderer.toneMapping = built.toneMapping;
    this.renderer.toneMappingExposure = built.exposure;

    this.mounted = { pattern, built, textures };
  }

  update(dt: number): void {
    this.mounted?.built.update?.(dt);
  }

  /** Take the room down and put the scene back exactly as it was found. */
  clear(): void {
    const mounted = this.mounted;
    if (!mounted) return;
    this.mounted = null;

    this.scene.remove(mounted.built.root);
    release(mounted.built.root);
    for (const texture of mounted.textures) texture.dispose();

    this.scene.fog = this.baseline.fog;
    this.scene.background = this.baseline.background;
    this.scene.environment = this.baseline.environment;
    this.scene.environmentIntensity = this.baseline.environmentIntensity;
    this.renderer.toneMapping = this.baseline.toneMapping;
    this.renderer.toneMappingExposure = this.baseline.exposure;
    for (const light of this.defaultLights) light.visible = true;
  }

  dispose(): void {
    this.clear();
    this.environment?.dispose();
    this.environment = null;
  }

  private ensureEnvironment(): THREE.Texture | null {
    if (this.environment) return this.environment;
    // `document` is the guard rather than a try/catch: this is reached only
    // from a browser, but the module is imported by tests that never mount.
    if (typeof document === 'undefined') return null;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    return this.environment;
  }
}

/**
 * Release every GPU resource under an object, by walking it.
 *
 * By walking rather than from a list built during construction, for the same
 * reason the material layer does it: a list is a second thing to keep in step
 * with the builders, and the one part somebody forgets to register is a leak
 * that nothing reports and that only shows up as a texture count climbing
 * across a long session of switching rooms.
 */
function release(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse((o) => {
    if (o instanceof THREE.Light) {
      // Disposes the shadow map, which is two megabytes per shadow-casting
      // light and is not reachable any other way.
      o.dispose();
      return;
    }
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry?.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m) materials.add(m);
    }
  });
  // Textures are disposed by the caller from the bin, because several materials
  // share one and a per-material sweep would dispose it more than once.
  for (const m of materials) m.dispose();
}
