import { describe, expect, it, vi } from 'vitest';
import { FakeComposition, FakeSlides } from './fakes';
import { build } from './harness';

/**
 * Where the line is delivered — the document behind the character, and a turn
 * that puts one up.
 */

describe('the document behind the character', () => {
  it('forwards the document and the page it opens on, null included', () => {
    const slides = new FakeSlides();
    const { session } = build({ slides });
    session.setDeck('intro', 4);
    session.setDeck('outro');
    // Null takes it down and has to arrive as itself, exactly as the backdrop's
    // does: a default applied on the way would make "put it away" unsayable.
    session.setDeck(null);
    expect(slides.calls).toEqual([
      { call: 'setDeck', id: 'intro', page: 4 },
      { call: 'setDeck', id: 'outro', page: undefined },
      { call: 'setDeck', id: null, page: undefined },
    ]);
  });

  it('leaves the page absent when the caller named none, rather than sending the first', () => {
    // Which page an unqualified `deck` opens on is the renderer's answer, and
    // the session must not decide it here — the port can tell "open it as you
    // would" from "open it at page one" only if the absence survives.
    const slides = new FakeSlides();
    build({ slides }).session.setDeck('intro');
    expect(slides.calls[0]).not.toHaveProperty('page', 1);
    expect(slides.report()).toEqual({
      deck: 'intro',
      page: 1,
      pages: 0,
      ready: true,
      error: null,
    });
  });

  it('forwards an absolute page and a relative move as the two different calls they are', () => {
    const slides = new FakeSlides();
    const { session } = build({ slides });
    session.setSlide(7);
    session.turnSlide(1);
    session.turnSlide(-3);
    // "The next one" is not a page number, and a signed `setSlide` would make
    // the caller that does not know which page is up say that it does.
    expect(slides.calls).toEqual([
      { call: 'setSlide', page: 7 },
      { call: 'turnSlide', by: 1 },
      { call: 'turnSlide', by: -3 },
    ]);
  });

  it('does nothing on a renderer with no document layer, which is most of them', () => {
    // The same shape `setBackdrop` has without scenery and `wear` has without a
    // wardrobe: a renderer that cannot show a document is not a broken one.
    const { session } = build();
    expect(session.slides).toBeNull();
    expect(() => {
      session.setDeck('intro', 2);
      session.setDeck(null);
      session.setSlide(3);
      session.turnSlide(1);
    }).not.toThrow();
  });

  it('forwards a layout patch verbatim, both halves at once', () => {
    const composition = new FakeComposition();
    const { session } = build({ composition });
    const patch = {
      avatar: { anchor: 'bottom-right' as const, width: 0.3 },
      slide: { anchor: 'center' as const, width: 1, fit: 'contain' as const },
    };
    session.setPlacement(patch);
    // One call, because they are one decision: sent as two, the frame is
    // briefly wrong in the most visible direction — two layers overlapping.
    expect(composition.placements).toEqual([patch]);
  });

  it('forwards one number on its own, which is what a slider under the pointer sends', () => {
    const composition = new FakeComposition();
    build({ composition }).session.setPlacement({ avatar: { width: 0.5 } });
    // Merging is the renderer's, and it can only merge what it is given: absent
    // has to stay absent all the way down or every drag resets the other three.
    expect(composition.placements).toEqual([{ avatar: { width: 0.5 } }]);
  });

  it('setPlacement is a no-op on a renderer that draws one way', () => {
    const { session } = build();
    expect(session.composition).toBeNull();
    expect(() => session.setPlacement({ avatar: { width: 0.5 } })).not.toThrow();
  });
});

