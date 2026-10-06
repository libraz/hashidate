import * as THREE from 'three';
import type { TextureBin } from './textures';

/**
 * What the window shows, and the weather on the glass it is seen through.
 *
 * The view is a crop of a photographed panorama, sampled by the direction from
 * the camera rather than painted on a plane behind the opening. That is what a
 * view a city away actually does: it is at infinity, so it slides with the
 * camera's angle and never with its position, and the frame of the window moves
 * across it rather than carrying it along.
 *
 * Rain is the same material, not a layer over it. Water on glass is a lens —
 * each bead shows a small inverted image of what is behind it — so a drop can
 * only look like water if it is drawn by sampling the view, offset by the shape
 * of the drop. A white alpha streak over the pane is what it looked like before,
 * and it read as scratches.
 *
 * The panoramas are CC0 from Poly Haven; see `VIEWS` for which is which.
 */

export interface View {
  /** Equirectangular crop under `public/textures/`, centred straight ahead. */
  path: string;
  /** Angular extent of the crop, in degrees. */
  yawSpan: number;
  pitchSpan: number;
  /**
   * Where the photograph's horizon sits, in degrees above the camera's eye
   * line. The bust framing sees the opening from about 0° to +14°, so this
   * decides which band of the photograph that is.
   */
  horizon: number;
  /** Horizontal aim within the crop, in degrees; the pane stays fixed. */
  yawOffset?: number;
}

/**
 * The four crops, 100° by 70° out of 8K tonemapped panoramas.
 *
 * Each is turned so the part worth seeing lands about 12° right of straight
 * ahead, which is where the window is from the bust framing.
 */
export const VIEWS = {
  /** `sunset_jhbcentral`: rooftops over a street, the last light behind them. */
  dusk: { path: '/textures/view-dusk.jpg', yawSpan: 100, pitchSpan: 70, horizon: 0 },
  /**
   * `shanghai_bund`: aim toward the towers so their lights appear in the pane,
   * rather than leaving the visible band as empty sky. The horizon stays low
   * so the promenade remains below the sill.
   */
  night: {
    path: '/textures/view-night.jpg',
    yawSpan: 100,
    pitchSpan: 70,
    horizon: 0,
    yawOffset: -32,
  },
  /** `hotel_rooftop_balcony`: a coastal town under a white sky. */
  morning: { path: '/textures/view-morning.jpg', yawSpan: 100, pitchSpan: 70, horizon: 9 },
  /** `urban_street_01`: a leafy residential street with damp paving. */
  rain: { path: '/textures/view-rain.jpg', yawSpan: 100, pitchSpan: 70, horizon: -4 },
} as const satisfies Record<string, View>;

export interface OutlookOptions {
  /** Multiplies the photograph. Tuned per room against its exposure. */
  intensity: number;
  /** 0 is grey, 1 is the photograph as shot. */
  saturation: number;
  /** Air between here and there, mixed in toward the horizon. */
  haze: { hex: number; amount: number };
  /**
   * Defocus, in mip levels. The camera is focused on a face a metre in front of
   * the glass, so nothing outside is sharp even on a clear day.
   */
  defocus: number;
  /** 0 for a dry pane. 1 is steady rain with the glass misted over. */
  rain: number;
  /** Pane size in metres, so drops are a physical size on any window. */
  pane: { width: number; height: number };
}

export interface Outlook {
  material: THREE.ShaderMaterial;
  update: (dt: number) => void;
}

