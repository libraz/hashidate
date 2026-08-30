import { stageMode } from './stage-mode';

/** How long a refused browser resume is allowed to answer before giving up. */
export const AUDIO_RESUME_WAIT_MS = 250;

/** Everything needed to ask an AudioContext to start. Kept small for tests. */
export type StartableAudioContext = Pick<AudioContext, 'state' | 'resume'>;

/**
 * Start an audio context, or answer false rather than waiting forever.
 *
 * Chromium leaves `resume()` pending when autoplay policy has not been
 * satisfied. A bounded race keeps a refused renderer's animation and control
 * channel alive; the gesture listener below will ask the same context again.
 */
export async function startContext(
  context: StartableAudioContext,
  waitMs = AUDIO_RESUME_WAIT_MS,
): Promise<boolean> {
  if (context.state === 'closed') return false;
  if (context.state !== 'running') {
    await Promise.race([
      context.resume().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, waitMs)),
    ]);
  }
  return context.state === 'running';
}

export interface BrowserAudioOutputOptions {
  /** Fixed for the life of the page. Defaults to the URL's `?mute=1`. */
  muted?: boolean;
  /** Injected context for browser tests or an embedding host. */
  context?: AudioContext;
  /** Alternate context constructor for browser tests. */
  contextFactory?: () => AudioContext;
  /** Bounded wait used by {@link ensureRunning}. */
  resumeWaitMs?: number;
}

type UnlockListener = () => void;

/**
 * The page-owned audio graph.
 *
 * There is one context for a renderer, regardless of how many avatars or BGM
 * tracks it visits. Voice and BGM each get a bus so neither can accidentally
 * pass through the other's processing. The final master is the only mute point;
 * both the speaker output and the recorder's MediaStreamDestination are taken
 * after it, making `?mute=1` the sole renderer mute mechanism.
 */
export class BrowserAudioOutput {
  readonly context: AudioContext;
  readonly voiceBus: GainNode;
  readonly bgmBus: GainNode;
  readonly master: GainNode;
  readonly captureDestination: MediaStreamAudioDestinationNode;

  private readonly muted: boolean;
  private readonly ownsContext: boolean;
  private readonly resumeWaitMs: number;
  private readonly unlockListeners = new Set<UnlockListener>();
  private disarm: (() => void) | null = null;
  private blocked = false;
  private disposed = false;

  constructor(options: BrowserAudioOutputOptions = {}) {
    this.muted = options.muted ?? (typeof location === 'undefined' ? false : stageMode().muted);
    this.resumeWaitMs = options.resumeWaitMs ?? AUDIO_RESUME_WAIT_MS;
    this.ownsContext = options.context === undefined;
    this.context = options.context ?? options.contextFactory?.() ?? new AudioContext();

    this.voiceBus = this.context.createGain();
    this.bgmBus = this.context.createGain();
    this.master = this.context.createGain();
    this.master.gain.value = this.muted ? 0 : 1;

    this.voiceBus.connect(this.master);
    this.bgmBus.connect(this.master);
    this.master.connect(this.context.destination);

    // Create this before a recorder is built. MediaRecorder cannot safely have
    // an audio track added after it has started, and the destination is the
    // post-master answer by construction.
    this.captureDestination = this.context.createMediaStreamDestination();
    this.master.connect(this.captureDestination);

    this.armUnlock();
  }

  /** The URL-selected mute state; there is intentionally no setter. */
  get isMuted(): boolean {
    return this.muted;
  }

  /** Whether the browser currently refuses this page an audio device. */
  get isBlocked(): boolean {
    return this.blocked;
  }

  /** The final master node, named explicitly for graph-oriented callers. */
  get masterBus(): GainNode {
    return this.master;
  }

  /** Subscribe to a successful pointer/key resume. Returns an unsubscribe. */
  onUnlock(listener: UnlockListener): () => void {
    this.unlockListeners.add(listener);
    return () => this.unlockListeners.delete(listener);
  }

  /**
   * Ask the browser to run this page's one context.
   *
   * `null` means autoplay policy (or a closed context) refused it. Callers keep
   * their dry/talking-clock fallback in that case and try again on the next
   * line or on the next pointer/key gesture.
   */
  async ensureRunning(): Promise<AudioContext | null> {
    if (this.disposed) return null;
    const started = await startContext(this.context, this.resumeWaitMs);
    if (started) {
      this.notifyUnlocked();
    } else {
      this.blocked = true;
    }
    return started ? this.context : null;
  }

  /** The stream captured after the final master, or null when start was refused. */
  async captureStream(): Promise<MediaStream | null> {
    const context = await this.ensureRunning();
    return context === null ? null : this.captureDestination.stream;
  }

  /** Release the page-owned context and every gesture listener. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disarm?.();
    this.disarm = null;
    safeDisconnect(this.voiceBus);
    safeDisconnect(this.bgmBus);
    safeDisconnect(this.master);
    if (this.ownsContext) void this.context.close().catch(() => {});
  }

  private notifyUnlocked(force = false): void {
    const wasBlocked = this.blocked;
    this.blocked = false;
    // A media element can reject play even while the shared context is already
    // running. Pointer/key gestures therefore notify listeners explicitly;
    // an ordinary ensureRunning() does not trigger a duplicate retry.
    if (!(wasBlocked || force)) return;
    for (const listener of this.unlockListeners) listener();
  }

  private armUnlock(): void {
    if (typeof addEventListener !== 'function') return;
    const options = { capture: true, passive: true } as const;
    const unlock = (): void => {
      if (this.disposed) return;
      if (this.context.state !== 'suspended') {
        if (this.context.state === 'running') this.notifyUnlocked(true);
        return;
      }
      void this.context.resume().then(
        () => {
          if (this.context.state === 'running') this.notifyUnlocked(true);
        },
        () => {},
      );
    };
    addEventListener('pointerdown', unlock, options);
    addEventListener('keydown', unlock, options);
    this.disarm = () => {
      removeEventListener('pointerdown', unlock, options);
      removeEventListener('keydown', unlock, options);
      this.disarm = null;
    };
  }
}

function safeDisconnect(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    // A graph can already have been torn down by an embedding browser.
  }
}
