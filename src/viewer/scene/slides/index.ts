import type { SlidePlacement, SlideReport, Slides } from '@/engine/types';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/translate';
import { FULL_SLIDE, type Rect, rectOf, resolvePlacement, type StageSize } from '../placement';
import { type DeckSource, openDeck } from './deck';

/**
 * The document behind the character.
 *
 * ## It is DOM, not a textured quad
 *
 * A page put into the 3D scene would go through tone mapping, texture filtering
 * and a colour-space round trip on its way to the frame, and the thing being
 * shown is text — the one subject where all three are visible. Here the page is
 * a canvas the browser composites, so it is as sharp as the PDF is, a page turn
 * is an image swap rather than a GPU upload, and the crossfade costs nothing
 * because CSS does it.
 *
 * ## Two canvases, because a page turn is not a flash
 *
 * The page being drawn is drawn into the one that is not showing, and the two
 * are crossfaded when it is ready. Painting over the visible canvas would put a
 * frame of blank white between two slides, which on a stream reads as a fault.
 *
 * ## Nothing here throws
 *
 * A document that will not open leaves the layer empty and the reason in
 * `report().error`. The alternative is a broadcast that stops because a file was
 * saved wrong, and the operator finding out from a black frame rather than from
 * the panel they are already looking at.
 */

/** How long a page takes to fade over the one before it, in milliseconds. */
const CROSSFADE_MS = 180;

/**
 * How long the layer waits after a resize before drawing again, in
 * milliseconds.
 *
 * A drag on the panel's preview changes the rectangle sixty times a second and
 * every one of those would be a full page rasterised at a new width. The
 * picture already on the canvas is stretched by the browser meanwhile, which is
 * soft for a quarter of a second and correct after it.
 */
const RESIZE_DEBOUNCE = 250;

/** The fallback when the browser has no idle callback, in milliseconds. */
const PREFETCH_DELAY = 300;

/**
 * The widest a page is ever drawn, in device pixels.
 *
 * A full-frame layer on a 4K stage at a device pixel ratio of 2 would otherwise
 * ask for a 7680-pixel-wide rasterisation of every page, which costs a second
 * each and is finer than the display can show.
 */
const MAX_PIXEL_WIDTH = 3840;

export interface SlideStageOptions {
  /**
   * How a document is opened. Injected so the tests can drive this layer
   * without pdf.js, a PDF fixture or a canvas that can actually paint — none of
   * which say anything about the part worth checking, which is which page is
   * asked for and what happens when the file is not there.
   */
  open?: (url: string) => Promise<DeckSource>;
  /** Where a document id is served from. See the control server's slide root. */
  url?: (id: string) => string;
}

export class SlideStage implements Slides {
  private readonly layer: HTMLDivElement;
  /** The two crossfading canvases. `front` says which one is showing. */
  private readonly canvases: [HTMLCanvasElement, HTMLCanvasElement];
  private front = 0;
  private readonly open: (url: string) => Promise<DeckSource>;
  private readonly url: (id: string) => string;

  private source: DeckSource | null = null;
  private deckId: string | null = null;
  private pages = 0;
  /** The page asked for, and the page actually drawn. 0 for neither. */
  private want = 0;
  private shown = 0;
  private error: string | null = null;

  private placement: Required<SlidePlacement> = FULL_SLIDE;
  private stage: StageSize = { width: 0, height: 0 };
  private rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  /** The device-pixel size the showing canvas was painted at. */
  private drawn: StageSize = { width: 0, height: 0 };

  /**
   * At most the page before, the page showing and the page after.
   *
   * A whole deck of decoded pages is tens of megabytes of GPU-backed images for
   * slides nobody is going to look at again — and the two that are worth having
   * are the two an arrow key reaches.
   */
  private readonly cache = new Map<number, ImageBitmap>();
  private readonly inflight = new Map<number, Promise<ImageBitmap | null>>();
  /**
   * Bumped whenever what is being drawn stops being what is wanted: a new
   * document, or a size the pages have to be redrawn at. A rasterisation that
   * lands under an old number is thrown away rather than painted, which is the
   * whole of how a fast run through a deck avoids showing a page out of order.
   */
  private generation = 0;

  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelPrefetch: (() => void) | null = null;

