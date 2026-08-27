/**
 * How the renderer presents itself: a stage by default, a tool when asked.
 *
 * The page is the program output, so it opens with nothing on it but the
 * character — no console, no HUD, no cursor. That is the whole difference
 * between a tool and a source: anything else on the page is something a viewer
 * can see, and a default that has to be switched *off* before going to air is a
 * default that eventually goes to air.
 *
 * `?console=1` brings the operator console back, along with the HUD and the
 * cursor, because those three are one thing — the development view. Everything
 * needed to run a broadcast lives in the panel on `/panel/`, which is a page of
 * its own and holds no renderer.
 *
 * `?debug=1` is the one readout that may be brought up over a frame that is on
 * air, because it only reads: the same measurements the HUD draws, printed as a
 * shell, above the document layer so a slide segment does not hide them. This
 * is only where a source *opens*; the backquote key and the `debug` command
 * both move it afterwards, and that is how it is used in practice — switched on
 * to answer a question and off again a few seconds later.
 *
 * `?stage=1` is still accepted and now says nothing the default does not. It
 * stays because it is written into browser sources that were configured before
 * the default changed, and a URL that quietly stops working is worse than a flag
 * that quietly does nothing.
 *
 * ## It is a browser source, not a captured window
 *
 * OBS renders this in its own offscreen CEF, so the page is never occluded,
 * never minimised and never on another Space — the `requestAnimationFrame`
 * throttling that makes screen capture unusable for a stream simply does not
 * apply. It also means page audio is picked up in-process, so the voice arrives
 * on the stream without a virtual audio device in between.
 *
 * ## The canvas is sized in pixels, not by the window
 *
 * `?size=1920x1080` fixes the render at exactly the source size configured in
 * OBS. Left to fill the window it would be resampled twice — once by the browser
 * onto a window that is some other size, once by OBS back onto the canvas — and
 * a 3D render survives that worse than video does, because the edges it is made
 * of are one pixel wide. Absent, the canvas fills the window, which is what a
 * bare `?stage=1` on a desktop browser wants.
 */

import type { Placement, SlidePlacement } from '@/engine/types';
import { PLACEMENT_LIMITS } from '@/engine/types';
import { backdropList } from './scene/backdrop';
import { FULL_FRAME, FULL_SLIDE, isAnchor } from './scene/placement';

