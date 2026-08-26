import { describe, expect, it } from 'vitest';
import { composeArkit, composeNative, dominantEmotion, EMOTIONS } from '@/engine/face';
import type { EmotionName, EmotionVector, ShapeWeights } from '@/engine/types';

/** The floor a mouth-soft shape falls to at full mouth busy, per `emotions.ts`. */
const SOFT_FLOOR = 0.4;

/** One shape from each of the three attenuation classes, all present in `joy`. */
const LOCKED = 'mouthUpperUpLeft';
const SOFT = 'mouthSmileLeft';
const FREE = 'cheekSquintLeft';

/** An avatar-vocabulary table: same operation, none of the ARKit names. */
const NATIVE: Partial<Record<EmotionName, ShapeWeights>> = {
  joy: { eye_joy: 0.85, brow_joy: 0.7, kuchi_warai: 0.6, hoho_ake: 0.3 },
  shy: { hoho_ake: 0.9, kuchi_muhyou: 0.5, brow_joy: 0.2 },
  // Deliberately spelled in ARKit's vocabulary to show the curated sets are not
  // consulted here.
  surprise: { jawOpen: 0.5, mouthSmileLeft: 0.4 },
};

describe('composeArkit', () => {
  it('sums the contributions of several emotions onto one shape', () => {
    const out = composeArkit({ joy: 1, relaxed: 1 });
    expect(out[FREE]).toBeCloseTo(EMOTIONS.joy[FREE] + EMOTIONS.relaxed[FREE], 12);
  });

  it('clamps a shape that several emotions push past full', () => {
    const raw = EMOTIONS.joy[SOFT] + EMOTIONS.relaxed[SOFT];
    expect(raw).toBeGreaterThan(1);
    expect(composeArkit({ joy: 1, relaxed: 1 })[SOFT]).toBe(1);
  });

  it('scales each emotion by its own weight before summing', () => {
    const out = composeArkit({ joy: 0.5, surprise: 0.25 });
    expect(out.browInnerUp).toBeCloseTo(
      EMOTIONS.joy.browInnerUp * 0.5 + EMOTIONS.surprise.browInnerUp * 0.25,
      12,
    );
  });

  it('leaves a shape at zero mouth busy exactly as the table has it', () => {
    const out = composeArkit({ joy: 1 });
    for (const [shape, v] of Object.entries(EMOTIONS.joy)) expect(out[shape]).toBeCloseTo(v, 12);
  });

  it('yields a mouth-locked shape entirely to the mouth layer while speaking', () => {
    expect(composeArkit({ joy: 1 }, { mouthBusy: 1 })[LOCKED]).toBe(0);
    expect(composeArkit({ surprise: 1 }, { mouthBusy: 1 }).jawOpen).toBe(0);
  });

  it('holds a mouth-soft shape back to the floor rather than dropping it', () => {
    const out = composeArkit({ joy: 1 }, { mouthBusy: 1 });
    expect(out[SOFT]).toBeCloseTo(EMOTIONS.joy[SOFT] * SOFT_FLOOR, 12);
    expect(out[SOFT]).toBeGreaterThan(0);
  });

  it('leaves everything outside the two mouth sets untouched while speaking', () => {
    const out = composeArkit({ joy: 1 }, { mouthBusy: 1 });
    expect(out[FREE]).toBeCloseTo(EMOTIONS.joy[FREE], 12);
    expect(out.browInnerUp).toBeCloseTo(EMOTIONS.joy.browInnerUp, 12);
    expect(out.eyeSquintLeft).toBeCloseTo(EMOTIONS.joy.eyeSquintLeft, 12);
  });

  it('separates the three classes: locked to nothing, soft to the floor, free intact', () => {
    const quiet = composeArkit({ joy: 1 });
    const busy = composeArkit({ joy: 1 }, { mouthBusy: 1 });
    expect(busy[LOCKED] / quiet[LOCKED]).toBe(0);
    expect(busy[SOFT] / quiet[SOFT]).toBeCloseTo(SOFT_FLOOR, 12);
    expect(busy[FREE] / quiet[FREE]).toBeCloseTo(1, 12);
  });

  it.each([0, 0.25, 0.5, 0.75, 1])('attenuates linearly in mouth busy at %f', (busy) => {
    const out = composeArkit({ joy: 1 }, { mouthBusy: busy });
    expect(out[LOCKED]).toBeCloseTo(EMOTIONS.joy[LOCKED] * (1 - busy), 12);
    expect(out[SOFT]).toBeCloseTo(EMOTIONS.joy[SOFT] * (1 - busy * (1 - SOFT_FLOOR)), 12);
    expect(out[FREE]).toBeCloseTo(EMOTIONS.joy[FREE], 12);
  });

  it('clamps after attenuating, so speaking can never raise a shape', () => {
    const quiet = composeArkit({ joy: 1, shy: 1 });
    const busy = composeArkit({ joy: 1, shy: 1 }, { mouthBusy: 0.6 });
    for (const shape of Object.keys(quiet)) expect(busy[shape]).toBeLessThanOrEqual(quiet[shape]);
  });

  it('contributes nothing for an emotion held at zero', () => {
    expect(composeArkit({ joy: 0 })).toEqual({});
    expect(composeArkit({ joy: 1, anger: 0 })).toEqual(composeArkit({ joy: 1 }));
  });

  it('contributes nothing for a name that is not an emotion', () => {
    const stray = { sparkle: 0.9 } as unknown as EmotionVector;
    expect(composeArkit(stray)).toEqual({});
    expect(composeArkit({ ...stray, joy: 1 })).toEqual(composeArkit({ joy: 1 }));
  });

  it('contributes nothing for neutral, which has no shapes at all', () => {
    expect(EMOTIONS.neutral).toEqual({});
    expect(composeArkit({ neutral: 1 })).toEqual({});
  });

  it('returns an empty map for an empty vector', () => {
    expect(composeArkit({})).toEqual({});
  });

  it('never emits a weight outside 0..1 for any single emotion at full strength', () => {
    for (const name of Object.keys(EMOTIONS) as EmotionName[]) {
      for (const v of Object.values(composeArkit({ [name]: 1 }))) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('composeNative', () => {
  it("blends the avatar's own table the same way the ARKit one blends", () => {
    const out = composeNative({ joy: 0.5, shy: 0.5 }, NATIVE);
    expect(out.hoho_ake).toBeCloseTo(0.3 * 0.5 + 0.9 * 0.5, 12);
    expect(out.eye_joy).toBeCloseTo(0.85 * 0.5, 12);
    expect(out.kuchi_muhyou).toBeCloseTo(0.5 * 0.5, 12);
  });

  it('clamps at one', () => {
    expect(composeNative({ joy: 1, shy: 1 }, NATIVE).hoho_ake).toBe(1);
  });

  it('leaves every shape alone when no mouth pattern is supplied', () => {
    const out = composeNative({ joy: 1 }, NATIVE, { mouthBusy: 1 });
    for (const [shape, v] of Object.entries(NATIVE.joy ?? {}))
      expect(out[shape]).toBeCloseTo(v, 12);
  });

  it("attenuates only the shapes the avatar names as the mouth layer's", () => {
    const out = composeNative({ joy: 1 }, NATIVE, { mouthBusy: 1, mouthShapes: /^kuchi_/ });
    expect(out.kuchi_warai).toBeCloseTo(0.6 * SOFT_FLOOR, 12);
    expect(out.eye_joy).toBeCloseTo(0.85, 12);
    expect(out.hoho_ake).toBeCloseTo(0.3, 12);
  });

  it('holds a matched shape to the soft floor rather than yielding it entirely', () => {
    const out = composeNative({ joy: 1 }, NATIVE, { mouthBusy: 1, mouthShapes: /^kuchi_/ });
    expect(out.kuchi_warai).toBeGreaterThan(0);
  });

  it('goes by the pattern, not by the ARKit sets, even for ARKit-spelled names', () => {
    const out = composeNative({ surprise: 1 }, NATIVE, { mouthBusy: 1, mouthShapes: /^kuchi_/ });
    // `jawOpen` is mouth-locked in the ARKit path and would be zeroed there.
    expect(out.jawOpen).toBeCloseTo(0.5, 12);
    expect(out.mouthSmileLeft).toBeCloseTo(0.4, 12);
  });

  it.each([0, 0.5, 1])('attenuates a matched shape linearly in mouth busy at %f', (busy) => {
    const out = composeNative({ joy: 1 }, NATIVE, { mouthBusy: busy, mouthShapes: /^kuchi_/ });
    expect(out.kuchi_warai).toBeCloseTo(0.6 * (1 - busy * (1 - SOFT_FLOOR)), 12);
  });

  it('skips an emotion the avatar has no entry for', () => {
    expect(composeNative({ anger: 1 }, NATIVE)).toEqual({});
    expect(composeNative({ anger: 1, joy: 1 }, NATIVE)).toEqual(composeNative({ joy: 1 }, NATIVE));
  });

  it('skips an emotion held at zero and an unknown name', () => {
    expect(composeNative({ joy: 0 }, NATIVE)).toEqual({});
    expect(composeNative({ sparkle: 1 } as unknown as EmotionVector, NATIVE)).toEqual({});
  });

  it('returns an empty map against an empty table', () => {
    expect(composeNative({ joy: 1 }, {})).toEqual({});
  });
});

describe('dominantEmotion', () => {
  it('returns the largest emotion above the floor', () => {
    expect(dominantEmotion({ joy: 0.3, sadness: 0.4, anger: 0.1 })).toBe('sadness');
  });

  it('falls back to neutral for an empty vector', () => {
    expect(dominantEmotion({})).toBe('neutral');
  });

  it.each([
    [0, 'neutral'],
    [0.05, 'neutral'],
    [0.0501, 'joy'],
    [0.06, 'joy'],
    [1, 'joy'],
  ] as const)('at weight %f the dominant emotion is %s', (w, expected) => {
    expect(dominantEmotion({ joy: w })).toBe(expected);
  });

  it('treats the floor as exclusive, so a trace emotion reads as neutral', () => {
    expect(dominantEmotion({ joy: 0.05, anger: 0.04 })).toBe('neutral');
  });

  it('keeps the first name on a tie rather than reordering', () => {
    expect(dominantEmotion({ joy: 0.5, anger: 0.5 })).toBe('joy');
    expect(dominantEmotion({ anger: 0.5, joy: 0.5 })).toBe('anger');
  });

  it('does not validate names, so an unknown one can win the comparison', () => {
    const vector = { sparkle: 0.9, joy: 0.2 } as unknown as EmotionVector;
    expect(dominantEmotion({ joy: 0.2 })).toBe('joy');
    // Returned as-is. The caller resolves the result against its own preset
    // table, where an unknown name simply finds nothing.
    expect(dominantEmotion(vector) as string).toBe('sparkle');
  });
});
