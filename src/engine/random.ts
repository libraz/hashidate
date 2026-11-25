/**
 * Seeded draws for the parts of a turn every renderer has to agree on.
 *
 * A turn the server queued reaches each renderer under the same id, so a
 * stream seeded from that id gives the stage and OBS the same gesture
 * variation, nods, break blinks and onset aversion. Each draw site gets its
 * own stream: one shared stream would be consumed in a frame-rate-dependent
 * order and every later draw would shift with it.
 */

const MASK = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf2_9ce4_8422_2325n;
const FNV_PRIME = 0x0000_0100_0000_01b3n;

/** Where a seeded turn draws from. */
export type TurnDrawSite = 'gesture' | 'nod' | 'blink' | 'gaze';

/** Draws in [0, 1) from splitmix64. */
export function splitmix64(seed: bigint): () => number {
  let state = seed;
  return () => {
    state = (state + 0x9e37_79b9_7f4a_7c15n) & MASK;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK;
    z ^= z >> 31n;
    return Number(z >> 11n) / 2 ** 53;
  };
}

/** 64-bit FNV-1a over the UTF-8 bytes of `text`. */
export function fnv1a64(text: string): bigint {
  let h = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    h = ((h ^ BigInt(byte)) * FNV_PRIME) & MASK;
  }
  return h;
}

/** The stream one draw site of turn `id` reads, the same on every renderer. */
export function turnRandom(id: string, site: TurnDrawSite): () => number {
  return splitmix64(fnv1a64(`${id}:${site}`));
}
