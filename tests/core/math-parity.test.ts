import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { core, views } from '@/core';
import { MATH_BATCHES, type MathBatchName } from '@/core/abi/math';
import { coreMathCalls, withCoreMath } from '../helpers/core-math';

/** Shared with `crates/hashidate-core/tests/math_corpus.rs`. */
const CORPUS_HASH = 0x3c38_dd49_d0d1_8fb7n;

const SEED = 0x6861_7368_6964_6174n;
const COUNT = 20_000;
const MASK = (1n << 64n) - 1n;

function splitmix64(seed: bigint): () => number {
  let state = seed;
  return () => {
    state = (state + 0x9e37_79b9_7f4a_7c15n) & MASK;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK;
    z ^= z >> 31n;
    // Uniform in [-8, 8).
    return (Number(z >> 11n) / 2 ** 53) * 16 - 8;
  };
}

function bitsOf(x: number): bigint {
  return new BigUint64Array(new Float64Array([x]).buffer)[0];
}

function fromBits(bits: bigint): number {
  return new Float64Array(new BigUint64Array([bits]).buffer)[0];
}

const SLERP_EDGE = [fromBits(bitsOf(0.9995) - 1n), 0.9995, fromBits(bitsOf(0.9995) + 1n)];

const SPECIALS = [
  0,
  -0,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.NaN,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  1,
  -1,
  Math.PI,
  ...SLERP_EDGE,
  1e300,
  -1e300,
  1e-300,
  Number.MAX_VALUE,
  2 ** -1022,
];

/** Enough draws for 20,000 items of the widest input; every op reads from the start. */
const POOL = (() => {
  const draw = splitmix64(SEED);
  const pool = new Float64Array(COUNT * 32);
  for (let i = 0; i < pool.length; i++) pool[i] = draw();
  return pool;
})();

const v3 = (i: number[], o = 0) => new THREE.Vector3(i[o], i[o + 1], i[o + 2]);
const v4 = (i: number[], o = 0) => new THREE.Vector4(i[o], i[o + 1], i[o + 2], i[o + 3]);
const q = (i: number[], o = 0) => new THREE.Quaternion(i[o], i[o + 1], i[o + 2], i[o + 3]);
const m4 = (i: number[], o = 0) => new THREE.Matrix4().fromArray(i, o);
const vq = (x: THREE.Quaternion) => [x.x, x.y, x.z, x.w];

function unitQuat(i: number[], o: number): void {
  const n = q(i, o).normalize();
  i.splice(o, 4, ...vq(n));
}

function unitVec(i: number[], o: number): void {
  const n = v3(i, o).normalize();
  i.splice(o, 3, ...n.toArray());
}

const rotation = (i: number[]) => new THREE.Matrix4().makeRotationFromQuaternion(q(i).normalize());

