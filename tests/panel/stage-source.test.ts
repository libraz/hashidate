import { describe, expect, it } from 'vitest';
import {
  composeSourceURL,
  liveDeck,
  SOURCE_PLACE_LABELS,
  SOURCE_PLACES,
  type SourceOptions,
  transparencyApplies,
} from '@/panel/stage/source';
import { parseBackdrop, parsePlace, parseSize, readStageMode } from '@/viewer/stage-mode';

/**
 * The one address an operator pastes into OBS.
 *
 * What makes this worth its own tests is where the value ends up: it is copied
 * out of the application and becomes somebody's OBS configuration for the rest
 * of the year, so a picker that composes a URL meaning something other than
 * what was chosen is a fault nobody finds until a broadcast looks wrong. The
 * checks below read the result back through the renderer's own parser, which is
 * the only way to know the two agree.
 */

const PANEL = 'http://127.0.0.1:8765/panel/';

const options = (over: Partial<SourceOptions> = {}): SourceOptions => ({
  size: '1920x1080',
  backdrop: '',
  transparent: false,
  deck: '',
  place: '',
  ...over,
});

/** The renderer's reading of a composed URL. */
const asRendered = (url: string) => readStageMode(new URL(url).search);

describe('composing the source address', () => {
  it('points at the viewer on the same server the panel came from', () => {
    // One origin by licence condition, not by convenience.
    expect(composeSourceURL(PANEL, options())).toBe('http://127.0.0.1:8765/?size=1920x1080');
  });

  it('writes down only what was chosen', () => {
    // A URL carrying `backdrop=&deck=` is one an operator has to read past to
    // see what the source actually is.
    const url = new URL(composeSourceURL(PANEL, options()));
    expect([...url.searchParams.keys()]).toEqual(['size']);
  });

  it('carries every choice through to what the renderer reads', () => {
    const url = composeSourceURL(
      PANEL,
      options({
        size: '1280x720',
        backdrop: 'none',
        deck: 'intro',
        place: 'bottom-right:0.32x0.6',
      }),
    );

    const mode = asRendered(url);
    expect(mode.size).toEqual({ width: 1280, height: 720 });
    expect(mode.deck).toBe('intro');
    expect(mode.place.avatar).toMatchObject({ anchor: 'bottom-right', width: 0.32, height: 0.6 });
  });

  it('offers only sizes and placements the renderer accepts', () => {
    for (const place of SOURCE_PLACES) {
      const url = composeSourceURL(PANEL, options({ place }));
      // A placement the renderer cannot parse silently becomes the full frame,
      // which is a picker that appears to do nothing.
      expect(parsePlace(new URL(url).searchParams.get('place'))).toEqual(asRendered(url).place);
    }
    for (const size of ['1920x1080', '1280x720'] as const) {
      expect(parseSize(size)).not.toBeNull();
    }
  });

  it('names every placement it offers', () => {
    for (const place of SOURCE_PLACES) {
      expect(SOURCE_PLACE_LABELS[place]).toMatch(/^panel\.source\./);
    }
  });
});

describe('transparency and a room', () => {
  it('applies only when there is no room', () => {
    expect(transparencyApplies('')).toBe(true);
    expect(transparencyApplies('night')).toBe(false);
  });

  it('is left off the URL when a room was chosen', () => {
    // A room is opaque geometry with its own background and wins over it, so
    // the two together are a source told to do two different things. The
    // renderer already resolves it in the room's favour; the picker agreeing
    // keeps it from offering a switch that does nothing when flipped.
    const url = composeSourceURL(PANEL, options({ backdrop: 'night', transparent: true }));
    expect(new URL(url).searchParams.has('transparent')).toBe(false);
    expect(asRendered(url).transparent).toBe(false);
  });

  it('is written when there is nothing behind the character', () => {
    const url = composeSourceURL(PANEL, options({ transparent: true }));
    expect(asRendered(url).transparent).toBe(true);
    expect(parseBackdrop(new URL(url).searchParams.get('backdrop'))).toBeNull();
  });
});

describe('a document that may have gone', () => {
  const roster = [{ id: 'intro' }, { id: 'closing' }];

  it('keeps a choice that is still on the roster', () => {
    expect(liveDeck('intro', roster)).toBe('intro');
  });

  it('drops one the directory no longer has', () => {
    // The roster is a directory somebody is dropping files into during a
    // broadcast, and a source opened on a deck that is not there comes up with
    // an error in a console nobody is reading.
    expect(liveDeck('gone', roster)).toBe('');
  });

  it('decides nothing from an empty roster, which is a server that just restarted', () => {
    expect(liveDeck('intro', [])).toBe('intro');
  });

  it('leaves the no-document choice alone', () => {
    expect(liveDeck('', roster)).toBe('');
    expect(liveDeck('', [])).toBe('');
  });

  it('keeps a dropped deck out of the URL', () => {
    const url = composeSourceURL(PANEL, options({ deck: liveDeck('gone', roster) }));
    expect(asRendered(url).deck).toBeNull();
  });
});
