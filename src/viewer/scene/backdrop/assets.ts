import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clockDial } from './clock-finish';
import { ClockHands } from './clock-hands';
import { linenMaterial, timberMaterial } from './finishes';
import type { TextureBin } from './textures';

// These URLs are source imports rather than paths under `public/`: Vite then
// serves them even when the development server was already running before a
// model was added, and fingerprints them in production builds.
const BED_URL = new URL('./assets/gothic-bed.glb', import.meta.url).href;
const COMMODE_URL = new URL('./assets/gothic-commode.glb', import.meta.url).href;
const SOFA_URL = new URL('./assets/sofa.glb', import.meta.url).href;
const PILLOWS_URL = new URL('./assets/pillows.glb', import.meta.url).href;
const PLANT_URL = new URL('./assets/potted-plant.glb', import.meta.url).href;
const TABLE_URL = new URL('./assets/round-table.glb', import.meta.url).href;
const TEA_SET_URL = new URL('./assets/tea-set.glb', import.meta.url).href;
const VASE_URL = new URL('./assets/vase-tall.glb', import.meta.url).href;
const JUG_URL = new URL('./assets/vase-jug.glb', import.meta.url).href;
const PHOTO_URL = new URL('./assets/photo-frame.glb', import.meta.url).href;
const WALL_CLOCK_URL = new URL('./assets/wall-clock.glb', import.meta.url).href;
const BASKET_URL = new URL('./assets/wicker-basket.glb', import.meta.url).href;

interface FurnitureSpec {
  url: string;
  position: readonly [number, number, number];
  rotationY: number;
  scale?: number;
  /** Replacement for the scanned picture, retaining the frame and glazing. */
  artwork?: string;
  rotationZ?: number;
  clock?: boolean;
  /** A material finish that needs the imported mesh's connected components. */
  finishKind?: 'bed' | 'sofa' | 'pillows';
  /**
   * Repaint in one flat colour. The large pieces take this so the bedroom
   * stays white whatever the source was; small things keep their own scans,
   * because a teapot or a clock face reads as an object through its texture.
   */
  finish?: { color: number; roughness: number };
}

/** The top of the commode at its 62% scale. */
const COMMODE_TOP = 0.751;