/** How the viewer was asked to present itself. */
export interface StageMode {
  /**
   * The operator console, the HUD and the cursor. Off unless `?console=1`.
   *
   * One flag for all three rather than three, because they are one decision:
   * this page is either the thing going to air or the thing being worked on.
   */
  console: boolean;
  /**
   * The telemetry readout, printed over the frame as a shell. Off unless
   * `?debug=1`, and toggled live by the backquote key or a `debug` command.
   *
   * Separate from `console` because it answers a different question. The
   * console is the development view — it reaches *into* the scene and needs a
   * page nobody is watching. This only reads, so it is safe to switch on over a
   * live frame, which is the only time some of these numbers mean anything: a
   * gaze that drifts or a frame rate that slips does it while a broadcast is
   * running, not while a pose is being worked on.
   *
   * It is not written back onto the address bar the way the room is. The room
   * is what a browser source *is*; this is something switched on to look at
   * now, and a URL that remembered it would be a URL that puts telemetry on
   * air the next time OBS reloads the source.
   */
  debug: boolean;
  /** Render size in CSS pixels, or null to fill the window. */
  size: { width: number; height: number } | null;
  /**
   * Which room to render the avatar in, or null for the flat background.
   *
   * On the URL rather than in the console because this is a property of the
   * *source*, not of the session: OBS holds one browser source per scene, and a
   * scene that is meant to be the night room is meant to be the night room every
   * time it is switched to, without an operator remembering to set it. Putting
   * it in a picker would mean the room silently reverting on every reload of a
   * page that reloads whenever OBS feels like it.
   */
  backdrop: string | null;
  /**
   * With no room and no document up, draw nothing behind the character at all.
   *
   * The flat colour this replaces is not a design choice, it is a floor: a
   * renderer opened in a browser window with no room selected has to put
   * *something* behind the avatar or it is a checkerboard. Over a game capture
   * that floor is the problem — it is an opaque rectangle covering the thing the
   * stream is about.
   *
   * So this is what a source says when it knows something is underneath it. The
   * compositing is OBS's: a game or window capture below, this page as a browser
   * source above, and the character lands on it with `?place=`. Capturing the
   * game *into* this page was the alternative and is worse in the place it has
   * to work — the browser embedded in OBS has no way to grant a display-capture
   * permission, so it would only ever run in a stray Chrome window, and it would
   * take every frame of the game twice.
   *
   * A room wins over it. A room is opaque geometry with its own background, and
   * one selected while this is on is an operator asking for the room.
   *
   * On the URL rather than in the vocabulary for the reason the room is, only
   * more so: no segment ever says "be transparent". What is underneath is a
   * property of the OBS scene the source was dropped into, and a line of script
   * cannot know it.
   */
  transparent: boolean;
  /**
   * Render the character but make no sound.
   *
   * For the preview embedded in the broadcast panel, which is a second renderer
   * of the same commands: without this the operator hears every line twice, once
   * from the preview and once from whatever is going to air, a fraction of a
   * second apart.
   *
   * **It silences the output and not the synthesis.** A muted viewer still asks
   * for every line and still plays the take — into a gain of zero. Skipping the
   * request would be cheaper and would put the preview on a different clock: the
   * mouth would fall back to the text estimate, lines would end at different
   * moments than they do on air, and the queue in the preview would drift out of
   * step with the queue being watched. A monitor that runs ahead of the thing it
   * monitors is worse than no monitor.
   */
  muted: boolean;
  /**
   * Which document to open on, or null for none.
   *
   * On the URL for the reason the room is: a scene in OBS that is the slide
   * segment should be the slide segment every time it is switched to, without
   * an operator remembering to send a command first.
   */
  deck: string | null;
  /**
   * How the frame is laid out: where the character stands in it, and where the
   * document behind them sits.
   *
   * Both are here so that a source can be configured as the composed picture
   * rather than as a renderer that has to be told what to be. The full frame
   * for both is the default, and is what every source that never mentions it
   * gets.
   */
  place: { avatar: Placement; slide: SlidePlacement };
}

/**
 * The widest render worth allowing.
 *
 * Not a policy so much as a guard against a typo in a query string allocating a
 * framebuffer the GPU cannot back — the device pixel ratio multiplies whatever
 * lands here, so `?size=19200x10800` on a retina display asks for a buffer in
 * the tens of gigabytes and takes the tab with it.
 */
const MAX_DIMENSION = 7680;

const SIZE = /^(\d{2,5})x(\d{2,5})$/;

/** A flag that is present and not explicitly switched off. */
const isOn = (value: string | null): boolean =>
  value !== null && value !== '0' && value !== 'false';

/** Parse `1920x1080`. Anything else — including out of range — is "fill the window". */
export function parseSize(raw: string | null): StageMode['size'] {
  const match = raw === null ? null : raw.match(SIZE);
  if (!match) return null;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  return { width, height };
}

/**
 * Resolve `?backdrop=night` against the patterns that exist.
 *
 * An unknown name is the flat background rather than an error. The viewer is
 * opened by a URL typed into a field inside OBS, where there is nowhere for an
 * error to be reported to and nobody watching if there were — so a typo has to
 * degrade to something that still streams.
 */
export function parseBackdrop(raw: string | null): string | null {
  if (raw === null || raw === '' || raw === 'none') return null;
  return backdropList().some((b) => b.id === raw) ? raw : null;
}

/**
 * Which document a source opens on, from `?deck=intro`.
 *
 * Unlike a room, this cannot be checked against a list: what documents exist is
 * whatever the operator dropped in a directory five minutes ago, and only the
 * process with a filesystem can answer. So all a renderer needs from an id is
 * that there is one — a non-empty string, with the spaces a query string picks
 * up trimmed off. `none` is the way to say there is no document, on the same
 * spelling the room takes.
 *
 * **What an id may be belongs to the control server**, which owns the directory
 * and guards it by resolving the path and checking it against the root. Stating
 * the rule a second time here would be stating it in a place that cannot see
 * the directory, and the copy would only have to be found and widened again the
 * next time the server's is. An id that names nothing already degrades the way
 * every other value read from this URL does: the fetch fails, the reason lands
 * in `report().error`, and the page carries on streaming the character.
 */
