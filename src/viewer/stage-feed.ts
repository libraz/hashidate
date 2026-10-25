import { compose, SlideComposite } from './record';
import type { StageSize } from './scene/placement';
import type { StageFrame } from './scene/runtime';

/**
 * The stage's picture, handed to the panel's preview so it does not draw its own.
 *
 * A second renderer agrees on every command but not on what runs on
 * `Math.random()` — blinks, saccades, breathing — and costs a whole second
 * simulation. So the stage window's renderer (`?feed=1`) encodes its composed
 * frame, the one a recording writes, and the preview decodes it.
 *
 * `BroadcastChannel`, not a socket: it reaches same-origin pages in the same
 * browser profile and nothing else, which is the native shell exactly. WebRTC
 * was rejected because it gathers candidates on every network interface, the
 * reach `AGENTS.md` keeps the renderer away from. A preview that hears no feed
 * draws its own picture.
 *
 * Only while watched: a preview says so every `WANT_INTERVAL_MS`, and a source
 * that has heard nothing for `WANT_TTL_MS` drops its encoder and canvas.
 */

export const FEED_CHANNEL = 'hashidate.stage-feed';

/** The picture the preview receives. Twice a typical preview's CSS width, for a HiDPI panel. */
export const FEED_SIZE: StageSize = { width: 1280, height: 720 };

/** Frames per second sent. A monitor of the shot, not a program feed. */
export const FEED_FPS = 30;

export const FEED_BITRATE = 4_000_000;

/** How often a watching preview says so. */
export const WANT_INTERVAL_MS = 1_000;

/** How long a source keeps encoding after the last preview stopped asking. */
export const WANT_TTL_MS = 3_000;

/** A late joiner waits at most this long for a picture it can start decoding from. */
export const KEYFRAME_INTERVAL_MS = 2_000;

/** What a decoder needs before the first chunk, sent beside every keyframe. */
export interface FeedConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: ArrayBuffer;
}

export type FeedMessage =
  /** From a preview: keep sending, and `key` if it has nothing to decode from yet. */
  | { type: 'want'; watcher: string; key: boolean }
  /** From a source: one encoded frame. `config` rides on every keyframe. */
  | {
      type: 'chunk';
      source: string;
      key: boolean;
      timestamp: number;
      data: ArrayBuffer;
      config?: FeedConfig;
    }
  /** From a source going away, so a preview falls back without waiting out the silence. */
  | { type: 'end'; source: string };

const isRecord = (data: unknown): data is Record<string, unknown> =>
  typeof data === 'object' && data !== null;

const isConfig = (data: unknown): data is FeedConfig =>
  isRecord(data) &&
  typeof data.codec === 'string' &&
  typeof data.codedWidth === 'number' &&
  typeof data.codedHeight === 'number' &&
  (data.description === undefined || data.description instanceof ArrayBuffer);

/** The channel carries only what this module sends; anything else is dropped. */
export function isFeedMessage(data: unknown): data is FeedMessage {
  if (!isRecord(data)) return false;
  switch (data.type) {
    case 'want':
      return typeof data.watcher === 'string' && typeof data.key === 'boolean';
    case 'chunk':
      return (
        typeof data.source === 'string' &&
        typeof data.key === 'boolean' &&
        typeof data.timestamp === 'number' &&
        data.data instanceof ArrayBuffer &&
        (data.config === undefined || isConfig(data.config))
      );
    case 'end':
      return typeof data.source === 'string';
    default:
      return false;
  }
}

/** The part of `BroadcastChannel` used here, so a test can pass a pair of stubs. */
export interface FeedPort {
  postMessage(message: FeedMessage): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export const openFeedPort = (): FeedPort => new BroadcastChannel(FEED_CHANNEL) as FeedPort;

/**
 * Encoders tried, best first: H.264 on the hardware encoder, then VP8, which
 * every WebCodecs build has. Annex B so a chunk carries its own parameter sets
 * and a decoder needs no `description`.
 */
const CODECS: ReadonlyArray<Pick<VideoEncoderConfig, 'codec' | 'avc' | 'hardwareAcceleration'>> = [
  { codec: 'avc1.42001f', avc: { format: 'annexb' }, hardwareAcceleration: 'prefer-hardware' },
  { codec: 'avc1.42001f', avc: { format: 'annexb' } },
  { codec: 'vp8' },
];

export const ENCODER_CANDIDATES: readonly VideoEncoderConfig[] = CODECS.map((c) => ({
  ...c,
  width: FEED_SIZE.width,
  height: FEED_SIZE.height,
  bitrate: FEED_BITRATE,
  framerate: FEED_FPS,
  latencyMode: 'realtime',
}));

/**
 * Pace the display's frames down to `FEED_FPS`, carrying the remainder so a
 * 72 Hz display sends 30 a second rather than every third frame (24). The
 * credit is capped so a stall is not followed by a burst.
 */
export function pace(credit: number, elapsedMs: number): { due: boolean; credit: number } {
  const next = Math.min(2, credit + (elapsedMs * FEED_FPS) / 1000);
  // The epsilon absorbs a sum of exact frame periods landing a hair under 1.
  return next >= 1 - 1e-9
    ? { due: true, credit: Math.max(0, next - 1) }
    : { due: false, credit: next };
}

export interface StageFeedOptions {
  /** Every drawn frame, as the runtime publishes it. Returns the unsubscribe. */
  onFrame: (fn: (frame: StageFrame) => void) => () => void;
  source: string;
  port?: FeedPort;
  now?: () => number;
}

/**
 * The encoding end, owned by the renderer in the stage window.
 *
 * Idle until a preview asks, and idle again once none has asked for
 * `WANT_TTL_MS`: the encoder, the canvas and the frame subscription all exist
 * only while somebody is watching.
 */
export class StageFeed {
  private readonly onFrame: StageFeedOptions['onFrame'];
  private readonly source: string;
  private readonly port: FeedPort;
  private readonly now: () => number;
  private readonly slideCache = new SlideComposite();

