import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BackdropStage } from '@/viewer/scene/backdrop';
import { fbm, mulberry32 } from '@/viewer/scene/backdrop/noise';
import { ROOM, WINDOW } from '@/viewer/scene/backdrop/parts';
import { PATTERNS } from '@/viewer/scene/backdrop/patterns';
import { parseBackdrop, readStageMode } from '@/viewer/stage-mode';

/**
 * Not what the rooms look like.
 *
 * Whether a backdrop reads as cheap is settled by rendering it and looking, and
 * no assertion is going to catch a wall that is a shade too bright. What these
 * cover is the layer underneath that: the properties that hold or do not hold
 * regardless of taste, and that fail in ways nobody reports.
 *
 * A seam in a tiled noise is the clearest example. It is a one-pixel line at the
 * tile boundary, invisible in a screenshot of a single wall, and a visible grid
 * across a floor seen at a grazing angle — which is a shot the viewer offers and
 * the operator may not take for weeks.
 */

describe('the noise the surfaces are made of', () => {
  it('is deterministic, so a wall is the same wall on the next reload', () => {
    const a = Array.from({ length: 8 }, mulberry32(42));
    const b = Array.from({ length: 8 }, mulberry32(42));
    expect(a).toEqual(b);
    expect(Array.from({ length: 8 }, mulberry32(43))).not.toEqual(a);
  });

  it('stays inside the range the byte conversion assumes', () => {
    // Written into an 8-bit canvas as `value * 255`. Outside 0..1 the clamp
    // takes it, which shows up as flat patches rather than as an error.
    const field = fbm(64, 4, 7);
    for (const v of field) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('wraps, so a tiled floor has no grid down it', () => {
    const size = 64;
    const field = fbm(size, 4, 11);
    const at = (x: number, y: number) => field[y * size + x];

    // The step across the seam is compared against the steps just inside it
    // rather than against zero. Noise is not smooth — adjacent samples differ —
    // so the test is that the boundary is unremarkable, not that it is flat.
    let interior = 0;
    let seam = 0;
    for (let y = 0; y < size; y++) {
      interior += Math.abs(at(1, y) - at(0, y));
      seam += Math.abs(at(0, y) - at(size - 1, y));
      interior += Math.abs(at(y, 1) - at(y, 0));
      seam += Math.abs(at(y, 0) - at(y, size - 1));
    }
    expect(seam).toBeLessThan(interior * 2);
  });
});

describe('the pattern table', () => {
  it('gives every room an id, a label and a note', () => {
    for (const pattern of PATTERNS) {
      expect(pattern.id, pattern.id).toMatch(/^[a-z]+$/);
      for (const locale of ['en', 'ja'] as const) {
        expect(pattern.label[locale], pattern.id).not.toBe('');
        expect(pattern.note[locale], pattern.id).not.toBe('');
      }
    }
  });

  it('keeps the ids unique, since the picker resolves by them', () => {
    const ids = PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('where the window sits', () => {
  it('leaves the opening inside the wall it is cut from', () => {
    // The back wall is built as four panels around this rectangle. A window
    // wider than the wall makes one of them negative, which three.js accepts
    // and renders as an inside-out box.
    expect(WINDOW.centerX - WINDOW.width / 2).toBeGreaterThan(-ROOM.halfWidth);
    expect(WINDOW.centerX + WINDOW.width / 2).toBeLessThan(ROOM.halfWidth);
    expect(WINDOW.sillY).toBeGreaterThan(0);
    expect(WINDOW.headY).toBeLessThan(ROOM.height);
  });

  it('keeps it off centre, where the avatar does not occlude it', () => {
    // The head sits on the axis. A window centred behind it is a bright rim
    // around a silhouette and a wasted third of the wall.
    expect(Math.abs(WINDOW.centerX)).toBeGreaterThan(WINDOW.width / 2);
  });
});

describe('reading the room off the URL', () => {
  it('accepts the patterns that exist', () => {
    for (const pattern of PATTERNS) {
      expect(parseBackdrop(pattern.id)).toBe(pattern.id);
    }
  });

  it('falls back to no room rather than failing', () => {
    // Typed into a field inside OBS, where there is nowhere to report an error
    // to and nobody watching if there were.
    for (const raw of [null, '', 'none', 'DUSK', 'kitchen', '../etc/passwd']) {
      expect(parseBackdrop(raw), String(raw)).toBeNull();
    }
  });

  it('comes off the query string with the rest of the presentation', () => {
    expect(readStageMode('?size=1920x1080&backdrop=night')).toMatchObject({
      console: false,
      size: { width: 1920, height: 1080 },
      backdrop: 'night',
      muted: false,
    });
    expect(readStageMode('').backdrop).toBeNull();
  });
});

/**
 * A room put away while a document is behind the character, and brought back.
 *
 * The two occupy the same place in the frame, so one of them gives way — and
 * what matters is that the one that gives way comes back *unchanged*. A room is
 * geometry, textures, six renderer and scene settings and a light rig, and the
 * failure mode of rebuilding it instead is neither a crash nor a wrong picture:
 * it is a visible rebuild in the middle of a segment, or a setting that comes
 * back a little different from the one that went away.
 */
function mountable() {
  const scene = new THREE.Scene();
  const flat = new THREE.Color(0x0f1115);
  scene.background = flat;
  // Enough of a renderer for what a backdrop reads and writes. A real one needs
  // a GL context, which is the thing this suite exists in order not to need.
  const renderer = {
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
    shadowMap: { enabled: false, type: THREE.BasicShadowMap },
  } as unknown as THREE.WebGLRenderer;
  const lights = new THREE.Group();
  scene.add(lights);
  const backdrop = new BackdropStage(scene, renderer, [lights]);
  return { scene, renderer, lights, backdrop };
}

type Mountable = ReturnType<typeof mountable>;

/** Everything a room touches that is not its own. */
const captured = (s: Mountable) => ({
  fog: s.scene.fog,
  background: s.scene.background,
  environment: s.scene.environment,
  environmentIntensity: s.scene.environmentIntensity,
  toneMapping: s.renderer.toneMapping,
  exposure: s.renderer.toneMappingExposure,
  lightsVisible: s.lights.visible,
  inScene: s.scene.children.length,
});

describe('putting the room away for a document', () => {
  const room = PATTERNS[0].id;

  it('leaves the scene exactly as clearing it would', () => {
    const cleared = mountable();
    cleared.backdrop.setBackdrop(room);
    cleared.backdrop.clear();

    const suspended = mountable();
    suspended.backdrop.setBackdrop(room);
    suspended.backdrop.suspend();

    expect(captured(suspended)).toEqual(captured(cleared));
  });

  it('keeps the room, so it is the same one that comes back', () => {
    const s = mountable();
    s.backdrop.setBackdrop(room);
    const mounted = captured(s);
    const built = s.scene.children.find((child) => child.name !== '');

    s.backdrop.suspend();
    // Still standing, just not being shown — which is what lets the picker and
    // the report keep saying which room this source is.
    expect(s.backdrop.current).toBe(room);

    s.backdrop.resume();
    expect(captured(s)).toEqual(mounted);
    // The same objects, not a second build of the same pattern.
    expect(s.scene.children).toContain(built);
  });

  it('records a room asked for while it is away, and shows it on the way back', () => {
    // Otherwise a `backdrop` command would silently do nothing for the length
    // of a slide segment — which is the stretch during which the run after it
    // is being set up.
    const s = mountable();
    const other = PATTERNS[1].id;
    s.backdrop.suspend();
    s.backdrop.setBackdrop(other);
    expect(s.backdrop.current).toBe(other);
    expect(captured(s).lightsVisible).toBe(true);

    s.backdrop.resume();
    expect(captured(s).lightsVisible).toBe(false);
    expect(s.backdrop.current).toBe(other);
  });

  it('does nothing on a resume that was never suspended', () => {
    const s = mountable();
    s.backdrop.setBackdrop(room);
    const mounted = captured(s);
    s.backdrop.resume();
    expect(captured(s)).toEqual(mounted);
  });

  it('gives the flat background back when nothing was standing', () => {
    const s = mountable();
    const bare = captured(s);
    s.backdrop.suspend();
    s.backdrop.resume();
    expect(captured(s)).toEqual(bare);
  });
});
