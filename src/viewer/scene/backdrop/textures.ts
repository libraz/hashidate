import * as THREE from 'three';
import { fbm, mulberry32 } from './noise';

/**
 * Every surface in the backdrop, drawn rather than downloaded.
 *
 * ## Why these are generated
 *
 * A photographed texture is a licence, a megabyte and a decision about whose
 * work is being redistributed — three things this tree is built to avoid, and
 * the reason `public/models/` is ignored in the first place. Generated ones cost
 * a few milliseconds at startup, live in the diff, and belong to us.
 *
 * ## Why they are not flat colours
 *
 * They could be, and that is exactly what makes a procedural room look cheap: a
 * wall painted with one RGB triple has no scale. The eye reads surface from the
 * variation across it — how the plaster mottles, how one plank differs from its
 * neighbour — and given none, it reads the geometry instead and finds a box.
 * The variation here is deliberately below the level of conscious notice; the
 * point is that it is there, not that it is seen.
 *
 * ## sRGB is handled by hand
 *
 * These write bytes into a canvas, which is an sRGB buffer, so the colours are
 * taken as packed hex and unpacked with shifts. Routing them through
 * `THREE.Color` would convert them to linear on the way in and the canvas would
 * receive values roughly twice as bright as asked for — a mistake that is
 * invisible on a mid grey and obvious on anything saturated.
 */

/** Everything the backdrop built, so it can be released in one pass. */
export type TextureBin = THREE.Texture[];

const byte = (hex: number, shift: number): number => (hex >> shift) & 0xff;
const unpack = (hex: number): [number, number, number] => [
  byte(hex, 16),
  byte(hex, 8),
  byte(hex, 0),
];

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/**
 * A canvas, or nothing.
 *
 * The test environment has no 2D context, and a backdrop is not something the
 * suite builds — but a null here has to become a plain material rather than a
 * thrown error, because the same code path is what a browser with a lost
 * context falls back to.
 */
function surface(width: number, height: number): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext('2d');
}

function finish(
  ctx: CanvasRenderingContext2D,
  bin: TextureBin,
  repeatX: number,
  repeatY: number,
): THREE.Texture {
  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  // 16× rather than the default 1×. The floor and the wall are both seen at
  // grazing angles, which is precisely where trilinear filtering turns a texture
  // into a grey smear a metre from the camera.
  tex.anisotropy = 16;
  bin.push(tex);
  return tex;
}

/**
 * A project-owned, generated raster texture.
 *
 * The room's small fabrics need the irregular weave and stitching that is hard
 * to suggest with a few lines on a canvas.  Keeping the texture in `public/`
 * still makes it a regular project asset, while this helper gives it the same
 * colour-space, filtering and disposal behaviour as the procedural textures.
 */
export function generatedFabric(
  bin: TextureBin,
  path: string,
  repeatX: number,
  repeatY: number,
): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const texture = new THREE.TextureLoader().load(path);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.anisotropy = 16;
  bin.push(texture);
  return texture;
}

/** Texture maps from one downloaded PBR material, kept in lockstep in UV space. */
export interface PbrMaps {
  color: THREE.Texture | null;
  normal: THREE.Texture | null;
  roughness: THREE.Texture | null;
}

function externalMap(
  bin: TextureBin,
  path: string,
  repeatX: number,
  repeatY: number,
  color: boolean,
): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const texture = new THREE.TextureLoader().load(path);
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.anisotropy = 16;
  bin.push(texture);
  return texture;
}

/**
 * Load the colour, normal, and roughness maps of a PBR surface.
 *
 * A normal or roughness image is data, not a photograph: marking it as sRGB
 * bends its values during decoding and makes a floor look waxy or inflated.
 */
export function pbrMaps(
  bin: TextureBin,
  paths: { color: string; normal: string; roughness: string },
  repeatX: number,
  repeatY: number,
): PbrMaps {
  return {
    color: externalMap(bin, paths.color, repeatX, repeatY, true),
    normal: externalMap(bin, paths.normal, repeatX, repeatY, false),
    roughness: externalMap(bin, paths.roughness, repeatX, repeatY, false),
  };
}

// --- surfaces ---------------------------------------------------------------

/**
 * Painted plaster.
 *
 * Two scales of variation, and the split matters. The coarse one is the
 * unevenness of a wall that was rolled by hand and reads at across-the-room
 * distance; the fine one is the tooth of the paint and only ever reads as "not
 * a gradient". Either alone looks wrong — coarse alone looks like a stain, fine
 * alone looks like film grain sitting on top of the image rather than in it.
 */
