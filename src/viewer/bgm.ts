import wasmUrl from '@libraz/libsonare/wasm?url';
import type { BgmCommand, BgmDsp, BgmReport, BgmTransport } from '@/protocol';
import { BGM_DEFAULT_LOOP, BGM_DEFAULT_VOLUME, BGM_DSP_DEFAULTS } from '@/protocol';
import type { BrowserAudioOutput } from './audio-output';
import { type BgmDspPlan, buildBgmDspPlan, mergeBgmDsp } from './bgm-dsp';
import bgmWorkletUrl from './bgm-worklet.ts?worker&url';

const PROCESSOR_NAME = 'hashidate-bgm';
const BLOCK_SIZE = 128;

type BgmNodeFactory = (
  context: BaseAudioContext,
  name: string,
  options: AudioWorkletNodeOptions,
) => AudioWorkletNode;

export interface BrowserBgmOptions {
  /** The page-owned output graph. */
  output: BrowserAudioOutput;
  /** URL prefix for the direct server asset route. */
  base?: string;
  /** Injectable media element factory for tests/embedding hosts. */
  audioFactory?: () => HTMLAudioElement;
  /** Injectable clock, in epoch seconds, for late-join tests. */
  now?: () => number;
  /** Vite-emitted local worklet module; override only for tests. */
  workletUrl?: string | URL;
  /** Injectable AudioWorkletNode constructor for graph tests. */
  nodeFactory?: BgmNodeFactory;
  /** Injectable WASM byte loader for browser tests. */
  wasmLoader?: () => Promise<ArrayBuffer>;
  /** Injectable plan for tests; production validates libsonare's scene/IDs. */
  dspPlan?: BgmDspPlan | ((dsp: BgmDsp) => Promise<BgmDspPlan>);
  /** Called when a report-worthy media event occurs. */
  onReport?: (report: BgmReport) => void;
}

type LegacyBrowserBgmOptions = Omit<BrowserBgmOptions, 'output'>;

/**
 * The browser-side BGM transport.
 *
 * The server's revision/position/at fields are authoritative. The HTML audio
 * element supplies streaming and seeking while a separate libsonare Mixer
 * worklet handles the BGM strip; it never enters BrowserVoice's DSP or room.
 */
export class BrowserBgm {
  private readonly output: BrowserAudioOutput;
  private readonly base: string;
  private readonly makeAudio: () => HTMLAudioElement;
  private readonly now: () => number;
  private readonly workletUrl: string | URL;
  private readonly nodeFactory: BgmNodeFactory;
  private readonly loadWasm: () => Promise<ArrayBuffer>;
  private readonly suppliedPlan: BrowserBgmOptions['dspPlan'];
  private readonly onReport?: (report: BgmReport) => void;
  private readonly offUnlock: (() => void) | null;

  private audio: HTMLAudioElement | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private dspNode: AudioWorkletNode | null = null;
  private plan: BgmDspPlan | null = null;
  private workletLoad: Promise<void> | null = null;
  private wasmLoad: Promise<ArrayBuffer> | null = null;
  private workletInitialized = false;
  /** Invalidates every async DSP install when the source route changes. */
  private dspGeneration = 0;
  private pendingPlay: {
    epoch: number;
    audio: HTMLAudioElement;
    promise: Promise<void>;
  } | null = null;

  private track: string | null = null;
  private volume: number = BGM_DEFAULT_VOLUME;
  private loop: boolean = BGM_DEFAULT_LOOP;
  private dsp: BgmDsp = cloneDsp(BGM_DSP_DEFAULTS);
  private transport: BgmTransport = 'stopped';
  private position = 0;
  private positionAt = 0;
  private duration: number | null = null;
  private blocked = false;
  private error: string | null = null;
  private dspDegraded = false;
  private revision = 0;
  private epoch = 0;
  private disposed = false;

