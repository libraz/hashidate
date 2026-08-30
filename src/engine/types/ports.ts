import type { LabelledId } from './primitives';
import type { Placement, PlacementReport, SlidePlacement, SlideReport } from './staging';
import type { Take } from './turn';
import type { VoiceChainRequest, VoiceReport } from './voice';

/**
 * The seams between the engine and whatever draws or sounds it.
 *
 * Each interface here is *stated* by the engine and *implemented* by a
 * renderer, and each is deliberately as thin as it can be: the engine names a
 * backdrop, a room, a document or a chain, and knows nothing whatever about
 * what one is. Every port is optional — a renderer that implements none of
 * them still plays turns, which is what every test does.
 */

/**
 * What the character is seen in front of.
 *
 * The visual counterpart to the `rooms` on `Voice`, and on exactly the same
 * footing: the engine knows that backdrops have ids and labels and knows
 * nothing whatever about what one is. A backdrop is geometry, lighting and
 * tone mapping, all of which belong to the renderer — the engine's business is
 * the character, and a `Scenery` that was any more specific than this would be
 * the engine holding an opinion about a wall.
 *
 * Absent on a renderer that has no backdrops, which is the same shape as a
 * renderer with no voice: `backdrop` then does nothing, and the empty list in
 * the vocabulary is how a caller can tell without sending one and watching.
 */
export interface Scenery {
  /** The rooms this renderer can show. Ids and labels only. */
  readonly backdrops: LabelledId[];
  /** Show one of them, or null for the flat background. Unknown ids are null. */
  setBackdrop(id: string | null): void;
}

/**
 * The document the character is presenting from.
 *
 * On the same footing as `Scenery`: the engine knows that a document has an id
 * and pages, and knows nothing at all about what one is. A page is an image on
 * a layer somewhere behind the character, and everything about how it gets
 * there — reading a file, rasterising it, deciding how sharp it needs to be —
 * belongs to the renderer.
 *
 * **There is no list here, unlike `Scenery.backdrops`.** What backdrops exist
 * is renderer data, decided in the source it ships with. What documents exist
 * is whatever the operator dropped in a directory five minutes ago, which only
 * the process with a filesystem can answer — so the roster comes back from the
 * control server, and this port is asked to show one rather than to enumerate
 * them. A renderer handed an id it cannot open says so in its report and keeps
 * drawing, because a broken file is not a reason for a stream to stop.
 *
 * Absent on a renderer with no document layer at all, which is every test.
 */
export interface Slides {
  /**
   * Put a document up, or take the one that is up down.
   *
   * `page` is where to open it. Absent is the first page — not "keep the page
   * we were on", which would be a page number from another document.
   */
  setDeck(id: string | null, page?: number): void;
  /** Go to a page, 1 based. Past either end is clamped, not an error. */
  setSlide(page: number): void;
  /**
   * Move by a number of pages. Its own call rather than a signed `setSlide`,
   * because "the next one" is not a page number — the caller that says it does
   * not know which page is up, and one that did would say so.
   */
  turnSlide(by: number): void;
  /** What is actually on screen, which is not always what was asked for. */
  report(): SlideReport;
}

/**
 * How the output frame is laid out: where the character is in it, and where the
 * document behind them sits.
 *
 * A renderer's question rather than a performance's, which is why it is a port
 * of its own beside `Shading` instead of a field on anything the director
 * holds. The character does not move — the picture of them is put somewhere
 * else in the frame — and the difference matters the moment a gesture is
 * authored against a framing: it still plays exactly as it did.
 *
 * Both halves are partials that land on top of what is already set, on the same
 * rule as a tuning patch: a surface with one slider under the pointer sends one
 * number, and absent means "leave it" rather than "reset it".
 */
export interface Composition {
  setPlacement(placement: { avatar?: Placement; slide?: SlidePlacement }): void;
  /** What the merging produced, and what is actually being drawn. */
  report(): PlacementReport;
}

/**
 * How the avatar's own materials are drawn.
 *
 * One switch, and it is here rather than on the director because the answer is
 * a renderer's: toon shading is a material graph over the meshes a GLB loader
 * built, and the engine has no meshes — it has a rig and a face. Absent on a
 * renderer that draws only one way, which is every test.
 *
 * It exists at all because the fallback is worth being able to see. Turning it
 * off gives the materials the file arrived with, which is how a model that
 * looks wrong is told apart from a shader that is wrong about it.
 */
export interface Shading {
  readonly toon: boolean;
  setToon(on: boolean): void;
}

/**
 * Where a line goes to be spoken.
 *
 * One method, and it is deliberately the *whole* line at once rather than a
 * stream: the speech model does not stream, and being handed the finished take
 * before the turn opens is what lets everything else be planned against a known
 * length instead of corrected mid-sentence.
 */
export interface Voice {
  /**
   * Synthesise a line, or answer null when there is nothing to synthesise it
   * with — no sidecar running, a request that failed, audio the browser will
   * not let us start yet. Null is a normal answer and means "play it silently",
   * not an error: the renderer has to work on a machine that does not have the
   * voice.
   */
  prepare(text: string, reading?: string): Promise<Take | null>;
  /**
   * The acoustic spaces this voice can be heard in, for the vocabulary.
   *
   * Ids and labels only. What a room *is* — its size, its walls, how much of it
   * is in the mix — belongs to whatever implements this, on the same footing as
   * the wardrobe: the engine names the thing and does not describe it.
   */
  readonly rooms: LabelledId[];
  /** Put the voice in one of them, or null for none. An unknown id is none. */
  setRoom(id: string | null): void;
  /**
   * The voice chains this voice can be put through, for the vocabulary. Ids and
   * labels only, on the same footing as `rooms`.
   */
  readonly presets: LabelledId[];
  /**
   * Set the chain. Applies from the next line synthesised: a take already made
   * was made with the chain that was up at the time, and re-making the queue on
   * every parameter change would send all of it back to the synthesiser.
   */
  setChain(request: VoiceChainRequest): void;
  /** What is currently applied, and what the last take measured. */
  report(): VoiceReport;
}
