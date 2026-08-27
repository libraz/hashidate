import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mulberry32 } from './noise';

/**
 * The furniture, as geometry.
 *
 * ## Why none of this is a model file
 *
 * A room is boxes. Almost every object below genuinely *is* a box, a cylinder or
 * a swept curve, and modelling it in Blender to export a GLB would buy nothing
 * except a binary that `public/models/` already ignores and that no diff can
 * show. Written out it is parametric — four rooms share one shelf builder and
 * differ in what they put on it — and it survives review.
 *
 * ## What actually makes it not look cheap
 *
 * Five things, in order of how much they matter, none of which is polygon count:
 *
 * 1. **Edges are never sharp.** Real objects have a fillet, a chamfer or a
 *    rounded-over edge, and the highlight that runs along it is most of what
 *    tells the eye a surface is solid. A perfect 90° corner reads as a render.
 *    Hence `RoundedBoxGeometry` almost everywhere, at radii small enough that
 *    the shape is unchanged.
 * 2. **Walls have thickness.** A window cut into a plane has no reveal, and the
 *    missing few centimetres of returned surface is the single most obvious
 *    tell in an amateur interior. These walls are boxes with a 120 mm section
 *    and the reveal comes for free.
 * 3. **Nothing repeats exactly.** Book heights, plank tones, the tilt of a
 *    frame: all seeded, all slightly off. Regularity is the signature of
 *    generated geometry and irregularity costs one call to a PRNG.
 * 4. **Cloth has folds.** A curtain as a flat quad is a coloured rectangle. The
 *    folds are what catch the window light and give the panel a form, and they
 *    are three lines of vertex displacement.
 * 5. **Everything casts and receives.** Contact shadow is what puts an object
 *    on a floor rather than in front of one.
 */

/** Room extents. The avatar stands at the origin, facing the camera at +Z. */
export const ROOM = {
  halfWidth: 2.6,
  height: 2.6,
  /** Back wall, and the only wall the bust framing ever sees. */
  backZ: -2.4,
  /** The side walls run past the camera, so no shot ever finds their near end. */
  frontZ: 4.0,
  wallThickness: 0.12,
} as const;

/**
 * The window opening, in back-wall coordinates.
 *
 * Off centre, and deliberately. Behind the avatar's head is the one part of the
 * wall guaranteed to be occluded, so putting the brightest object in the room
 * there wastes it and haloes the silhouette. At the 28° framing this sits on the
 * right third with both its head and its sill inside the frame.
 */
export const WINDOW = {
  centerX: 0.85,
  width: 1.05,
  sillY: 0.86,
  headY: 2.06,
} as const;