  private encoder: VideoEncoder | null = null;
  /** In flight while `isConfigSupported` is being asked; stops a second open racing it. */
  private opening = false;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private unsubscribe: (() => void) | null = null;
  private config: FeedConfig | null = null;
  private lastWant = Number.NEGATIVE_INFINITY;
  private lastFrame: number | null = null;
  private credit = 1;
  private lastKey = Number.NEGATIVE_INFINITY;
  private keyWanted = true;
  private disposed = false;
  private readonly onPageHide = (): void => this.dispose();

  constructor(opts: StageFeedOptions) {
    this.onFrame = opts.onFrame;
    this.source = opts.source;
    this.port = opts.port ?? openFeedPort();
    this.now = opts.now ?? (() => performance.now());
    this.port.onmessage = (event) => this.receive(event.data);
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('pagehide', this.onPageHide);
    }
  }

  /** Whether frames are being encoded. */
  get running(): boolean {
    return this.unsubscribe !== null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('pagehide', this.onPageHide);
    }
    if (this.running) this.port.postMessage({ type: 'end', source: this.source });
    this.stop();
    this.port.onmessage = null;
    this.port.close();
  }

  private receive(data: unknown): void {
    if (this.disposed || !isFeedMessage(data) || data.type !== 'want') return;
    this.lastWant = this.now();
    if (data.key) this.keyWanted = true;
    void this.start();
  }

  private async start(): Promise<void> {
    if (this.unsubscribe === null) this.unsubscribe = this.onFrame((frame) => this.frame(frame));
    if (this.encoder !== null || this.opening) return;
    this.opening = true;
    try {
      this.encoder = await openEncoder(
        (chunk, meta) => this.output(chunk, meta),
        () => {
          // Dropped, not retried here: the next want opens a fresh one.
          this.closeEncoder();
        },
      );
    } finally {
      this.opening = false;
    }
    if (this.disposed || this.unsubscribe === null) this.closeEncoder();
    this.keyWanted = true;
  }

  private stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lastFrame = null;
    this.credit = 1;
    this.closeEncoder();
    this.canvas = null;
    this.ctx = null;
    this.slideCache.dispose();
  }

  private closeEncoder(): void {
    const encoder = this.encoder;
    this.encoder = null;
    this.config = null;
    if (encoder !== null && encoder.state !== 'closed') encoder.close();
  }

  private frame(frame: StageFrame): void {
    const now = this.now();
    if (now - this.lastWant > WANT_TTL_MS) {
      this.stop();
      return;
    }
    const encoder = this.encoder;
    if (encoder === null || encoder.state !== 'configured') return;
    const paced = pace(this.credit, this.lastFrame === null ? 0 : now - this.lastFrame);
    this.lastFrame = now;
    this.credit = paced.credit;
    if (!paced.due) return;
    // A queue that is not draining means the encoder is behind; a skipped frame
    // costs the preview less than a growing delay.
    if (encoder.encodeQueueSize > 2) return;
    const ctx = this.context();
    if (ctx === null || !compose(ctx, frame, FEED_SIZE, this.slideCache)) return;

    const key = this.keyWanted || now - this.lastKey >= KEYFRAME_INTERVAL_MS;
    const video = new VideoFrame(ctx.canvas, { timestamp: Math.round(now * 1000) });
    try {
      encoder.encode(video, { keyFrame: key });
    } finally {
      video.close();
    }
    if (key) {
      this.lastKey = now;
      this.keyWanted = false;
    }
  }

  private context(): CanvasRenderingContext2D | null {
    if (this.ctx !== null) return this.ctx;
    const canvas = document.createElement('canvas');
    canvas.width = FEED_SIZE.width;
    canvas.height = FEED_SIZE.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx === null) return null;
    ctx.imageSmoothingQuality = 'high';
    this.canvas = canvas;
    this.ctx = ctx;
    return ctx;
  }

  private output(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    if (this.disposed) return;
    const decoder = meta?.decoderConfig;
    if (decoder) {
      this.config = {
        codec: decoder.codec,
        codedWidth: decoder.codedWidth ?? FEED_SIZE.width,
        codedHeight: decoder.codedHeight ?? FEED_SIZE.height,
        ...(decoder.description ? { description: copyBuffer(decoder.description) } : {}),
      };
    }
    const data = new ArrayBuffer(chunk.byteLength);
    chunk.copyTo(data);
    const key = chunk.type === 'key';
    this.port.postMessage({
      type: 'chunk',
      source: this.source,
      key,
      timestamp: chunk.timestamp,
      data,
      ...(key && this.config ? { config: this.config } : {}),
    });
  }
}

function copyBuffer(source: AllowSharedBufferSource): ArrayBuffer {
  const view = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  return view.slice().buffer;
}

/** The first candidate this build will encode with, configured; null if none. */
async function openEncoder(
  output: EncodedVideoChunkOutputCallback,
  error: (e: DOMException) => void,
): Promise<VideoEncoder | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const config of ENCODER_CANDIDATES) {
    const { supported } = await VideoEncoder.isConfigSupported(config).catch(() => ({
      supported: false,
    }));
    if (!supported) continue;
    const encoder = new VideoEncoder({ output, error });
    encoder.configure(config);
    return encoder;
  }
  return null;
}
