import { describe, expect, it } from 'vitest';
import {
  BLOOM_RANGES,
  bloomPatchSchema,
  bloomSettingsSchema,
  parseCommand,
  reportBodySchema,
} from '@/protocol';

describe('bloom', () => {
  it('accepts an on or off patch and an individual numeric knob', () => {
    expect(parseCommand({ cmd: 'bloom', enabled: false })).toEqual({
      cmd: 'bloom',
      enabled: false,
    });
    expect(parseCommand({ cmd: 'bloom', strength: 1.2 })).toEqual({
      cmd: 'bloom',
      strength: 1.2,
    });
  });

  it('accepts each numeric range boundary and rejects values outside it', () => {
    for (const [field, range] of [
      ['strength', BLOOM_RANGES.strength],
      ['radius', BLOOM_RANGES.radius],
      ['threshold', BLOOM_RANGES.threshold],
    ] as const) {
      for (const value of [range.min, range.max]) {
        expect(parseCommand({ cmd: 'bloom', [field]: value }), `${field}=${value}`).not.toBeNull();
      }
      for (const value of [
        range.min - 0.01,
        range.max + 0.01,
        Number.NEGATIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.NaN,
      ]) {
        expect(parseCommand({ cmd: 'bloom', [field]: value }), `${field}=${value}`).toBeNull();
      }
    }
  });

  it('requires a known setting and refuses unknown keys', () => {
    expect(parseCommand({ cmd: 'bloom' })).toBeNull();
    expect(parseCommand({ cmd: 'bloom', typo: true })).toBeNull();
    expect(bloomPatchSchema.safeParse({}).success).toBe(true);
    expect(bloomPatchSchema.safeParse({ enabled: false, typo: true }).success).toBe(false);
  });

  it('validates the full resolved settings used by reports', () => {
    const settings = { enabled: false, strength: 0.2, radius: 0.4, threshold: 0.85 };
    expect(bloomSettingsSchema.safeParse(settings).data).toEqual(settings);
    expect(bloomSettingsSchema.safeParse({ ...settings, radius: 1.01 }).success).toBe(false);
    expect(reportBodySchema.safeParse({ bloom: settings }).success).toBe(true);
    expect(reportBodySchema.safeParse({ bloom: { ...settings, strength: -0.1 } }).success).toBe(
      false,
    );
  });
});