/** A rounded box, sized in metres, with the fillet given in millimetres. */
export function slab(
  width: number,
  height: number,
  depth: number,
  material: THREE.Material,
  filletMm = 6,
): THREE.Mesh {
  const radius = Math.min(filletMm / 1000, Math.min(width, height, depth) / 2.05);
  const geometry =
    radius > 0.0005
      ? new RoundedBoxGeometry(width, height, depth, 2, radius)
      : new THREE.BoxGeometry(width, height, depth);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A plain box for surfaces too large for a fillet to be visible or affordable. */
/**
 * A plain box, for surfaces too large for a fillet to read.
 *
 * Its own geometry rather than a shared unit cube scaled to fit: the backdrop
 * releases everything it built by walking its own graph, and a geometry shared
 * across two backdrops would be disposed by the first one torn down and leave
 * the next one drawing nothing.
 *
 * Walls cast as well as receive. That is what turns a directional light outside
 * the window into a shaft with the sash printed on it, which is most of what
 * sells the window as an opening rather than a bright rectangle.
 */
function plate(width: number, height: number, depth: number, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// --- the shell ---------------------------------------------------------------

export interface ShellMaterials {
  wall: THREE.Material;
  floor: THREE.Material;
  ceiling: THREE.Material;
  trim: THREE.Material;
}

/**
 * Floor, ceiling, three walls and the skirting, with the window left as a hole.
 *
 * The opening is made by building the back wall as four panels around it rather
 * than by subtracting a solid. CSG would need a library and would produce the
 * same four rectangles.
 */
export function shell(m: ShellMaterials): THREE.Group {
  const group = new THREE.Group();
  const width = ROOM.halfWidth * 2;
  const depth = ROOM.frontZ - ROOM.backZ;
  const midZ = (ROOM.frontZ + ROOM.backZ) / 2;
  const t = ROOM.wallThickness;

  const floor = plate(width, t, depth, m.floor);
  floor.position.set(0, -t / 2, midZ);
  group.add(floor);

  const ceiling = plate(width, t, depth, m.ceiling);
  ceiling.position.set(0, ROOM.height + t / 2, midZ);
  group.add(ceiling);

  // The side walls and the ceiling receive light and do not block it.
  //
  // Deliberate, and the single most important cheat in the file. A room lit only
  // through the one window it can show is a room lit from behind, and a subject
  // lit from behind has no face — so the key comes from the camera's left, from
  // a window in a wall the shot never sees. If these panels cast, that light
  // never arrives and the room falls back to ambient, which is exactly what
  // "cheap procedural interior" looks like.
  //
  // The back wall still casts, which is what matters: the shaft coming through
  // the real window is cut to the shape of the opening, and the sash prints on
  // the floor.
  for (const side of [-1, 1]) {
    const wall = plate(t, ROOM.height, depth, m.wall);
    wall.position.set(side * (ROOM.halfWidth + t / 2), ROOM.height / 2, midZ);
    wall.castShadow = false;
    group.add(wall);
  }
  ceiling.castShadow = false;
  // A floor casting onto itself is nothing but an opportunity for acne.
  floor.castShadow = false;

  const left = WINDOW.centerX - WINDOW.width / 2;
  const right = WINDOW.centerX + WINDOW.width / 2;
  const backZ = ROOM.backZ - t / 2;
  const panels: [number, number, number, number][] = [
    // [centreX, centreY, width, height]
    [0, WINDOW.sillY / 2, width, WINDOW.sillY],
    [0, (WINDOW.headY + ROOM.height) / 2, width, ROOM.height - WINDOW.headY],
    [
      (-ROOM.halfWidth + left) / 2,
      (WINDOW.sillY + WINDOW.headY) / 2,
      left + ROOM.halfWidth,
      WINDOW.headY - WINDOW.sillY,
    ],
    [
      (right + ROOM.halfWidth) / 2,
      (WINDOW.sillY + WINDOW.headY) / 2,
      ROOM.halfWidth - right,
      WINDOW.headY - WINDOW.sillY,
    ],
  ];
  for (const [x, y, w, h] of panels) {
    const panel = plate(w, h, t, m.wall);
    panel.position.set(x, y, backZ);
    group.add(panel);
  }

  // Skirting. Seventy millimetres of painted timber that nobody looks at and
  // whose absence makes a room look like a cardboard box, because the
  // wall-meets-floor junction is otherwise a mathematically perfect line.
  const skirt = slab(width, 0.07, 0.018, m.trim, 3);
  skirt.position.set(0, 0.035, ROOM.backZ + 0.009);
  group.add(skirt);
  for (const side of [-1, 1]) {
    const run = slab(0.018, 0.07, depth * 0.6, m.trim, 3);
    run.position.set(side * (ROOM.halfWidth - 0.009), 0.035, ROOM.backZ + depth * 0.3);
    group.add(run);
  }

  return group;
}

export interface CasementMaterials {
  frame: THREE.Material;
  glass: THREE.Material;
  view: THREE.Material;
  sill: THREE.Material;
}

/**
 * The window: reveal lining, sash, glazing bars, sill, glass and the view.
 *
 * The view is a plane 1.8 m behind the glass, not a texture on the glass. That
 * separation is doing real work — it parallaxes as the camera moves, and it
 * means the outside is genuinely outside rather than a picture hung in the
 * opening, which is visible the instant the shot changes from bust to full.
 */
export function casement(m: CasementMaterials): THREE.Group {
  const group = new THREE.Group();
  const height = WINDOW.headY - WINDOW.sillY;
  const centerY = (WINDOW.headY + WINDOW.sillY) / 2;
  const z = ROOM.backZ - ROOM.wallThickness / 2;

  // The sash: four members around the opening, inset into the reveal.
  const bar = 0.045;
  const sashZ = z + 0.02;
  for (const [w, h, x, y] of [
    [WINDOW.width, bar, WINDOW.centerX, WINDOW.sillY + bar / 2],
    [WINDOW.width, bar, WINDOW.centerX, WINDOW.headY - bar / 2],
    [bar, height, WINDOW.centerX - WINDOW.width / 2 + bar / 2, centerY],
    [bar, height, WINDOW.centerX + WINDOW.width / 2 - bar / 2, centerY],
  ] as const) {
    const member = slab(w, h, 0.05, m.frame, 4);
    member.position.set(x, y, sashZ);
    group.add(member);
  }

  // One vertical bar and one horizontal. Two panes each way is a domestic
  // window; a single sheet reads as an office and a grid of nine as a cottage.
  const mullion = slab(0.03, height - bar * 2, 0.045, m.frame, 3);
  mullion.position.set(WINDOW.centerX, centerY, sashZ);
  group.add(mullion);
  const transom = slab(WINDOW.width - bar * 2, 0.03, 0.045, m.frame, 3);
  transom.position.set(WINDOW.centerX, centerY + height * 0.12, sashZ);
  group.add(transom);

  const glass = new THREE.Mesh(new THREE.PlaneGeometry(WINDOW.width, height), m.glass);
  glass.position.set(WINDOW.centerX, centerY, z + 0.005);
  group.add(glass);

  const view = new THREE.Mesh(new THREE.PlaneGeometry(WINDOW.width * 2.6, height * 2.6), m.view);
  view.position.set(WINDOW.centerX, centerY + 0.15, z - 1.8);
  group.add(view);

  // The sill, projecting into the room. It is what the light landing on it
  // proves the window is a hole rather than a bright rectangle.
  const sill = slab(WINDOW.width + 0.16, 0.032, 0.19, m.sill, 5);
  sill.position.set(WINDOW.centerX, WINDOW.sillY - 0.016, ROOM.backZ + 0.06);
  group.add(sill);

  return group;
}

/**
 * A rain-streaked pane, sitting just inside the glass.
 *
 * Its own plane rather than a map on the glass material so the streaks can be
 * scrolled without touching anything else, and so the dry pane stays specular
 * where the water is not.
 */
export function wetPane(material: THREE.Material): THREE.Mesh {
  const height = WINDOW.headY - WINDOW.sillY;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(WINDOW.width, height), material);
  mesh.position.set(
    WINDOW.centerX,
    (WINDOW.headY + WINDOW.sillY) / 2,
    ROOM.backZ - ROOM.wallThickness / 2 + 0.012,
  );
  return mesh;
}

// --- cloth -------------------------------------------------------------------

/**
 * A hanging panel with folds in it.
 *
 * The folds are a sum of two sines at incommensurate frequencies, which is the
 * cheapest thing that does not look like corrugated iron — a single sine gives
 * every fold the same width and the regularity is immediately legible as
 * generated. The envelope tapers the displacement to nothing at the rod, since
 * a curtain is gathered flat where it is hung and swings free at the hem.
 */
export function foldedPanel(
  width: number,
  height: number,
  material: THREE.Material,
  amplitude = 0.045,
  folds = 7,
): THREE.Mesh {
  const segments = Math.max(24, folds * 6);
  const geometry = new THREE.PlaneGeometry(width, height, segments, 12);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const u = position.getX(i) / width + 0.5;
    const v = position.getY(i) / height + 0.5; // 0 at hem, 1 at rod
    /**
     * Clamped, because the top row does not land on exactly 1.
     *
     * `PlaneGeometry` walks its rows as `iy * (height / rows) - height / 2`, and
     * for a 1.62 m drop over twelve rows that accumulates to 1.0000000000000002
     * here. A fractional power of the resulting −2 × 10⁻¹⁶ is NaN, which
     * propagates into the vertex, into the bounding sphere, and out to a mesh
     * that frustum culling can no longer reason about — visible as a curtain
     * that vanishes at some camera angles and not others, from a rounding error
     * two hundred quadrillionths wide.
     */
    const fromRod = Math.max(0, 1 - v);
    const envelope = 0.35 + 0.65 * fromRod ** 0.7;
    const fold =
      Math.sin(u * Math.PI * 2 * folds) * 0.75 + Math.sin(u * Math.PI * 2 * folds * 1.618) * 0.25;
    // The hem falls away from the wall as well as rippling across it, or the
    // panel hangs like a poster stuck to the plaster.
    position.setZ(i, fold * amplitude * envelope + fromRod * fromRod * amplitude * 1.2);
  }
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** The pair of panels either side of the window, plus the rod they hang from. */
export function curtains(
  cloth: THREE.Material,
  rodMaterial: THREE.Material,
  opts: { drop?: number; coverage?: number; amplitude?: number } = {},
): THREE.Group {
  const group = new THREE.Group();
  const drop = opts.drop ?? WINDOW.headY - WINDOW.sillY + 0.42;
  const coverage = opts.coverage ?? 0.34;
  const top = WINDOW.headY + 0.16;
  const width = WINDOW.width * coverage;

  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(0.014, 0.014, WINDOW.width + 0.42, 12),
    rodMaterial,
  );
  // Clear of the sill, which projects 95 mm into the room from the reveal. Hung
  // any closer and the sill's front edge surfaces through the back of a fold —
  // a row of pale rectangles across the cloth that reads as a texture bug rather
  // than as the intersection it is.
  const hang = ROOM.backZ + 0.24;

  rod.rotation.z = Math.PI / 2;
  rod.position.set(WINDOW.centerX, top + 0.02, hang + 0.01);
  rod.castShadow = true;
  group.add(rod);

  for (const side of [-1, 1]) {
    const panel = foldedPanel(width, drop, cloth, opts.amplitude ?? 0.045, 6);
    panel.position.set(
      WINDOW.centerX + side * (WINDOW.width / 2 - width / 2 + 0.09),
      top - drop / 2,
      hang,
    );
    group.add(panel);
  }
  return group;
}

