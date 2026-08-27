/**
 * Seamless value noise, which is the reason the backdrop has no image files.
 *
 * Every surface in a room is the same material repeated — plaster, plank, weave
 * — and the thing that separates a real one from a flat fill is that the repeat
 * is never exact. Downloading a texture to get that is what drags a licence and
 * a megabyte into a tree that is meant to hold neither, so the variation is
 * generated instead.
 *
 * "Seamless" is the whole requirement. A tiled surface built from noise that
 * does not wrap shows a grid of visible seams at the tile boundary, and at the
 * grazing angles a floor is seen at, that grid is the first thing the eye finds.
 * Wrapping the lattice modulo its own size costs one `%` per axis and removes
 * the problem completely.
 */

/**
 * A named seed per texture rather than `Math.random`.
 *
 * A wall that regenerates its mottling on reload is a wall that looks slightly
 * different in every clip cut from the stream, which is exactly the kind of
 * inconsistency nobody reports and everybody notices.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smoothstep, so the lattice interpolation has no first-derivative creases. */
const fade = (t: number): number => t * t * (3 - 2 * t);

/**
 * One octave: a `cells`×`cells` lattice of random values, bilinearly
 * interpolated over `size`×`size` samples and wrapping at the edges.
 */
function octave(size: number, cells: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();

  const out = new Float32Array(size * size);
  const scale = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * scale;
    const y0 = Math.floor(fy);
    const ty = fade(fy - y0);
    const ry0 = (y0 % cells) * cells;
    const ry1 = ((y0 + 1) % cells) * cells;
    for (let x = 0; x < size; x++) {
      const fx = x * scale;
      const x0 = Math.floor(fx);
      const tx = fade(fx - x0);
      const rx0 = x0 % cells;
      const rx1 = (x0 + 1) % cells;
      const top = lattice[ry0 + rx0] * (1 - tx) + lattice[ry0 + rx1] * tx;
      const bot = lattice[ry1 + rx0] * (1 - tx) + lattice[ry1 + rx1] * tx;
      out[y * size + x] = top * (1 - ty) + bot * ty;
    }
  }
  return out;
}

/**
 * Fractal noise in `[0, 1]`, seamless over `size`×`size`.
 *
 * Four octaves is where this stops paying: the fifth lands below one 8-bit
 * level once the amplitudes have halved four times, so it costs a full pass
 * over the buffer to write nothing.
 *
 * @param size   Texture edge in pixels.
 * @param cells  Lattice size of the coarsest octave. Must divide `size`.
 */
export function fbm(size: number, cells: number, seed: number, octaves = 4): Float32Array {
  const out = new Float32Array(size * size);
  let amplitude = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const layer = octave(size, cells << o, seed + o * 977);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amplitude;
    total += amplitude;
    amplitude *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}