export function parseDeck(raw: string | null): string | null {
  const id = raw === null ? '' : raw.trim();
  if (id === '' || id === 'none') return null;
  return id;
}

/** `bottom-right:0.32x0.6` — an anchor, then the fractions of the frame. */
const PLACE = /^([a-z-]+):(\d*\.?\d+)x(\d*\.?\d+)$/;

/**
 * Where the character stands in the frame, from `?place=bottom-right:0.32x0.6`.
 *
 * The rectangle is the *character's*, and the document keeps the whole frame:
 * the document is what a source like this is for, and the thing being placed is
 * the picture in front of it. A layout finer than one corner and one size
 * belongs to the panel, which can show what it is doing.
 *
 * Anything that does not parse — a bad anchor, a fraction outside what the wire
 * accepts, a missing half — is the full frame, on the same rule as every other
 * value read from this URL: there is nowhere to report an error to, so it has
 * to degrade to something that still streams.
 */
export function parsePlace(raw: string | null): StageMode['place'] {
  const full = { avatar: { ...FULL_FRAME }, slide: { ...FULL_SLIDE } };
  const match = raw === null ? null : raw.match(PLACE);
  if (!match) return full;
  const [, anchor, rawWidth, rawHeight] = match;
  if (!isAnchor(anchor)) return full;
  const width = Number.parseFloat(rawWidth);
  const height = Number.parseFloat(rawHeight);
  if (!(within(width, PLACEMENT_LIMITS.width) && within(height, PLACEMENT_LIMITS.height))) {
    return full;
  }
  return { avatar: { ...full.avatar, anchor, width, height }, slide: full.slide };
}

const within = (value: number, limit: { min: number; max: number }): boolean =>
  Number.isFinite(value) && value >= limit.min && value <= limit.max;

/** Read the mode off a query string. */
export function readStageMode(search: string): StageMode {
  const params = new URLSearchParams(search);
  return {
    console: isOn(params.get('console')),
    debug: isOn(params.get('debug')),
    size: parseSize(params.get('size')),
    backdrop: parseBackdrop(params.get('backdrop')),
    transparent: isOn(params.get('transparent')),
    muted: isOn(params.get('mute')),
    deck: parseDeck(params.get('deck')),
    place: parsePlace(params.get('place')),
  };
}

/** Read the mode off the live location. */
export const stageMode = (): StageMode => readStageMode(location.search);

/**
 * Write the room back onto the address bar.
 *
 * The console can change the backdrop live, and without this the change is
 * invisible the moment the operator wants to *use* it: the URL is what gets
 * pasted into an OBS browser source, and a room chosen in a picker that leaves
 * no trace on the address bar has to be chosen again by hand at the other end.
 * Putting it back means the console doubles as the place the source URL is
 * composed — pick the room, copy the bar.
 *
 * `replaceState`, not `pushState`. A picker is not navigation, and five clicks
 * through the rooms should not be five presses of the back button to undo.
 *
 * Only the console calls this. A `backdrop` command arriving over the control
 * API deliberately does not, because the URL is the source's configuration and
 * an orchestrator changing the set for one segment has not changed what the
 * source is.
 */
export function rememberBackdrop(id: string | null): void {
  const url = new URL(location.href);
  if (id === null) url.searchParams.delete('backdrop');
  else url.searchParams.set('backdrop', id);
  history.replaceState(null, '', url);
}

/**
 * Write the transparent background back onto the address bar, as the room is.
 *
 * More load-bearing than the room's, because there is nothing to see. A room
 * picked in the console is visible in the frame whether or not the URL kept it;
 * this switched on over a page with nothing underneath looks exactly like the
 * flat colour it replaced, so an operator who could not read it off the bar
 * would have no way to tell whether the source they are about to paste is the
 * one they set up.
 */
export function rememberTransparent(on: boolean): void {
  const url = new URL(location.href);
  if (on) url.searchParams.set('transparent', '1');
  else url.searchParams.delete('transparent');
  history.replaceState(null, '', url);
}