// --- things in the room ------------------------------------------------------

export interface ShelfOptions {
  width: number;
  /** Book spine colours to draw from. */
  spines: readonly number[];
  seed: number;
}

/**
 * A bracket shelf with books on it.
 *
 * The books are the point. They are the only object in the room with enough
 * instances for irregularity to register as texture rather than as a mistake,
 * so their heights, thicknesses and lean are all seeded — and one in seven is
 * laid flat, because a shelf where every book is upright has been arranged by a
 * loop.
 */
export function shelf(board: THREE.Material, opts: ShelfOptions): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(opts.seed);
  const depth = 0.2;

  const plank = slab(opts.width, 0.026, depth, board, 4);
  plank.position.set(0, 0, 0);
  group.add(plank);

  for (const side of [-1, 1]) {
    const bracket = slab(0.02, 0.11, depth * 0.8, board, 2);
    bracket.position.set(side * (opts.width / 2 - 0.09), -0.068, -0.01);
    group.add(bracket);
  }

  const spineMaterials = opts.spines.map(
    (hex) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.82 }),
  );

  let x = -opts.width / 2 + 0.06;
  while (x < opts.width / 2 - 0.12) {
    const material = spineMaterials[Math.floor(rand() * spineMaterials.length)];
    if (rand() < 0.14) {
      // A short stack lying down, which is what a shelf that gets used looks
      // like and what stops the row reading as a single extruded strip.
      const stack = 2 + Math.floor(rand() * 3);
      const stackWidth = 0.13 + rand() * 0.05;
      for (let i = 0; i < stack; i++) {
        const book = slab(stackWidth, 0.022 + rand() * 0.008, depth * 0.7, material, 2);
        book.position.set(x + stackWidth / 2, 0.026 + i * 0.028, -0.01 + (rand() - 0.5) * 0.012);
        book.rotation.y = (rand() - 0.5) * 0.1;
        group.add(book);
      }
      x += stackWidth + 0.02;
      continue;
    }
    const thickness = 0.014 + rand() * 0.026;
    const height = 0.17 + rand() * 0.09;
    const book = slab(thickness, height, depth * 0.72, material, 2);
    const lean = rand() < 0.12 ? (rand() - 0.5) * 0.28 : 0;
    book.position.set(x + thickness / 2, 0.013 + height / 2, -0.012);
    book.rotation.z = lean;
    book.position.y -= Math.abs(lean) * height * 0.06;
    group.add(book);
    x += thickness + 0.002 + Math.abs(lean) * 0.05;
  }

  return group;
}