  constructor(host: HTMLElement, opts: SlideStageOptions = {}) {
    this.open = opts.open ?? openDeck;
    this.url = opts.url ?? ((id) => `/slides/${encodeURIComponent(id)}.pdf`);

    this.layer = document.createElement('div');
    this.layer.style.position = 'absolute';
    // Behind the canvas, which the runtime lifts to `1`. Explicit on both,
    // because an absolutely positioned canvas paints over a static sibling
    // whatever the document order says.
    this.layer.style.zIndex = '0';
    // Opaque, so a page that does not fill its rectangle letterboxes against
    // black rather than against whatever the room behind it was.
    this.layer.style.background = '#000';
    this.layer.style.overflow = 'hidden';
    this.layer.style.display = 'none';
    this.canvases = [this.buildCanvas(), this.buildCanvas()];
    this.canvases[0].style.opacity = '1';
    for (const canvas of this.canvases) this.layer.appendChild(canvas);
    host.appendChild(this.layer);
  }

  private buildCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.opacity = '0';
    canvas.style.transition = `opacity ${CROSSFADE_MS}ms ease`;
    return canvas;
  }

  // --- what the runtime asks -----------------------------------------------

  /**
   * Whether a document is actually up.
   *
   * A deck that failed to open is not: the room stays where it was and the
   * reason goes in the report, because taking the set down for a file that
   * turned out to be missing would leave the stream looking at nothing. The
   * same answer covers the second or two while a document is being read — the
   * room holds until there is something to put in front of it.
   *
   * An open document, and deliberately **not** an empty `error`. A page that
   * would not rasterise writes one without closing the file, and reading this
   * off the error would take the set back mid-deck over a single bad page —
   * putting the room in front of the document rather than behind it, since the
   * character's canvas turns opaque again with it.
   */
  get up(): boolean {
    return this.deckId !== null && this.source !== null;
  }

  get slidePlacement(): Required<SlidePlacement> {
    return this.placement;
  }

  /** Move or resize the layer. Redrawing at the new size is debounced. */
  setPlacement(placement: SlidePlacement): void {
    this.placement = resolvePlacement(this.placement, placement);
    this.layout();
  }

  /** The stage changed size. Fed by the runtime's one resize path. */
  resize(stage: StageSize): void {
    this.stage = stage;
    this.layout();
  }

  // --- the engine's port ----------------------------------------------------

  setDeck(id: string | null, page = 1): void {
    if (id === null) {
      this.takeDown();
      return;
    }
    const gen = this.invalidate();
    this.source?.dispose();
    this.source = null;
    this.deckId = id;
    this.error = null;
    this.pages = 0;
    this.shown = 0;
    // Where to open it, before the document is there to clamp it against.
    this.want = Math.max(1, Math.floor(page));
    this.layer.style.display = '';
    void this.load(id, gen);
  }

  setSlide(page: number): void {
    if (this.pages === 0) return;
    this.want = Math.min(Math.max(Math.floor(page), 1), this.pages);
    void this.settle();
  }

  /**
   * Move by a number of pages from the one showing.
   *
   * Counted from the page *asked for* rather than the page drawn, so an
   * operator pressing the arrow key twice in quick succession advances two
   * pages instead of racing the rasteriser and advancing one.
   */
  turnSlide(by: number): void {
    if (this.pages === 0 || this.want === 0) return;
    this.setSlide(this.want + Math.trunc(by));
  }

  report(): SlideReport {
    return {
      deck: this.deckId,
      page: this.shown,
      pages: this.pages,
      // Nothing pending counts as ready: with no document up both are 0.
      ready: this.shown === this.want,
      error: this.error,
    };
  }

  dispose(): void {
    this.invalidate();
    this.source?.dispose();
    this.source = null;
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.layer.remove();
  }

  // --- opening --------------------------------------------------------------

  private takeDown(): void {
    this.invalidate();
    this.source?.dispose();
    this.source = null;
    this.deckId = null;
    this.error = null;
    this.pages = 0;
    this.want = 0;
    this.shown = 0;
    this.layer.style.display = 'none';
  }

  private async load(id: string, gen: number): Promise<void> {
    const url = this.url(id);
    let source: DeckSource;
    try {
      source = await this.open(url);
    } catch (e) {
      if (gen === this.generation) this.fail(url, e);
      return;
    }
    if (gen !== this.generation) {
      // Another document was asked for while this one was being read. It is
      // holding a worker and a parsed file, neither of which anything is going
      // to look at.
      source.dispose();
      return;
    }
    if (source.pages < 1) {
      source.dispose();
      this.fail(url, new Error(translate('console.slides.empty', getLocale())));
      return;
    }
    this.source = source;
    this.pages = source.pages;
    // Clamped now rather than when it was asked for: how many pages a document
    // has is only known once it is open, and `deck intro 40` on a nine-page
    // deck means the last page.
    this.want = Math.min(this.want, this.pages);
    void this.settle();
  }

  private fail(url: string, e: unknown): void {
    this.error = translate('console.slides.openFailed', getLocale(), {
      url,
      reason: String(e instanceof Error ? e.message : e),
    });
    this.pages = 0;
    this.want = 0;
    this.shown = 0;
    // Empty rather than half a document. The room comes back, because `up` is
    // false the moment there is an error.
    this.layer.style.display = 'none';
  }

  // --- drawing --------------------------------------------------------------

  /** Get the page that is wanted onto the screen, and warm the one after it. */
  private async settle(): Promise<void> {
    const gen = this.generation;
    const page = this.want;
    if (page === 0 || !this.source) return;
    const bitmap = this.cache.get(page) ?? (await this.rasterise(page, gen));
    // A page that arrived after the operator moved on, or after the deck did.
    if (!bitmap || gen !== this.generation || this.want !== page) return;
    this.paint(bitmap);
    this.shown = page;
    this.trim();
    this.prefetch();
  }

  /**
   * Draw one page, or answer null.
   *
   * Shared per page so that a prefetch already running for the page an operator
   * then turns to is waited on rather than started again.
   */
  private rasterise(page: number, gen: number): Promise<ImageBitmap | null> {
    const existing = this.inflight.get(page);
    if (existing) return existing;
    const source = this.source;
    if (!source) return Promise.resolve(null);
    const pending = source.render(page, this.pixels().width).then(
      (bitmap) => {
        this.forget(page, pending);
        if (gen !== this.generation) {
          // Drawn for a document that has been taken down, or at a size the
          // layer has since left. Closing it releases the decoded image now
          // rather than at the next collection.
          bitmap.close();
          return null;
        }
        this.cache.set(page, bitmap);
        return bitmap;
      },
      (e: unknown) => {
        this.forget(page, pending);
        if (gen === this.generation) {
          this.error = translate('console.slides.drawFailed', getLocale(), {
            page,
            reason: String(e instanceof Error ? e.message : e),
          });
        }
        return null;
      },
    );
    this.inflight.set(page, pending);
    return pending;
  }

  /** Only if it is still ours: a resize may have replaced the entry. */
  private forget(page: number, pending: Promise<ImageBitmap | null>): void {
    if (this.inflight.get(page) === pending) this.inflight.delete(page);
  }

  /**
   * Put a page up.
   *
   * The back canvas is sized here rather than on resize, because assigning to
   * `width` clears a canvas — done while it was showing, the picture would
   * blank for as long as the next rasterisation takes. The showing one is left
   * stretched by the browser until this one is ready to take over.
   */
  private paint(bitmap: ImageBitmap): void {
    const back = this.canvases[1 - this.front];
    const { width, height } = this.pixels();
    back.width = width;
    back.height = height;
    const ctx = back.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      const scale =
        this.placement.fit === 'cover'
          ? Math.max(width / bitmap.width, height / bitmap.height)
          : Math.min(width / bitmap.width, height / bitmap.height);
      const w = bitmap.width * scale;
      const h = bitmap.height * scale;
      ctx.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
    }
    this.drawn = { width, height };
    this.canvases[this.front].style.opacity = '0';
    back.style.opacity = '1';
    this.front = 1 - this.front;
  }

  /**
   * Draw the next page while nothing is happening.
   *
   * The flip is then a swap of two images that already exist, and the 30-80 ms
   * a page costs is paid during a sentence rather than at the moment the
   * operator asked for it — which is the moment it would be seen.
   */
  private prefetch(): void {
    this.cancelPrefetch?.();
    this.cancelPrefetch = null;
    const next = this.shown + 1;
    if (next > this.pages || this.cache.has(next)) return;
    const gen = this.generation;
    this.cancelPrefetch = whenIdle(() => {
      this.cancelPrefetch = null;
      if (gen === this.generation) void this.rasterise(next, gen);
    });
  }

  private trim(): void {
    for (const [page, bitmap] of this.cache) {
      if (Math.abs(page - this.shown) <= 1) continue;
      bitmap.close();
      this.cache.delete(page);
    }
  }

  /** The layer's size in device pixels, with the widest render allowed for. */
  private pixels(): StageSize {
    const ratio = Math.min(devicePixelRatio || 1, MAX_PIXEL_WIDTH / Math.max(this.rect.width, 1));
    return {
      width: Math.max(1, Math.round(this.rect.width * ratio)),
      height: Math.max(1, Math.round(this.rect.height * ratio)),
    };
  }

  /**
   * Move the layer, and redraw at the new resolution if it is a new one.
   *
   * Position is applied immediately — it costs nothing and a layer that lags a
   * drag looks broken. Resolution is not: see `RESIZE_DEBOUNCE`.
   */
  private layout(): void {
    this.rect = rectOf(this.placement, this.stage);
    this.layer.style.left = `${this.rect.left}px`;
    this.layer.style.top = `${this.rect.top}px`;
    this.layer.style.width = `${this.rect.width}px`;
    this.layer.style.height = `${this.rect.height}px`;
    // Nothing on the canvas yet: whatever is drawn next is drawn at the size
    // the layer has now, so there is nothing to redraw and no timer to set.
    if (this.shown === 0) return;
    const pixels = this.pixels();
    if (pixels.width === this.drawn.width && pixels.height === this.drawn.height) return;
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      // Every cached page is at the old resolution, so this is a new
      // generation for the same reason a new document is.
      this.invalidate();
      void this.settle();
    }, RESIZE_DEBOUNCE);
  }

  /**
   * Everything drawn so far stops counting. Answers the new generation.
   *
   * The document itself is deliberately not touched — a resize invalidates the
   * pictures and not the file they came from.
   */
  private invalidate(): number {
    this.cancelPrefetch?.();
    this.cancelPrefetch = null;
    for (const bitmap of this.cache.values()) bitmap.close();
    this.cache.clear();
    this.inflight.clear();
    this.generation += 1;
    return this.generation;
  }
}

/**
 * Run something during a quiet moment, and answer how to call it off.
 *
 * `requestIdleCallback` is what this wants — the work is a rasterisation nobody
 * is waiting for — and the timeout is the fallback for a browser without one
 * rather than a second schedule.
 */
function whenIdle(fn: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(fn, { timeout: PREFETCH_DELAY * 4 });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(fn, PREFETCH_DELAY);
  return () => clearTimeout(handle);
}