  constructor(options: BrowserBgmOptions);
  constructor(output: BrowserAudioOutput, options?: LegacyBrowserBgmOptions);
  constructor(first: BrowserAudioOutput | BrowserBgmOptions, legacy: LegacyBrowserBgmOptions = {}) {
    const options = isOutput(first) ? { ...legacy, output: first } : first;
    this.output = options.output;
    this.base = trimBase(options.base ?? '/bgm');
    this.makeAudio =
      options.audioFactory ??
      (() => {
        if (typeof document === 'undefined') throw new Error('document is unavailable');
        return document.createElement('audio');
      });
    this.now = options.now ?? (() => Date.now() / 1000);
    this.workletUrl = options.workletUrl ?? bgmWorkletUrl;
    this.nodeFactory =
      options.nodeFactory ??
      ((context, name, nodeOptions) => {
        if (typeof AudioWorkletNode === 'undefined')
          throw new Error('AudioWorkletNode unavailable');
        return new AudioWorkletNode(context, name, nodeOptions);
      });
    this.loadWasm = options.wasmLoader ?? fetchBgmWasm;
    this.suppliedPlan = options.dspPlan;
    this.onReport = options.onReport;
    this.offUnlock = this.output.onUnlock(() => {
      void this.retryPlay();
    });
    this.setBusVolume();
  }

  /** Apply a canonical server command. False means an older revision. */
  apply(command: BgmCommand): boolean {
    if (this.disposed) return false;
    const nextRevision = command.revision ?? this.revision;
    if (nextRevision < this.revision) return false;
    const revisionChanged = nextRevision !== this.revision;
    this.revision = nextRevision;
    if (revisionChanged) this.dspDegraded = false;

    if (command.volume !== undefined) {
      this.volume = command.volume;
      this.setBusVolume();
    }
    if (command.loop !== undefined) {
      this.loop = command.loop;
      if (this.audio) this.audio.loop = this.loop;
    }
    if (command.dsp !== undefined) this.dsp = mergeBgmDsp(this.dsp, command.dsp);

    const selected = command.track === undefined ? undefined : normalizeTrack(command.track);
    const commandTransport = command.transport ?? actionTransport(command.action);
    const projected = this.projectPosition(command.position, command.at, commandTransport);
    let mediaChanged = false;
    if (commandTransport !== undefined) this.transport = commandTransport;
    if (command.position !== undefined || command.at !== undefined) {
      this.position = projected;
      this.positionAt = this.now();
      this.syncPosition(projected);
    }

    if (selected !== undefined && selected !== this.track) {
      mediaChanged = true;
      this.epoch += 1;
      const epoch = this.epoch;
      this.detachMedia();
      this.track = selected;
      this.duration = null;
      this.error = null;
      this.blocked = false;
      this.position = selected === null ? 0 : projected;
      this.positionAt = this.now();
      if (selected === null) {
        this.transport = 'stopped';
        this.emitReport();
      } else {
        void this.loadTrack(selected, epoch, this.position);
      }
    }

    if (command.action === 'stop') {
      this.stopAtBoundary();
    } else if (!mediaChanged && this.transport === 'playing') {
      void this.playCurrent(this.epoch);
    } else if (this.transport === 'paused' || this.transport === 'ended') {
      this.audio?.pause();
      this.emitReport();
    }

    // A settings-only DSP patch applies to the existing node without replacing
    // media. Initial construction also sends the complete macro state.
    const dspNode = this.dspNode;
    if (dspNode && this.plan && command.dsp !== undefined) {
      try {
        this.plan.apply(dspNode, this.dsp);
      } catch {
        this.failDsp(this.epoch, dspNode);
      }
    }
    return true;
  }

  /** The last canonical revision and the renderer's diagnostic state. */
  report(): BgmReport {
    const at = this.now();
    let position = this.position;
    if (this.transport === 'playing') {
      const current = this.audio?.currentTime;
      position = Number.isFinite(current) ? Math.max(0, current as number) : this.projectPosition();
    } else if (
      this.transport === 'paused' &&
      this.audio &&
      Number.isFinite(this.audio.currentTime)
    ) {
      position = Math.max(0, this.audio.currentTime);
    }
    return {
      revision: this.revision,
      track: this.track,
      dsp: this.dsp,
      transport: this.transport,
      position,
      duration: this.duration,
      muted: this.output.isMuted,
      blocked: this.blocked || this.output.isBlocked,
      error: this.error,
      dspDegraded: this.dspDegraded,
      at,
    };
  }