export interface DeskMaterials {
  top: THREE.Material;
  leg: THREE.Material;
  screen: THREE.Material;
  glow: THREE.Material;
}

/**
 * A desk with a monitor on it.
 *
 * The screen is a separate emissive plane inset into the bezel rather than an
 * emissive face on the body, so it can be the room's key light without the
 * casing glowing along with it.
 */
export function desk(m: DeskMaterials, opts: { width: number; screenWidth: number }): THREE.Group {
  const group = new THREE.Group();
  const depth = 0.58;
  const height = 0.73;

  const top = slab(opts.width, 0.03, depth, m.top, 5);
  top.position.set(0, height, 0);
  group.add(top);

  for (const sx of [-1, 1]) {
    const leg = slab(0.04, height, 0.04, m.leg, 3);
    leg.position.set(sx * (opts.width / 2 - 0.05), height / 2, -depth / 2 + 0.05);
    group.add(leg);
    const front = slab(0.04, height, 0.04, m.leg, 3);
    front.position.set(sx * (opts.width / 2 - 0.05), height / 2, depth / 2 - 0.05);
    group.add(front);
  }

  const screenHeight = opts.screenWidth * 0.58;
  const body = slab(opts.screenWidth, screenHeight, 0.022, m.screen, 4);
  body.position.set(0, height + 0.06 + screenHeight / 2, -depth / 2 + 0.12);
  group.add(body);

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(opts.screenWidth - 0.024, screenHeight - 0.024),
    m.glow,
  );
  panel.position.copy(body.position);
  panel.position.z += 0.013;
  group.add(panel);

  const stem = slab(0.05, 0.1, 0.04, m.screen, 3);
  stem.position.set(0, height + 0.05, -depth / 2 + 0.12);
  group.add(stem);
  const foot = slab(0.22, 0.014, 0.14, m.screen, 4);
  foot.position.set(0, height + 0.022, -depth / 2 + 0.14);
  group.add(foot);

  return group;
}