describe('a turn that stages a document', () => {
  it('opens the document before the page, so the page is the new document’s', () => {
    const slides = new FakeSlides();
    const { session, runUntil } = build({ slides });
    session.setDeck('outro', 9);
    slides.calls.length = 0;

    session.say({ text: 'いち', stage: { deck: 'intro', slide: 4 } });
    runUntil(() => session.turn?.text === 'いち');

    // The other order turns to page 4 of the document being replaced and then
    // opens the new one at its first, which is neither of the two things the
    // line said. One call and not two: the page rides on the document change,
    // so nothing downstream sees the same page asked for twice.
    expect(slides.calls).toEqual([{ call: 'setDeck', id: 'intro', page: 4 }]);
    expect(slides.report()).toMatchObject({ deck: 'intro', page: 4 });
  });

  it('turns a page of the document already up when the line names only a page', () => {
    const slides = new FakeSlides();
    const { session, runUntil } = build({ slides });
    session.setDeck('intro', 1);
    slides.calls.length = 0;

    session.say({ text: 'いち', stage: { slide: 3 } });
    runUntil(() => session.turn?.text === 'いち');

    expect(slides.calls).toEqual([{ call: 'setSlide', page: 3 }]);
    expect(slides.report()).toMatchObject({ deck: 'intro', page: 3 });
  });

  it('takes the document down on a null deck', () => {
    const slides = new FakeSlides();
    const { session, runUntil } = build({ slides });
    session.setDeck('intro', 2);
    slides.calls.length = 0;

    session.say({ text: 'いち', stage: { deck: null } });
    runUntil(() => session.turn?.text === 'いち');

    expect(slides.calls).toEqual([{ call: 'setDeck', id: null, page: undefined }]);
    expect(slides.report()).toMatchObject({ deck: null, page: 0 });
  });

  // Absent is not null, the same rule the backdrop follows: a staging that says
  // nothing about the document is a staging that leaves it exactly where it is.
  it('leaves the document alone when the staging names neither field', () => {
    const slides = new FakeSlides();
    const camera = vi.fn();
    const { session, runUntil } = build({ slides, camera });
    session.setDeck('intro', 5);
    slides.calls.length = 0;

    session.say({ text: 'いち', stage: { camera: 'full' } });
    runUntil(() => session.turn?.text === 'いち');

    expect(camera).toHaveBeenCalledWith({ frame: 'full' });
    expect(slides.calls).toEqual([]);
    expect(slides.report()).toMatchObject({ deck: 'intro', page: 5 });
  });

  it('says a line with no staging at all without touching the document', () => {
    const slides = new FakeSlides();
    const { session, runUntil } = build({ slides });
    session.say({ text: 'いち' });
    runUntil(() => session.turn?.text === 'いち');
    expect(slides.calls).toEqual([]);
  });

  /**
   * The reason a layout is on the turn at all. A deck that fills the frame
   * wants the character out of the middle of it, and the two sent separately
   * arrive at different moments — with her standing over the page in between.
   */
  it('moves the character aside on the same line that puts the document up', () => {
    const slides = new FakeSlides();
    const composition = new FakeComposition();
    const { session, runUntil } = build({ slides, composition });
    const place = { avatar: { anchor: 'bottom-right' as const, width: 0.26 } };

    session.say({ text: 'いち', stage: { deck: 'intro', slide: 1, place } });
    runUntil(() => session.turn?.text === 'いち');

    expect(slides.calls).toEqual([{ call: 'setDeck', id: 'intro', page: 1 }]);
    // Forwarded verbatim, exactly as the standalone command forwards it: absent
    // has to stay absent all the way down or a line that moves her sideways
    // resets her size too.
    expect(composition.placements).toEqual([place]);
  });

  it('leaves the layout alone when the staging does not name one', () => {
    const composition = new FakeComposition();
    const { session, runUntil } = build({ composition });
    session.say({ text: 'いち', stage: { camera: 'full' } });
    runUntil(() => session.turn?.text === 'いち');
    expect(composition.placements).toEqual([]);
  });

  it('leaves the layout where the line put it after the turn ends', () => {
    const composition = new FakeComposition();
    const { session, runUntil } = build({ composition });
    session.say({ text: 'いち', stage: { place: { avatar: { width: 0.3 } } } });
    runUntil(() => session.turn?.text === 'いち');
    runUntil(() => !session.busy);
    // Where the picture sits in the broadcast frame is a property of the
    // stream, not of a sentence. A turn that put it back would drop the
    // character into the middle of the document on the next line.
    expect(composition.placements).toEqual([{ avatar: { width: 0.3 } }]);
  });

  it('leaves the document up after the turn ends, like the camera and the backdrop', () => {
    const slides = new FakeSlides();
    const { session, runUntil } = build({ slides });
    session.say({ text: 'いち', stage: { deck: 'intro', slide: 2 } });
    runUntil(() => session.turn?.text === 'いち');
    const applied = [...slides.calls];

    runUntil(() => !session.busy);

    // A document is where the stream is, not a property of a sentence. A turn
    // that put its own away would leave the next line on a blank layer.
    expect(slides.calls).toEqual(applied);
    expect(slides.report()).toMatchObject({ deck: 'intro', page: 2 });
  });
});
