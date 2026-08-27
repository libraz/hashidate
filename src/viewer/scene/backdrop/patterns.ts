import * as THREE from 'three';
import {
  bed,
  casement,
  curtains,
  desk,
  garland,
  lamp,
  mug,
  picture,
  plant,
  ROOM,
  rug,
  shelf,
  shell,
  WINDOW,
  wetPane,
} from './parts';
import { art, plank, plaster, rain, screen, sky, type TextureBin, weave } from './textures';

/**
 * The four rooms.
 *
 * ## They are one room lit four ways
 *
 * The shell, the window and most of the furniture are shared. What differs is
 * the light — its direction, its colour temperature, the ratio between key and
 * fill, and where the darkest and brightest values fall in the frame. That is
 * not a shortcut; it is the accurate division. A room at four in the afternoon
 * and the same room at two in the morning are different *images* made of
 * identical objects, and building four sets of furniture to express that would
 * have been solving the wrong half of the problem.
 *
 * ## What each one is for
 *
 * A backdrop has to survive being behind a face for two hours, which rules out
 * most of what looks good in a still. So each of these is built to a value
 * structure rather than to a colour scheme:
 *
 *   夕暮れ  one hot source behind the subject, everything else in shadow.
 *           Rim-lights the silhouette, which is the most flattering thing that
 *           can happen to an avatar, and keeps the centre of frame dark.
 *   深夜    the subject is the brightest object in a dark frame, lit by a screen
 *           they are plausibly looking at. Highest contrast of the four.
 *   朝      almost no contrast anywhere. Nothing competes; the face carries the
 *           whole frame. The one to use when the talking matters.
 *   雨      cool everywhere except one warm lamp. The warm/cool split is what
 *           gives a low-saturation image somewhere to look.
 *
 * ## The composition is fixed to the framing
 *
 * `FOV 28` at bust distance shows about three metres of the back wall. The
 * window sits on the right third, the furniture on the left, and the strip
 * directly behind the head is left as bare plaster — the avatar occludes it, so
 * anything put there is paid for and never seen, and anything bright there
 * haloes the outline.
 */

export interface BuiltBackdrop {
  root: THREE.Group;
  toneMapping: THREE.ToneMapping;
  exposure: number;
  /** Ambient contribution for the room's PBR materials. Toon is unaffected. */
  environmentIntensity: number;
  fog: THREE.Fog | null;
  /** Called from the frame loop when the pattern has something that moves. */
  update?: (dt: number) => void;
}

export interface Pattern {
  id: string;
  label: string;
  /** One line, shown under the picker. */
  note: string;
  build: (bin: TextureBin) => BuiltBackdrop;
}

// --- material helpers --------------------------------------------------------

const surfaceOf = (
  map: THREE.Texture | null,
  hex: number,
  roughness: number,
  opts: Partial<THREE.MeshStandardMaterialParameters> = {},
): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ map, color: map ? 0xffffff : hex, roughness, ...opts });

const paint = (hex: number, roughness = 0.9): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: hex, roughness });

/**
 * Leaf material, and the reason it is not just `paint`.
 *
 * A leaf is a curved sheet with no thickness, so half of every plant is facing
 * away from the camera — and `ShapeGeometry` renders front faces only. Lit
 * single-sided the plant collapses into a flat silhouette, which is exactly the
 * cardboard-cutout look that betrays a generated interior. Double-sided costs
 * one more triangle's worth of fill on a few dozen triangles.
 *
 * Low roughness on a leaf is not a mistake either: foliage is waxy, and the
 * broad soft highlight running along the curl is most of what says "alive".
 */
const foliage = (hex: number): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: hex, roughness: 0.52, side: THREE.DoubleSide });

/** Unlit. For anything that is its own light source or is genuinely elsewhere. */
const unlit = (hex: number, map?: THREE.Texture | null): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({ color: hex, map: map ?? null });

/**
 * Glass, faked.
 *
 * `MeshPhysicalMaterial` with real transmission would be correct and costs a
 * full-screen render target plus a second pass over the scene — for a pane that
 * has nothing behind it but a plane already drawn as opaque. A thin transparent
 * layer with a low roughness gets the sheen and the reflection of the room's
 * light and nothing else, which is all a window at this distance shows.
 */
const glazing = (): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color: 0xeaf2ff,
    roughness: 0.06,
    metalness: 0,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    envMapIntensity: 2.2,
  });