/**
 * A desk lamp, and the only light in the room the viewer can see the source of.
 *
 * The shade is an open cone with the emissive disc recessed inside it, so the
 * bulb is hidden at eye level and the pool it throws is visibly coming from
 * somewhere. A bare emissive sphere in the same place is the difference between
 * a lamp and a floating dot.
 */
export function lamp(shadeMaterial: THREE.Material, bulbMaterial: THREE.Material): THREE.Group {
  const group = new THREE.Group();

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.018, 20), shadeMaterial);
  base.position.y = 0.009;
  base.castShadow = true;
  group.add(base);

  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.34, 10), shadeMaterial);
  arm.position.set(0, 0.18, 0);
  arm.rotation.z = 0.22;
  arm.castShadow = true;
  group.add(arm);

  const shade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.105, 0.11, 22, 1, true),
    shadeMaterial,
  );
  shade.position.set(-0.075, 0.36, 0.02);
  shade.rotation.set(0.5, 0, 0.38);
  shade.castShadow = true;
  group.add(shade);

  const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.095, 20), bulbMaterial);
  bulb.position.copy(shade.position);
  bulb.position.y -= 0.038;
  bulb.rotation.set(-Math.PI / 2 + 0.5, 0, 0.38);
  group.add(bulb);

  return group;
}

