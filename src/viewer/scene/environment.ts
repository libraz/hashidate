import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * The one studio reflection map the viewer builds, shared by rooms and avatar metals.
 *
 * A room puts it on the scene at a low intensity; an avatar descriptor can
 * give a preserved metal its own fixed reflection from the same map, so the
 * metal reads as metal on the default flat background too. Built on first use
 * and released only with the runtime: materials and rooms borrow it.
 */
export class StudioEnvironment {
  private readonly renderer: THREE.WebGLRenderer;
  private map: THREE.Texture | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
  }

  get texture(): THREE.Texture | null {
    if (this.map) return this.map;
    // `document` is the guard rather than a try/catch: this is reached only
    // from a browser, but the module is imported by tests that never mount.
    if (typeof document === 'undefined') return null;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.map = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    return this.map;
  }

  dispose(): void {
    this.map?.dispose();
    this.map = null;
  }
}
