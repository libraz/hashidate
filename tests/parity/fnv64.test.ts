import { describe, expect, it } from 'vitest';
import { ByteWriter, fnv64, makeFnv64 } from '../../tools/parity/hash';

/**
 * The 32-bit-halves FNV-1a 64 of `tools/parity/hash.ts` against a direct BigInt
 * one, on random byte strings, so the carry arithmetic is checked rather than
 * trusted. The page hashes real avatars with the same code.
 */

const MASK = (1n << 64n) - 1n;
const OFFSET = 0xcbf2_9ce4_8422_2325n;
const PRIME = 0x100_0000_01b3n;

function reference(bytes: Uint8Array): string {
  let h = OFFSET;
  for (const b of bytes) h = ((h ^ BigInt(b)) * PRIME) & MASK;
  return h.toString(16).padStart(16, '0');
}

function splitmix64(seed: bigint): () => bigint {
  let state = seed;
  return () => {
    state = (state + 0x9e37_79b9_7f4a_7c15n) & MASK;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK;
    return z ^ (z >> 31n);
  };
}

const draw = splitmix64(0x6861_7368_6964_6174n);

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 8) {
    let word = draw();
    for (let k = i; k < Math.min(length, i + 8); k++) {
      out[k] = Number(word & 0xffn);
      word >>= 8n;
    }
  }
  return out;
}

describe('fnv64', () => {
  it('matches the published vectors', () => {
    expect(fnv64(new Uint8Array())).toBe('cbf29ce484222325');
    expect(fnv64(new TextEncoder().encode('a'))).toBe('af63dc4c8601ec8c');
    expect(fnv64(new TextEncoder().encode('foobar'))).toBe('85944171f73967e8');
  });

  it('matches a BigInt FNV-1a on 10,000 random byte strings', () => {
    let mismatches = 0;
    for (let i = 0; i < 10_000; i++) {
      const length = Number(draw() % 97n);
      const bytes = randomBytes(length);
      if (fnv64(bytes) !== reference(bytes)) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it('carries across its staging buffer', () => {
    const bytes = randomBytes(200_003);
    const sink = makeFnv64();
    for (let i = 0; i < bytes.length; i += 4097) sink.bytes(bytes.subarray(i, i + 4097));
    expect(sink.digest()).toBe(reference(bytes));
  });

  it('hashes the same bytes a ByteWriter serialises', () => {
    const values = [0, -0, Number.NaN, 1.5, -Number.MAX_VALUE, Number.POSITIVE_INFINITY];
    const nan = new Float64Array(new BigUint64Array([0x7ff4_0000_0000_0001n]).buffer)[0];
    const sink = makeFnv64();
    const writer = new ByteWriter();
    for (const out of [sink, writer]) {
      // Enough values to cross the staging buffer more than once.
      for (let round = 0; round < 3000; round++) {
        out.f64s(values);
        out.f64(nan);
        out.f32s([0.1, Number.NaN, -0]);
        out.bool(round % 2 === 0);
        out.u32(round);
        out.string(`ラウンド ${round}`);
      }
    }
    expect(sink.digest()).toBe(reference(writer.bytes()));
  });

  it('starts again on reset', () => {
    const sink = makeFnv64();
    sink.u32(7);
    sink.reset();
    expect(sink.digest()).toBe('cbf29ce484222325');
  });
});
