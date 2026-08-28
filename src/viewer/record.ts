import type { Rect, StageSize } from './scene/placement';
import type { StageFrame } from './scene/runtime';

/**
 * Recording the composed frame, and posting it to the control server.
 *
 * ## Why the picture has to be assembled again here
 *
 * There is no single canvas to capture. The document layer is two DOM canvases
 * the browser composites *behind* the WebGL canvas — see `SlideStage`, where
 * the reason the page is not a textured quad is written down — and the colour
 * behind both is CSS. `captureStream` on either canvas would produce a
 * recording missing the other half of the picture.
 *
 * So the frame is drawn a second time, into one canvas, from the rectangles the
 * runtime already computed for it. That is a second compositor and it is the
 * cost of the arrangement; what keeps it from drifting is that it invents no
 * geometry — every rectangle comes from `StageFrame`, which is read back off
 * the elements the browser is drawing.
 *
 * ## The output size is not the window size
 *
 * The composite is scaled into whatever frame was asked for, letterboxed if the
 * proportions differ. A take is 1920×1080 whether the stage window is
 * fullscreen or a strip down one side of a desk, which is the whole point — the
 * alternative was recordings whose resolution depended on how the operator
 * happened to have arranged their screen.
 *
 * What it cannot do is add detail. A stage window drawn at 800 pixels wide
 * scaled up to 1920 records soft, and nothing here can tell that from a take
 * that was meant to look that way — which is why the panel says so in words
 * rather than trying to refuse it.
 *
 * ## The bytes leave as they are made
 *
 * `MediaRecorder` is run with a timeslice and every chunk is posted straight
 * on. Holding them for a single blob at the end would mean a half-hour segment
 * living in the tab's memory, and would lose the whole take to a reload.
 */

/** How much of the encoded stream is posted at a time, in milliseconds. */
export const CHUNK_MS = 1_000;

/**
 * The containers tried, best first.
 *
 * MP4 is what an operator wants out of this — it opens in everything and drops
 * into an editor without a conversion step — and Chromium has muxed it since
 * 130, which is comfortably older than the runtime this ships against. The WebM
 * entries are the honest fallback for a build without an H.264 encoder rather
 * than a preference: the file still plays, it is still the take, and the server
 * names it for what it actually is. Silently writing `.mp4` over a WebM stream
 * would be the one outcome worse than either.
 *
 * The codec strings are spelled out because Chromium refuses the truncated
 * forms for `video/mp4`.
 */
export const CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
] as const;

/** The first container this browser will encode, or null if it will encode none. */
export function pickMime(
  supported: (type: string) => boolean = (type) => MediaRecorder.isTypeSupported(type),
): string | null {
  return CANDIDATES.find((type) => supported(type)) ?? null;
}

/** Where the stage lands inside the output frame, and how much it is scaled by. */
export interface Fit {
  scale: number;
  left: number;
  top: number;
}

/**
 * Fit the stage into the output frame, centred, without changing its shape.
 *
 * Contain rather than cover, and that is the one choice here worth stating: a
 * stage cropped to fill a frame of different proportions loses picture off two
 * edges, and what it loses is whichever edge the character was standing
 * against. Bars are visible and recoverable; a cropped head is neither.
 */
export function fitStage(stage: StageSize, out: StageSize): Fit {
  if (stage.width <= 0 || stage.height <= 0) return { scale: 0, left: 0, top: 0 };
  const scale = Math.min(out.width / stage.width, out.height / stage.height);
  return {
    scale,
    left: (out.width - stage.width * scale) / 2,
    top: (out.height - stage.height * scale) / 2,
  };
}

/** One of the stage's rectangles, placed in the output frame. */
export function place(rect: Rect, fit: Fit): Rect {
  return {
    left: rect.left * fit.scale + fit.left,
    top: rect.top * fit.scale + fit.top,
    width: rect.width * fit.scale,
    height: rect.height * fit.scale,
  };
}

/**
 * Draw one frame of the stage into a 2D context of the given size.
 *
 * The order is the browser's own: the page colour, then the document layer at
 * its rectangle, then the character over it. Nothing here decides where
 * anything goes — see the module docstring.
 */
export function compose(ctx: CanvasRenderingContext2D, frame: StageFrame, out: StageSize): boolean {
  const fit = fitStage(frame.stage, out);
  if (fit.scale <= 0) return false;

  // Black first, and under everything. It is the letterbox, and it is also what
  // a transparent source records as — a recording has no alpha channel to carry
  // "nothing" in, and black is what such a source already looks like on a page
  // with nothing behind it.
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, out.width, out.height);

  const stage = place({ left: 0, top: 0, ...frame.stage }, fit);
  ctx.fillStyle = frame.background;
  ctx.fillRect(stage.left, stage.top, stage.width, stage.height);

  if (frame.slides !== null) {
    const rect = place(frame.slides.rect, fit);
    // Opaque, so a page that does not fill its rectangle letterboxes against
    // black rather than against the page colour. The same thing the layer's own
    // element does; see `SlideStage`.
    ctx.fillStyle = '#000';
    ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
    for (const layer of frame.slides.canvases) {
      if (layer.opacity <= 0 || layer.canvas.width === 0 || layer.canvas.height === 0) continue;
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(layer.canvas, rect.left, rect.top, rect.width, rect.height);
    }
    ctx.globalAlpha = 1;
  }

  const avatar = place(frame.avatar.rect, fit);
  if (frame.avatar.canvas.width > 0 && avatar.width > 0 && avatar.height > 0) {
    ctx.drawImage(frame.avatar.canvas, avatar.left, avatar.top, avatar.width, avatar.height);
  }
  return true;
}