/**
 * A leaf, as a shape rather than an alpha-cut card.
 *
 * A card needs a cutout texture, and a cutout texture at this size either
 * aliases along the edge or costs a mip chain to avoid it. The silhouette is two
 * quadratic curves, which is one draw and a clean edge at any distance.
 */
function leafGeometry(length: number, width: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.quadraticCurveTo(width, length * 0.42, 0, length);
  shape.quadraticCurveTo(-width, length * 0.42, 0, 0);
  const geometry = new THREE.ShapeGeometry(shape, 10);
  // A curl along the leaf. Flat leaves stack into a fan and read as paper.
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const t = position.getY(i) / length;
    const x = position.getX(i);
    position.setZ(i, -(t * t) * length * 0.22 - ((x * x) / width) * 0.35);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export interface PlantOptions {
  leaves: number;
  height: number;
  seed: number;
}

/** A potted plant. Organic silhouette in a room that is otherwise all right angles. */
export function plant(
  potMaterial: THREE.Material,
  leafMaterial: THREE.Material,
  opts: PlantOptions,
): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(opts.seed);
  const potHeight = opts.height * 0.26;
  const potRadius = opts.height * 0.19;

  const pot = new THREE.Mesh(
    new THREE.CylinderGeometry(potRadius, potRadius * 0.78, potHeight, 22),
    potMaterial,
  );
  pot.position.y = potHeight / 2;
  pot.castShadow = true;
  pot.receiveShadow = true;
  group.add(pot);

  const soil = new THREE.Mesh(
    new THREE.CircleGeometry(potRadius * 0.94, 22),
    new THREE.MeshStandardMaterial({ color: 0x2a2320, roughness: 1 }),
  );
  soil.rotation.x = -Math.PI / 2;
  soil.position.y = potHeight - 0.004;
  group.add(soil);

  for (let i = 0; i < opts.leaves; i++) {
    const length = opts.height * (0.42 + rand() * 0.38);
    const leaf = new THREE.Mesh(leafGeometry(length, length * 0.19), leafMaterial);
    leaf.castShadow = true;
    // Spread by golden angle rather than evenly: an even fan has a visible
    // rotational period and a plant does not.
    const around = i * 2.39996 + rand() * 0.3;
    leaf.rotation.order = 'YXZ';
    leaf.rotation.y = around;
    leaf.rotation.x = 0.25 + rand() * 0.55;
    leaf.position.set(
      Math.cos(around) * potRadius * 0.22,
      potHeight - 0.01,
      Math.sin(around) * potRadius * 0.22,
    );
    group.add(leaf);
  }
  return group;
}

/**
 * A framed print, hung with a slight and deliberate error in the level.
 *
 * Thirty-four millimetres deep, which is thicker than the frame needs to be and
 * exactly as thick as it needs to be to cast. At the 22 mm it started at, the
 * shadow it threw was under a centimetre and the prints read as printed *on* the
 * plaster — flat rectangles of colour with nothing holding them off the wall.
 * The shadow is the only cue that they are objects.
 */
