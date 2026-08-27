/**
 * Stage mode — the viewer with nothing on it but the character.
 *
 * `?stage=1` is what OBS opens. The console, the HUD and the cursor go away and
 * what is left is the render, which is the whole difference between a tool and a
 * source: anything else on the page is something a viewer can see.
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

import { backdropList } from './scene/backdrop';

/** How the viewer was asked to present itself. */
export interface StageMode {
  /** No console, no HUD, no cursor. */
  stage: boolean;
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

/** Read the mode off a query string. */
export function readStageMode(search: string): StageMode {
  const params = new URLSearchParams(search);
  return {
    stage: isOn(params.get('stage')),
    size: parseSize(params.get('size')),
    backdrop: parseBackdrop(params.get('backdrop')),
    muted: isOn(params.get('mute')),
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
