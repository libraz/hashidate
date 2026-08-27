import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

/**
 * A PDF, as far as the layer above it is concerned: a page count and a way to
 * get one page as a picture.
 *
 * Everything about how that picture is made stays behind this interface, which
 * is why the interface is this narrow. The layer above deals in pages and
 * pixels; that a page is parsed by pdf.js, drawn by a font engine and handed
 * over as an `ImageBitmap` is nothing it has to know, and it is what lets the
 * whole document layer be driven by a fake in a test.
 */

// The worker is a second file that has to be fetched, and Vite needs to be told
// so — hence the `?url` import rather than a path. Without it pdf.js falls back
// to parsing on the main thread, which stalls the frame loop for as long as a
// page takes to lay out.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface DeckSource {
  /** How many pages it has. Known as soon as it is open. */
  readonly pages: number;
  /**
   * Draw one page, 1 based, at `pixelWidth` device pixels across.
   *
   * **This is deliberately the whole seam.** Rasterising a page costs 30-80 ms
   * on the main thread, which is four missed frames of a live render, and the
   * fix for that is to do it somewhere else — an `ImageBitmap` is transferable
   * and this signature is already the one a worker would answer. Nothing above
   * would change. So the cost stays here, in one call, rather than being spread
   * across the layer that decides which page to show.
   */
  render(page: number, pixelWidth: number): Promise<ImageBitmap>;
  dispose(): void;
}

/** A surface to rasterise into. Not every browser has the offscreen one. */
type RasterCanvas = OffscreenCanvas | HTMLCanvasElement;

/**
 * Open a document.
 *
 * Rejects for anything that is not a readable PDF — missing, truncated,
 * encrypted. The caller reports that and keeps drawing; see `SlideStage`.
 */
export async function openDeck(url: string): Promise<DeckSource> {
  const task = pdfjs.getDocument({
    url,
    // A PDF may name a font instead of carrying it, and a Japanese deck usually
    // does — the machine that made it had 游ゴシック (Yu Gothic) installed, so
    // nothing embedded it. These two directories are what pdf.js reads instead:
    // the character-map tables for those encodings, and the outlines of the
    // fourteen standard faces. Without them the page still draws, without its
    // text, which is a failure nobody is told about.
    //
    // Served by the control server out of the installed package; see its
    // `PDFJS_PREFIX`. Fetched only for a page that actually needs one.
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
  });
  const doc = await task.promise;
  return {
    pages: doc.numPages,
    async render(page: number, pixelWidth: number): Promise<ImageBitmap> {
      const loaded = await doc.getPage(page);
      // The scale is derived from the page's own width rather than assumed,
      // because a deck may mix page sizes and a slide that is 4:3 among 16:9
      // ones would otherwise come back at the wrong resolution rather than
      // merely at the wrong shape.
      const unit = loaded.getViewport({ scale: 1 });
      const viewport = loaded.getViewport({ scale: pixelWidth / unit.width });
      const width = Math.max(1, Math.round(viewport.width));
      const height = Math.max(1, Math.round(viewport.height));
      const canvas = surface(width, height);
      // pdf.js types the target as a DOM canvas; it reads `getContext('2d')`
      // off whatever it is given and an `OffscreenCanvas` answers that too.
      await loaded.render({ canvas: canvas as HTMLCanvasElement, viewport }).promise;
      // The page's own operator list and fonts, which are held for a redraw
      // that is not coming: the picture is what we keep.
      loaded.cleanup();
      return createImageBitmap(canvas);
    },
    dispose(): void {
      // The loading task rather than the document: it owns the worker and the
      // request that is still arriving, and a deck taken down while it was
      // still downloading would otherwise finish downloading.
      void task.destroy();
    },
  };
}

/**
 * The surface to draw on.
 *
 * `OffscreenCanvas` where there is one, because it is never in the document and
 * so cannot be laid out, composited or found by anything walking the page. The
 * detached element is the same thing without the guarantee, and is only reached
 * on a browser old enough not to have the former.
 */
function surface(width: number, height: number): RasterCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