export function picture(
  frameMaterial: THREE.Material,
  artMaterial: THREE.Material,
  opts: { width: number; height: number; tilt?: number },
): THREE.Group {
  const group = new THREE.Group();
  const border = 0.022;

  const body = slab(opts.width, opts.height, 0.034, frameMaterial, 3);
  group.add(body);

  const print = new THREE.Mesh(
    new THREE.PlaneGeometry(opts.width - border * 2, opts.height - border * 2),
    artMaterial,
  );
  print.position.z = 0.018;
  group.add(print);

  group.rotation.z = opts.tilt ?? 0;
  return group;
}

/**
 * A string of small lights on a catenary.
 *
 * The curve is the whole trick: a straight run of bulbs is a dotted line, and a
 * sagging one is a physical object. The bulbs are emissive spheres and are not
 * lights — twenty point lights would cost more than the rest of the room put
 * together, and the two that the pattern places by hand do the actual lighting.
 */
export function garland(
  bulbMaterial: THREE.Material,
  cordMaterial: THREE.Material,
  opts: { from: THREE.Vector3; to: THREE.Vector3; sag: number; bulbs: number },
): THREE.Group {
  const group = new THREE.Group();
  const points: THREE.Vector3[] = [];
  const steps = 32;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const point = new THREE.Vector3().lerpVectors(opts.from, opts.to, t);
    point.y -= Math.sin(t * Math.PI) * opts.sag;
    points.push(point);
  }
  const curve = new THREE.CatmullRomCurve3(points);
  const cord = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.0025, 5, false), cordMaterial);
  group.add(cord);

  const bulb = new THREE.SphereGeometry(0.012, 10, 8);
  for (let i = 0; i < opts.bulbs; i++) {
    const mesh = new THREE.Mesh(bulb, bulbMaterial);
    mesh.position.copy(curve.getPointAt((i + 0.5) / opts.bulbs));
    mesh.position.y -= 0.012;
    group.add(mesh);
  }
  return group;
}

/** A rug. Floor-only, so it is seen at full framing and nowhere else. */
export function rug(material: THREE.Material, opts: { width: number; depth: number }): THREE.Mesh {
  const mesh = slab(opts.width, 0.012, opts.depth, material, 20);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

export interface BedMaterials {
  frame: THREE.Material;
  duvet: THREE.Material;
  pillow: THREE.Material;
}

/** A made bed, the duvet given folds by the same displacement the curtains use. */
export function bed(m: BedMaterials, opts: { width: number; length: number }): THREE.Group {
  const group = new THREE.Group();
  const mattressY = 0.44;

  const base = slab(opts.width, mattressY, opts.length, m.frame, 8);
  base.position.set(0, mattressY / 2, 0);
  group.add(base);

  const head = slab(opts.width + 0.06, 0.52, 0.05, m.frame, 10);
  head.position.set(0, mattressY + 0.14, -opts.length / 2 - 0.02);
  group.add(head);

  const duvet = foldedPanel(opts.width, opts.length * 0.82, m.duvet, 0.022, 4);
  duvet.rotation.x = -Math.PI / 2;
  duvet.position.set(0, mattressY + 0.06, opts.length * 0.08);
  group.add(duvet);

  for (const side of [-1, 1]) {
    const pillow = slab(opts.width * 0.42, 0.1, 0.3, m.pillow, 40);
    pillow.position.set(side * opts.width * 0.24, mattressY + 0.09, -opts.length / 2 + 0.22);
    pillow.rotation.x = -0.18;
    group.add(pillow);
  }
  return group;
}

/** A mug, because a desk with nothing on it is a desk in a showroom. */
export function mug(material: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.041, 0.036, 0.095, 20), material);
  body.position.y = 0.0475;
  body.castShadow = true;
  group.add(body);
  const handle = new THREE.Mesh(
    new THREE.TorusGeometry(0.028, 0.007, 8, 18, Math.PI * 1.2),
    material,
  );
  handle.position.set(0.046, 0.05, 0);
  handle.rotation.set(0, Math.PI / 2, -0.4);
  handle.castShadow = true;
  group.add(handle);
  return group;
}
