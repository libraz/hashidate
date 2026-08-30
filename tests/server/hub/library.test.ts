import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hub, STATE_STALE_SECONDS } from '@/server/hub';
import { deck, EPOCH_MS, placement, slides, state } from './fixtures';

/**
 * What is on disk, as the snapshot reports it.
 */

let hub: Hub;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH_MS);
  hub = new Hub();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('documents', () => {
  it('reports no documents on a server started without a directory', () => {
    // Not an error and not an absent field: the feature is optional, and a hub
    // with no store must answer exactly as one with an empty directory does.
    expect(hub.snapshot().decks).toEqual([]);
  });

  it('reports the roster the store last read', () => {
    const withDecks = new Hub({ current: [deck('intro'), deck('closing')] });
    expect(withDecks.snapshot().decks.map((found) => found.id)).toEqual(['intro', 'closing']);
  });

  it('reads the roster on each snapshot, since the directory changes underneath', () => {
    const store = { current: [deck('intro')] };
    const withDecks = new Hub(store);
    store.current = [deck('intro'), deck('late')];
    // An operator saving a file three minutes into a broadcast is the ordinary
    // case, not an unusual one.
    expect(withDecks.snapshot().decks).toHaveLength(2);
  });

  it('says nothing about the document layer until a renderer with one reports', () => {
    // Null is how a panel tells a renderer that has no document layer from one
    // that simply has nothing up.
    expect(hub.snapshot().slides).toBeNull();
    hub.report({ state: state() });
    expect(hub.snapshot().slides).toBeNull();
  });

  it('keeps the last slide report a renderer sent', () => {
    hub.report({ slides: slides() });
    expect(hub.snapshot().slides).toEqual(slides());
    hub.report({ slides: slides({ page: 4, ready: false }) });
    expect(hub.snapshot().slides).toMatchObject({ page: 4, ready: false });
  });

  it('leaves the slide report alone for a report that omits it', () => {
    hub.report({ slides: slides() });
    hub.report({ state: state() });
    expect(hub.snapshot().slides).toEqual(slides());
  });

  it('says nothing about the frame until a renderer that composes one reports', () => {
    // Null is how a panel tells a renderer that lays the frame out from one
    // that draws only one way, exactly as it does for the document layer.
    expect(hub.snapshot().placement).toBeNull();
    hub.report({ state: state() });
    expect(hub.snapshot().placement).toBeNull();
  });

  it('serves the layout a renderer reported, so a control is drawn at what is in force', () => {
    hub.report({ placement: placement() });
    expect(hub.snapshot().placement).toEqual(placement());
    // A layout nothing sent as a command: the source was opened on it.
    const moved = placement({ avatar: { anchor: 'left', width: 0.5, height: 0.5, margin: 0 } });
    hub.report({ placement: moved });
    expect(hub.snapshot().placement).toEqual(moved);
  });

  it('leaves the layout alone for a report that omits it', () => {
    hub.report({ placement: placement() });
    hub.report({ state: state() });
    expect(hub.snapshot().placement).toEqual(placement());
  });

  it('keeps serving both while the state is stale', () => {
    hub.subscribe(() => {});
    const withDecks = new Hub({ current: [deck('intro')] });
    withDecks.subscribe(() => {});
    withDecks.report({ state: state(), slides: slides(), placement: placement() });
    vi.advanceTimersByTime((STATE_STALE_SECONDS + 1) * 1000);

    const snapshot = withDecks.snapshot();
    // A stale state is a lie about what the avatar is doing right now. What is
    // in the directory, which page was reached and what shape the frame was in
    // are still true, and are what an operator with nothing connected is most
    // likely to be looking at.
    expect(snapshot.state).toEqual({});
    expect(snapshot.decks).toHaveLength(1);
    expect(snapshot.slides).toEqual(slides());
    expect(snapshot.placement).toEqual(placement());
  });
});

/**
 * The setup a renderer opened at the top of the broadcast has to be handed.
 *
 * `standing.ts` decides *what* is kept; this is about the hub actually keeping
 * it and getting it to a viewer that was not there when it was chosen. That is
 * the whole reason a control panel and a renderer can be two pages: the panel is
 * where the show is set up, and the renderer is opened last.
 */

describe('the directories on the snapshot', () => {
  const roots = {
    document: '/work/hashidate/dist',
    slides: '/work/hashidate/show/slides',
    scripts: '/work/hashidate/show/scripts',
    motions: '/work/hashidate/show/motions',
    recordings: '/work/hashidate/show/recordings',
  };

  it('carries the ones a server was started on', () => {
    expect(new Hub(null, null, roots).snapshot().roots).toEqual(roots);
  });

  it('says nothing at all from a hub that was never told', () => {
    // Absent rather than null: a key holding null would be a server claiming to
    // know where it is serving from and answering nowhere.
    expect(new Hub().snapshot()).not.toHaveProperty('roots');
  });
});

/**
 * A take, from the hub's side of it.
 *
 * What is tested here is the three things only the hub can do: telling the
 * renderers to roll, letting a held queue go on the evidence that they actually
 * are, and ending the take when the script runs out. The file is somebody
 * else's problem — see `tests/server/recordings.test.ts`.
 */
