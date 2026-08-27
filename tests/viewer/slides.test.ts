// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { SlideStage } from '@/viewer/scene/slides';
import type { DeckSource } from '@/viewer/scene/slides/deck';

/**
 * The document layer, driven by a document that is not a PDF.
 *
 * Nothing here rasterises anything: the seam `DeckSource` names exists so that
 * pdf.js, a fixture file and a canvas that can actually paint are all somebody
 * else's problem, and what is left is the part that decides what a broadcast
 * shows — which page was asked for, which one is up, and what happens when the
 * file the operator named is not there.
 *
 * That last one is the reason most of this exists. A deck is opened by id from
 * a directory a person drops files into, so "not there" is an ordinary Tuesday,
 * and the only acceptable behaviour is an empty layer, a line in the report and
 * a stream that carries on.
 */

/** Stands in for a decoded page. Only its proportions are ever read. */
const bitmap = (): ImageBitmap =>
  ({ width: 1600, height: 900, close: () => {} }) as unknown as ImageBitmap;

function fakeDeck(pages: number) {
  const state = { rendered: [] as number[], widths: [] as number[], disposed: 0 };
  const source: DeckSource = {
    pages,
    render: async (page, pixelWidth) => {
      state.rendered.push(page);
      state.widths.push(pixelWidth);
      return bitmap();
    },
    dispose: () => {
      state.disposed += 1;
    },
  };
  return { source, state };
}

/** Everything the layer does is a promise, and none of them is handed back. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function build(open: (url: string) => Promise<DeckSource>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const stage = new SlideStage(host, { open });
  stage.resize({ width: 1920, height: 1080 });
  return { host, stage };
}

let opened: string[];

beforeEach(() => {
  opened = [];
});

/** A stage over one document of `pages` pages, recording what was asked for. */
function overDeck(pages: number) {
  const deck = fakeDeck(pages);
  const { stage, host } = build(async (url) => {
    opened.push(url);
    return deck.source;
  });
  return { stage, host, deck };
}

describe('putting a document up', () => {
  it('opens the first page by id, from the path the server serves', async () => {
    const { stage, deck } = overDeck(4);
    stage.setDeck('intro');
    await settled();
    expect(opened).toEqual(['/slides/intro.pdf']);
    expect(deck.state.rendered).toEqual([1]);
    expect(stage.report()).toMatchObject({ deck: 'intro', page: 1, pages: 4, ready: true });
    expect(stage.up).toBe(true);
  });

  it('renders at the layer’s own device pixels, not the stage’s', async () => {
    const { stage, deck } = overDeck(2);
    stage.setPlacement({ width: 0.5 });
    stage.setDeck('intro');
    await settled();
    expect(deck.state.widths).toEqual([960 * devicePixelRatio]);
  });

  it('opens on the page it was asked for', async () => {
    const { stage } = overDeck(9);
    stage.setDeck('intro', 4);
    await settled();
    expect(stage.report().page).toBe(4);
  });

  it('clamps a page past the end to the last one there is', async () => {
    // How many pages a document has is only known once it is open, so a script
    // that says 40 of a nine-page deck means the last page rather than an error.
    const { stage } = overDeck(9);
    stage.setDeck('intro', 40);
    await settled();
    expect(stage.report()).toMatchObject({ page: 9, ready: true });
  });

  it('takes it down again, and says nothing is up', async () => {
    const { stage, deck } = overDeck(3);
    stage.setDeck('intro');
    await settled();
    stage.setDeck(null);
    expect(deck.state.disposed).toBe(1);
    expect(stage.up).toBe(false);
    expect(stage.report()).toEqual({ deck: null, page: 0, pages: 0, ready: true, error: null });
  });

  it('replaces the document that was up, and lets go of it', async () => {
    const first = fakeDeck(3);
    const second = fakeDeck(7);
    const { stage } = build(async (url) => {
      opened.push(url);
      return url.includes('first') ? first.source : second.source;
    });
    stage.setDeck('first');
    await settled();
    stage.setDeck('second', 2);
    await settled();
    expect(first.state.disposed).toBe(1);
    expect(stage.report()).toMatchObject({ deck: 'second', page: 2, pages: 7 });
    // The page the old document was on is not a page of the new one.
    expect(second.state.rendered).toEqual([2]);
  });
});