// --- shared construction -----------------------------------------------------

interface Finish {
  wallHex: number;
  ceilingHex: number;
  trimHex: number;
  floorHex: number;
  floorSpread: number;
  floorGapHex: number;
  seed: number;
}

/** Shell, window and sill, with the finishes a pattern chose. */
function room(bin: TextureBin, finish: Finish, skyTexture: THREE.Texture | null): THREE.Group {
  const group = new THREE.Group();
  group.add(
    shell({
      wall: surfaceOf(plaster(bin, finish.wallHex, finish.seed), finish.wallHex, 0.95),
      ceiling: paint(finish.ceilingHex, 1),
      trim: paint(finish.trimHex, 0.65),
      floor: surfaceOf(
        plank(bin, {
          hex: finish.floorHex,
          spread: finish.floorSpread,
          gapHex: finish.floorGapHex,
          seed: finish.seed + 5,
        }),
        finish.floorHex,
        0.55,
      ),
    }),
  );
  group.add(
    casement({
      frame: paint(finish.trimHex, 0.6),
      sill: paint(finish.trimHex, 0.6),
      glass: glazing(),
      view: unlit(0xffffff, skyTexture),
    }),
  );
  return group;
}

/**
 * A directional light standing in for the sun, aimed through the window.
 *
 * The shadow camera is fitted to the room by hand. Left at its defaults it
 * covers a five-metre cube centred on the origin, which here means half the
 * shadow map is spent on space outside the walls and the window bars land on
 * the floor as a staircase.
 */
function daylight(hex: number, intensity: number, from: THREE.Vector3, at: THREE.Vector3) {
  const light = new THREE.DirectionalLight(hex, intensity);
  light.position.copy(from);
  light.target.position.copy(at);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  const cam = light.shadow.camera;
  // Wide enough to hold the room from any of the directions the patterns light
  // it from, including the ones outside the side walls. Fitting it tighter per
  // light would buy sharper contact shadows and cost a bounds calculation that
  // has to be redone whenever a pattern moves a lamp.
  cam.left = -4.2;
  cam.right = 4.2;
  cam.top = 3.6;
  cam.bottom = -3.6;
  cam.near = 0.5;
  cam.far = 22;
  cam.updateProjectionMatrix();
  // `normalBias` rather than `bias`: the walls are thick boxes lit at a grazing
  // angle, which is the exact case where a constant depth bias either leaves
  // acne on the plaster or detaches the skirting from the floor. Offsetting
  // along the normal fixes both without choosing between them.
  light.shadow.normalBias = 0.03;
  light.shadow.bias = -0.0004;
  return light;
}

/**
 * The key: a window off the left of frame, as a spot rather than a sun.
 *
 * A directional light is the physically right model for daylight and the wrong
 * one for this shot. It has no position, so every surface facing it is lit
 * equally — and a back wall that is exactly as bright in the far corner as it is
 * beside the subject is the last thing in the room that still reads as a render
 * after the shadows and the textures are working. A spot has an inverse-power
 * falloff, so the wall darkens away from the source and the avatar, standing
 * closer to it than the wall does, sits above the background in value without
 * anything having been graded.
 *
 * `decay` is deliberately under the physical 2. At 2 the falloff across five
 * metres is severe enough to need the intensity pushed to where the near edge
 * clips; a little under trades correctness for a range that fits in the frame.
 */
function raking(
  hex: number,
  intensity: number,
  from: THREE.Vector3,
  at: THREE.Vector3,
  decay = 1.2,
  /**
   * Shadow blur, in shadow-map texels. The size of the source, in effect: a
   * bare bulb is 1, a window on an overcast day is 6, and the difference is
   * most of what makes one pattern read as a different hour than another.
   */
  softness = 2.5,
): THREE.SpotLight {
  // The cone is fitted to the room, not opened wide "to be safe". A spot's
  // shadow map is a perspective render across the whole cone, so doubling the
  // angle quarters the resolution landing on the wall — which showed up as the
  // sill's shadow edge breaking into a dotted stair, and reads as aliasing
  // rather than as the softness it was supposed to be.
  const light = new THREE.SpotLight(hex, intensity, 0, Math.PI * 0.19, 1, decay);
  light.position.copy(from);
  light.target.position.copy(at);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  light.shadow.camera.near = 0.5;
  light.shadow.camera.far = 20;
  light.shadow.normalBias = 0.03;
  light.shadow.bias = -0.0004;
  light.shadow.radius = softness;
  return light;
}

