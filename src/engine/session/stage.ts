import type {
  Composition,
  Placement,
  Scenery,
  Shot,
  SlidePlacement,
  Slides,
  Staging,
  Voice,
  VoiceChainRequest,
} from '../types';

/**
 * Where the line is delivered.
 *
 * Five axes — the framing, the acoustic, the set, the document, the layout —
 * and every one of them is a pass-through to whatever the renderer supplied.
 * The engine names the thing and does not describe it, so each method here is
 * one line; what this module is actually for is the *sixth* thing, `apply`,
 * which is the order they go in when a turn carries them all at once.
 *
 * Every axis persists. None of them is a property of a sentence — a shot is
 * where the stream is — so each stays until something says otherwise, unlike
 * everything else a turn sets.
 */
export class Stage {
  constructor(
    private readonly camera: ((shot: Shot) => void) | null,
    private readonly scenery: Scenery | null,
    private readonly voice: Voice | null,
    private readonly slides: Slides | null,
    private readonly composition: Composition | null,
  ) {}

  /**
   * Move the camera: a framing, an offset off it, or both.
   *
   * Staging, beside the room and the backdrop — where the stream is, not what
   * the character is doing — and passed straight through for the same reason:
   * what a framing means in metres is the renderer's business and differs per
   * avatar. See `Shot` for why the offsets are relative.
   *
   * An absent field is left where it was, which is what lets a drag on a
   * preview send a yaw and a pitch and nothing else.
   */
  setCamera(shot: Shot): void {
    this.camera?.(shot);
  }

  /**
   * Put the voice in a named room, or take it out of one.
   *
   * Staging rather than performance, which is why it sits beside the camera and
   * not beside the face: it says where the character is being heard, not what
   * they are doing. It persists until it is changed, and it survives an avatar
   * swap the way the camera does — the room is the set, not the actor.
   *
   * A renderer with no voice has no rooms and this does nothing, which is the
   * same shape as `wear` on an avatar with no wardrobe.
   */
  setRoom(id: string | null): void {
    this.voice?.setRoom(id);
  }

  /**
   * Put the character in front of a named backdrop, or take it away.
   *
   * Staging, beside the camera and the room and for the same reason. It is
   * deliberately *not* chained to `setRoom`: how a set looks and how a voice
   * sits in a mix are chosen for different reasons and changed at different
   * moments, and a renderer that quietly moved the reverb every time the
   * backdrop changed would make every visual cut audible.
   */
  setBackdrop(id: string | null): void {
    this.scenery?.setBackdrop(id);
  }

  /**
   * Put a document up behind the character, or take it down.
   *
   * Staging, beside the backdrop, and it is a **separate axis from one** for
   * the same reason the backdrop is separate from the room: they are chosen at
   * different moments and for different reasons. What they are not is separate
   * *places* — a document and a room both go behind the character, and a
   * renderer showing both has to decide which one is seen. That decision is the
   * renderer's and is stated where it is made; the engine says what was asked
   * for and nothing more.
   *
   * `page` is where to open it, defaulting to the first — not to the page that
   * was showing, which belonged to the document being replaced.
   */
  setDeck(id: string | null, page?: number): void {
    this.slides?.setDeck(id, page);
  }

  /** Go to a page of the document that is up, 1 based. Out of range clamps. */
  setSlide(page: number): void {
    this.slides?.setSlide(page);
  }

  /**
   * Turn pages, forward or back.
   *
   * Distinct from `setSlide` because the caller genuinely does not know which
   * page is up — an operator with a hand on an arrow key, or a hotkey on a
   * control surface. A caller that does know says the number.
   */
  turnSlide(by: number): void {
    this.slides?.turnSlide(by);
  }

  /**
   * Lay out the output frame: where the character stands in it, and where the
   * document sits behind them.
   *
   * Staging, and it is neither the camera nor the backdrop. See `Placement` —
   * the character does not move, the picture of them is put somewhere else in
   * the frame, so every gesture authored against a framing still plays exactly
   * as it did.
   *
   * Both halves merge onto what is already set rather than replacing it, so a
   * panel with one slider under the pointer sends one number.
   */
  setPlacement(placement: { avatar?: Placement; slide?: SlidePlacement }): void {
    this.composition?.setPlacement(placement);
  }

  /**
   * Set how the voice is processed on its way out.
   *
   * Staging, like the room beside it, and passed straight through for the same
   * reason: what a chain is belongs to whatever provides the voice. It takes
   * effect from the next line synthesised rather than retroactively — a take
   * already in the queue was made with the chain that was up when it was made.
   */
  setVoiceChain(request: VoiceChainRequest): void {
    this.voice?.setChain(request);
  }

  /**
   * Apply the staging a turn carried, in the one order that reads correctly.
   *
   * Called as the turn opens and before its audio, so the frame the line opens
   * on is already the right one. It goes through the same calls a standalone
   * `camera`, `backdrop` or `room` would, which is the whole point of putting
   * staging on a turn: not a second way to stage, the same way, said early
   * enough to travel with the line it belongs to.
   *
   * "Before" is exact for the camera and the backdrop and approximate for the
   * room, which is not something this can fix from here. A renderer builds an
   * impulse response to change the acoustic and that is asynchronous — 2 ms
   * for the smallest of the current set and 62 for the largest — so a line
   * that moves rooms opens dry for about a frame. Standalone `room` has
   * always behaved that way; nothing here makes it worse.
   *
   * `undefined` and `null` are not the same and the difference is load
   * bearing — an axis the caller left out keeps what it had, an axis set to
   * null is emptied. `??` here would quietly turn the first into the second.
   */
  apply(staging: Staging): void {
    const { camera, backdrop, room, deck, slide, place } = staging;
    // The framing only: a line names how much of the character is in shot,
    // and where the operator is standing is not a property of a sentence.
    if (camera !== undefined) this.setCamera({ frame: camera });
    if (backdrop !== undefined) this.setBackdrop(backdrop);
    if (room !== undefined) this.setRoom(room);
    // The page goes *into* the document change rather than after it, and the
    // order is not incidental: a line that moves to another document and
    // names a page means that document's page. Doing it the other way round
    // turns to a page of the one being replaced and then opens the new one at
    // its first, which is neither of the two things the line said.
    //
    // `else if`, so a line carrying both is one instruction. Sending the page
    // again afterwards would be harmless here and is exactly the kind of
    // duplicate a renderer eventually acts on twice — a crossfade started, cut
    // and started again on the same page.
    if (deck !== undefined) this.setDeck(deck, slide);
    else if (slide !== undefined) this.setSlide(slide);
    // Last of the five, and after the document rather than before it. Both
    // orders show a wrong frame for an instant; this one shows the character
    // still where she was over a document that has arrived, which reads as
    // her stepping aside. The other shows her already gone from a frame that
    // has nothing in it yet, which reads as a dropped frame.
    if (place !== undefined) this.setPlacement(place);
  }
}