  /** Release this BGM without closing the page's shared output context. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.offUnlock?.();
    this.detachMedia();
  }

  get currentTrack(): string | null {
    return this.track;
  }

  get currentRevision(): number {
    return this.revision;
  }

  get isBlocked(): boolean {
    return this.blocked || this.output.isBlocked;
  }

  get isDspDegraded(): boolean {
    return this.dspDegraded;
  }

  private async loadTrack(track: string, epoch: number, position: number): Promise<void> {
    let audio: HTMLAudioElement;
    let generation = 0;
    try {
      audio = this.makeAudio();
      audio.preload = 'auto';
      audio.loop = this.loop;
      // Element volume stays at unity. The BGM bus owns the user fader, and the
      // final master owns the immutable renderer mute.
      audio.volume = 1;
      audio.src = `${this.base}/${encodeURIComponent(track)}`;
      const source = this.output.context.createMediaElementSource(audio);
      source.connect(this.output.bgmBus);
      this.audio = audio;
      this.source = source;
      generation = ++this.dspGeneration;
      this.bindMediaEvents(audio, epoch);
      this.syncPosition(position);
      audio.load();
    } catch (reason) {
      if (epoch !== this.epoch) return;
      this.error = reason instanceof Error ? reason.message : String(reason);
      this.emitReport();
      return;
    }

    // Dry audio is already connected. A successful worklet replaces that edge;
    // a failed worklet leaves media playing and marks only the DSP degraded.
    void this.installDsp(epoch, generation);
    if (this.transport === 'playing') void this.playCurrent(epoch);
    this.emitReport();
  }

  private bindMediaEvents(audio: HTMLAudioElement, epoch: number): void {
    audio.onloadedmetadata = () => {
      if (epoch !== this.epoch || this.audio !== audio) return;
      this.duration = finiteDuration(audio.duration);
      this.syncPosition(this.position);
      this.emitReport();
    };
    audio.onerror = () => {
      if (epoch !== this.epoch || this.audio !== audio) return;
      this.error = mediaError(audio);
      this.blocked = false;
      this.emitReport();
    };
    audio.onended = () => {
      if (epoch !== this.epoch || this.audio !== audio) return;
      if (this.loop) {
        this.position = 0;
        this.syncPosition(0);
        if (this.transport === 'playing') void this.playCurrent(epoch);
        return;
      }
      this.position = 0;
      this.positionAt = this.now();
      this.transport = 'ended';
      this.emitReport();
    };
  }

  private async installDsp(epoch: number, generation: number): Promise<void> {
    if (this.source === null || this.track === null) return;
    const source = this.source;
    let plan: BgmDspPlan;
    try {
      plan = await this.getPlan();
      await this.ensureWorklet();
      if (
        epoch !== this.epoch ||
        generation !== this.dspGeneration ||
        this.source !== source ||
        this.disposed
      )
        return;
      const node = await this.createDspNode(plan.sceneJson);
      if (
        epoch !== this.epoch ||
        generation !== this.dspGeneration ||
        this.source !== source ||
        this.disposed
      ) {
        destroyNode(node);
        return;
      }
      // A media source has exactly one active edge. The generation check above
      // prevents an older async install from restoring a stale DSP connection.
      if (this.dspNode !== null && this.dspNode !== node) destroyNode(this.dspNode);
      source.disconnect();
      source.connect(node);
      node.connect(this.output.bgmBus);
      this.dspNode = node;
      this.plan = plan;
      attachProcessorError(node, () => this.failDsp(epoch, node));
      plan.apply(node, this.dsp);
      this.emitReport();
    } catch {
      if (epoch === this.epoch && generation === this.dspGeneration && this.source === source)
        this.failDsp(epoch);
    }
  }

  private async getPlan(): Promise<BgmDspPlan> {
    if (typeof this.suppliedPlan === 'function') return this.suppliedPlan(this.dsp);
    if (this.suppliedPlan) return this.suppliedPlan;
    return buildBgmDspPlan(this.dsp);
  }

  private async createDspNode(sceneJson: string): Promise<AudioWorkletNode> {
    const wasmBinary = this.workletInitialized ? undefined : await this.ensureWasm();
    const node = this.nodeFactory(this.output.context, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        sceneJson,
        sampleRate: this.output.context.sampleRate,
        blockSize: BLOCK_SIZE,
        stripCount: 1,
        ...(wasmBinary === undefined ? {} : { wasmBinary }),
      },
    });
    try {
      await processorReady(node);
      this.workletInitialized = true;
      return node;
    } catch (reason) {
      destroyNode(node);
      throw reason;
    }
  }

  private ensureWorklet(): Promise<void> {
    if (this.workletLoad !== null) return this.workletLoad;
    const addModule = this.output.context.audioWorklet?.addModule;
    if (!addModule) return Promise.reject(new Error('AudioWorklet is unavailable'));
    this.workletLoad = addModule
      .call(this.output.context.audioWorklet, this.workletUrl)
      .catch((reason) => {
        this.workletLoad = null;
        throw reason;
      });
    return this.workletLoad;
  }

  private ensureWasm(): Promise<ArrayBuffer> {
    if (this.wasmLoad !== null) return this.wasmLoad;
    this.wasmLoad = this.loadWasm().catch((reason) => {
      this.wasmLoad = null;
      throw reason;
    });
    return this.wasmLoad;
  }

  private async playCurrent(epoch: number): Promise<void> {
    const audio = this.audio;
    if (audio === null || epoch !== this.epoch || this.transport !== 'playing') return;
    const pending = this.pendingPlay;
    if (pending?.epoch === epoch && pending.audio === audio) return pending.promise;
    const promise = this.startPlay(audio, epoch);
    this.pendingPlay = { epoch, audio, promise };
    void promise.then(
      () => this.clearPendingPlay(promise),
      () => this.clearPendingPlay(promise),
    );
    return promise;
  }

  private async startPlay(audio: HTMLAudioElement, epoch: number): Promise<void> {
    const context = await this.output.ensureRunning();
    if (context === null || epoch !== this.epoch || this.audio !== audio) {
      if (epoch === this.epoch) {
        this.blocked = true;
        this.error = null;
        this.emitReport();
      }
      return;
    }
    try {
      // A renderer can spend seconds behind autoplay policy while the
      // server-owned transport keeps moving. Seek from the canonical command
      // clock again at the moment playback is actually allowed, rather than
      // starting the delayed renderer from the position it first received.
      this.syncPosition(this.projectPosition());
      await audio.play();
      if (epoch !== this.epoch || this.audio !== audio) return;
      this.blocked = false;
      this.error = null;
      this.positionAt = this.now();
      this.emitReport();
    } catch (reason) {
      if (epoch !== this.epoch || this.audio !== audio) return;
      if (isBlockedPlayError(reason)) {
        this.blocked = true;
        this.error = null;
      } else {
        this.blocked = false;
        this.error = reason instanceof Error ? reason.message : String(reason);
      }
      this.emitReport();
    }
  }

  private clearPendingPlay(promise: Promise<void>): void {
    if (this.pendingPlay?.promise === promise) this.pendingPlay = null;
  }

  private async retryPlay(): Promise<void> {
    if (this.disposed || this.transport !== 'playing' || this.audio === null) return;
    await this.playCurrent(this.epoch);
  }

  private stopAtBoundary(): void {
    this.transport = 'stopped';
    this.position = 0;
    this.positionAt = this.now();
    this.audio?.pause();
    this.syncPosition(0);
    this.epoch += 1;
    const epoch = this.epoch;
    // Stop is a hard transport boundary: remove the old worklet instance so a
    // plate tail cannot leak into the next take. Pause intentionally skips this.
    this.recreateDsp(epoch);
    this.emitReport();
  }

  private recreateDsp(epoch: number): void {
    const source = this.source;
    const generation = ++this.dspGeneration;
    destroyNode(this.dspNode);
    this.dspNode = null;
    this.plan = null;
    if (source === null || this.track === null) return;
    // The epoch also guards media callbacks. Stop/replay keeps the same audio
    // element, so install handlers that accept the new generation before the
    // async DSP rebuild starts.
    if (this.audio !== null) this.bindMediaEvents(this.audio, epoch);
    safeDisconnect(source);
    source.connect(this.output.bgmBus);
    void this.installDsp(epoch, generation);
  }

  private detachMedia(): void {
    this.dspGeneration += 1;
    const source = this.source;
    this.source = null;
    destroyNode(this.dspNode);
    this.dspNode = null;
    this.plan = null;
    safeDisconnect(source);
    const audio = this.audio;
    this.audio = null;
    if (audio) {
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.onended = null;
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch {
        /* a test host may expose only a partial media element */
      }
    }
  }

  private projectPosition(position?: number, at?: number, transport?: BgmTransport): number {
    const base = position ?? this.position;
    const reference = at ?? this.positionAt;
    if (transport === 'playing' && at !== undefined)
      return Math.max(0, base + Math.max(0, this.now() - reference));
    if (transport === undefined && this.transport === 'playing' && at === undefined) {
      return Math.max(0, base + Math.max(0, this.now() - reference));
    }
    return Math.max(0, base);
  }

  private syncPosition(position: number): void {
    const audio = this.audio;
    if (audio === null) return;
    const duration = this.duration ?? finiteDuration(audio.duration);
    if (duration !== null) this.duration = duration;
    const target =
      duration !== null && duration > 0
        ? this.loop
          ? position % duration
          : Math.min(position, duration)
        : position;
    try {
      audio.currentTime = Math.max(0, target);
    } catch {
      // Media elements reject seeks before metadata; loadedmetadata retries it.
    }
  }

  private setBusVolume(): void {
    this.output.bgmBus.gain.value = this.volume;
  }

  private failDsp(epoch: number, failedNode?: AudioWorkletNode): void {
    if (epoch !== this.epoch || (failedNode !== undefined && this.dspNode !== failedNode)) return;
    this.dspGeneration += 1;
    destroyNode(this.dspNode);
    this.dspNode = null;
    this.plan = null;
    if (this.source !== null) {
      safeDisconnect(this.source);
      this.source.connect(this.output.bgmBus);
    }
    this.dspDegraded = true;
    // A worklet failure is distinct from a media error: the dry element keeps
    // playing, and the server must still accept a healthy natural end. The
    // reason is intentionally diagnostic-only and is represented by
    // `dspDegraded`, not by the transport-blocking `error` field.
    this.emitReport();
  }

  private emitReport(): void {
    this.onReport?.(this.report());
  }
}

