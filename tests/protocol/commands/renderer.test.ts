import { describe, expect, it } from 'vitest';
import { TUNING_RANGES } from '@/engine/tuning';
import { parseCommand } from '@/protocol';

/**
 * The renderer and the character it has loaded.
 */

describe('tune', () => {
  it('carries one fader on its own, because that is what a drag sends', () => {
    expect(parseCommand({ cmd: 'tune', sway: { stiffness: 1.4 } })).toEqual({
      cmd: 'tune',
      sway: { stiffness: 1.4 },
    });
  });

  it('leaves an untouched group absent rather than filling it in', () => {
    // Absent means "leave it" everywhere on this wire. A default landing here
    // would make every knob turn also reset the four groups it did not name.
    const parsed = parseCommand({ cmd: 'tune', idle: { blink: false } }) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['cmd', 'idle']);
    expect((parsed.idle as Record<string, unknown>).breathDepth).toBeUndefined();
  });

  it.each([
    ['idle', 'breathDepth', TUNING_RANGES.idle.breathDepth],
    ['idle', 'breathPeriod', TUNING_RANGES.idle.breathPeriod],
    ['idle', 'eyeLimit', TUNING_RANGES.idle.eyeLimit],
    ['sway', 'stiffness', TUNING_RANGES.sway.stiffness],
    ['sway', 'inertia', TUNING_RANGES.sway.inertia],
    ['hop', 'height', TUNING_RANGES.hop.height],
    ['hop', 'gravity', TUNING_RANGES.hop.gravity],
    ['tail', 'amount', TUNING_RANGES.tail.amount],
  ])('accepts both ends of %s.%s and refuses either side of them', (group, field, range) => {
    // The bounds a panel sweeps and the bounds the wire accepts are the same
    // object, so a fader that reaches its end cannot send something refused.
    for (const value of [range.min, range.max]) {
      expect(parseCommand({ cmd: 'tune', [group]: { [field]: value } })).not.toBeNull();
    }
    for (const value of [range.min - 0.01, range.max + 0.01]) {
      expect(parseCommand({ cmd: 'tune', [group]: { [field]: value } })).toBeNull();
    }
  });

  it('carries settle, which is the one verb in a patch of values', () => {
    expect(parseCommand({ cmd: 'tune', settle: true })).toEqual({ cmd: 'tune', settle: true });
  });

  it('rejects a misspelled field instead of stripping a tuning operation', () => {
    expect(parseCommand({ cmd: 'tune', sway: { stifness: 2 } })).toBeNull();
  });

  it('rejects an unknown tuning group at the command boundary', () => {
    expect(parseCommand({ cmd: 'tune', swya: { stiffness: 2 } })).toBeNull();
  });

  it('parses with no groups at all, which asks for nothing and is not an error', () => {
    expect(parseCommand({ cmd: 'tune' })).toEqual({ cmd: 'tune' });
  });
});

describe('avatar', () => {
  it('spends id on the avatar rather than on correlation', () => {
    expect(parseCommand({ cmd: 'avatar', id: 'sample' })).toEqual({ cmd: 'avatar', id: 'sample' });
  });

  it('requires one, because there is no sensible avatar to mean by omission', () => {
    // Unlike `expression` or `room`, where absent means "take it off". There is
    // no such thing as no avatar: the renderer would have nothing to draw.
    expect(parseCommand({ cmd: 'avatar' })).toBeNull();
  });

  it('accepts an id this renderer may not have, which it ignores when it applies', () => {
    // The roster is renderer data and travels with the vocabulary. Refusing here
    // would only move the failure to a place with less information about it.
    expect(parseCommand({ cmd: 'avatar', id: 'nosuchavatar' })).toMatchObject({
      id: 'nosuchavatar',
    });
  });
});
