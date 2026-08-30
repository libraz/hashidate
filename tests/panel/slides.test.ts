import { afterEach, describe, expect, it } from 'vitest';
import { PLACEMENT_LIMITS } from '@/engine/types';
import { resetLocale, setLocale } from '@/i18n';
import { ago, avatarPlacement, clampPage, fitAspect, settled } from '@/panel/slides/SlidesTab';

/**
 * The five things the document tab works out for itself.
 *
 * Everything else in that tab is a command with a label on it. These are the
 * translations: one gesture into the two fractions the wire carries, a typed
 * page into one the wire will accept, a file's timestamp into the thing an
 * operator actually asks of it — which of these two exports is the one I just
 * made — and which of two answers about the frame a control is drawn at.
 */

afterEach(() => {
  // The locale is module state, so a case that switches it would otherwise leak
  // the switch into the next one.
  resetLocale();
});

describe('fitAspect', () => {
  it('spends one size on both axes', () => {
    // The renderer draws the frame's own shape inside whatever area it is
    // given, so only the tighter of the two fractions ever decides anything —
    // and a second control for the other would do nothing half the time.
    expect(fitAspect(0.5)).toEqual({ width: 0.5, height: 0.5 });
  });

  it('clamps to what the wire accepts rather than sending a refused command', () => {
    // A placement outside the limits is dropped silently at the other end: the
    // slider would move and nothing else would.
    expect(fitAspect(0)).toEqual({
      width: PLACEMENT_LIMITS.width.min,
      height: PLACEMENT_LIMITS.height.min,
    });
    expect(fitAspect(4)).toEqual({
      width: PLACEMENT_LIMITS.width.max,
      height: PLACEMENT_LIMITS.height.max,
    });
  });
});

describe('avatarPlacement', () => {
  const full = { anchor: 'center' as const, width: 1, height: 1, margin: 0.04 };

  it('shrinks a full-frame avatar when moving away from centre', () => {
    // A top-only anchor is the regression: horizontal anchors appeared to work
    // at full size because the renderer hugs the silhouette to the side.
    expect(avatarPlacement(full, { anchor: 'top' })).toEqual({
      anchor: 'top',
      width: 0.32,
      height: 0.32,
      margin: 0.04,
    });
  });

  it('keeps a full-frame avatar when centre is selected', () => {
    expect(avatarPlacement(full, { anchor: 'center' })).toEqual(full);
  });

  it('uses the renderer effective size from a non-square report', () => {
    expect(
      avatarPlacement(
        { anchor: 'bottom-right', width: 0.32, height: 0.6, margin: 0.08 },
        { anchor: 'top-left' },
      ),
    ).toEqual({ anchor: 'top-left', width: 0.32, height: 0.32, margin: 0.08 });
  });

  it('keeps an existing effective size below full frame', () => {
    expect(
      avatarPlacement(
        { anchor: 'bottom-right', width: 0.47, height: 0.72, margin: 0.1 },
        { anchor: 'left' },
      ),
    ).toEqual({ anchor: 'left', width: 0.47, height: 0.47, margin: 0.1 });
  });
});

describe('clampPage', () => {
  it('takes a page inside the document as it was typed', () => {
    expect(clampPage(7, 4, 24)).toBe(7);
  });

  it('stops at either end', () => {
    // The renderer clamps too. This is about the schema, which refuses a page
    // below 1 outright — and a command refused there goes nowhere quietly.
    expect(clampPage(0, 4, 24)).toBe(1);
    expect(clampPage(99, 4, 24)).toBe(24);
  });

  it('stays where it is when the field says nothing usable', () => {
    expect(clampPage(Number.NaN, 4, 24)).toBe(4);
  });

  it('rounds a typed fraction down to a page', () => {
    expect(clampPage(3.7, 1, 24)).toBe(3);
  });
});

describe('settled', () => {
  const CORNER = { anchor: 'bottom-right', width: 0.32, height: 0.6, margin: 0.04 };

  it('says a change has landed when the renderer reports the same rectangle', () => {
    // From then on the control is drawn at the report, which is the only thing
    // that knows about a layout nobody here asked for — a source opened on
    // `?place=bottom-right:0.32x0.6`, or a `place` from an orchestrator.
    expect(settled(CORNER, { ...CORNER })).toBe(true);
  });

  it('says it has not while the report still shows where the layer was', () => {
    // The gap between a drag and the poll that answers it is what the held
    // value covers: bound straight to the report, a fader snaps back under the
    // pointer for the whole of it.
    expect(settled(CORNER, { anchor: 'center', width: 1, height: 1, margin: 0 })).toBe(false);
    expect(settled(CORNER, { ...CORNER, margin: 0.05 })).toBe(false);
  });

  it('says it has not when there is no report at all', () => {
    // A renderer that has never reported cannot have agreed to anything, so the
    // operator's own value stays where they put it.
    expect(settled(CORNER, null)).toBe(false);
    expect(settled(CORNER, undefined)).toBe(false);
  });
});

describe('ago', () => {
  const now = 1_700_000_000;

  // Written in English because that is what the store falls back to away from a
  // browser. The wording is the catalogue's; what is pinned here is which unit
  // a given gap is counted in.

  it('calls anything within the last minute or so now', () => {
    expect(ago(now - 5, now)).toBe('just now');
  });

  it('counts in minutes, then hours, then days', () => {
    expect(ago(now - 600, now)).toBe('10 min ago');
    expect(ago(now - 7200, now)).toBe('2 h ago');
    expect(ago(now - 3 * 86_400, now)).toBe('3 d ago');
  });

  it('follows the locale', () => {
    // The chip is read at a glance beside a file name, so it has to be in the
    // language the rest of the tab is in.
    setLocale('ja');
    expect(ago(now - 600, now)).toBe('10 分前');
  });

  it('does not go backwards on a file stamped in the future', () => {
    // Clocks differ between whatever exported the file and this process.
    expect(ago(now + 60, now)).toBe('just now');
  });
});
