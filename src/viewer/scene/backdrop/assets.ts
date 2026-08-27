import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// These URLs are source imports rather than paths under `public/`: Vite then
// serves them even when the development server was already running before a
// model was added, and fingerprints them in production builds.
const BED_URL = new URL('./assets/gothic-bed.glb', import.meta.url).href;
const COMMODE_URL = new URL('./assets/gothic-commode.glb', import.meta.url).href;
const SOFA_URL = new URL('./assets/sofa.glb', import.meta.url).href;
const PILLOWS_URL = new URL('./assets/pillows.glb', import.meta.url).href;

interface FurnitureSpec {
  url: string;
  position: readonly [number, number, number];
  rotationY: number;
  scale?: number;
  color: number;
  roughness: number;
}

const FURNITURE: readonly FurnitureSpec[] = [
  {
    url: BED_URL,
    position: [-1.48, 0, -1.42],
    rotationY: Math.PI / 2,
    color: 0xf9f3f1,
    roughness: 0.62,
  },
  {
    url: COMMODE_URL,
    // The source is a 1.21 m high commode, too tall beside the avatar.  At
    // 62% it becomes a 75 cm chest; its scaled 0.36 m depth and 0.74 m width
    // still meet both walls with a 10 mm shadow reveal.
    position: [2.22, 0, -2.21],
    rotationY: 0,
    scale: 0.62,
    color: 0xfaf8f4,
    roughness: 0.48,
  },
  {
    url: SOFA_URL,
    position: [-2.18, 0, 0.25],
    rotationY: Math.PI / 2,
    color: 0xf2e6e7,
    roughness: 0.72,
  },
  {
    url: PILLOWS_URL,
    // The pillow asset's pivot is at its own middle, not at its base.  The
    // bed's mattress is about 0.5 m from the floor, so adding half the pillow
    // thickness seats it on the duvet instead of hanging above it.
    position: [-1.48, 0.46, -1.35],
    rotationY: Math.PI / 2,
    color: 0xf4cad4,
    roughness: 0.88,
  },
];

/**
 * Imported furniture shared by every weather pattern.
 *
 * Patterns own their lights and disposable canvas textures; the furniture is
 * deliberately outside that lifecycle. Switching from rain to morning should
 * change the light over the same room, never fetch a new bedroom or leave a
 * late glTF response attached to an already-cleared backdrop.
 */
export class SceneryAssets {
  readonly root = new THREE.Group();
  private disposed = false;

  constructor() {
    this.root.name = 'shared-scenery';
    const loader = new GLTFLoader();
    for (const spec of FURNITURE) this.load(loader, spec);
  }

  attach(scene: THREE.Scene): void {
    if (!this.disposed && this.root.parent !== scene) scene.add(this.root);
  }

  detach(scene: THREE.Scene): void {
    if (this.root.parent === scene) scene.remove(this.root);
  }

  dispose(): void {
    this.disposed = true;
    this.root.removeFromParent();
    const materials = new Set<THREE.Material>();
    this.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
      }
    });
    for (const material of materials) material.dispose();
    this.root.clear();
  }

  private load(loader: GLTFLoader, spec: FurnitureSpec): void {
    loader.load(
      spec.url,
      ({ scene }) => {
        if (this.disposed) {
          dispose(scene);
          return;
        }
        scene.position.set(...spec.position);
        scene.rotation.y = spec.rotationY;
        scene.scale.setScalar(spec.scale ?? 1);
        scene.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          object.castShadow = true;
          object.receiveShadow = true;
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material]) {
            material.dispose();
          }
          object.material = new THREE.MeshStandardMaterial({
            color: spec.color,
            roughness: spec.roughness,
            envMapIntensity: 0.7,
          });
        });
        this.root.add(scene);
      },
      undefined,
      (error) => console.warn(`Unable to load room furniture: ${spec.url}`, error),
    );
  }
}

function dispose(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
    }
  });
  for (const material of materials) material.dispose();
}