export function plaster(bin: TextureBin, hex: number, seed: number): THREE.Texture | null {
  const size = 256;
  const ctx = surface(size, size);
  if (!ctx) return null;

  const [r, g, b] = unpack(hex);
  const coarse = fbm(size, 4, seed, 3);
  const fine = fbm(size, 64, seed + 31, 2);
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    // ±5% across the wall, ±2% within a centimetre. Anything stronger stops
    // being plaster and starts being camouflage.
    const k = 1 + (coarse[i] - 0.5) * 0.1 + (fine[i] - 0.5) * 0.04;
    image.data[i * 4] = clamp255(r * k);
    image.data[i * 4 + 1] = clamp255(g * k);
    image.data[i * 4 + 2] = clamp255(b * k);
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return finish(ctx, bin, 3, 2);
}

export interface PlankOptions {
  /** Mid tone of the boards. */
  hex: number;
  /** How far individual boards stray from it, 0..1. Oak is high, painted is low. */
  spread: number;
  /** The line between boards. Darker than the boards, never black. */
  gapHex: number;
  seed: number;
}

/**
 * A plank floor.
 *
 * The board-to-board tone difference is doing more work here than the grain is.
 * A floor of identically coloured boards reads as printed paper no matter how
 * good the grain on each one is, because a real floor is cut from a tree that
 * was not uniform and laid by someone who did not sort them.
 */
