import { describe, expect, it } from 'vitest';
import { MOTION_MAX_TURN_DEGREES, motionBodySchema, parseMotion } from '@/protocol/motions';

/**
 * How far one direction may turn between two keyframes that state it.
 *
 * Past a certain spread the arc between two bearings stops being the movement
 * anybody meant: at 180 degrees every arc is the shortest one, and a hair under
 * it the limb takes whichever side the rounding picks.
 */

const D = Math.PI / 180;
/** A unit direction `deg` degrees from +y, turning toward +z. */
const bearing = (deg: number): [number, number, number] => [
  0,
  Math.cos(deg * D),
  Math.sin(deg * D),
];

const body = (frames: unknown[]) => ({
  label: { en: 'Turn', ja: '回転' },
  group: 'pose',
  lead: 0.3,
  hold: 1,
  frames,
});

describe('keyframe turn limit', () => {
  it('accepts a turn inside the limit', () => {
    const frames = [
      { at: 0, arms: { R: { hand: bearing(0) } } },
      { at: 1, arms: { R: { hand: bearing(MOTION_MAX_TURN_DEGREES - 5) } } },
    ];
    expect(motionBodySchema.safeParse(body(frames)).success).toBe(true);
  });

  it.each(['shoulder', 'upperArm', 'lowerArm', 'hand', 'palm'])(
    'refuses a %s that turns past the limit between keyframes',
    (slot) => {
      const parsed = parseMotion(
        'turn',
        body([
          { at: 0, arms: { L: { [slot]: bearing(0) } } },
          { at: 1, arms: { L: { [slot]: bearing(MOTION_MAX_TURN_DEGREES + 5) } } },
        ]),
      );
      expect(parsed).toEqual({
        error: expect.stringContaining(`frames.1.arms.L.${slot}`),
      });
      expect(parsed).toEqual({ error: expect.stringContaining(`${MOTION_MAX_TURN_DEGREES}`) });
    },
  );

  it('compares the keyframes that state the channel, skipping the ones that do not', () => {
    const frames = [
      { at: 0, arms: { R: { hand: bearing(0) } } },
      { at: 0.5, arms: { R: { twist: 0.2 } }, spine: { head: [0.1, 0, 0] } },
      { at: 1, arms: { R: { hand: bearing(170) } } },
    ];
    const parsed = motionBodySchema.safeParse(body(frames));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['frames', 2, 'arms', 'R', 'hand']);
  });

  it('allows a large total turn made in steps', () => {
    const frames = [0, 120, 240, 360].map((deg, i) => ({
      at: i,
      arms: { R: { upperArm: bearing(deg) } },
    }));
    expect(motionBodySchema.safeParse(body(frames)).success).toBe(true);
  });

  it('keeps each side its own channel', () => {
    const frames = [
      { at: 0, arms: { L: { hand: bearing(0) } } },
      { at: 1, arms: { R: { hand: bearing(170) } } },
    ];
    expect(motionBodySchema.safeParse(body(frames)).success).toBe(true);
  });
});
