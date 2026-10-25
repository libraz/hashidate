import {
  type FeedConfig,
  type FeedMessage,
  type FeedPort,
  isFeedMessage,
  openFeedPort,
  WANT_INTERVAL_MS,
} from '@/viewer/stage-feed';

/**
 * The receiving end of the stage feed. See `src/viewer/stage-feed.ts`.
 *
 * Locks onto one source and stays on it while it keeps sending, so a second
 * stage window cannot interleave its chunks into the first one's stream; it is
 * switched to only after the first has been silent for `STALE_MS`.
 */

/** Silence after which the feed counts as gone and the preview draws its own picture. */
export const STALE_MS = 1_500;

/** The decoder-facing half, injected so the source logic can be tested without WebCodecs. */
export interface FeedDecoder {
  configure(config: FeedConfig): void;
  decode(chunk: { key: boolean; timestamp: number; data: ArrayBuffer }): void;
  reset(): void;
  close(): void;
  readonly backlog: number;
}

export interface FeedReceiverOptions {
  watcher: string;
  /** Builds a decoder whose frames go to `draw`; errors go to `failed`. */
  decoder: (failed: () => void) => FeedDecoder | null;
  port?: FeedPort;
  now?: () => number;
}

const sameConfig = (a: FeedConfig | null, b: FeedConfig): boolean =>
  a !== null &&
  a.codec === b.codec &&
  a.codedWidth === b.codedWidth &&
  a.codedHeight === b.codedHeight;

export class FeedReceiver {
  private readonly watcher: string;
  private readonly makeDecoder: FeedReceiverOptions['decoder'];
  private readonly port: FeedPort;
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval>;

  private decoder: FeedDecoder | null = null;
  private config: FeedConfig | null = null;
  /** The source this preview is decoding, and when it was last heard. */
  private source: string | null = null;
  private heard = Number.NEGATIVE_INFINITY;
  /** Set once a keyframe has been decoded; chunks before one are useless. */
  private keyed = false;
  private disposed = false;

  constructor(opts: FeedReceiverOptions) {
    this.watcher = opts.watcher;
    this.makeDecoder = opts.decoder;
    this.port = opts.port ?? openFeedPort();
    this.now = opts.now ?? (() => performance.now());
    this.port.onmessage = (event) => this.receive(event.data);
    this.want();
    this.timer = setInterval(() => this.want(), WANT_INTERVAL_MS);
  }

  /** Whether a source has been heard recently enough to show its picture. */
  get live(): boolean {
    return this.source !== null && this.keyed && this.now() - this.heard < STALE_MS;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.port.onmessage = null;
    this.port.close();
    this.decoder?.close();
    this.decoder = null;
  }

  private want(): void {
    if (this.disposed) return;
    const message: FeedMessage = { type: 'want', watcher: this.watcher, key: !this.keyed };
    this.port.postMessage(message);
  }

  private receive(data: unknown): void {
    if (this.disposed || !isFeedMessage(data)) return;
    if (data.type === 'want') return;
    if (data.type === 'end') {
      if (data.source === this.source) this.drop();
      return;
    }
    const now = this.now();
    if (this.source !== data.source) {
      if (this.source !== null && now - this.heard < STALE_MS) return;
      this.drop();
      this.source = data.source;
    }
    this.heard = now;
    if (!(this.keyed || data.key)) return;
    if (data.key && data.config && !sameConfig(this.config, data.config)) {
      if (!this.open(data.config)) return;
    }
    const decoder = this.decoder;
    if (decoder === null) return;
    // A decoder that is not keeping up is reset to the next keyframe rather
    // than left to show an ever older picture.
    if (decoder.backlog > 3 && !data.key) {
      this.restart();
      return;
    }
    decoder.decode(data);
    if (data.key) this.keyed = true;
  }

  private open(config: FeedConfig): boolean {
    if (this.decoder === null) this.decoder = this.makeDecoder(() => this.restart());
    if (this.decoder === null) return false;
    this.decoder.configure(config);
    this.config = config;
    return true;
  }

  /** Start again from the next keyframe on the same source. */
  private restart(): void {
    this.decoder?.reset();
    this.config = null;
    this.keyed = false;
    this.want();
  }

  /** Forget the source, so the next one heard is taken from its first keyframe. */
  private drop(): void {
    this.restart();
    this.source = null;
    this.heard = Number.NEGATIVE_INFINITY;
  }
}

/**
 * A `FeedDecoder` over WebCodecs, drawing each frame through `draw`.
 * Null where the page has no `VideoDecoder`.
 */
export function webCodecsDecoder(
  draw: (frame: VideoFrame) => void,
): (failed: () => void) => FeedDecoder | null {
  return (failed) => {
    if (typeof VideoDecoder === 'undefined') return null;
    let decoder = make();
    function make(): VideoDecoder {
      return new VideoDecoder({
        output: (frame) => {
          try {
            draw(frame);
          } finally {
            frame.close();
          }
        },
        error: () => failed(),
      });
    }
    // A closed decoder cannot be configured again, so an error replaces it.
    const live = (): VideoDecoder => {
      if (decoder.state === 'closed') decoder = make();
      return decoder;
    };
    return {
      configure: (config) => live().configure({ ...config, optimizeForLatency: true }),
      decode: ({ key, timestamp, data }) => {
        const d = live();
        if (d.state !== 'configured') return;
        d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data }));
      },
      reset: () => {
        if (decoder.state !== 'closed') decoder.reset();
      },
      close: () => {
        if (decoder.state !== 'closed') decoder.close();
      },
      get backlog() {
        return decoder.decodeQueueSize;
      },
    };
  };
}
