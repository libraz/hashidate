import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FaceSurface } from '@/engine/anatomy/face';

interface SurfaceFixture {
  scene: THREE.Scene;
  root: THREE.Group;
  head: THREE.Bone;
  face: FaceSurface;
}

interface SurfaceCase {
  shape: 'plane' | 'curved';
  local: readonly [number, number, number];
  /** Captured from the unchanged shortfall implementation at clear=0.03. */
  shortfall: number;
  normal: readonly [number, number, number];
}

const CLEAR = 0.03;
const ROTATED_PLANE_NORMAL = [
  0.29116930397264834, -0.14869156426260066, 0.9450456365389052,
] as const;
const CASES: readonly SurfaceCase[] = [
  {
    shape: 'plane',
    local: [0.013, 0.004, 0.006],
    shortfall: 0.024,
    normal: ROTATED_PLANE_NORMAL,
  },
  {
    shape: 'plane',
    local: [0.013, 0.004, -0.004],
    shortfall: 0.034,
    normal: ROTATED_PLANE_NORMAL,
  },
  {
    shape: 'curved',
    local: [0.023, -0.018, 0.102735],
    shortfall: 0.023476148986988465,
    normal: [0.485142503309084, -0.2872242147713401, 0.8259170672240539],
  },
  {
    shape: 'curved',
    local: [0.023, -0.018, 0.088735],
    shortfall: 0.03695687124457286,
    normal: [0.5060138469550715, -0.3038423005120602, 0.8072359277864608],
  },
];

function makeSurfaceFixture(shape: 'plane' | 'curved' | 'balanced'): SurfaceFixture {
  const positions: number[] = [];
  const indices: number[] = [];
  if (shape === 'balanced') {
    const radius = 0.004;
    const points: [number, number, number][] = [
      [radius, 0, 0],
      [-radius, 0, 0],
      [0, radius, 0],
      [0, -radius, 0],
      [0, 0, radius],
      [0, 0, -radius],
    ];
    for (const point of points) positions.push(...point);
    const vertex = (index: number) => {
      const point = points[index];
      if (!point) throw new Error('balanced surface has an incomplete face');
      return new THREE.Vector3(...point);
    };
    for (const x of [0, 1]) {
      for (const y of [2, 3]) {
        for (const z of [4, 5]) {
          const face: [number, number, number] = [x, y, z];
          const a = vertex(x);
          const b = vertex(y);
          const c = vertex(z);
          const normal = b.clone().sub(a).cross(c.clone().sub(a));
          if (normal.dot(a.clone().add(b).add(c)) < 0) {
            const second = face[1];
            face[1] = face[2];
            face[2] = second;
          }
          indices.push(...face);
        }
      }
    }
  } else {
    const side = 15;
    const center = (side - 1) / 2;
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const px = (x - center) * 0.01;
        const py = (y - center) * 0.01;
        const pz = shape === 'plane' ? 0 : 0.1 - (px * px + py * py) / 0.2;
        positions.push(px, py, pz);
      }
    }
    for (let y = 0; y < side - 1; y++) {
      for (let x = 0; x < side - 1; x++) {
        const a = y * side + x;
        const b = a + 1;
        const c = a + side;
        const d = c + 1;
        indices.push(a, b, d, a, d, c);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  const position = new THREE.Float32BufferAttribute(positions, 3);
  geometry.setAttribute('position', position);
  geometry.setIndex(indices);
  const skinIndex = new Uint16Array(position.count * 4);
  const skinWeight = new Float32Array(position.count * 4);
  for (let i = 0; i < position.count; i++) skinWeight[i * 4] = 1;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));

  const scene = new THREE.Scene();
  const root = new THREE.Group();
  const head = new THREE.Bone();
  head.name = 'Head';
  root.add(head);
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  root.add(mesh);
  scene.add(root);
  scene.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton([head]);
  mesh.bind(skeleton);
  scene.updateMatrixWorld(true);
  skeleton.update();

  const face = FaceSurface.measure(root, head, new Set([head]));
  if (!face) throw new Error('synthetic face surface could not be measured');
  face.refresh();
  return { scene, root, head, face };
}