// --- 夕暮れ -------------------------------------------------------------------

const dusk: Pattern = {
  id: 'dusk',
  label: '夕暮れ',
  note: '西日が窓から入る。逆光でシルエットが縁取られ、中央は落ちる。',
  build(bin) {
    const root = new THREE.Group();
    // Darker than a real wall of this colour reads, and on purpose. The avatar
    // is a pale toon figure with almost no value range of its own, so the only
    // way it separates from the plaster behind it is for the plaster to sit
    // clearly below it. Matching the two is what makes a composite look pasted.
    const finish: Finish = {
      wallHex: 0xc9b8a4,
      ceilingHex: 0xd8cec2,
      trimHex: 0xe8e0d4,
      floorHex: 0x8f6f4d,
      floorSpread: 0.22,
      floorGapHex: 0x4a3623,
      seed: 1201,
    };
    root.add(
      room(
        bin,
        finish,
        sky(bin, {
          // Four stops, not two. A sunset read as a linear ramp is the single
          // most common tell of a generated sky; the band where orange turns to
          // rose is narrow and sits low, and that asymmetry is the whole look.
          stops: [0xf6c48a, 0xffa96a, 0xf3785f, 0xb4526d],
          skylineHex: 0x4b3446,
          lights: { hex: 0xffd9a0, count: 26 },
          seed: 1201,
        }),
      ),
    );

    root.add(
      curtains(
        surfaceOf(weave(bin, 0xd6c0a6, 1201), 0xd6c0a6, 0.92, { side: THREE.DoubleSide }),
        paint(0x6f5a45, 0.5),
        { coverage: 0.3 },
      ),
    );

    const books = shelf(paint(0xb99169, 0.7), {
      width: 1.15,
      spines: [0x8d5b4c, 0x3f5a6b, 0xc9a26b, 0x5c6b4f, 0xa8534f, 0xd0c3ae],
      seed: 44,
    });
    books.position.set(-1.0, 1.56, ROOM.backZ + 0.11);
    root.add(books);

    const frames = new THREE.Group();
    const frameMaterial = paint(0x6b5744, 0.6);
    for (const [x, y, w, h, tilt, seed] of [
      [-1.86, 1.9, 0.34, 0.44, 0.012, 3],
      [-1.86, 1.36, 0.26, 0.2, -0.02, 9],
    ] as const) {
      const hung = picture(
        frameMaterial,
        unlit(0xffffff, art(bin, [0xf0e4d2, 0xd98f6a, 0x7d5a6b], seed)),
        { width: w, height: h, tilt },
      );
      hung.position.set(x, y, ROOM.backZ + 0.018);
      frames.add(hung);
    }
    root.add(frames);

    // Low, and well out to the side. The key rakes from the left, so a plant
    // this far over throws its leaves across the wall behind it — which is a
    // good thing to have in a frame and a bad thing to have much of. At full
    // height it filled the bottom-left corner with hard spikes and pulled the
    // eye straight off the face.
    const fern = plant(paint(0xb08768, 0.85), foliage(0x4c6b45), {
      leaves: 13,
      height: 0.78,
      seed: 77,
    });
    fern.position.set(-2.25, 0, -1.35);
    root.add(fern);

    const mat = rug(surfaceOf(weave(bin, 0xb5a08c, 88), 0xb5a08c, 1), { width: 2.2, depth: 1.5 });
    mat.position.set(-0.2, 0.006, -0.5);
    root.add(mat);

    // The key, and it does not come through the window that can be seen.
    //
    // It cannot: a window in the back wall throws its light away from that wall,
    // so the only surfaces it reaches are the floor and the wall behind the
    // camera. Lit by that alone the room has no modelling at all — which is what
    // the first version of this looked like, and it looked like a diagram.
    //
    // So the key is a second window off the camera's left, which the side walls
    // are transparent to. High and well round, so the shelf prints on the wall
    // and the avatar's shadow falls back and to the right, out past the frame.
    const key = raking(
      0xffc489,
      15,
      new THREE.Vector3(-3.5, 2.7, 2.4),
      new THREE.Vector3(0.5, 0.9, -2.2),
    );
    root.add(key, key.target);

    // The sun proper, low through the glass. Weak against the key by design —
    // its job is the rim down the far side of the hair and the shaft on the
    // floor, not to light anything.
    const sun = daylight(
      0xff9548,
      1.9,
      new THREE.Vector3(4.6, 3.0, -7.4),
      new THREE.Vector3(-0.5, 0.4, 0.9),
    );
    root.add(sun, sun.target);

    // Sky and ground bounce, split warm over cool. A single ambient term at the
    // average of the two flattens the shadow side to grey, and the whole reason
    // this hour looks the way it does is that the shadows stay blue while the
    // light goes orange.
    //
    // Low, because ambient is the enemy here. Every tenth added to it lifts the
    // shadows and closes the gap between the avatar and the wall behind it,
    // and that gap is the only thing keeping the two apart.
    root.add(new THREE.HemisphereLight(0xffcda2, 0x2b2838, 0.32));

    return {
      root,
      toneMapping: THREE.NeutralToneMapping,
      exposure: 1.0,
      environmentIntensity: 0.28,
      fog: null,
    };
  },
};

