import * as THREE from 'three';

/**
 * The default rig: the light the avatar stands in when no room is up, which is
 * every slide presentation.
 *
 * Toon materials blow out easily; these levels are tuned for MeshToonMaterial.
 * Held in a group so a backdrop can hide the whole rig with one flag. A room
 * brings its own light — that is most of what distinguishes one room from
 * another — and the alternative to switching this off is scaling it, which
 * would mean these numbers being read and multiplied somewhere else.
 *
 * The key casts, and only onto the avatar: nothing else is in the scene. Its
 * shadow camera follows the avatar rather than covering a room, so a fringe on
 * a forehead is a few texels wide instead of under one.
 */

/** Where the key comes from: front right, above. The metal studio lights from here too. */
export const KEY_FROM = new THREE.Vector3(1, 1.6, 2.5);
/** Where the rim comes from: behind left. */
export const RIM_FROM = new THREE.Vector3(-1.6, 0.8, -2);

/** Margin around the avatar's sphere, so a hand flung out keeps its shadow. */
const SHADOW_MARGIN = 1.15;

export class DefaultRig extends THREE.Group {
  readonly key = new THREE.DirectionalLight(0xffffff, 1.05);
  private readonly direction = KEY_FROM.clone().normalize();

  constructor() {
    super();
    this.add(new THREE.HemisphereLight(0xffffff, 0x4a5160, 0.85));
    this.key.position.copy(KEY_FROM);
    // In the rig, so the target's world matrix is updated with the scene's.
    this.add(this.key, this.key.target);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    // Fitted to one figure the map is about a millimetre a texel, and at this
    // offset skin and hair showed no acne in close-up on either avatar.
    this.key.shadow.normalBias = 0.004;
    this.key.shadow.bias = -0.0002;
    this.key.shadow.radius = 2;
    const rim = new THREE.DirectionalLight(0xbcd2ff, 0.35);
    rim.position.copy(RIM_FROM);
    this.add(rim);
  }

  /** Fit the key's shadow camera to a world-space sphere, keeping its direction. */
  fitShadow(centre: THREE.Vector3, radius: number): void {
    const r = radius * SHADOW_MARGIN;
    this.key.target.position.copy(centre);
    this.key.position.copy(centre).addScaledVector(this.direction, 2 * r);
    const cam = this.key.shadow.camera;
    if (cam.right === r) return;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = r * 0.5;
    cam.far = r * 3.5;
    cam.updateProjectionMatrix();
  }
}