const FURNITURE: readonly FurnitureSpec[] = [
  {
    url: BED_URL,
    position: [-1.48, 0, -1.42],
    rotationY: Math.PI / 2,
    finishKind: 'bed',
  },
  {
    url: COMMODE_URL,
    // The source is a 1.21 m high commode, too tall beside the avatar.  At
    // 62% it becomes a 75 cm chest; its scaled 0.36 m depth and 0.74 m width
    // still meet both walls with a 10 mm shadow reveal.
    position: [2.22, 0, -2.21],
    rotationY: 0,
    scale: 0.62,
    finish: { color: 0xfaf8f4, roughness: 0.48 },
  },
  {
    url: SOFA_URL,
    position: [-2.18, 0, 0.25],
    rotationY: Math.PI / 2,
    finishKind: 'sofa',
  },
  {
    url: PILLOWS_URL,
    // The pillow asset's pivot is at its own middle, not at its base.  The
    // bed's mattress is about 0.5 m from the floor, so adding half the pillow
    // thickness seats it on the duvet instead of hanging above it.
    position: [-1.48, 0.46, -1.35],
    rotationY: Math.PI / 2,
    finishKind: 'pillows',
  },
  // The rear easel sits inside the wall; the scanned front and glazing remain.
  {
    url: PHOTO_URL,
    position: [-1.12, 1.38, -2.36],
    rotationY: -Math.PI / 2,
    rotationZ: -0.018,
    scale: 1.55,
    artwork: '/textures/poster-peonies.jpg',
  },
  {
    url: PHOTO_URL,
    position: [-0.73, 1.36, -2.38],
    rotationY: -Math.PI / 2,
    rotationZ: 0.02,
    scale: 1.18,
    artwork: '/textures/poster-moon-garden.jpg',
  },
  // Poly Haven CC0 props from here down, at their scanned scale unless noted.
  {
    // A 1.3 m plant in the gap between the curtain and the commode. It breaks
    // the run of bare wall right of the window, which the full shot shows.
    url: PLANT_URL,
    position: [1.62, 0, -1.62],
    rotationY: 0.7,
  },
  {
    // A 1.3 m coffee table, taken down to a 78 cm, 29 cm high low table in
    // front of the sofa.
    url: TABLE_URL,
    position: [-1.35, 0, 0.25],
    rotationY: 0,
    scale: 0.6,
  },
  {
    url: TEA_SET_URL,
    position: [-1.35, 0.294, 0.25],
    rotationY: 1.25,
    scale: 0.55,
  },
  {
    url: VASE_URL,
    position: [2.4, COMMODE_TOP, -2.24],
    rotationY: 0,
    scale: 0.8,
  },
  {
    url: PHOTO_URL,
    position: [1.98, COMMODE_TOP, -2.26],
    rotationY: -Math.PI / 2 + 0.35,
  },
  {
    url: WALL_CLOCK_URL,
    position: [1.86, 1.74, -2.4],
    rotationY: 0,
    scale: 0.9,
    clock: true,
  },
  {
    // CC0 ceramic jug on the wall shelf.
    url: JUG_URL,
    position: [-0.87, 1.113, -2.25],
    rotationY: 0.4,
    scale: 0.32,
  },
  {
    // On the sill, right of the procedural plant, clear of the curtain.
    url: JUG_URL,
    position: [1.16, 0.86, -2.33],
    rotationY: 0.4,
    scale: 0.55,
  },
  {
    url: BASKET_URL,
    position: [1.02, 0, -1.4],
    rotationY: -0.3,
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
  /** PBR maps belong to the scenery, which outlives each weather pattern. */
  private readonly textures: TextureBin = [];
  private disposed = false;
  private clock: ClockHands | null = null;

  constructor(private readonly environment: () => THREE.Texture | null = () => null) {
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

  /** Turn the wall clock to `now`, once it has loaded. */
  update(now: Date): void {
    this.clock?.set(now);
  }

  dispose(): void {
    this.disposed = true;
    this.clock = null;
    this.root.removeFromParent();
    const materials = new Set<THREE.Material>();
    this.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
      }
    });
    for (const material of materials) release(material, this.textures);
    // Several furniture materials share map ownership through this bin. Each
    // map is released once after all materials have been disposed.
    for (const texture of new Set(this.textures)) texture.dispose();
    this.textures.length = 0;
    this.root.clear();
  }

  /**
   * Give the imported upholstery a finish without changing its geometry.
   *
   * The geometry-only exports omit source materials. The bed's disconnected
   * duvet is identified by its full extents; the sofa export supplies named
   * cloth and frame meshes separated along the source diffuse boundary.
   */
  private applyFurnitureFinish(
    scene: THREE.Object3D,
    kind: NonNullable<FurnitureSpec['finishKind']>,
  ): boolean {
    // These recipes depend on the known asset layout. An unfamiliar mesh
    // keeps the ordinary repaint instead of receiving a guessed cloth finish.
    const names: string[] = [];
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh) names.push(object.name);
    });
    const expected =
      kind === 'bed'
        ? names.some((name) => name === 'GothicBed_01')
        : kind === 'sofa'
          ? names.some(
              (name) =>
                name === 'Sofa_01' || name === 'Sofa_01_upholstery' || name === 'Sofa_01_frame',
            )
          : names.some((name) => name.includes('throw_pillows_01'));
    if (!expected) return false;

    const original = new Set<THREE.Material>();
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        original.add(material);
      }
    });

    if (kind === 'bed') {
      // One authored UV unit on the duvet covers roughly 4.56 m of its
      // measured surface. With the Fabric036 scan calibrated to 0.25 m, this
      // is the repeat that keeps threads at the same scale as the curtains.
      const linen = this.withEnvironment(
        linenMaterial(this.textures, 0xf1d4dc, { width: 4.56, height: 4.56 }),
      );
      const ivory = this.withEnvironment(
        new THREE.MeshStandardMaterial({
          name: 'bed-frame-ivory-paint',
          color: 0xf8f2ee,
          roughness: 0.68,
        }),
      );
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        assignComponentGroups(object.geometry, (bounds) => (isDuvetComponent(bounds) ? 0 : 1));
        object.material = [linen, ivory];
      });
    } else if (kind === 'sofa') {
      // The export has the authored diffuse boundary baked into two geometry
      // objects. Keep the source's timber edge and feet together, so the
      // cloth normal map never leaks onto the dark wood trim.
      const linen = this.withEnvironment(
        linenMaterial(this.textures, 0xf0d5dc, { width: 2.18, height: 2.18 }),
      );
      const timber = this.withEnvironment(
        // The split export measures 0.5582 m² of frame over 0.2585 authored
        // UV m² (sqrt(area / uvArea) = 1.4695 m per UV). timberMaterial
        // applies Wood095's calibrated 0.7 m × 0.35 m tile to this density.
        timberMaterial(this.textures, { width: 1.4695, height: 1.4695 }),
      );
      const splitBySourceMaterial = names.some(
        (name) => name === 'Sofa_01_upholstery' || name === 'Sofa_01_frame',
      );
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        if (splitBySourceMaterial) {
          object.material = object.name === 'Sofa_01_upholstery' ? linen : timber;
          return;
        }
        // Compatibility path for a pre-split checkout: all broad cushion
        // components use cloth and the small feet use timber.
        assignComponentGroups(object.geometry, (bounds) =>
          isSofaUpholsteryComponent(bounds) ? 0 : 1,
        );
        object.material = [linen, timber];
      });
    } else {
      const linen = this.withEnvironment(
        linenMaterial(this.textures, 0xf1c6d2, { width: 1.2, height: 1.2 }),
      );
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) object.material = linen;
      });
    }

    for (const material of original) release(material, this.textures);
    return true;
  }

  private withEnvironment<T extends THREE.MeshStandardMaterial>(material: T): T {
    material.envMap = this.environment();
    material.envMapIntensity = 0.7;
    // These maps are applied to glTF UVs. TextureLoader defaults to a canvas
    // orientation, while glTF's UV origin is already at the lower left.
    for (const texture of [material.map, material.normalMap, material.roughnessMap]) {
      if (texture) {
        texture.flipY = false;
        texture.needsUpdate = true;
      }
    }
    return material;
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
        scene.rotation.set(0, spec.rotationY, spec.rotationZ ?? 0, 'ZYX');
        scene.scale.setScalar(spec.scale ?? 1);
        const appliedFinish = spec.finishKind
          ? this.applyFurnitureFinish(scene, spec.finishKind)
          : false;
        if (spec.clock) {
          const original = new Set<THREE.Material>();
          const dial = clockDial();
          scene.traverse((object) => {
            if (!(object instanceof THREE.Mesh)) return;
            for (const material of Array.isArray(object.material)
              ? object.material
              : [object.material]) {
              original.add(material);
            }
            const hand = object.name.includes('hand');
            const glass =
              object.name.toLowerCase().includes('glass') ||
              (object.material instanceof THREE.Material && object.material.name.includes('glass'));
            object.material = new THREE.MeshStandardMaterial({
              name: glass ? 'clock-glazing' : hand ? 'clock-hand' : 'clock-case-and-dial',
              map: !(hand || glass) ? dial : null,
              color: hand ? 0x555a54 : 0xffffff,
              roughness: glass ? 0.12 : 0.6,
              metalness: hand ? 0.15 : 0,
              transparent: glass,
              opacity: glass ? 0.05 : 1,
              depthWrite: !glass,
            });
          });
          for (const material of original) release(material, this.textures);
          this.clock = ClockHands.find(scene);
          this.clock?.set(new Date());
        }
        scene.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          object.castShadow = true;
          object.receiveShadow = true;
          if (spec.url === PLANT_URL && object.name === 'potted_plant_01_pot') {
            const source = object.material;
            if (source instanceof THREE.MeshStandardMaterial) {
              // The source material is also used by stems and stones. Clone the
              // finish only for the vessel, keeping those scans and the foliage.
              const pot = source.clone();
              pot.map = null;
              pot.metalnessMap = null;
              pot.roughnessMap = null;
              pot.color.set(0xcdd5c7);
              pot.roughness = 0.9;
              pot.metalness = 0;
              pot.normalScale.set(0.2, 0.2);
              object.material = pot;
            }
          }
          const materials = (
            Array.isArray(object.material) ? object.material : [object.material]
          ).map((material) => {
            if (!spec.artwork || material.name !== 'standing_picture_frame_02_glass')
              return material;
            // Scanned glass contains dark reflections of the source room. A clear
            // pane lets this room, rather than that photograph, sit over the print.
            release(material);
            return new THREE.MeshStandardMaterial({
              name: 'picture-glazing',
              color: 0xffffff,
              metalness: 0,
              roughness: 0.12,
              transparent: true,
              opacity: 0.06,
              depthWrite: false,
            });
          });
          object.material = Array.isArray(object.material) ? materials : materials[0];
          if (appliedFinish) return;
          if (spec.finishKind) {
            // A mocked or malformed asset without the expected node name gets
            // the same safe fallback as a flat finish. This keeps late
            // callbacks renderable while real furniture takes the component
            // path above.
            for (const material of materials) release(material, this.textures);
            const color =
              spec.finishKind === 'bed'
                ? 0xf8f2ee
                : spec.finishKind === 'sofa'
                  ? 0xf0d5dc
                  : 0xf1c6d2;
            object.material = new THREE.MeshStandardMaterial({
              color,
              roughness: spec.finishKind === 'pillows' ? 0.88 : 0.72,
              envMap: this.environment(),
              envMapIntensity: 0.7,
            });
            return;
          }
          if (!spec.finish) {
            for (const material of materials) {
              if (!(material instanceof THREE.MeshStandardMaterial)) continue;
              if (spec.artwork && material.name === 'standing_picture_frame_02_artwork') {
                const original = material.map;
                const replacement = new THREE.TextureLoader().load(spec.artwork);
                replacement.colorSpace = THREE.SRGBColorSpace;
                replacement.flipY = false;
                // Preserve the glTF UV transform while changing just the image.
                if (original) {
                  replacement.offset.copy(original.offset);
                  replacement.repeat.copy(original.repeat);
                  replacement.rotation = original.rotation;
                  replacement.center.copy(original.center);
                  replacement.channel = original.channel;
                }
                replacement.anisotropy = 8;
                material.map = replacement;
                material.color.set(0xffffff);
                material.needsUpdate = true;
                original?.dispose();
              }
              material.envMap = this.environment();
              material.envMapIntensity = 0.7;
            }
            return;
          }
          for (const material of materials) release(material, this.textures);
          object.material = new THREE.MeshStandardMaterial({
            color: spec.finish.color,
            roughness: spec.finish.roughness,
            envMap: this.environment(),
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

interface ComponentBounds {
  min: THREE.Vector3;
  max: THREE.Vector3;
  extent: THREE.Vector3;
}

/** The broad, low component measured on GothicBed_01 is the draped duvet. */
function isDuvetComponent(bounds: ComponentBounds): boolean {
  const { x, y, z } = bounds.extent;
  return x > 0.9 && z > 0.9 && y > 0.2 && y < Math.max(x, z) * 0.55;
}

/** Sofa upholstery includes the low seat/front component; only the six feet are tiny. */
function isSofaUpholsteryComponent(bounds: ComponentBounds): boolean {
  const { x, y, z } = bounds.extent;
  return x > 1.1 && z > 0.35 && y > 0.1;
}

/**
 * Add material groups by welded-position connected component.
 *
 * The source GLBs interleave triangles from several components, so one group
 * per component would require reordering the index buffer. Consecutive runs
 * retain the original index order and still let the renderer choose the right
 * material for every triangle. Vertex positions and UVs remain untouched.
 */
function assignComponentGroups(
  geometry: THREE.BufferGeometry,
  materialFor: (bounds: ComponentBounds) => number,
): void {
  const position = geometry.getAttribute('position');
  if (!position || position.itemSize < 3) return;
  const index = geometry.getIndex();
  const indexCount = index?.count ?? position.count;
  const vertexAt = (offset: number): number => index?.getX(offset) ?? offset;
  const parent = Int32Array.from({ length: position.count }, (_, i) => i);

  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root] ?? root] ?? root;
      root = parent[root] ?? root;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };

  // Weld only for connectivity. The attributes themselves stay byte-for-byte
  // in place, including separate UV islands at a shared geometric seam.
  const welded = new Map<string, number>();
  for (let i = 0; i < position.count; i++) {
    const key = [position.getX(i), position.getY(i), position.getZ(i)]
      .map((value) => Math.round(value * 100_000))
      .join(',');
    const existing = welded.get(key);
    if (existing === undefined) welded.set(key, i);
    else union(i, existing);
  }
  for (let offset = 0; offset + 2 < indexCount; offset += 3) {
    const a = vertexAt(offset);
    const b = vertexAt(offset + 1);
    const c = vertexAt(offset + 2);
    union(a, b);
    union(a, c);
  }

  const boundsByRoot = new Map<number, ComponentBounds>();
  for (let i = 0; i < position.count; i++) {
    const root = find(i);
    let bounds = boundsByRoot.get(root);
    if (!bounds) {
      const point = new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i));
      bounds = { min: point.clone(), max: point.clone(), extent: new THREE.Vector3() };
      boundsByRoot.set(root, bounds);
    } else {
      bounds.min.min(new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i)));
      bounds.max.max(new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i)));
    }
  }
  for (const bounds of boundsByRoot.values()) bounds.extent.subVectors(bounds.max, bounds.min);

  const triangleRoots: number[] = [];
  for (let offset = 0; offset + 2 < indexCount; offset += 3) {
    triangleRoots.push(find(vertexAt(offset)));
  }
  geometry.clearGroups();
  if (triangleRoots.length === 0) return;

  const materialByRoot = new Map<number, number>();
  const materialAt = (root: number): number => {
    const existing = materialByRoot.get(root);
    if (existing !== undefined) return existing;
    const bounds = boundsByRoot.get(root);
    const material = bounds ? materialFor(bounds) : 0;
    materialByRoot.set(root, material);
    return material;
  };
  let start = 0;
  let material = materialAt(triangleRoots[0] ?? 0);
  for (let triangle = 1; triangle < triangleRoots.length; triangle++) {
    const next = materialAt(triangleRoots[triangle] ?? 0);
    if (next === material) continue;
    geometry.addGroup(start, triangle * 3 - start, material);
    start = triangle * 3;
    material = next;
  }
  geometry.addGroup(start, triangleRoots.length * 3 - start, material);
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
  for (const material of materials) release(material);
}

/**
 * Dispose a material and the scanned textures it owns.
 *
 * The borrowed environment map is skipped: it belongs to the runtime and is
 * shared with every room.
 */
function release(material: THREE.Material, owned: TextureBin = []): void {
  const envMap = material instanceof THREE.MeshStandardMaterial ? material.envMap : null;
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture && value !== envMap && !owned.includes(value))
      value.dispose();
  }
  material.dispose();
}