export interface RecordRequest {
  session: string;
  width: number;
  height: number;
  fps: number;
}

export interface StageRecorderOptions {
  /** Every drawn frame, as the runtime publishes it. Returns the unsubscribe. */
  onFrame: (fn: (frame: StageFrame) => void) => () => void;
  /** Everything the voice makes, as a stream. See `BrowserVoice.captureStream`. */
  openAudio: () => Promise<MediaStream | null>;
  base?: string;
  /** Injected so a test can drive a take without an encoder or a network. */
  fetch?: typeof globalThis.fetch;
}

/**
 * A take in flight: one canvas, one encoder, one queue of uploads.
 *
 * Built once per renderer and asked to start and stop. It holds no opinion
 * about *whether* this renderer should be recording — that is decided by the
 * one rule in `recordCommandSchema`, and is applied where the command is
 * received.
 *
 * It is given the two things it needs rather than the objects that have them,
 * which is what lets a test drive a whole take with a stub frame and no GPU.
 */
export class StageRecorder {
  private readonly onFrame: StageRecorderOptions['onFrame'];
  private readonly openAudio: StageRecorderOptions['openAudio'];
  private readonly base: string;
  private readonly send: typeof globalThis.fetch;

  /**
   * The context the take is composed into, which is also the flag for whether
   * one is running. The canvas itself is not held: the capture stream keeps it
   * alive, and a second reference would only be a second thing to clear.
   */
  private ctx: CanvasRenderingContext2D | null = null;
  private recorder: MediaRecorder | null = null;
  private unsubscribe: (() => void) | null = null;
  private session: string | null = null;
  private out: StageSize = { width: 0, height: 0 };
  /** Uploads are chained so the server appends them in the order they were made. */
  private uploads: Promise<void> = Promise.resolve();
  /** The last problem, for the renderer's own report. Cleared by a new take. */
  private failure: string | null = null;

  constructor(opts: StageRecorderOptions) {
    this.onFrame = opts.onFrame;
    this.openAudio = opts.openAudio;
    this.base = opts.base ?? '/api';
    this.send = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get recording(): boolean {
    return this.recorder !== null;
  }

  /** Why the last take would not start, or null. */
  get error(): string | null {
    return this.failure;
  }

  /**
   * Start recording, replacing any take already running.
   *
   * Replacing rather than refusing: a second `start` means the server opened a
   * second file, and the alternative to switching is a renderer writing into a
   * session nothing is listening for any more.
   */
  async start(request: RecordRequest): Promise<void> {
    if (this.session === request.session && this.recorder !== null) return;
    await this.stop();
    this.failure = null;

    const mime = pickMime();
    if (mime === null) {
      this.failure = 'this browser cannot encode video';
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = request.width;
    canvas.height = request.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx === null) {
      this.failure = 'no 2d context for the recording canvas';
      return;
    }
    ctx.imageSmoothingQuality = 'high';

    const stream = canvas.captureStream(request.fps);
    // Before the recorder is built, because a track cannot be added to a stream
    // one is already reading. A renderer that has not spoken yet has no audio
    // graph at all, so this is what builds it — see `BrowserVoice.captureStream`.
    const audio = await this.openAudio();
    for (const track of audio?.getAudioTracks() ?? []) stream.addTrack(track);

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime });
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      return;
    }

    this.ctx = ctx;
    this.out = { width: request.width, height: request.height };
    this.session = request.session;
    this.recorder = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.post(request.session, mime, event.data, false);
    };
    // The last thing the encoder does. The empty chunk after it is what tells
    // the server the file is complete — the alternative, flagging whichever
    // chunk turned out to be last, means guessing which one that was.
    recorder.onstop = () => {
      this.post(request.session, mime, new Blob([]), true);
    };
    recorder.onerror = () => {
      this.failure = 'the encoder stopped';
      void this.stop();
    };

    this.unsubscribe = this.onFrame((frame) => {
      if (this.ctx !== null) compose(this.ctx, frame, this.out);
    });
    recorder.start(CHUNK_MS);
  }

  /** Stop, and let the encoder flush. Safe to call when nothing is running. */
  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const recorder = this.recorder;
    this.recorder = null;
    this.session = null;
    this.ctx = null;
    if (recorder !== null && recorder.state !== 'inactive') recorder.stop();
    await this.uploads;
  }

  /**
   * Queue one chunk for upload.
   *
   * Chained rather than sent in parallel: the server appends what arrives, and
   * two overlapping posts would interleave two seconds of one file.
   */
  private post(session: string, mime: string, blob: Blob, final: boolean): void {
    const url =
      `${this.base}/record/chunk?session=${encodeURIComponent(session)}` +
      `&mime=${encodeURIComponent(mime)}${final ? '&final=1' : ''}`;
    this.uploads = this.uploads.then(async () => {
      try {
        await this.send(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: blob,
        });
      } catch {
        // The server went away mid-take. Nothing here can repair that, and the
        // panel is already reading the byte count that stopped climbing.
      }
    });
  }
}