// --- 深夜 ---------------------------------------------------------------------

const night: Pattern = {
  id: 'night',
  label: '深夜',
  note: 'モニタの光が主光源。寒色のキーに、机の電球が暖色で差す。',
  build(bin) {
    const root = new THREE.Group();
    const finish: Finish = {
      wallHex: 0xbcb6ad,
      ceilingHex: 0xa9a49c,
      trimHex: 0xd6d1c8,
      floorHex: 0x6a4f38,
      floorSpread: 0.24,
      floorGapHex: 0x2e2117,
      seed: 903,
    };
    root.add(
      room(
        bin,
        finish,
        sky(bin, {
          stops: [0x0a1122, 0x121b30, 0x1d2740, 0x28324a],
          skylineHex: 0x060a14,
          lights: { hex: 0xffd79a, count: 120 },
          seed: 903,
        }),
      ),
    );

    root.add(
      curtains(
        surfaceOf(weave(bin, 0x4a4f63, 903), 0x4a4f63, 0.94, { side: THREE.DoubleSide }),
        paint(0x2e3038, 0.5),
        { coverage: 0.42 },
      ),
    );

    const screenGlow = unlit(0xffffff, screen(bin, 903));
    const workstation = desk(
      {
        top: surfaceOf(
          plank(bin, { hex: 0x7c5c3f, spread: 0.16, gapHex: 0x33241a, seed: 12 }),
          0x7c5c3f,
          0.5,
        ),
        leg: paint(0x2c2e33, 0.45),
        screen: paint(0x1d1f24, 0.42),
        glow: screenGlow,
      },
      { width: 1.5, screenWidth: 0.66 },
    );
    workstation.position.set(-1.0, 0, ROOM.backZ + 0.31);
    root.add(workstation);

    const deskLamp = lamp(paint(0x2f3238, 0.4), unlit(0xffd9a0));
    deskLamp.position.set(-1.62, 0.745, ROOM.backZ + 0.36);
    deskLamp.rotation.y = 0.5;
    root.add(deskLamp);

    const cup = mug(paint(0xd8d2c6, 0.55));
    cup.position.set(-0.42, 0.745, ROOM.backZ + 0.5);
    root.add(cup);

    const books = shelf(paint(0x5d4b3a, 0.72), {
      width: 1.2,
      spines: [0x3f4a5e, 0x6b4c3a, 0x8a6a4a, 0x4f5b4a, 0x7a4f52],
      seed: 51,
    });
    books.position.set(-1.05, 1.62, ROOM.backZ + 0.11);
    root.add(books);

    // Hung low enough to be in shot. At picture-rail height it was above the
    // top of the bust framing entirely, which is the sort of thing that is
    // obvious in the render and invisible in the source.
    root.add(
      garland(unlit(0xffcf8a), paint(0x2a2622, 0.8), {
        from: new THREE.Vector3(-2.45, 2.12, ROOM.backZ + 0.08),
        to: new THREE.Vector3(2.1, 2.18, ROOM.backZ + 0.08),
        sag: 0.26,
        bulbs: 26,
      }),
    );

    // The key, at the monitor and pointing back at the avatar. A spot rather
    // than a point light: the cone is what keeps the light off the ceiling, and
    // a wide penumbra is what stops the edge of it being visible on the face.
    //
    // Nearly white, and that is the correction that mattered most in this
    // pattern. A saturated blue at this intensity is the only thing lighting the
    // face, so the avatar came out uniformly cyan — skin, hair and cloth all
    // pushed to one hue, which no amount of "moody" excuses. A screen is bright
    // and slightly cool, not blue; the colour reads from the wall it spills on
    // and from the contrast against the lamp, not from staining the subject.
    const monitor = new THREE.SpotLight(0xc9d8ea, 5.4, 6.5, Math.PI * 0.42, 1, 1.4);
    monitor.position.set(-0.95, 1.16, ROOM.backZ + 0.55);
    monitor.target.position.set(0, 1.25, 1.2);
    monitor.castShadow = true;
    monitor.shadow.mapSize.set(1024, 1024);
    monitor.shadow.normalBias = 0.03;
    root.add(monitor, monitor.target);

    // The lamp, as a light rather than as a mesh. Short range and quadratic
    // falloff, so it pools on the desk and rims the near shoulder and does not
    // quietly become a second key.
    //
    // The intensity is the third of what it was. A point light with decay 2 has
    // no shoulder — it clips to white at its centre long before the pool has
    // spread — so what was on the wall was not a lamp but a hole in the image,
    // and the whole left of frame lost its texture to it.
    const bulb = new THREE.PointLight(0xffb066, 2.1, 2.8, 2);
    bulb.position.set(-1.68, 1.09, ROOM.backZ + 0.4);
    root.add(bulb);

    // The city, coming back through the glass. Cool, weak, and from behind —
    // it is what separates the far corner of the room from black.
    const outside = new THREE.DirectionalLight(0x6f8fd0, 0.5);
    outside.position.set(3.2, 2.6, -6.5);
    outside.target.position.set(-0.4, 1.0, 0.4);
    root.add(outside, outside.target);

    root.add(new THREE.HemisphereLight(0x2b3a5c, 0x14161c, 0.35));

    return {
      root,
      toneMapping: THREE.NeutralToneMapping,
      exposure: 1.02,
      environmentIntensity: 0.1,
      // Near enough that the far wall lifts slightly and far enough that the
      // avatar never touches it. Aerial perspective in a five-metre room is not
      // physical; it is standing in for the bounce a real dark room has and a
      // renderer with no global illumination does not.
      fog: new THREE.Fog(0x131a2a, 3.2, 13),
    };
  },
};