const vertexShader = /* glsl */ `
varying vec3 vWorld;
varying vec2 vUv;

void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uView;
uniform vec2 uSpan;
uniform float uHorizon;
uniform float uYawOffset;
uniform float uIntensity;
uniform float uSaturation;
uniform vec3 uHaze;
uniform float uHazeAmount;
uniform float uDefocus;
uniform float uRain;
uniform float uTime;
uniform vec2 uPane;

varying vec3 vWorld;
varying vec2 vUv;

#define PI 3.14159265

float hash(vec2 p) {
  p = fract(p * vec2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

vec2 hash2(vec2 p) {
  float n = hash(p);
  return vec2(n, hash(p + n));
}

// The photograph, looked up by direction and offset by whatever the water bends.
vec3 outside(vec3 dir, vec2 bend, float lod) {
  float yaw = atan(dir.x, -dir.z);
  float pitch = asin(clamp(dir.y, -1.0, 1.0));
  vec2 uv = vec2(0.5 + (yaw + uYawOffset) / uSpan.x, 0.5 + (pitch - uHorizon) / uSpan.y) + bend;
  vec3 c = textureLod(uView, uv, lod).rgb;
  // Haze settles at the horizon and thins above it, as air does over a city.
  float h = exp(-abs(pitch - uHorizon) * 4.0) * uHazeAmount;
  return mix(c, uHaze, h);
}

// Rain falling outside, a few metres off: thin, fast and only just visible.
float downpour(vec3 dir) {
  float yaw = atan(dir.x, -dir.z);
  float pitch = asin(clamp(dir.y, -1.0, 1.0));
  float sum = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float density = 180.0 + fi * 140.0;
    vec2 p = vec2(yaw + pitch * 0.06, pitch) * density;
    p.y += uTime * (26.0 + fi * 9.0);
    vec2 cell = floor(vec2(p.x, p.y / 14.0));
    float r = hash(cell + fi * 17.0);
    float x = abs(fract(p.x) - 0.5);
    float y = fract(p.y / 14.0 + r);
    float streak = smoothstep(0.12, 0.0, x) * smoothstep(0.0, 0.05, y) * smoothstep(0.32, 0.12, y);
    sum += streak * step(0.55, r) * (0.55 - fi * 0.12);
  }
  return sum;
}

// Beads that cling: a grid with at most one drop per cell, each of which grows
// in, sits, and evaporates on its own clock. xy is the bend, z the coverage.
vec3 beads(vec2 p, float cell, float t) {
  vec2 id = floor(p / cell);
  vec2 local = fract(p / cell) - 0.5;
  vec2 r = hash2(id);
  vec2 centre = (r - 0.5) * 0.6;
  float life = fract(t * (0.04 + r.y * 0.05) + r.x);
  float size = r.x * r.x;
  float radius = (0.1 + size * 0.32) * smoothstep(0.0, 0.1, life) * smoothstep(1.0, 0.7, life);
  vec2 d = local - centre;
  // Flattened a little: a drop on a vertical pane sags.
  d.y *= 1.0 + 0.25 * sign(d.y);
  float dist = length(d);
  float aa = fwidth(dist) + 1e-4;
  float m = smoothstep(radius + aa, radius - aa, dist) * step(0.55, r.y);
  return vec3(d / max(radius, 1e-3) * m, m);
}

// Drops heavy enough to run. Each column carries one at a time; it creeps, lets
// go, and leaves a cleared track with a few small beads stranded in it.
vec4 runners(vec2 p, float t) {
  float colWidth = 0.07;
  float col = floor(p.x / colWidth);
  float r = hash(vec2(col, 3.7));
  if (r < 0.35) return vec4(0.0);
  float period = 5.0 + r * 9.0;
  float phase = fract(t / period + r * 7.0);
  // Stick-slip: most of the period near the top, then a run to the sill.
  float fall = pow(phase, 2.2 + r * 1.5);
  float y = uPane.y * (1.05 - fall * 1.15);
  float wobble = sin(p.y * 38.0 + r * 30.0) * 0.004 + sin(p.y * 9.0 + r * 11.0) * 0.006;
  float x = (col + 0.3 + r * 0.4) * colWidth + wobble;
  vec2 d = vec2(p.x - x, p.y - y);
  float radius = 0.011 + r * 0.007;
  vec2 shaped = d * vec2(1.0, d.y > 0.0 ? 0.55 : 1.0);
  float dist = length(shaped);
  float aa = fwidth(dist) + 1e-4;
  float drop = smoothstep(radius + aa, radius - aa, dist);
  // The track above the drop, fading with age. Width tapers as it dries.
  float above = p.y - y;
  float age = clamp(above / (0.25 + r * 0.35), 0.0, 1.0);
  float track = step(0.0, above) * (1.0 - age) * smoothstep(radius * 0.7, radius * 0.25, abs(d.x));
  // A few stranded beads along it.
  float bead = 0.0;
  vec2 bp = vec2(d.x, above) / 0.018;
  vec2 bid = floor(bp);
  vec2 bl = fract(bp) - 0.5;
  float br = hash(bid + col);
  bead = smoothstep(0.22, 0.12, length(bl - vec2(0.0, br - 0.5) * 0.3)) * step(0.6, br) * track * 2.0;
  bead = clamp(bead, 0.0, 1.0);
  vec2 bend = shaped / radius * drop + bl * 0.6 * bead;
  return vec4(bend, max(drop, bead), track);
}

void main() {
  vec3 dir = normalize(vWorld - cameraPosition);
  vec2 bend = vec2(0.0);
  float water = 0.0;
  float clear = 0.0;

  if (uRain > 0.0) {
    vec2 p = vUv * uPane;
    vec3 big = beads(p, 0.024, uTime);
    vec3 small = beads(p + 0.37, 0.011, uTime * 1.3);
    vec4 run = runners(p, uTime);
    bend = big.xy + small.xy * 0.6 + run.xy;
    water = max(max(big.z, small.z * 0.8), run.z);
    clear = run.w;
  }

  // A drop is a tiny lens: it shows a wide patch of the scene, sharp and flipped.
  vec2 lensBend = -bend * vec2(0.02, 0.028);
  float mist = uRain * 0.7 * (1.0 - clear * 0.8);
  float lod = mix(uDefocus + mist, uDefocus * 0.5, water);
  vec3 colour = outside(dir, lensBend, lod);

  if (uRain > 0.0) {
    colour += vec3(downpour(dir)) * 0.13 * uRain * (1.0 - water);
    // Condensation lifts the blacks and greys the view; the tracks cut through it.
    float fog = 0.16 * uRain * (1.0 - clear) * (1.0 - water);
    colour = mix(colour, vec3(dot(colour, vec3(0.333))) + 0.04, fog);
    // The rim of a drop bends light past the camera and goes dark; the room's
    // window light sits as a pinpoint near the top.
    float r = length(bend);
    colour *= 1.0 - water * smoothstep(0.6, 1.0, r) * 0.25;
    colour += water * smoothstep(0.28, 0.0, length(bend - vec2(-0.3, 0.45))) * 0.3;
  }

  float grey = dot(colour, vec3(0.2126, 0.7152, 0.0722));
  colour = mix(vec3(grey), colour, uSaturation) * uIntensity;

  gl_FragColor = vec4(colour, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const deg = THREE.MathUtils.degToRad;

/** Load a view and build the material that shows it. */
export function outlook(bin: TextureBin, view: View, opts: OutlookOptions): Outlook {
  let map: THREE.Texture | null = null;
  if (typeof document !== 'undefined') {
    map = new THREE.TextureLoader().load(view.path);
    map.colorSpace = THREE.SRGBColorSpace;
    // Trilinear, because defocus and condensation are both a mip level.
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.anisotropy = 4;
    bin.push(map);
  }
  const haze = new THREE.Color(opts.haze.hex);
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uView: { value: map },
      uSpan: { value: new THREE.Vector2(deg(view.yawSpan), deg(view.pitchSpan)) },
      uHorizon: { value: deg(view.horizon) },
      uYawOffset: { value: deg(view.yawOffset ?? 0) },
      uIntensity: { value: opts.intensity },
      uSaturation: { value: opts.saturation },
      uHaze: { value: haze },
      uHazeAmount: { value: opts.haze.amount },
      uDefocus: { value: opts.defocus },
      uRain: { value: opts.rain },
      uTime: { value: 0 },
      uPane: { value: new THREE.Vector2(opts.pane.width, opts.pane.height) },
    },
  });
  material.toneMapped = true;
  const time = material.uniforms.uTime;
  return {
    material,
    // Wrapped well inside float precision; the slowest drop clock is ~25 s.
    update: (dt) => {
      time.value = (time.value + dt) % 3600;
    },
  };
}
