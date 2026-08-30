import { describe, expect, it } from 'vitest';
import type { Anchor } from '@/engine/types';
import { PLACEMENT_LIMITS } from '@/engine/types';
import { parseCommand } from '@/protocol';

/**
 * Where the line is delivered, and where it sits in the frame.
 */

describe('camera', () => {
  it('takes a framing on its own, which is what a script sends', () => {
    expect(parseCommand({ cmd: 'camera', frame: 'full' })).toEqual({
      cmd: 'camera',
      frame: 'full',
    });
  });

  it('takes an offset with no framing, which is what a drag sends', () => {
    // Absent means "leave it": naming a framing must not straighten a shot
    // somebody tilted, and tilting one must not change how much is in frame.
    expect(parseCommand({ cmd: 'camera', yaw: -22.5, zoom: 1.25 })).toEqual({
      cmd: 'camera',
      yaw: -22.5,
      zoom: 1.25,
    });
  });

  it('accepts both ends of every offset and refuses either side', () => {
    for (const [field, min, max] of [
      ['yaw', -180, 180],
      ['pitch', -85, 85],
      ['zoom', 0.25, 4],
    ] as const) {
      for (const value of [min, max]) {
        expect(parseCommand({ cmd: 'camera', [field]: value }), `${field}=${value}`).not.toBeNull();
      }
      for (const value of [min - 0.01, max + 0.01]) {
        expect(parseCommand({ cmd: 'camera', [field]: value }), `${field}=${value}`).toBeNull();
      }
    }
  });

  it('parses with nothing at all, which asks for nothing and is not an error', () => {
    expect(parseCommand({ cmd: 'camera' })).toEqual({ cmd: 'camera' });
  });
});

describe('deck', () => {
  it('spends id on the document rather than on correlation', () => {
    // The file's own stem, and it travels untouched: a server that stamped a
    // correlation id into this field would ask the renderer for a document
    // nobody has.
    const id = '2026年-まとめ.第一部';
    expect(parseCommand({ cmd: 'deck', id })).toEqual({ cmd: 'deck', id });
  });

  it('opens the document at a page when one is given', () => {
    expect(parseCommand({ cmd: 'deck', id: 'intro', page: 12 })).toEqual({
      cmd: 'deck',
      id: 'intro',
      page: 12,
    });
  });

  it('leaves the page absent rather than filling in the first one', () => {
    // Absent is the first page to whoever applies it. Defaulting here would put
    // a number on the wire the caller never said, and the server forwards a
    // parsed command on unchanged.
    const parsed = parseCommand({ cmd: 'deck', id: 'intro' }) as { page?: number };
    expect(parsed.page).toBeUndefined();
  });

  it('parses null, which takes the document down', () => {
    expect(parseCommand({ cmd: 'deck', id: null })).toEqual({ cmd: 'deck', id: null });
  });

  it('accepts an id the renderer may not be able to open', () => {
    // What documents exist is a directory listing, not vocabulary. A name a
    // minute out of date is the ordinary case, and it is reported rather than
    // refused here where there is nothing to report it against.
    expect(parseCommand({ cmd: 'deck', id: 'nosuchdeck' })).toMatchObject({ id: 'nosuchdeck' });
  });

  it('refuses a page that is not one, at either end of the mistake', () => {
    expect(parseCommand({ cmd: 'deck', id: 'intro', page: 0 })).toBeNull();
    expect(parseCommand({ cmd: 'deck', id: 'intro', page: -1 })).toBeNull();
    expect(parseCommand({ cmd: 'deck', id: 'intro', page: 1.5 })).toBeNull();
  });
});

describe('slide', () => {
  it('takes an absolute page, which is what a script has', () => {
    expect(parseCommand({ cmd: 'slide', page: 9 })).toEqual({ cmd: 'slide', page: 9 });
  });

  it('takes a relative move, which is what a hand on an arrow key has', () => {
    expect(parseCommand({ cmd: 'slide', by: 1 })).toEqual({ cmd: 'slide', by: 1 });
    expect(parseCommand({ cmd: 'slide', by: -1 })).toEqual({ cmd: 'slide', by: -1 });
    expect(parseCommand({ cmd: 'slide', by: -3 })).toEqual({ cmd: 'slide', by: -3 });
  });

  it('carries both when both are given, leaving the choice to whoever applies it', () => {
    // `page` wins there, not here: the schema's business is that neither is
    // dropped on the way, so the applier can see it was handed two answers.
    expect(parseCommand({ cmd: 'slide', page: 3, by: 1 })).toEqual({
      cmd: 'slide',
      page: 3,
      by: 1,
    });
  });

  it('parses with neither, which is the bare "next" an operator sends all night', () => {
    const parsed = parseCommand({ cmd: 'slide' }) as { page?: number; by?: number };
    expect(parsed).toEqual({ cmd: 'slide' });
    expect(parsed.page).toBeUndefined();
    expect(parsed.by).toBeUndefined();
  });

  it('spends id on correlation, unlike deck', () => {
    expect(parseCommand({ cmd: 'slide', id: 'c-9', by: 1 })).toEqual({
      cmd: 'slide',
      id: 'c-9',
      by: 1,
    });
  });

  it('refuses a page that is not one, while leaving by unbounded in either direction', () => {
    expect(parseCommand({ cmd: 'slide', page: 0 })).toBeNull();
    expect(parseCommand({ cmd: 'slide', page: -2 })).toBeNull();
    expect(parseCommand({ cmd: 'slide', page: 2.5 })).toBeNull();
    // Past either end of the document is clamped where the pages are known, so
    // a move of forty is a very ordinary mistake rather than a refused command.
    expect(parseCommand({ cmd: 'slide', by: 40 })).toMatchObject({ by: 40 });
  });
});