// --- 朝 -----------------------------------------------------------------------

const morning: Pattern = {
  id: 'morning',
  label: '朝',
  note: '曇天の拡散光。影がほとんど出ず、顔だけが立つ。',
  build(bin) {
    const root = new THREE.Group();
    const finish: Finish = {
      // Not white. A wall painted the same value as the light falling on it has
      // nowhere left to go, and the avatar — which is pale to begin with —
      // dissolves into it. Warm grey lit brightly reads as white; white lit
      // brightly reads as nothing.
      wallHex: 0xcfcac1,
      ceilingHex: 0xdedbd4,
      trimHex: 0xeeece6,
      floorHex: 0xc4ac8e,
      floorSpread: 0.14,
      floorGapHex: 0x7d6749,
      seed: 640,
    };
    root.add(
      room(
        bin,
        finish,
        sky(bin, {
          stops: [0xfdfefe, 0xf2f7fb, 0xe4edf4],
          skylineHex: 0xc8d4de,
          lights: null,
          seed: 640,
        }),
      ),
    );

    // Sheer, and drawn most of the way across. The curtain is the light source
    // as far as the room is concerned — the point of this pattern is that
    // nothing in it has an edge, and an open window would give it one.
    root.add(
      curtains(
        new THREE.MeshStandardMaterial({
          color: 0xfcfaf6,
          roughness: 1,
          transparent: true,
          opacity: 0.62,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
        paint(0xd8d2c6, 0.5),
        { coverage: 0.46, amplitude: 0.035 },
      ),
    );

    const linen = surfaceOf(weave(bin, 0xf2eee7, 640), 0xf2eee7, 1);
    const cot = bed(
      {
        frame: paint(0xd9c8b0, 0.75),
        duvet: linen,
        pillow: surfaceOf(weave(bin, 0xfaf8f4, 641), 0xfaf8f4, 1),
      },
      { width: 1.1, length: 2.0 },
    );
    cot.position.set(-1.5, 0, -1.45);
    cot.rotation.y = Math.PI / 2;
    root.add(cot);

    // A cluster rather than a single frame, hung at slightly different heights.
    // Three objects at one height is a shelf; three at three heights is a wall
    // somebody arranged.
    const frameMaterial = paint(0xe8e2d8, 0.6);
    for (const [x, y, w, h, tilt, seed] of [
      [-1.18, 1.72, 0.3, 0.4, 0.008, 21],
      [-0.82, 1.55, 0.22, 0.26, -0.014, 22],
      [-1.14, 1.28, 0.24, 0.2, 0.018, 23],
    ] as const) {
      const hung = picture(
        frameMaterial,
        unlit(0xffffff, art(bin, [0xfaf6ef, 0xa8c4c0, 0xe4b9a0], seed)),
        { width: w, height: h, tilt },
      );
      hung.position.set(x, y, ROOM.backZ + 0.018);
      root.add(hung);
    }

    // On the sill, where the light is. The one saturated thing in a pattern
    // that is otherwise entirely off-white, and it is there to give the eye a
    // second place to land after the face.
    const pot = plant(paint(0xd6c3ae, 0.9), foliage(0x6f8f5e), {
      leaves: 9,
      height: 0.36,
      seed: 31,
    });
    pot.position.set(WINDOW.centerX - 0.3, WINDOW.sillY, ROOM.backZ + 0.07);
    root.add(pot);

    const mat = rug(surfaceOf(weave(bin, 0xe0d5c4, 645), 0xe0d5c4, 1), { width: 2.4, depth: 1.6 });
    mat.position.set(0.1, 0.006, -0.3);
    root.add(mat);

    // Soft, but still a direction.
    //
    // "Overcast" is not "ambient". A white sky is a very large source, not an
    // absent one — it still comes from above and from the window side, and the
    // gradient it lays across a wall is the only thing telling the eye that the
    // wall is a surface. Lit by a hemisphere alone, this pattern came out as an
    // even field of near-white with nothing in it casting anything, which read
    // as a missing texture rather than as a bright morning.
    //
    // Low decay, because the whole point of this hour is that the falloff is
    // gentle — enough to seat the subject above the background and not enough to
    // put a corner of the room in shadow.
    const overcast = raking(
      0xf0f5ff,
      11,
      new THREE.Vector3(-3.2, 3.1, 2.6),
      new THREE.Vector3(0.5, 1.0, -2.2),
      0.9,
      6,
    );
    root.add(overcast, overcast.target);

    // Halved. This carried the entire pattern before and it is a fill, not a
    // key; at 1.15 it lifted every shadow the window light was making and the
    // room lost the last of its modelling.
    root.add(new THREE.HemisphereLight(0xf6f9ff, 0xd9cebc, 0.6));

    const bounce = new THREE.DirectionalLight(0xfff7ec, 0.22);
    bounce.position.set(-0.6, 1.7, 4.2);
    root.add(bounce);

    return {
      root,
      toneMapping: THREE.NeutralToneMapping,
      // Under one, which no other pattern is. A high-key image is the easiest
      // of the four to push past the top of the range — and once the wall
      // clips there is no difference between "bright morning" and "broken".
      exposure: 0.84,
      environmentIntensity: 0.5,
      fog: null,
    };
  },
};

// --- 雨 -----------------------------------------------------------------------

const rainy: Pattern = {
  id: 'rain',
  label: '雨',
  note: '寒色に沈んだ室内を、電球ひとつだけが暖色で割る。窓は流れる。',
  build(bin) {
    const root = new THREE.Group();
    const finish: Finish = {
      wallHex: 0xd6d5d0,
      ceilingHex: 0xcfcec9,
      trimHex: 0xe6e5e0,
      floorHex: 0x6d5344,
      floorSpread: 0.2,
      floorGapHex: 0x2f231c,
      seed: 2088,
    };
    root.add(
      room(
        bin,
        finish,
        sky(bin, {
          stops: [0xa8b1b8, 0x99a2aa, 0x88919a, 0x79828b],
          skylineHex: 0x6d767f,
          lights: null,
          seed: 2088,
        }),
      ),
    );

    const streaks = rain(bin, 2088);
    const pane = wetPane(
      new THREE.MeshStandardMaterial({
        color: 0xdfe9f2,
        roughness: 0.08,
        metalness: 0,
        transparent: true,
        alphaMap: streaks,
        opacity: 0.85,
        depthWrite: false,
        envMapIntensity: 2.4,
      }),
    );
    root.add(pane);

    root.add(
      curtains(
        surfaceOf(weave(bin, 0x8f9299, 2088), 0x8f9299, 0.95, { side: THREE.DoubleSide }),
        paint(0x4c4f55, 0.5),
        { coverage: 0.26 },
      ),
    );

    const workstation = desk(
      {
        top: surfaceOf(
          plank(bin, { hex: 0x8a6a52, spread: 0.14, gapHex: 0x37281f, seed: 9 }),
          0x8a6a52,
          0.5,
        ),
        leg: paint(0x3a3d42, 0.45),
        screen: paint(0x25272c, 0.42),
        // Switched off, which is a dark mirror rather than a black rectangle.
        // Unlit near-black was what it was first, and it sat in the frame as a
        // hole — the one object in the room that no light touched. A very smooth
        // standard material with almost no albedo picks up the environment and
        // the lamp instead, which is what a dead screen actually looks like.
        glow: new THREE.MeshStandardMaterial({
          color: 0x14181e,
          roughness: 0.11,
          metalness: 0.1,
          envMapIntensity: 1.8,
        }),
      },
      { width: 1.35, screenWidth: 0.5 },
    );
    workstation.position.set(-1.1, 0, ROOM.backZ + 0.31);
    root.add(workstation);

    const deskLamp = lamp(paint(0xb9b2a6, 0.45), unlit(0xffd9a8));
    deskLamp.position.set(-1.66, 0.745, ROOM.backZ + 0.38);
    deskLamp.rotation.y = 0.62;
    root.add(deskLamp);

    const cup = mug(paint(0x6f7a80, 0.5));
    cup.position.set(-0.55, 0.745, ROOM.backZ + 0.52);
    root.add(cup);

    const books = shelf(paint(0x7a6552, 0.72), {
      width: 1.05,
      spines: [0x4a5560, 0x7d6a58, 0x5f6b5c, 0x8a7d6b],
      seed: 66,
    });
    books.position.set(-1.1, 1.66, ROOM.backZ + 0.11);
    root.add(books);

    // More leaves, smaller, and a lighter green.
    //
    // Breaking the frame edge with something organic is a good idea badly
    // executed at the first sizes: thirteen leaves at nearly a metre put four or
    // five enormous flat shapes across the bottom-right corner, and a large
    // untextured plane in near-silhouette is indistinguishable from a sticker.
    // The same silhouette made of twice as many pieces at half the size stops
    // being a shape and starts being foliage.
    const fern = plant(paint(0x8c8880, 0.9), foliage(0x6c8259), {
      leaves: 22,
      height: 0.68,
      seed: 12,
    });
    fern.position.set(1.5, 0, -2.05);
    root.add(fern);

    // Cool, soft, and from the left like the others — rain has no sun, but it
    // still has a window, and light that arrives from nowhere in particular is
    // what made this room look like an untextured mesh in the first pass.
    const overcast = raking(
      0xb6c6da,
      13,
      new THREE.Vector3(-3.3, 2.9, 2.5),
      new THREE.Vector3(0.4, 1.0, -2.2),
      1.0,
      4.5,
    );
    root.add(overcast, overcast.target);

    root.add(new THREE.HemisphereLight(0x93a6bb, 0x38332e, 0.5));

    // The one warm thing in the frame, and the reason this pattern works. Take
    // it out and the room is correctly lit and completely dead.
    const bulb = new THREE.PointLight(0xffab5c, 2.4, 3.0, 2);
    bulb.position.set(-1.72, 1.1, ROOM.backZ + 0.42);
    root.add(bulb);

    const fill = new THREE.DirectionalLight(0xdfe8f2, 0.3);
    fill.position.set(0.4, 1.8, 4.4);
    root.add(fill);

    return {
      root,
      toneMapping: THREE.NeutralToneMapping,
      exposure: 0.94,
      environmentIntensity: 0.34,
      fog: new THREE.Fog(0x8e97a0, 4.0, 16),
      /**
       * The water runs. Slowly — 0.06 of the tile a second, which is far below
       * what a real drop does and reads correctly anyway, because the streaks
       * are a static pattern and speeding them up turns the pane into a
       * conveyor belt.
       */
      update: (dt: number) => {
        if (!streaks) return;
        streaks.offset.y = (streaks.offset.y - dt * 0.06) % 1;
      },
    };
  },
};

export const PATTERNS: readonly Pattern[] = [dusk, night, morning, rainy];