/** Matrices where a determinant or a branch threshold is the point. */
function edgeMatrices(): number[][] {
  const out: number[][] = [];
  const turn = (axis: THREE.Vector3, angle: number) =>
    new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion().setFromAxisAngle(axis, angle),
    );
  for (const axis of [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ]) {
    for (const angle of [Math.PI, Math.PI / 2, 3, 1e-9]) out.push(turn(axis, angle).toArray());
  }
  out.push(new THREE.Matrix4().makeScale(1, 1, 0).toArray());
  out.push(new THREE.Matrix4().makeScale(1e-300, 1e-300, 1e-300).toArray());
  out.push(new THREE.Matrix4().makeScale(-1, 2, 3).toArray());
  out.push(new THREE.Matrix4().makeScale(1, 1, 1e-20).toArray());
  out.push([1, 2, 3, 0, 2, 4, 6, 0, 0, 0, 1, 0, 5, 6, 7, 1]);
  out.push([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
  out.push(
    new THREE.Matrix4()
      .compose(
        new THREE.Vector3(1, 2, 3),
        new THREE.Quaternion(0.1, 0.2, 0.3, 0.9).normalize(),
        new THREE.Vector3(-2, 0.5, 1e-8),
      )
      .toArray(),
  );
  return out;
}

/** Quaternion pairs whose dot sits exactly on either side of slerp's 0.9995 threshold. */
function slerpEdges(): number[][] {
  const out: number[][] = [];
  for (const d of SLERP_EDGE) {
    const s = Math.sqrt(1 - d * d);
    for (const t of [0, 0.25, 0.5, 1]) {
      out.push([0, 0, 0, 1, s, 0, 0, d, t]);
      out.push([0, 0, 0, 1, -s, 0, 0, -d, t]);
      out.push([0, 0, 0, 1, 0, s, 0, d, t]);
    }
  }
  out.push([0, 0, 0, 1, 0, 0, 0, 1, 0.5]);
  out.push([0, 0, 0, 1, 0, 0, 0, -1, 0.5]);
  out.push([0, 0, 0, 1, 1, 0, 0, 0, 0.5]);
  return out;
}

interface Op {
  name: MathBatchName;
  three: (i: number[]) => number[];
  /** Runs three inside `withCoreMath`: the op reaches a transcendental. */
  transcendental?: boolean;
  /** Bends an item into the op's meaningful domain; applied to every item, special or not. */
  shape?: (item: number[], index: number) => void;
  extra?: () => number[][];
}

const OPS: Op[] = [
  { name: 'hd_math_vector3_add', three: (i) => v3(i).add(v3(i, 3)).toArray() },
  { name: 'hd_math_vector3_sub', three: (i) => v3(i).sub(v3(i, 3)).toArray() },
  {
    name: 'hd_math_vector3_add_vectors',
    three: (i) => new THREE.Vector3().addVectors(v3(i), v3(i, 3)).toArray(),
  },
  {
    name: 'hd_math_vector3_sub_vectors',
    three: (i) => new THREE.Vector3().subVectors(v3(i), v3(i, 3)).toArray(),
  },
  {
    name: 'hd_math_vector3_add_scaled_vector',
    three: (i) => v3(i).addScaledVector(v3(i, 3), i[6]).toArray(),
  },
  { name: 'hd_math_vector3_multiply_scalar', three: (i) => v3(i).multiplyScalar(i[3]).toArray() },
  { name: 'hd_math_vector3_divide_scalar', three: (i) => v3(i).divideScalar(i[3]).toArray() },
  {
    name: 'hd_math_vector3_normalize',
    three: (i) => v3(i).normalize().toArray(),
    extra: () => [
      [0, 0, 0],
      [-0, -0, -0],
      [1e-170, 0, 0],
      [1e200, 1e200, 0],
      [3, 4, 0],
    ],
  },
  { name: 'hd_math_vector3_negate', three: (i) => v3(i).negate().toArray() },
  { name: 'hd_math_vector3_length', three: (i) => [v3(i).length()] },
  { name: 'hd_math_vector3_length_sq', three: (i) => [v3(i).lengthSq()] },
  { name: 'hd_math_vector3_dot', three: (i) => [v3(i).dot(v3(i, 3))] },
  {
    name: 'hd_math_vector3_cross_vectors',
    three: (i) => new THREE.Vector3().crossVectors(v3(i), v3(i, 3)).toArray(),
  },
  { name: 'hd_math_vector3_distance_to', three: (i) => [v3(i).distanceTo(v3(i, 3))] },
  {
    name: 'hd_math_vector3_distance_to_squared',
    three: (i) => [v3(i).distanceToSquared(v3(i, 3))],
  },
  {
    name: 'hd_math_vector3_lerp_vectors',
    three: (i) => new THREE.Vector3().lerpVectors(v3(i), v3(i, 3), i[6]).toArray(),
  },
  {
    name: 'hd_math_vector3_apply_quaternion',
    three: (i) => v3(i).applyQuaternion(q(i, 3)).toArray(),
    shape: (i, k) => k % 2 === 1 && unitQuat(i, 3),
  },
  {
    name: 'hd_math_vector3_apply_matrix4',
    three: (i) => v3(i).applyMatrix4(m4(i, 3)).toArray(),
    extra: () => edgeMatrices().map((m) => [1.5, -2, 0.25, ...m]),
  },
  {
    name: 'hd_math_vector3_set_from_matrix_position',
    three: (i) => new THREE.Vector3().setFromMatrixPosition(m4(i)).toArray(),
  },
  {
    name: 'hd_math_vector3_set_from_matrix_column',
    three: (i) => new THREE.Vector3().setFromMatrixColumn(m4(i), i[16]).toArray(),
    shape: (i, k) => {
      i[16] = k % 4;
    },
  },
  { name: 'hd_math_vector3_min', three: (i) => v3(i).min(v3(i, 3)).toArray() },
  { name: 'hd_math_vector3_max', three: (i) => v3(i).max(v3(i, 3)).toArray() },
  {
    name: 'hd_math_vector4_get_component',
    three: (i) => [v4(i).getComponent(i[4])],
    shape: (i, k) => {
      i[4] = k % 4;
    },
  },
  {
    name: 'hd_math_vector4_add_scaled_vector',
    three: (i) => v4(i).addScaledVector(v4(i, 4), i[8]).toArray(),
  },
  {
    name: 'hd_math_vector4_apply_matrix4',
    three: (i) => v4(i).applyMatrix4(m4(i, 4)).toArray(),
  },
  { name: 'hd_math_quaternion_multiply', three: (i) => vq(q(i).multiply(q(i, 4))) },
  { name: 'hd_math_quaternion_premultiply', three: (i) => vq(q(i).premultiply(q(i, 4))) },
  {
    name: 'hd_math_quaternion_multiply_quaternions',
    three: (i) => vq(new THREE.Quaternion().multiplyQuaternions(q(i), q(i, 4))),
  },
  { name: 'hd_math_quaternion_invert', three: (i) => vq(q(i).invert()) },
  {
    name: 'hd_math_quaternion_normalize',
    three: (i) => vq(q(i).normalize()),
    extra: () => [
      [0, 0, 0, 0],
      [-0, 0, -0, 0],
      [1e-170, 0, 0, 0],
    ],
  },
  { name: 'hd_math_quaternion_length', three: (i) => [q(i).length()] },
  { name: 'hd_math_quaternion_dot', three: (i) => [q(i).dot(q(i, 4))] },
  {
    name: 'hd_math_quaternion_set_from_axis_angle',
    three: (i) => vq(new THREE.Quaternion().setFromAxisAngle(v3(i), i[3])),
    transcendental: true,
    shape: (i, k) => k % 2 === 1 && unitVec(i, 0),
    extra: () => [
      [1, 0, 0, Math.PI],
      [0, 1, 0, -Math.PI],
      [0, 0, 1, 2 * Math.PI],
      [0, 0, 1, 1e-300],
    ],
  },
  {
    name: 'hd_math_quaternion_set_from_unit_vectors',
    three: (i) => vq(new THREE.Quaternion().setFromUnitVectors(v3(i), v3(i, 3))),
    shape: (i, k) => {
      if (k % 2 === 0) return;
      unitVec(i, 0);
      if (k % 4 === 1) i.splice(3, 3, -i[0], -i[1], -i[2]);
      else unitVec(i, 3);
    },
    extra: () => [
      [1, 0, 0, -1, 0, 0],
      [0, 0, 1, 0, 0, -1],
      [0.6, 0, 0.8, -0.6, 0, -0.8],
      [0.8, 0.6, 0, -0.8, -0.6 + 1e-9, 0],
      [0, 1, 0, 0, 1, 0],
    ],
  },
  {
    name: 'hd_math_quaternion_set_from_rotation_matrix',
    three: (i) => vq(new THREE.Quaternion().setFromRotationMatrix(m4(i))),
    shape: (i, k) => k % 2 === 1 && i.splice(0, 16, ...rotation(i).toArray()),
    extra: edgeMatrices,
  },
  {
    name: 'hd_math_quaternion_slerp',
    three: (i) => vq(q(i).slerp(q(i, 4), i[8])),
    transcendental: true,
    shape: (i, k) => shapeSlerp(i, k),
    extra: slerpEdges,
  },
  {
    name: 'hd_math_quaternion_slerp_quaternions',
    three: (i) => vq(new THREE.Quaternion().slerpQuaternions(q(i), q(i, 4), i[8])),
    transcendental: true,
    shape: (i, k) => shapeSlerp(i, k),
    extra: slerpEdges,
  },
  { name: 'hd_math_matrix4_multiply', three: (i) => m4(i).multiply(m4(i, 16)).toArray() },
  { name: 'hd_math_matrix4_premultiply', three: (i) => m4(i).premultiply(m4(i, 16)).toArray() },
  {
    name: 'hd_math_matrix4_multiply_matrices',
    three: (i) => new THREE.Matrix4().multiplyMatrices(m4(i), m4(i, 16)).toArray(),
  },
  {
    name: 'hd_math_matrix4_extract_rotation',
    three: (i) => new THREE.Matrix4().extractRotation(m4(i)).toArray(),
    extra: edgeMatrices,
  },
  {
    name: 'hd_math_matrix4_compose',
    three: (i) => new THREE.Matrix4().compose(v3(i), q(i, 3), v3(i, 7)).toArray(),
    shape: (i, k) => k % 2 === 1 && unitQuat(i, 3),
  },
  {
    name: 'hd_math_matrix4_decompose',
    three: (i) => {
      const [p, r, s] = [new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3()];
      m4(i).decompose(p, r, s);
      return [...p.toArray(), ...vq(r), ...s.toArray()];
    },
    shape: (i, k) => {
      if (k % 2 === 0) return;
      const m = new THREE.Matrix4().compose(v3(i), q(i, 3).normalize(), v3(i, 7));
      i.splice(0, 16, ...m.toArray());
    },
    extra: edgeMatrices,
  },
  {
    name: 'hd_math_matrix4_determinant',
    three: (i) => [m4(i).determinant()],
    extra: edgeMatrices,
  },
  {
    name: 'hd_math_matrix4_determinant_affine',
    three: (i) => [m4(i).determinantAffine()],
    extra: edgeMatrices,
  },
  {
    name: 'hd_math_matrix4_invert',
    three: (i) => m4(i).invert().toArray(),
    extra: edgeMatrices,
  },
  {
    name: 'hd_math_object3d_update_matrix',
    three: (i) => {
      const o = new THREE.Object3D();
      o.position.copy(v3(i));
      o.quaternion.copy(q(i, 3));
      o.scale.copy(v3(i, 7));
      if (i[13] !== 0) o.pivot = v3(i, 10);
      o.updateMatrix();
      return o.matrix.toArray();
    },
    // Writing `quaternion` syncs the Euler through `asin` and `atan2`.
    transcendental: true,
    shape: (i, k) => {
      i[13] = k % 2;
      if (k % 4 >= 2) unitQuat(i, 3);
    },
  },
  {
    name: 'hd_math_clamp',
    three: (i) => [THREE.MathUtils.clamp(i[0], i[1], i[2])],
    extra: () => [
      [-0, 0, 1],
      [0, -0, 1],
      [-0, -0, 0],
      [5, 0, -0],
      [Number.NaN, 0, 1],
    ],
  },
  {
    name: 'hd_math_box3_set_from_points',
    three: (i) => {
      const box = new THREE.Box3().setFromPoints([v3(i), v3(i, 3), v3(i, 6), v3(i, 9)]);
      return [
        ...box.getSize(new THREE.Vector3()).toArray(),
        ...box.min.toArray(),
        ...box.max.toArray(),
      ];
    },
  },
];

function shapeSlerp(i: number[], k: number): void {
  if (k % 2 === 0) return;
  unitQuat(i, 0);
  if (k % 4 === 1) {
    // A neighbour of the first, so both branches are taken.
    for (let c = 0; c < 4; c++) i[4 + c] = i[c] + i[4 + c] * 1e-3;
  }
  unitQuat(i, 4);
  i[8] = (i[8] + 8) / 16;
}

/** Specials broadcast, specials mixed into draws, the op's edge cases, then 20,000 draws. */
function inputs(op: Op): number[][] {
  const [width] = MATH_BATCHES[op.name];
  const items: number[][] = SPECIALS.map((s) => new Array<number>(width).fill(s));
  for (let j = 0; j < 2000; j++) {
    items.push(
      Array.from({ length: width }, (_, c) =>
        (j * 7 + c * 3) % 5 === 0
          ? SPECIALS[(j * width + c) % SPECIALS.length]
          : POOL[j * width + c],
      ),
    );
  }
  items.push(...(op.extra?.() ?? []));
  for (let j = 0; j < COUNT; j++) items.push(Array.from(POOL.subarray(j * width, (j + 1) * width)));
  if (op.shape) for (let k = 0; k < items.length; k++) op.shape(items[k], k);
  return items;
}

/** Run a batch export over packed items and return its packed output. */
function runCore(name: MathBatchName, items: number[][]): Float64Array {
  const [width, outWidth] = MATH_BATCHES[name];
  const exports = core();
  const inBytes = items.length * width * 8;
  const outBytes = items.length * outWidth * 8;
  const inPtr = exports.hd_alloc(inBytes);
  const outPtr = exports.hd_alloc(outBytes);
  try {
    views().f64.set(items.flat(), inPtr / 8);
    exports[name](inPtr, items.length, outPtr);
    return views().f64.slice(outPtr / 8, outPtr / 8 + items.length * outWidth);
  } finally {
    exports.hd_free(inPtr, inBytes);
    exports.hd_free(outPtr, outBytes);
  }
}

function runThree(op: Op, items: number[][]): Float64Array {
  const compute = () => new Float64Array(items.flatMap((item) => op.three(item)));
  return op.transcendental ? withCoreMath(compute) : compute();
}

/** Indices where the two differ under `Object.is`, at most `limit` of them. */
function mismatches(expected: Float64Array, actual: Float64Array, limit = 5): number[] {
  const out: number[] = [];
  const n = Math.max(expected.length, actual.length);
  for (let k = 0; k < n && out.length < limit; k++) {
    if (!Object.is(expected[k], actual[k])) out.push(k);
  }
  return out;
}

function report(items: number[][], outWidth: number, expected: Float64Array, actual: Float64Array) {
  return mismatches(expected, actual).map((k) => {
    const item = Math.floor(k / outWidth);
    return {
      item,
      input: items[item],
      component: k % outWidth,
      three: expected[k],
      core: actual[k],
    };
  });
}

describe('core math against three r186', () => {
  it('lists a batch export for every op the test covers, and the reverse', () => {
    expect(OPS.map((op) => op.name).sort()).toEqual(Object.keys(MATH_BATCHES).sort());
  });

  for (const op of OPS) {
    it(`${op.name} matches bit for bit`, () => {
      const items = inputs(op);
      const before = coreMathCalls();
      const expected = runThree(op, items);
      const calls = coreMathCalls() - before;
      const actual = runCore(op.name, items);
      expect(actual.length).toBe(expected.length);
      expect(report(items, MATH_BATCHES[op.name][1], expected, actual)).toEqual([]);
      if (op.transcendental) expect(calls).toBeGreaterThan(0);
    });
  }

  it('hypot3 matches the host Math.hypot', () => {
    const triples: [number, number, number][] = [];
    for (const a of SPECIALS)
      for (const b of SPECIALS) for (const c of SPECIALS) triples.push([a, b, c]);
    for (let j = 0; j < COUNT; j++) triples.push([POOL[3 * j], POOL[3 * j + 1], POOL[3 * j + 2]]);
    for (let j = 0; j < 2000; j++) {
      const scale = 2 ** ((j % 41) * 50 - 1000);
      triples.push([POOL[3 * j] * scale, POOL[3 * j + 1], POOL[3 * j + 2] * scale]);
    }
    const bad = triples
      .filter(([a, b, c]) => !Object.is(core().hd_math_hypot3(a, b, c), Math.hypot(a, b, c)))
      .slice(0, 5);
    expect(bad).toEqual([]);
  });

  it('hashes the corpus to the same constant as the native build', () => {
    expect(BigInt.asUintN(64, core().hd_math_corpus_hash())).toBe(CORPUS_HASH);
  });

  it('notices a single flipped bit', () => {
    const op = OPS.find((o) => o.name === 'hd_math_matrix4_compose');
    if (!op) throw new Error('compose op missing');
    const items = inputs(op).slice(0, 100);
    const expected = runThree(op, items);
    const actual = runCore(op.name, items);
    expect(mismatches(expected, actual)).toEqual([]);
    new BigUint64Array(actual.buffer)[37] ^= 1n;
    expect(mismatches(expected, actual)).toEqual([37]);
  });
});

describe('withCoreMath', () => {
  it('answers with the core, forbids the unfixed functions and restores everything', () => {
    const { sin, exp, hypot } = Math;
    const x = 0.7853981633974483;
    const inside = withCoreMath(() => {
      expect(() => Math.exp(1)).toThrow(/Math\.exp/);
      expect(() => Math.hypot(1, 2)).toThrow(/Math\.hypot/);
      return Math.sin(x);
    });
    expect(inside).toBe(core().hd_math_sin(x));
    expect(Math.sin).toBe(sin);
    expect(Math.exp).toBe(exp);
    expect(Math.hypot).toBe(hypot);
  });
});