function worldPoint(fixture: SurfaceFixture, local: THREE.Vector3): THREE.Vector3 {
  fixture.scene.updateMatrixWorld(true);
  return local
    .clone()
    .applyQuaternion(fixture.head.getWorldQuaternion(new THREE.Quaternion()))
    .add(fixture.head.getWorldPosition(new THREE.Vector3()));
}

function posedFixture(shape: SurfaceCase['shape']): SurfaceFixture {
  const fixture = makeSurfaceFixture(shape);
  fixture.root.position.set(0.8, -0.3, 1.1);
  fixture.root.rotation.y = 0.4;
  fixture.head.rotation.set(0.15, -0.1, 0.08);
  fixture.scene.updateMatrixWorld(true);
  fixture.face.refresh();
  return fixture;
}

describe('FaceSurface signed samples', () => {
  it('keeps the recorded legacy shortfall and world normal on transformed skins', () => {
    for (const row of CASES) {
      const fixture = posedFixture(row.shape);
      const normal = new THREE.Vector3(4, 5, 6);
      const point = worldPoint(fixture, new THREE.Vector3(...row.local));
      const shortfall = fixture.face.shortfall(point, CLEAR, normal);
      expect(shortfall).toBeCloseTo(row.shortfall, 8);
      expect(normal.distanceTo(new THREE.Vector3(...row.normal))).toBeLessThan(1e-8);
    }
  });

  it('exposes signed distance and outward world normal for the same samples', () => {
    for (const row of CASES) {
      const fixture = posedFixture(row.shape);
      const point = worldPoint(fixture, new THREE.Vector3(...row.local));
      const original = point.clone();
      const sample = {
        distance: 123,
        normal: new THREE.Vector3(4, 5, 6),
        valid: false,
      };

      fixture.face.sample(point, sample);

      expect(sample.valid).toBe(true);
      expect(sample.distance).toBeCloseTo(CLEAR - row.shortfall, 8);
      expect(sample.normal.distanceTo(new THREE.Vector3(...row.normal))).toBeLessThan(1e-8);
      expect(point.equals(original)).toBe(true);

      const outward = new THREE.Vector3(4, 5, 6);
      expect(fixture.face.shortfall(point, CLEAR, outward)).toBeCloseTo(row.shortfall, 8);
      expect(outward.distanceTo(sample.normal)).toBeLessThan(1e-8);
    }
  });

  it('keeps valid clear points signed without changing legacy normal writes', () => {
    const fixture = makeSurfaceFixture('plane');
    const point = worldPoint(fixture, new THREE.Vector3(0.013, 0.004, 0.006));
    const sample = {
      distance: -1,
      normal: new THREE.Vector3(4, 5, 6),
      valid: false,
    };
    fixture.face.sample(point, sample);
    expect(sample.valid).toBe(true);
    expect(sample.distance).toBeCloseTo(0.006, 8);
    expect(sample.normal.length()).toBeCloseTo(1, 8);

    const outward = new THREE.Vector3(4, 5, 6);
    expect(fixture.face.shortfall(point, 0.003, outward)).toBe(0);
    expect(outward.toArray()).toEqual([4, 5, 6]);
  });

  it('preserves the nearest-plane fallback for points deep inside the skin', () => {
    const fixture = posedFixture('curved');
    const point = worldPoint(fixture, new THREE.Vector3(0, 0, 0.04));
    const sample = {
      distance: 123,
      normal: new THREE.Vector3(4, 5, 6),
      valid: false,
    };

    fixture.face.sample(point, sample);

    expect(sample.valid).toBe(true);
    expect(sample.distance).toBeCloseTo(-0.06761233848142988, 8);
    expect(sample.normal.toArray()).toEqual([
      0.734208899333023, -0.25993920721420577, 0.6271912608092143,
    ]);
    const outward = new THREE.Vector3();
    expect(fixture.face.shortfall(point, CLEAR, outward)).toBeCloseTo(0.09761233848142988, 8);
    expect(outward.distanceTo(sample.normal)).toBeLessThan(1e-8);
  });

  it('marks a balanced local normal as invalid without leaving stale output', () => {
    const fixture = makeSurfaceFixture('balanced');
    const point = worldPoint(fixture, new THREE.Vector3());
    const sample = {
      distance: 123,
      normal: new THREE.Vector3(4, 5, 6),
      valid: true,
    };

    fixture.face.sample(point, sample);

    expect(sample.valid).toBe(false);
    expect(sample.distance).toBe(0);
    expect(sample.normal.toArray()).toEqual([0, 0, 0]);
    const outward = new THREE.Vector3(4, 5, 6);
    expect(fixture.face.shortfall(point, CLEAR, outward)).toBe(0);
    expect(outward.toArray()).toEqual([4, 5, 6]);
  });

  it('returns neutral invalid samples without probing disjoint hash cells', () => {
    const fixture = posedFixture('curved');
    const point = worldPoint(fixture, new THREE.Vector3(0, 0, 0.8));
    const cells = (fixture.face as unknown as { cells: Map<number, number[]> }).cells;
    const get = cells.get.bind(cells);
    let lookups = 0;
    cells.get = (cell) => {
      lookups++;
      return get(cell);
    };
    const sample = {
      distance: 123,
      normal: new THREE.Vector3(4, 5, 6),
      valid: true,
    };

    fixture.face.sample(point, sample);

    expect(lookups).toBe(0);
    expect(sample.valid).toBe(false);
    expect(sample.distance).toBe(0);
    expect(sample.normal.toArray()).toEqual([0, 0, 0]);
  });

  it('keeps queries whose reach cube touches the occupied cell bounds', () => {
    const fixture = posedFixture('plane');
    for (const local of [
      new THREE.Vector3(-0.135, -0.135, -0.055),
      new THREE.Vector3(0.125, 0.125, 0.065),
    ]) {
      const sample = {
        distance: 123,
        normal: new THREE.Vector3(4, 5, 6),
        valid: false,
      };

      fixture.face.sample(worldPoint(fixture, local), sample);

      expect(sample.valid).toBe(true);
      expect(Number.isFinite(sample.distance)).toBe(true);
      expect(sample.normal.lengthSq()).toBeGreaterThan(0);
    }
  });

  it('resets invalid far samples and preserves the legacy no-write result', () => {
    const fixture = makeSurfaceFixture('curved');
    const point = worldPoint(fixture, new THREE.Vector3(0, 0, 0.8));
    const original = point.clone();
    const sample = {
      distance: 123,
      normal: new THREE.Vector3(4, 5, 6),
      valid: true,
    };

    fixture.face.sample(point, sample);

    expect(sample.valid).toBe(false);
    expect(sample.distance).toBe(0);
    expect(sample.normal.toArray()).toEqual([0, 0, 0]);
    expect(point.equals(original)).toBe(true);
    const outward = new THREE.Vector3(4, 5, 6);
    expect(fixture.face.shortfall(point, CLEAR, outward)).toBe(0);
    expect(outward.toArray()).toEqual([4, 5, 6]);
  });

  it('reuses traversal callbacks for repeated samples on each surface', () => {
    type Traversal = {
      each: (cx: number, cy: number, cz: number, r: number, fn: (i: number) => void) => void;
    };
    const fixtures = [makeSurfaceFixture('plane'), makeSurfaceFixture('plane')];
    const callbacks = fixtures.map(() => new Set<(i: number) => void>());
    const calls = fixtures.map(() => 0);

    for (const [index, fixture] of fixtures.entries()) {
      const traversal = fixture.face as unknown as Traversal;
      const each = traversal.each;
      traversal.each = (cx, cy, cz, r, fn) => {
        calls[index]++;
        callbacks[index]?.add(fn);
        each.call(fixture.face, cx, cy, cz, r, fn);
      };
    }

    for (const fixture of fixtures) {
      for (let i = 0; i < 2; i++) {
        const sample = {
          distance: 123,
          normal: new THREE.Vector3(4, 5, 6),
          valid: false,
        };
        fixture.face.sample(worldPoint(fixture, new THREE.Vector3(0.013, 0.004, 0.006)), sample);
        expect(sample.valid).toBe(true);
        expect(sample.distance).toBeCloseTo(0.006, 8);
      }
    }

    expect(calls).toEqual([4, 4]);
    expect(callbacks.map((set) => set.size)).toEqual([2, 2]);
    const [firstCallbacks, secondCallbacks] = callbacks;
    if (!(firstCallbacks && secondCallbacks)) throw new Error('expected two callback sets');
    expect([...firstCallbacks].some((fn) => secondCallbacks.has(fn))).toBe(false);
  });
});
