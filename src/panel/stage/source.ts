/**
 * The one address an operator pastes into OBS, composed.
 *
 * Kept apart from the control that draws it because this is the part with a
 * rule in it. What the renderer does with each of these is decided in
 * `stage-mode.ts`, and this side has to agree with it or the panel will show a
 * URL that means something other than what the picker said — the worst kind of
 * disagreement here, because the URL is copied out of the application and is
 * then somebody's OBS configuration for the rest of the year.
 */

/**
 * The two source sizes worth offering.
 *
 * Not a free field. `?size=` fixes the render at exactly the source size
 * configured in OBS so that nothing resamples it, which only helps if the
 * number matches the one in the OBS dialog — and those are the two numbers in
 * that dialog. See `parseSize`, which refuses anything absurd anyway.
 */
export const SOURCE_SIZES = ['1920x1080', '1280x720'] as const;

/** Full frame, or the character in a corner of it. See `parsePlace`. */
export const SOURCE_PLACES = ['', 'bottom-right:0.32x0.6', 'bottom-left:0.32x0.6'] as const;

export type SourceSize = (typeof SOURCE_SIZES)[number];
export type SourcePlace = (typeof SOURCE_PLACES)[number];

/**
 * What each placement is called, so that the list above is the only place a
 * fourth one would have to be added.
 */
export const SOURCE_PLACE_LABELS = {
  '': 'panel.source.full',
  'bottom-right:0.32x0.6': 'panel.source.right',
  'bottom-left:0.32x0.6': 'panel.source.left',
} as const satisfies Record<SourcePlace, string>;

export interface SourceOptions {
  size: SourceSize;
  /** A backdrop id, or empty for the flat background. */
  backdrop: string;
  transparent: boolean;
  /** A deck id, or empty for no document. */
  deck: string;
  place: SourcePlace;
}

/**
 * Whether asking for a transparent background would mean anything.
 *
 * A room is opaque geometry with its own background and wins over it, so the
 * two together are a source configured to do one thing and told to do another.
 * The renderer already resolves that in favour of the room; saying so here
 * keeps the picker from offering a switch that does nothing when it is flipped.
 * See `StageMode.transparent`.
 */
export function transparencyApplies(backdrop: string): boolean {
  return backdrop === '';
}

/**
 * Which deck id is still real.
 *
 * The roster is a directory somebody is dropping files into during a
 * broadcast, so a chosen document can stop existing while the panel is open.
 * An id that is no longer on the roster is dropped rather than carried into
 * the URL, because a source opened on a deck that is not there is a source
 * that comes up with an error in the console and no document. An empty roster
 * decides nothing — that is a control server that has just restarted, and the
 * selection is still good.
 */
export function liveDeck(deck: string, roster: readonly { id: string }[]): string {
  if (deck === '' || roster.length === 0) return deck;
  return roster.some((item) => item.id === deck) ? deck : '';
}

/**
 * Compose the browser source address against the page's own origin.
 *
 * Its own origin, because that is the address OBS has to be able to reach and
 * the panel is already being served from it — the viewer, the panel and the
 * control API are one origin by licence condition. Only what has been chosen
 * is written down: a URL carrying `backdrop=&deck=` is a URL an operator has to
 * read past to see what the source actually is.
 */
export function composeSourceURL(origin: string, options: SourceOptions): string {
  const source = new URL('/', origin);
  source.searchParams.set('size', options.size);
  if (options.backdrop) source.searchParams.set('backdrop', options.backdrop);
  if (options.transparent && transparencyApplies(options.backdrop)) {
    source.searchParams.set('transparent', '1');
  }
  if (options.deck) source.searchParams.set('deck', options.deck);
  if (options.place) source.searchParams.set('place', options.place);
  return source.href;
}
