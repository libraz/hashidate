import { describe, expect, it } from 'vitest';
import {
  MOTION_MAX_FRAMES,
  MOTION_MAX_SECONDS,
  motionBodySchema,
  motionsResponseSchema,
  parseMotion,
} from '@/protocol';

/**
 * The motion format, as both ends check it.
 *
 * A motion is a file somebody is editing at one end of this and a socket at the
 * other, and neither end may believe it without looking. What is checked here
 * is the part the field types cannot say — that keyframes go forwards, that a
 * motion ends — plus the bounds that only exist because this is hand-typed:
 * everything in the built-in gesture table is written in TypeScript against
 * ranges the code around it respects, and a YAML file is not.
 */

const body = (over: Record<string, unknown> = {}) => ({
  label: { en: 'Wave', ja: '手を振る' },
  group: 'greeting',
  lead: 0.3,
  hold: 2,
  frames: [{ at: 0, arms: { R: { hand: [0, 1, 0] } } }],
  ...over,
});

describe('motionBodySchema', () => {
  it('accepts a motion with one keyframe', () => {
    expect(motionBodySchema.safeParse(body()).success).toBe(true);
  });

  it('wants at least one keyframe', () => {
    expect(motionBodySchema.safeParse(body({ frames: [] })).success).toBe(false);
  });

  it('wants the keyframe times to ascend', () => {
    const parsed = motionBodySchema.safeParse(
      body({ frames: [{ at: 0 }, { at: 0.5 }, { at: 0.2 }] }),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].path).toEqual(['frames', 2, 'at']);
  });

  it('refuses two keyframes at the same moment', () => {
    expect(motionBodySchema.safeParse(body({ frames: [{ at: 1 }, { at: 1 }] })).success).toBe(
      false,
    );
  });

  /** A mistyped `hold` is how a character ends up stuck in a pose with nothing
   *  on screen saying why. Both the hold and the track are bounded. */
  it('refuses a motion that never ends', () => {
    expect(motionBodySchema.safeParse(body({ hold: MOTION_MAX_SECONDS + 1 })).success).toBe(false);
    expect(
      motionBodySchema.safeParse(body({ frames: [{ at: MOTION_MAX_SECONDS + 1 }] })).success,
    ).toBe(false);
  });

  it('refuses more keyframes than anyone hand-writes', () => {
    const frames = Array.from({ length: MOTION_MAX_FRAMES + 1 }, (_, i) => ({ at: i * 0.01 }));
    expect(motionBodySchema.safeParse(body({ frames })).success).toBe(false);
  });

  it('refuses a group the gesture table does not have', () => {
    expect(motionBodySchema.safeParse(body({ group: 'dance' })).success).toBe(false);
  });

  it('wants both languages on the label', () => {
    expect(motionBodySchema.safeParse(body({ label: { en: 'Wave' } })).success).toBe(false);
  });

  it('wants a direction to be three numbers', () => {
    expect(
      motionBodySchema.safeParse(body({ frames: [{ at: 0, arms: { R: { hand: [0, 1] } } }] }))
        .success,
    ).toBe(false);
  });

  /** Curl is 0 straight to 1 closed, and the follower downstream would happily
   *  chase 4 and fold the hand through itself. */
  it('bounds a finger curl', () => {
    expect(
      motionBodySchema.safeParse(body({ frames: [{ at: 0, fingers: { L: { index: 4 } } }] }))
        .success,
    ).toBe(false);
  });

  it('refuses a side that is not one', () => {
    expect(
      motionBodySchema.safeParse(body({ frames: [{ at: 0, arms: { C: { hand: [0, 1, 0] } } }] }))
        .success,
    ).toBe(false);
  });

  it('refuses a spine slot that is not one', () => {
    expect(
      motionBodySchema.safeParse(body({ frames: [{ at: 0, spine: { tail: [0, 1, 0] } }] })).success,
    ).toBe(false);
  });

  /** The filename is the id. Carrying one in the file as well would be two
   *  spellings of a name that can disagree. */
  it('has no id of its own', () => {
    const parsed = motionBodySchema.safeParse(body({ id: 'elsewhere' }));
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('id');
  });
});

describe('parseMotion', () => {
  it('attaches the id it was given', () => {
    const parsed = parseMotion('myWave', body());
    expect('motion' in parsed && parsed.motion.id).toBe('myWave');
  });

  it('says which field was wrong rather than throwing', () => {
    const parsed = parseMotion('myWave', body({ group: 'dance' }));
    expect('error' in parsed && parsed.error).toMatch(/group/);
  });

  it('answers for something that is not an object at all', () => {
    expect('error' in parseMotion('myWave', null)).toBe(true);
  });
});

describe('motionsResponseSchema', () => {
  it('carries the files that would not parse beside the ones that did', () => {
    const parsed = motionsResponseSchema.safeParse({
      motions: [{ ...body(), id: 'myWave' }],
      errors: [{ id: 'broken', error: 'group: invalid' }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.errors[0].id).toBe('broken');
  });

  it('wants both lists, so an empty directory is still an answer', () => {
    expect(motionsResponseSchema.safeParse({ motions: [] }).success).toBe(false);
    expect(motionsResponseSchema.safeParse({ motions: [], errors: [] }).success).toBe(true);
  });
});
