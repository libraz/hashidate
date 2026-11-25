import { describe, expect, it } from 'vitest';
import {
  eventsResponseSchema,
  reportBodySchema,
  sessionEventSchema,
  sessionEventsSchema,
  sessionEventTypeSchema,
  touchPartSchema,
} from '@/protocol';

describe('touchPartSchema', () => {
  it('accepts the five parts and nothing else', () => {
    for (const part of ['head', 'torso', 'arm', 'hand', 'leg']) {
      expect(touchPartSchema.safeParse(part).success).toBe(true);
    }
    for (const part of ['foot', 'HEAD', '', null, 1]) {
      expect(touchPartSchema.safeParse(part).success).toBe(false);
    }
  });
});

describe('touch session events', () => {
  it('names both kinds in the type enum', () => {
    expect(sessionEventTypeSchema.safeParse('touch.tap').success).toBe(true);
    expect(sessionEventTypeSchema.safeParse('touch.hold').success).toBe(true);
  });

  it('carries part, side and count', () => {
    const event = { type: 'touch.tap', part: 'arm', side: 'L', count: 3 };
    expect(sessionEventSchema.parse(event)).toEqual(event);
  });

  it('takes every field as optional', () => {
    expect(sessionEventSchema.safeParse({ type: 'touch.hold' }).success).toBe(true);
    expect(sessionEventSchema.safeParse({ type: 'touch.tap', part: 'head' }).success).toBe(true);
  });

  it.each([
    ['count 0', { count: 0 }],
    ['count -0', { count: -0 }],
    ['count 11', { count: 11 }],
    ['count 1.5', { count: 1.5 }],
    ['count NaN', { count: Number.NaN }],
    ['count Infinity', { count: Number.POSITIVE_INFINITY }],
    ['count 2^31', { count: 2 ** 31 }],
    ['count 2^32', { count: 2 ** 32 }],
    ['count string', { count: '2' }],
    ['count null', { count: null }],
    ['side lower case', { side: 'l' }],
    ['side word', { side: 'left' }],
    ['part unknown', { part: 'foot' }],
  ])('rejects %s', (_name, extra) => {
    expect(sessionEventSchema.safeParse({ type: 'touch.tap', ...extra }).success).toBe(false);
  });

  it('accepts the count range ends', () => {
    expect(sessionEventSchema.safeParse({ type: 'touch.tap', count: 1 }).success).toBe(true);
    expect(sessionEventSchema.safeParse({ type: 'touch.tap', count: 10 }).success).toBe(true);
  });

  it('strips an unknown key', () => {
    expect(sessionEventSchema.parse({ type: 'touch.tap', extra: 1 })).toEqual({
      type: 'touch.tap',
    });
  });
});

describe('sessionEventsSchema', () => {
  const good = { type: 'turn.end', turn: 'a' };

  it('drops an unknown type and an unknown part, keeping the rest in order', () => {
    const parsed = sessionEventsSchema.parse([
      good,
      { type: 'touch.poke', part: 'head' },
      { type: 'touch.tap', part: 'foot' },
      { type: 'touch.tap', part: 'head', count: 2 },
      'junk',
      null,
    ]);
    expect(parsed).toEqual([good, { type: 'touch.tap', part: 'head', count: 2 }]);
  });

  it('reads an empty list', () => {
    expect(sessionEventsSchema.parse([])).toEqual([]);
  });

  it('still rejects a value that is not a list', () => {
    expect(sessionEventsSchema.safeParse({}).success).toBe(false);
    expect(sessionEventsSchema.safeParse(undefined).success).toBe(false);
  });

  it('is what the events response reads with', () => {
    const parsed = eventsResponseSchema.parse({
      seq: 2,
      events: [{ type: 'future.thing' }, good],
    });
    expect(parsed.events).toEqual([good]);
  });
});

describe('the report direction', () => {
  it('stays strict about an event it does not know', () => {
    const body = { avatar: { phase: 'ready' }, events: [{ type: 'future.thing' }] };
    expect(reportBodySchema.safeParse(body).success).toBe(false);
  });
});