export function plank(bin: TextureBin, opts: PlankOptions): THREE.Texture | null {
  const size = 512;
  const rows = 8; // boards across the tile
  const rowHeight = size / rows;
  const ctx = surface(size, size);
  if (!ctx) return null;

  const rand = mulberry32(opts.seed);
  const [r, g, b] = unpack(opts.hex);
  // Grain: the square lattice sampled with y multiplied by an integer, which
  // stretches it along the board and still wraps at the tile edge. Sampling a
  // non-integer stretch is what puts a seam down the middle of a floor.
  const grain = fbm(size, 32, opts.seed + 7, 3);

  const image = ctx.createImageData(size, size);
  for (let row = 0; row < rows; row++) {
    const tone = 1 + (rand() - 0.5) * opts.spread;
    for (let y = row * rowHeight; y < (row + 1) * rowHeight; y++) {
      for (let x = 0; x < size; x++) {
        const gy = (y * 5) % size;
        const k = tone * (1 + (grain[gy * size + x] - 0.5) * 0.22);
        const i = (y * size + x) * 4;
        image.data[i] = clamp255(r * k);
        image.data[i + 1] = clamp255(g * k);
        image.data[i + 2] = clamp255(b * k);
        image.data[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(image, 0, 0);

  // The joints, drawn over the grain rather than left as gaps in it: a board
  // edge is a shadow line on top of a continuous surface, not a hole.
  const [gr, gg, gb] = unpack(opts.gapHex);
  ctx.fillStyle = `rgba(${gr},${gg},${gb},0.85)`;
  for (let row = 0; row < rows; row++) ctx.fillRect(0, row * rowHeight, size, 1.5);
  // Butt joints, staggered. One per row is enough at the distance the floor is
  // seen from, and a regular stagger is worse than none — it reads as a grid.
  for (let row = 0; row < rows; row++) {
    const x = Math.floor(rand() * size);
    ctx.fillRect(x, row * rowHeight, 1.5, rowHeight);
  }

  return finish(ctx, bin, 3, 3);
}

/**
 * Woven cloth — curtain, duvet, rug.
 *
 * The weave itself is far too fine to resolve at any framing the stream uses.
 * What survives is the slight directional unevenness it produces, which is why
 * this is two stretched noises crossed rather than a drawn grid: a drawn grid
 * aliases into moiré the moment the surface tilts.
 */
export function weave(bin: TextureBin, hex: number, seed: number): THREE.Texture | null {
  const size = 256;
  const ctx = surface(size, size);
  if (!ctx) return null;

  const [r, g, b] = unpack(hex);
  const warp = fbm(size, 32, seed, 2);
  const weft = fbm(size, 32, seed + 13, 2);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const k = 1 + (warp[((y * 7) % size) * size + x] - 0.5) * 0.09 + (weft[i] - 0.5) * 0.07;
      image.data[i * 4] = clamp255(r * k);
      image.data[i * 4 + 1] = clamp255(g * k);
      image.data[i * 4 + 2] = clamp255(b * k);
      image.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return finish(ctx, bin, 2, 2);
}

// --- the view out ------------------------------------------------------------

export interface SkyOptions {
  /** Top-to-bottom gradient stops, as packed sRGB. */
  stops: readonly number[];
  /** Silhouetted rooflines along the bottom, or none for an upper floor. */
  skylineHex: number | null;
  /** Defocused window lights. The thing that makes a night window read as a city. */
  lights: { hex: number; count: number } | null;
  seed: number;
}

/**
 * What is outside the window.
 *
 * This is one plane a couple of metres past the glass, and it carries most of
 * the scene's mood — the room is lit *because of* what is painted here, so the
 * two are chosen together or neither is convincing.
 *
 * It is deliberately soft. A window is the brightest thing in shot and the one
 * place the eye goes first; giving it detail invites a look it cannot survive,
 * whereas a graded wash with a soft skyline reads as depth of field and holds up
 * at any framing.
 */
export function sky(bin: TextureBin, opts: SkyOptions): THREE.Texture | null {
  const w = 512;
  const h = 512;
  const ctx = surface(w, h);
  if (!ctx) return null;

  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  opts.stops.forEach((hex, i) => {
    const [r, g, b] = unpack(hex);
    gradient.addColorStop(i / Math.max(1, opts.stops.length - 1), `rgb(${r},${g},${b})`);
  });
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  const rand = mulberry32(opts.seed);

  if (opts.skylineHex !== null) {
    // Two ranks at different heights and opacities. One rank is a cardboard
    // cutout; two is distance, for the cost of a second loop.
    //
    // Both are blurred, and the near one less than the far one. A window is
    // metres past the wall and the camera is focused on a face a metre in front
    // of it, so nothing out there can be sharp — and hard-edged rectangles in a
    // window is the tell that survives every other improvement to the room. The
    // canvas filter is doing the work a depth-of-field pass would, at the cost
    // of one texture built once instead of a second render target every frame.
    const [r, g, b] = unpack(opts.skylineHex);
    for (const rank of [
      { base: h * 0.62, span: 0.16, alpha: 0.3, blur: 7 },
      { base: h * 0.74, span: 0.24, alpha: 0.62, blur: 4 },
    ]) {
      ctx.filter = `blur(${rank.blur}px)`;
      ctx.fillStyle = `rgba(${r},${g},${b},${rank.alpha})`;
      let x = -40;
      while (x < w) {
        const width = 30 + rand() * 90;
        const top = rank.base - rand() * h * rank.span;
        ctx.fillRect(x, top, width, h - top);
        x += width + rand() * 12;
      }
    }
    ctx.filter = 'none';

    // Haze, settling into the bottom of the frame. Air between here and there
    // is what stops a skyline reading as a sticker, and it is also the only
    // thing that puts the two ranks at different distances rather than merely
    // at different opacities.
    const [hr, hg, hb] = unpack(opts.stops[Math.min(1, opts.stops.length - 1)]);
    const haze = ctx.createLinearGradient(0, h * 0.5, 0, h);
    haze.addColorStop(0, `rgba(${hr},${hg},${hb},0)`);
    haze.addColorStop(1, `rgba(${hr},${hg},${hb},0.55)`);
    ctx.fillStyle = haze;
    ctx.fillRect(0, h * 0.5, w, h * 0.5);
  }

  if (opts.lights) {
    const [r, g, b] = unpack(opts.lights.hex);
    // Over the haze, not under it. A lit window carries through air that a wall
    // in shadow does not, which is why a city at night reads as points of light
    // floating in a grey mass rather than as a lit facade.
    for (let i = 0; i < opts.lights.count; i++) {
      const x = rand() * w;
      const y = h * 0.6 + rand() * h * 0.38;
      const radius = 2 + rand() * 5;
      // A radial falloff rather than a disc: an out-of-focus point source has
      // no edge, and a hard dot on a soft sky is the one thing here that would
      // announce the window as a painted plane.
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 3);
      glow.addColorStop(0, `rgba(${r},${g},${b},${0.5 + rand() * 0.5})`);
      glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(x - radius * 3, y - radius * 3, radius * 6, radius * 6);
    }
  }

  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  bin.push(tex);
  return tex;
}

/**
 * Water on glass, as an alpha map for a plane sitting just inside the window.
 *
 * Streaks and beads, not a uniform blur. A pane in rain is mostly dry — the
 * water runs in a few tracks and pools at the bottom, and reproducing that
 * unevenness is what stops it looking like frosted glass.
 *
 * Returned tiling only in Y, because the streaks are vertical and scrolling the
 * offset down the pane is what animates them.
 */
export function rain(bin: TextureBin, seed: number): THREE.Texture | null {
  const size = 256;
  const ctx = surface(size, size);
  if (!ctx) return null;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const rand = mulberry32(seed);

  ctx.lineCap = 'round';
  for (let i = 0; i < 34; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const length = 12 + rand() * 60;
    ctx.strokeStyle = `rgba(255,255,255,${0.18 + rand() * 0.5})`;
    ctx.lineWidth = 0.8 + rand() * 1.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    // A slight drift, because a running drop follows the pane's own texture and
    // never quite falls straight.
    ctx.lineTo(x + (rand() - 0.5) * 6, (y + length) % size);
    ctx.stroke();
  }
  // Beads, small and few. Generous ones read as snow rather than as water on
  // glass — a drop clinging to a vertical pane is flattened and barely there,
  // and the moment it is large enough to see clearly it is large enough to run.
  for (let i = 0; i < 46; i++) {
    const radius = 0.5 + rand() * 1.2;
    ctx.fillStyle = `rgba(255,255,255,${0.12 + rand() * 0.3})`;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  bin.push(tex);
  return tex;
}

// --- things on the wall ------------------------------------------------------

/**
 * A print for a frame.
 *
 * Abstract on purpose. Anything representational at this size is either
 * unreadable or a distraction behind someone's head, and drawing a recognisable
 * subject would put a picture in shot that has to be defensible as artwork in
 * its own right. Bands and a disc read as "a print" from across a room, which is
 * the entire job.
 */
export function art(
  bin: TextureBin,
  palette: readonly number[],
  seed: number,
): THREE.Texture | null {
  const w = 192;
  const h = 256;
  const ctx = surface(w, h);
  if (!ctx) return null;
  const rand = mulberry32(seed);

  const [br, bg, bb] = unpack(palette[0]);
  ctx.fillStyle = `rgb(${br},${bg},${bb})`;
  ctx.fillRect(0, 0, w, h);

  // Everything inside the mount is blurred and drawn well under full opacity.
  // Hard-edged bands at full saturation is what a placeholder looks like; a
  // print seen across a room is soft, low in contrast against its own paper,
  // and mostly margin. The margin is the largest single reason this reads as a
  // framed picture rather than as a coloured rectangle.
  const margin = w * 0.14;
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin, margin, w - margin * 2, h - margin * 2);
  ctx.clip();
  ctx.filter = 'blur(3px)';

  let y = margin + h * (0.12 + rand() * 0.16);
  for (let i = 1; i < palette.length; i++) {
    const [r, g, b] = unpack(palette[i]);
    const band = h * (0.07 + rand() * 0.17);
    ctx.fillStyle = `rgba(${r},${g},${b},0.44)`;
    ctx.fillRect(0, y, w, band);
    y += band;
  }

  const [dr, dg, db] = unpack(palette[palette.length - 1]);
  ctx.fillStyle = `rgba(${dr},${dg},${db},0.3)`;
  ctx.beginPath();
  ctx.arc(w * (0.34 + rand() * 0.32), h * (0.32 + rand() * 0.24), w * 0.19, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  bin.push(tex);
  return tex;
}

/**
 * What is on the monitor.
 *
 * A flat fill was the first version and it was the worst object in the night
 * room — an unlit rectangle of one colour is the only thing in a rendered
 * interior with no variation whatsoever, so the eye finds it immediately. This
 * is barely more: a couple of panes and some bars standing in for text, at low
 * contrast against the background and blurred past legibility.
 *
 * Blurred deliberately, and not only for the defocus. Anything readable on a
 * screen behind a streamer is something that has to be *decided* — a
 * recognisable application, a language, a piece of text somebody will pause and
 * read. Illegible is the only version of this that stays out of the way.
 */
export function screen(bin: TextureBin, seed: number): THREE.Texture | null {
  const w = 320;
  const h = 192;
  const ctx = surface(w, h);
  if (!ctx) return null;
  const rand = mulberry32(seed);

  ctx.fillStyle = '#1b2735';
  ctx.fillRect(0, 0, w, h);
  ctx.filter = 'blur(2.5px)';

  ctx.fillStyle = '#16202c';
  ctx.fillRect(0, 0, w * 0.22, h);
  ctx.fillStyle = '#22303f';
  ctx.fillRect(w * 0.22, 0, w * 0.78, h * 0.07);

  const tint = ['#5f7f9e', '#7e93a6', '#6f8a76', '#9a8878'];
  for (let i = 0; i < 22; i++) {
    const y = h * 0.12 + i * (h * 0.038);
    if (y > h - 8) break;
    ctx.fillStyle = tint[Math.floor(rand() * tint.length)];
    ctx.globalAlpha = 0.35 + rand() * 0.4;
    ctx.fillRect(w * 0.26 + rand() * w * 0.06, y, w * (0.1 + rand() * 0.48), h * 0.02);
  }
  ctx.globalAlpha = 1;
  ctx.filter = 'none';

  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  bin.push(tex);
  return tex;
}