describe('place', () => {
  const ANCHORS: Anchor[] = [
    'center',
    'top-left',
    'top',
    'top-right',
    'left',
    'right',
    'bottom-left',
    'bottom',
    'bottom-right',
  ];

  it('takes the character half on its own', () => {
    expect(parseCommand({ cmd: 'place', avatar: { anchor: 'bottom-right', width: 0.3 } })).toEqual({
      cmd: 'place',
      avatar: { anchor: 'bottom-right', width: 0.3 },
    });
  });

  it('takes the document half on its own', () => {
    expect(parseCommand({ cmd: 'place', slide: { width: 0.8, fit: 'cover' } })).toEqual({
      cmd: 'place',
      slide: { width: 0.8, fit: 'cover' },
    });
  });

  it('carries one number, which is what a slider under the pointer sends', () => {
    const parsed = parseCommand({ cmd: 'place', avatar: { width: 0.5 } }) as {
      avatar?: Record<string, unknown>;
    };
    expect(parsed).toEqual({ cmd: 'place', avatar: { width: 0.5 } });
    // Absent means "leave it", never "reset it". A default landing here would
    // make every drag of the width also re-centre and re-size the layer.
    expect(parsed.avatar?.anchor).toBeUndefined();
    expect(parsed.avatar?.height).toBeUndefined();
    expect(parsed.avatar?.margin).toBeUndefined();
  });

  it('parses with neither half, which asks for nothing and is not an error', () => {
    expect(parseCommand({ cmd: 'place' })).toEqual({ cmd: 'place' });
  });

  it.each(ANCHORS)('accepts %s on both halves', (anchor) => {
    expect(parseCommand({ cmd: 'place', avatar: { anchor } })).toEqual({
      cmd: 'place',
      avatar: { anchor },
    });
    expect(parseCommand({ cmd: 'place', slide: { anchor } })).toEqual({
      cmd: 'place',
      slide: { anchor },
    });
  });

  it('refuses a position that is not one of the nine', () => {
    expect(parseCommand({ cmd: 'place', avatar: { anchor: 'middle' } })).toBeNull();
    expect(parseCommand({ cmd: 'place', slide: { anchor: 'centre' } })).toBeNull();
  });

  it.each([
    ['width', PLACEMENT_LIMITS.width],
    ['height', PLACEMENT_LIMITS.height],
    ['margin', PLACEMENT_LIMITS.margin],
  ])('accepts both ends of %s and refuses either side, on both halves', (field, range) => {
    // The bounds the panel's preview drags between and the bounds the wire
    // accepts are the same object, so a slider at its stop cannot send
    // something that is silently dropped.
    for (const half of ['avatar', 'slide'] as const) {
      for (const value of [range.min, range.max]) {
        expect(
          parseCommand({ cmd: 'place', [half]: { [field]: value } }),
          `${half}.${field}=${value}`,
        ).not.toBeNull();
      }
      for (const value of [range.min - 0.01, range.max + 0.01]) {
        expect(
          parseCommand({ cmd: 'place', [half]: { [field]: value } }),
          `${half}.${field}=${value}`,
        ).toBeNull();
      }
    }
  });

  it('has fit on the document half and nowhere else', () => {
    // How a picture fills its rectangle is a question only a picture asks. On
    // the character it is an unknown field and is stripped, like any other.
    expect(parseCommand({ cmd: 'place', slide: { fit: 'contain' } })).toEqual({
      cmd: 'place',
      slide: { fit: 'contain' },
    });
    expect(parseCommand({ cmd: 'place', avatar: { width: 0.4, fit: 'cover' } })).toEqual({
      cmd: 'place',
      avatar: { width: 0.4 },
    });
  });

  it('refuses a fit it does not have', () => {
    expect(parseCommand({ cmd: 'place', slide: { fit: 'stretch' } })).toBeNull();
  });
});