function isOutput(value: BrowserAudioOutput | BrowserBgmOptions): value is BrowserAudioOutput {
  return 'context' in value && 'bgmBus' in value;
}

function cloneDsp(dsp: BgmDsp): BgmDsp {
  return { ...dsp, reverb: { ...dsp.reverb } };
}

function normalizeTrack(track: string | null): string | null {
  return track === null ? null : track.normalize('NFC');
}

function trimBase(base: string): string {
  const trimmed = base.trim();
  if (trimmed === '') return '';
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function actionTransport(action: BgmCommand['action']): BgmTransport | undefined {
  switch (action) {
    case 'play':
      return 'playing';
    case 'pause':
      return 'paused';
    case 'stop':
      return 'stopped';
    default:
      return undefined;
  }
}

function finiteDuration(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function mediaError(audio: HTMLAudioElement): string {
  const message = audio.error?.message;
  return message && message.length > 0 ? message : 'BGM media could not be loaded';
}

function isBlockedPlayError(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    ('name' in reason ? (reason as { name?: unknown }).name === 'NotAllowedError' : false)
  );
}

function safeDisconnect(node: AudioNode | null): void {
  if (node === null) return;
  try {
    node.disconnect();
  } catch {
    /* already disconnected */
  }
}

function destroyNode(node: AudioWorkletNode | null): void {
  if (node === null) return;
  try {
    node.port.postMessage({ type: 'destroy' });
  } catch {
    /* processor may already be gone */
  }
  safeDisconnect(node);
}

function attachProcessorError(node: AudioWorkletNode, listener: () => void): void {
  const candidate = node as AudioWorkletNode & {
    addEventListener?: (type: string, listener: EventListener) => void;
    onprocessorerror?: ((event: Event) => void) | null;
  };
  if (candidate.addEventListener) candidate.addEventListener('processorerror', listener);
  else candidate.onprocessorerror = listener;
}

async function fetchBgmWasm(): Promise<ArrayBuffer> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`BGM DSP WASM request failed: ${response.status}`);
  return response.arrayBuffer();
}

function processorReady(node: AudioWorkletNode): Promise<void> {
  return new Promise((resolve, reject) => {
    const port = node.port;
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (!isProcessorStatus(event.data)) return;
      cleanup();
      if (event.data.type === 'ready') resolve();
      else reject(new Error(event.data.message));
    };
    const onProcessorError = (): void => {
      cleanup();
      reject(new Error('BGM DSP processor failed during initialization'));
    };
    const cleanup = (): void => {
      port.removeEventListener('message', onMessage);
      node.removeEventListener('processorerror', onProcessorError);
    };
    port.addEventListener('message', onMessage);
    node.addEventListener('processorerror', onProcessorError);
    port.start();
  });
}

function isProcessorStatus(
  value: unknown,
): value is { type: 'ready' } | { type: 'error'; message: string } {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const status = value as { type?: unknown; message?: unknown };
  return status.type === 'ready' || (status.type === 'error' && typeof status.message === 'string');
}
