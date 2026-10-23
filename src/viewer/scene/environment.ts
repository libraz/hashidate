import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { KEY_FROM, RIM_FROM } from './rig';

/** A scene a reflection map is rendered from, released once the map exists. */
type EnvironmentScene = THREE.Scene & { dispose(): void };

/** An emissive-only panel material, as three's own room uses, so no light is needed. */
const panel = (intensity: number): THREE.MeshLambertMaterial =>
  new THREE.MeshLambertMaterial({
    color: 0x000000,
    emissive: 0xffffff,
    emissiveIntensity: intensity,
  });

/**
 * What an avatar's preserved metal reflects: a dark room with three softboxes.
 *
 * Metal reads as metal by what it mirrors changing as it turns. Three's studio
 * room is bright from every side, so a reflective metal mirrored a near-even
 * white and stayed one flat tone whatever the body did — a plastic pendant at
 * the size a slide leaves the character. Dark between the panels is what lets a
 * breath or a gesture swing the reflection across an edge. The key sits on the
 * default rig's key direction so the glint agrees with the shading.
 */
export class MetalEnvironment extends THREE.Scene {
  constructor() {
    super();
    this.name = 'MetalEnvironment';
    const box = new THREE.BoxGeometry();
    box.deleteAttribute('uv');
    const room = new THREE.Mesh(
      box,
      new THREE.MeshLambertMaterial({
        side: THREE.BackSide,
        color: 0x000000,
        emissive: 0xffffff,
        emissiveIntensity: 0.06,
      }),
    );
    room.scale.setScalar(30);
    this.add(room);
    const softbox = (intensity: number, at: THREE.Vector3, w: number, h: number): void => {
      const mesh = new THREE.Mesh(box, panel(intensity));
      mesh.position.copy(at);
      mesh.scale.set(w, h, 0.1);
      mesh.lookAt(0, 0, 0);
      this.add(mesh);
    };
    softbox(12, KEY_FROM.clone().setLength(10), 4, 5);
    softbox(5, RIM_FROM.clone().setLength(10), 1, 7);
    softbox(3, new THREE.Vector3(0, 10, 1), 3, 3);
  }

  override dispose(): void {
    const resources = new Set<{ dispose(): void }>();
    this.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      resources.add(object.geometry);
      resources.add(object.material as THREE.Material);
    });
    for (const resource of resources) resource.dispose();
  }
}

/**
 * A reflection map the viewer builds once and lends out.
 *
 * Two exist: three's studio room, which a room puts on its scene at a low
 * intensity, and {@link MetalEnvironment}, which an avatar descriptor gives a
 * preserved metal as its own fixed reflection. Built on first use and released
 * only with the runtime: materials and rooms borrow it.
 */
export class StudioEnvironment {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly build: () => EnvironmentScene;
  // PMREM's texture is attached to this target, which also owns its framebuffer
  // and depth buffer. Keep the target until the shared environment is released.
  private target: THREE.WebGLRenderTarget | null = null;

  constructor(
    renderer: THREE.WebGLRenderer,
    build: () => EnvironmentScene = () => new RoomEnvironment(),
  ) {
    this.renderer = renderer;
    this.build = build;
  }

  get texture(): THREE.Texture | null {
    if (this.target) return this.target.texture;
    // `document` is the guard rather than a try/catch: this is reached only
    // from a browser, but the module is imported by tests that never mount.
    if (typeof document === 'undefined') return null;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = this.build();
    try {
      this.target = pmrem.fromScene(room, 0.04);
      return this.target.texture;
    } finally {
      room.dispose();
      pmrem.dispose();
    }
  }

  /**
   * Forget the map after its WebGL context was lost, returning it so borrowers
   * can be moved to the rebuilt one. Its GPU memory went with the context.
   */
  invalidate(): THREE.Texture | null {
    const lost = this.target?.texture ?? null;
    this.target = null;
    return lost;
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
  }
}

/** Point every material under `root` that borrowed `from` at `to` instead. */
export function rebindEnvironment(
  root: THREE.Object3D,
  from: THREE.Texture,
  to: THREE.Texture | null,
): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material instanceof THREE.MeshStandardMaterial && material.envMap === from) {
        material.envMap = to;
      }
    }
  });
}