describe('turning a page', () => {
  it('moves relative to the page asked for', async () => {
    const { stage } = overDeck(5);
    stage.setDeck('intro');
    await settled();
    stage.turnSlide(1);
    await settled();
    expect(stage.report().page).toBe(2);
    stage.turnSlide(2);
    await settled();
    expect(stage.report().page).toBe(4);
    stage.turnSlide(-3);
    await settled();
    expect(stage.report().page).toBe(1);
  });

  it('counts two quick presses as two pages, not one', async () => {
    // Counted off the page drawn instead, an operator ahead of the rasteriser
    // would send two and move one.
    const { stage } = overDeck(5);
    stage.setDeck('intro');
    await settled();
    stage.turnSlide(1);
    stage.turnSlide(1);
    await settled();
    expect(stage.report().page).toBe(3);
  });

  it('stops at either end rather than refusing', async () => {
    const { stage } = overDeck(3);
    stage.setDeck('intro');
    await settled();
    stage.turnSlide(9);
    await settled();
    expect(stage.report().page).toBe(3);
    stage.turnSlide(-9);
    await settled();
    expect(stage.report().page).toBe(1);
    stage.setSlide(400);
    await settled();
    expect(stage.report().page).toBe(3);
  });

  it('does nothing at all with no document up', async () => {
    const { stage, deck } = overDeck(3);
    expect(() => stage.turnSlide(1)).not.toThrow();
    expect(() => stage.setSlide(2)).not.toThrow();
    await settled();
    expect(deck.state.rendered).toEqual([]);
    expect(stage.report()).toMatchObject({ page: 0, pages: 0 });
  });
});

describe('a document that will not open', () => {
  it('reports why and keeps the layer empty, rather than throwing', async () => {
    const { stage } = build(async (url) => {
      throw new Error(`404 ${url}`);
    });
    expect(() => stage.setDeck('missing')).not.toThrow();
    await settled();
    const report = stage.report();
    // The id is still what was asked for: the panel is showing an operator what
    // they typed alongside why it did not work.
    expect(report.deck).toBe('missing');
    expect(report.pages).toBe(0);
    expect(report.error).toContain('/slides/missing.pdf');
    expect(report.ready).toBe(true);
    // And the room behind the character stays where it was, because taking the
    // set down for a file that is not there leaves the stream looking at black.
    expect(stage.up).toBe(false);
  });

  it('keeps the document up when one page of it will not draw', async () => {
    const deck = fakeDeck(5);
    deck.source.render = async (page) => {
      if (page === 2) throw new Error('この頁は壊れています');
      return bitmap();
    };
    const { stage } = build(async () => deck.source);
    stage.setDeck('intro');
    await settled();

    stage.setSlide(2);
    await settled();
    // The file is still open and page 1 is still on the screen. Reading this off
    // the error instead would take the room back over a single bad page — and
    // the room comes back in *front* of the document, because the character's
    // canvas turns opaque with it.
    expect(stage.up).toBe(true);
    expect(stage.report()).toMatchObject({ deck: 'intro', page: 1, pages: 5, ready: false });
    expect(stage.report().error).toContain('2');
  });

  it('clears the error when a document that does open replaces it', async () => {
    const deck = fakeDeck(2);
    let broken = true;
    const { stage } = build(async (url) => {
      if (broken) throw new Error(`404 ${url}`);
      return deck.source;
    });
    stage.setDeck('missing');
    await settled();
    broken = false;
    stage.setDeck('intro');
    await settled();
    expect(stage.report()).toMatchObject({ deck: 'intro', page: 1, error: null });
    expect(stage.up).toBe(true);
  });

  it('drops a document that arrives after another was asked for', async () => {
    // Two ids in quick succession: the first file is still being read when the
    // second is asked for, and showing it would put the wrong deck on air.
    const first = fakeDeck(3);
    const second = fakeDeck(4);
    let release = (): void => {};
    const arriving = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const { stage } = build(async (url) => {
      if (url.includes('first')) {
        await arriving;
        return first.source;
      }
      return second.source;
    });
    stage.setDeck('first');
    stage.setDeck('second');
    await settled();
    release();
    await settled();
    expect(stage.report()).toMatchObject({ deck: 'second', pages: 4 });
    // Held a worker and a parsed file that nothing is going to look at.
    expect(first.state.disposed).toBe(1);
    expect(first.state.rendered).toEqual([]);
  });
});

describe('disposing the layer', () => {
  it('lets go of the document and takes the element off the page', async () => {
    const { stage, host, deck } = overDeck(3);
    stage.setDeck('intro');
    await settled();
    stage.dispose();
    expect(deck.state.disposed).toBe(1);
    expect(host.children).toHaveLength(0);
  });
});
