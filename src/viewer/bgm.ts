import wasmUrl from '@libraz/libsonare/wasm?url';
import type { BgmCommand, BgmDsp, BgmFade, BgmReport, BgmTransport } from '@/protocol';
import {
  BGM_DEFAULT_LOOP,
  BGM_DEFAULT_VOLUME,
  BGM_DSP_DEFAULTS,
  BGM_FADE_DEFAULTS,
} from '@/protocol';
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

interface EnvelopeState {
  from: number;
  to: number;
  start: number;
  duration: number;
}

interface TrackRoute {
  readonly epoch: number;
  readonly track: string;
  readonly audio: HTMLAudioElement;
  readonly source: MediaElementAudioSourceNode;
  readonly envelope: GainNode;
  envelopeState: EnvelopeState;
  retired: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
}

interface PendingSwitch {
  incomingEpoch: number;
  outgoing: TrackRoute[];
  fade: BgmFade;
}

/**
 * The browser-side BGM transport.
 *
 * The server's revision/position/at fields are authoritative. Every media
 * source enters its own envelope, then a persistent mix bus feeds one shared
 * libsonare Mixer worklet (or its dry fallback) and finally the BGM bus. The
 * mix is deliberately separate from voice and the final master remains the
 * only renderer mute point.
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
  /** All track envelopes feed this one persistent route into BGM DSP. */
  private readonly mixBus: GainNode;
  private readonly routes = new Set<TrackRoute>();

  private currentRoute: TrackRoute | null = null;
  private pendingSwitch: PendingSwitch | null = null;
  private dspNode: AudioWorkletNode | null = null;
  private plan: BgmDspPlan | null = null;
  private workletLoad: Promise<void> | null = null;
  private wasmLoad: Promise<ArrayBuffer> | null = null;
  private workletInitialized = false;
  /** Invalidates every async shared DSP install when its route is rebuilt. */
  private dspGeneration = 0;
  private dspInstall: Promise<void> | null = null;
  private pendingPlay: {
    epoch: number;
    route: TrackRoute;
    generation: number;
    promise: Promise<void>;
  } | null = null;

  private track: string | null = null;
  private volume: number = BGM_DEFAULT_VOLUME;
  private loop: boolean = BGM_DEFAULT_LOOP;
  private dsp: BgmDsp = cloneDsp(BGM_DSP_DEFAULTS);
  private fade: BgmFade = { ...BGM_FADE_DEFAULTS };
  private transport: BgmTransport = 'stopped';
  private position = 0;
  private positionAt = 0;
  private duration: number | null = null;
  private blocked = false;
  private error: string | null = null;
  private dspDegraded = false;
  private revision = 0;
  private epoch = 0;
  private playGeneration = 0;
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
    this.mixBus = this.output.context.createGain();
    this.mixBus.gain.value = 1;
    this.connectDry();
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

    const previousTransport = this.transport;
    const previousTrack = this.track;

    if (command.volume !== undefined) {
      this.volume = command.volume;
      this.setBusVolume();
    }
    if (command.loop !== undefined) {
      this.loop = command.loop;
      for (const route of this.routes) route.audio.loop = this.loop;
    }
    if (command.dsp !== undefined) this.dsp = mergeBgmDsp(this.dsp, command.dsp);
    if (command.fade !== undefined) this.fade = mergeFade(this.fade, command.fade);

    const selected = command.track === undefined ? undefined : normalizeTrack(command.track);
    const commandTransport = command.transport ?? actionTransport(command.action);
    const projected = this.projectPosition(command.position, command.at, commandTransport);
    let mediaChanged = false;
    if (commandTransport !== undefined) this.transport = commandTransport;
    if (command.position !== undefined || command.at !== undefined) {
      this.position = projected;
      this.positionAt = this.now();
      if (this.currentRoute !== null) this.syncPosition(this.currentRoute, projected);
    }

    if (selected !== undefined && selected !== previousTrack) {
      mediaChanged = true;
      this.epoch += 1;
      this.playGeneration += 1;
      const epoch = this.epoch;
      this.track = selected;
      this.duration = null;
      this.error = null;
      this.blocked = false;
      this.currentRoute = null;
      this.position = selected === null ? 0 : projected;
      this.positionAt = this.now();
      if (selected === null) {
        // Unload is a hard boundary. No old tail or timer may survive it.
        this.hardUnload();
        this.transport = 'stopped';
        this.emitReport();
      } else {
        if (command.action === 'stop') {
          this.hardUnload();
        } else if (commandTransport === 'playing') {
          const outgoing = this.chooseOutgoing();
          this.pendingSwitch = {
            incomingEpoch: epoch,
            outgoing,
            fade: cloneFade(this.fade),
          };
          for (const route of [...this.routes]) {
            if (!outgoing.includes(route)) this.finalizeRoute(route);
          }
        } else {
          const outgoing = this.chooseOutgoing();
          this.pendingSwitch = null;
          const at = outgoing.length > 0 ? this.audioTime() : 0;
          for (const route of [...this.routes]) {
            if (outgoing.includes(route)) this.retireRouteAt(route, this.fade.outSeconds, at);
            else this.finalizeRoute(route);
          }
        }
        // A track selection without an explicit transport is a stopped load.
        if (commandTransport === undefined) this.transport = 'stopped';
        void this.loadTrack(selected, epoch, this.position);
      }
    }

    if (command.action === 'stop' && !mediaChanged) {
      this.stopAtBoundary();
    } else if (!mediaChanged && this.transport === 'playing') {
      const resumed = previousTransport === 'paused' && previousTrack === this.track;
      const route = this.currentRoute ?? this.reloadCurrentTrack(previousTransport !== 'paused');
      if (route !== null && resumed) this.scheduleEnvelope(route, 1, 0);
      const pending =
        route !== null && this.pendingSwitch?.incomingEpoch === route.epoch
          ? this.pendingSwitch
          : null;
      void this.playCurrent(
        route,
        !resumed && (previousTransport !== 'playing' || route?.started !== true),
        pending?.fade,
      );
    } else if (this.transport === 'paused' || this.transport === 'ended') {
      const route = this.currentRoute;
      if (this.pendingSwitch !== null) {
        this.pendingSwitch = null;
        for (const pending of [...this.routes]) this.finalizeRoute(pending);
        this.currentRoute = null;
        this.duration = null;
      } else if (route !== null) {
        this.holdEnvelope(route);
        route.audio.pause();
      }
      for (const retired of [...this.routes]) {
        if (retired !== route) this.finalizeRoute(retired);
      }
      this.playGeneration += 1;
      this.pendingPlay = null;
      this.emitReport();
    }

    // A settings-only DSP patch applies to the one shared node without
    // replacing media. The complete resolved macro state is always applied.
    const dspNode = this.dspNode;
    if (dspNode && this.plan && command.dsp !== undefined) {
      try {
        this.plan.apply(dspNode, this.dsp);
      } catch {
        this.failDsp(this.dspGeneration, dspNode);
      }
    }
    return true;
  }

  /** The last canonical revision and the renderer's diagnostic state. */
  report(): BgmReport {
    const at = this.now();
    const audio = this.currentRoute?.audio ?? null;
    let position = this.position;
    if (this.transport === 'playing') {
      const current = audio?.currentTime;
      position = Number.isFinite(current) ? Math.max(0, current as number) : this.projectPosition();
    } else if (this.transport === 'paused' && audio && Number.isFinite(audio.currentTime)) {
      position = Math.max(0, audio.currentTime);
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
    this.playGeneration += 1;
    this.pendingSwitch = null;
    this.dspGeneration += 1;
    this.dspInstall = null;
    this.offUnlock?.();
    for (const route of [...this.routes]) this.finalizeRoute(route);
    this.currentRoute = null;
    destroyNode(this.dspNode);
    this.dspNode = null;
    this.plan = null;
    safeDisconnect(this.mixBus);
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

  private async loadTrack(
    track: string,
    epoch: number,
    position: number,
    fadeIn = true,
  ): Promise<void> {
    let audio: HTMLAudioElement | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    let envelope: GainNode | null = null;
    let route: TrackRoute | null = null;
    try {
      audio = this.makeAudio();
      audio.preload = 'auto';
      audio.loop = this.loop;
      // Element volume stays at unity. The BGM bus owns the user fader, and the
      // final master owns the immutable renderer mute.
      audio.volume = 1;
      audio.src = `${this.base}/${encodeURIComponent(track)}`;
      source = this.output.context.createMediaElementSource(audio);
      envelope = this.output.context.createGain();
      envelope.gain.value = 0;
      source.connect(envelope);
      envelope.connect(this.mixBus);
      route = {
        epoch,
        track,
        audio,
        source,
        envelope,
        envelopeState: { from: 0, to: 0, start: this.audioTime(), duration: 0 },
        retired: false,
        timer: null,
        started: false,
      };
      this.routes.add(route);
      if (epoch !== this.epoch || this.disposed || this.track !== track) {
        this.finalizeRoute(route);
        return;
      }
      this.currentRoute = route;
      this.bindMediaEvents(route);
      this.syncPosition(route, position);
      audio.load();
    } catch (reason) {
      if (route !== null) this.finalizeRoute(route);
      else {
        safeDisconnect(envelope);
        safeDisconnect(source);
        cleanupAudio(audio);
      }
      if (epoch !== this.epoch) return;
      this.error = reason instanceof Error ? reason.message : String(reason);
      this.emitReport();
      return;
    }

    // Dry audio is already connected. A successful worklet replaces that edge;
    // a failed worklet leaves the shared mix playing and marks only DSP degraded.
    this.installDsp();
    const pending = this.pendingSwitch?.incomingEpoch === epoch ? this.pendingSwitch : null;
    if (this.transport === 'playing' && route !== null)
      void this.playCurrent(route, fadeIn, pending?.fade);
    this.emitReport();
  }

  private bindMediaEvents(route: TrackRoute): void {
    const { audio } = route;
    audio.onloadedmetadata = () => {
      if (!this.isCurrent(route)) return;
      this.duration = finiteDuration(audio.duration);
      this.syncPosition(route, this.position);
      this.emitReport();
    };
    audio.onerror = () => {
      if (!this.isCurrent(route)) return;
      this.error = mediaError(audio);
      this.blocked = false;
      this.emitReport();
    };
    audio.onended = () => {
      route.started = false;
      if (route.retired) {
        this.finalizeRoute(route);
        return;
      }
      if (this.pendingSwitch?.outgoing.includes(route)) {
        this.pendingSwitch.outgoing = this.pendingSwitch.outgoing.filter(
          (candidate) => candidate !== route,
        );
        this.finalizeRoute(route);
        return;
      }
      if (!this.isCurrent(route)) return;
      if (this.loop) {
        this.position = 0;
        this.syncPosition(route, 0);
        if (this.transport === 'playing') void this.playCurrent(route, false);
        return;
      }
      this.position = 0;
      this.positionAt = this.now();
      this.transport = 'ended';
      this.emitReport();
    };
  }

  /** Install one shared worklet route for every overlapping track. */
  private installDsp(): void {
    if (this.disposed || this.dspNode !== null || this.dspInstall !== null) return;
    const generation = this.dspGeneration;
    const task = this.installDspAsync(generation);
    let tracked: Promise<void>;
    tracked = task.finally(() => {
      if (this.dspInstall === tracked) this.dspInstall = null;
    });
    this.dspInstall = tracked;
  }

  private async installDspAsync(generation: number): Promise<void> {
    let plan: BgmDspPlan;
    try {
      plan = await this.getPlan();
      await this.ensureWorklet();
      if (generation !== this.dspGeneration || this.disposed) return;
      const node = await this.createDspNode(plan.sceneJson);
      if (generation !== this.dspGeneration || this.disposed) {
        destroyNode(node);
        return;
      }
      if (this.dspNode !== null && this.dspNode !== node) destroyNode(this.dspNode);
      safeDisconnect(this.mixBus);
      this.mixBus.connect(node);
      node.connect(this.output.bgmBus);
      this.dspNode = node;
      this.plan = plan;
      attachProcessorError(node, () => this.failDsp(generation, node));
      plan.apply(node, this.dsp);
      this.emitReport();
    } catch {
      if (generation === this.dspGeneration && !this.disposed) this.failDsp(generation);
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

  private async playCurrent(
    route: TrackRoute | null,
    fadeIn: boolean,
    switchFade?: BgmFade,
  ): Promise<void> {
    if (route === null || !this.isCurrent(route) || this.transport !== 'playing') return;
    if (route.started && !route.audio.paused) return;
    const pending = this.pendingPlay;
    if (
      pending?.epoch === route.epoch &&
      pending.route === route &&
      pending.generation === this.playGeneration
    )
      return pending.promise;
    const generation = this.playGeneration;
    const promise = this.startPlay(route, fadeIn, generation, switchFade);
    this.pendingPlay = { epoch: route.epoch, route, generation, promise };
    void promise.then(
      () => this.clearPendingPlay(promise),
      () => this.clearPendingPlay(promise),
    );
    return promise;
  }

  private async startPlay(
    route: TrackRoute,
    fadeIn: boolean,
    generation: number,
    switchFade?: BgmFade,
  ): Promise<void> {
    const { audio } = route;
    const context = await this.output.ensureRunning();
    if (
      context === null ||
      !this.isCurrent(route) ||
      this.transport !== 'playing' ||
      generation !== this.playGeneration
    ) {
      if (this.isCurrent(route) && generation === this.playGeneration) {
        this.blocked = true;
        this.error = null;
        this.emitReport();
      }
      return;
    }
    try {
      // A renderer can spend seconds behind autoplay policy while the
      // server-owned transport keeps moving. Seek from the canonical command
      // clock again at the moment playback is actually allowed.
      this.syncPosition(route, this.projectPosition());
      await audio.play();
      if (
        !this.isCurrent(route) ||
        this.transport !== 'playing' ||
        generation !== this.playGeneration
      ) {
        audio.pause();
        return;
      }
      route.started = true;
      const pending = this.pendingSwitch?.incomingEpoch === route.epoch ? this.pendingSwitch : null;
      if (pending !== null) {
        this.pendingSwitch = null;
        this.beginCrossfade(route, pending.outgoing, pending.fade);
      } else {
        this.scheduleEnvelope(
          route,
          1,
          fadeIn ? (switchFade?.inSeconds ?? this.fade.inSeconds) : 0,
        );
      }
      this.blocked = false;
      this.error = null;
      this.positionAt = this.now();
      this.emitReport();
    } catch (reason) {
      if (
        !this.isCurrent(route) ||
        this.transport !== 'playing' ||
        generation !== this.playGeneration
      )
        return;
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
    if (this.disposed || this.transport !== 'playing' || this.currentRoute === null) return;
    if (this.currentRoute.started && !this.currentRoute.audio.paused) {
      this.syncPosition(this.currentRoute, this.projectPosition());
      return;
    }
    await this.playCurrent(this.currentRoute, true);
  }

  private reloadCurrentTrack(fadeIn: boolean): TrackRoute | null {
    if (this.track === null || this.disposed) return null;
    this.epoch += 1;
    this.playGeneration += 1;
    const epoch = this.epoch;
    if (this.pendingSwitch !== null) this.pendingSwitch.incomingEpoch = epoch;
    void this.loadTrack(this.track, epoch, this.position, fadeIn);
    return null;
  }

  private stopAtBoundary(): void {
    this.transport = 'stopped';
    this.position = 0;
    this.positionAt = this.now();
    const route = this.currentRoute;
    if (this.pendingSwitch !== null) {
      this.pendingSwitch = null;
      for (const pending of [...this.routes]) this.finalizeRoute(pending);
      this.currentRoute = null;
      this.duration = null;
    } else if (route !== null) {
      route.audio.pause();
      this.scheduleEnvelope(route, 0, 0);
      this.syncPosition(route, 0);
    }
    for (const retired of [...this.routes]) {
      if (retired !== route) this.finalizeRoute(retired);
    }
    this.pendingPlay = null;
    this.epoch += 1;
    this.playGeneration += 1;
    // Stop is a hard transport boundary: remove the old worklet instance so a
    // plate tail cannot leak into the next take. Pause intentionally skips this.
    this.recreateDsp();
    this.emitReport();
  }

  private recreateDsp(): void {
    this.dspGeneration += 1;
    this.dspInstall = null;
    destroyNode(this.dspNode);
    this.dspNode = null;
    this.plan = null;
    this.connectDry();
    if (this.currentRoute !== null && !this.disposed) this.installDsp();
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

  private syncPosition(route: TrackRoute, position: number): void {
    const audio = route.audio;
    const duration = this.duration ?? finiteDuration(audio.duration);
    if (duration !== null && this.isCurrent(route)) this.duration = duration;
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

  private failDsp(generation: number, failedNode?: AudioWorkletNode): void {
    if (
      generation !== this.dspGeneration ||
      (failedNode !== undefined && this.dspNode !== failedNode)
    )
      return;
    this.dspGeneration += 1;
    destroyNode(this.dspNode);
    this.dspNode = null;
    this.plan = null;
    this.connectDry();
    this.dspDegraded = true;
    // A worklet failure is distinct from a media error: dry media keeps
    // playing, and the server can still accept a healthy natural end.
    this.emitReport();
  }

  private emitReport(): void {
    this.onReport?.(this.report());
  }

  private isCurrent(route: TrackRoute): boolean {
    return !this.disposed && this.currentRoute === route && this.track === route.track;
  }

  /** Keep every live route that may still contribute to the audible mix. */
  private chooseOutgoing(): TrackRoute[] {
    return [...this.routes].filter((route) => this.isAudible(route));
  }

  private isAudible(route: TrackRoute): boolean {
    return route.started && !route.audio.paused;
  }

  private audioTime(): number {
    const value = this.output.context.currentTime;
    return Number.isFinite(value) ? value : this.now();
  }

  private connectDry(): void {
    safeDisconnect(this.mixBus);
    this.mixBus.connect(this.output.bgmBus);
  }

  /** Start both sides of a switch from one AudioContext timestamp. */
  private beginCrossfade(incoming: TrackRoute, outgoing: TrackRoute[], fade: BgmFade): void {
    const at = this.audioTime();
    for (const route of outgoing) {
      if (route === incoming || !this.routes.has(route) || !this.isAudible(route)) continue;
      this.retireRouteAt(route, fade.outSeconds, at);
    }
    this.scheduleEnvelopeAt(incoming, 1, fade.inSeconds, at);
  }

  private retireRouteAt(route: TrackRoute, duration: number, at: number): void {
    if (route.timer !== null) {
      clearTimeout(route.timer);
      route.timer = null;
    }
    route.retired = true;
    this.scheduleEnvelopeAt(route, 0, duration, at);
    if (duration <= 0) {
      this.finalizeRoute(route);
      return;
    }
    route.timer = setTimeout(() => this.finalizeRoute(route), duration * 1000);
  }

  private finalizeRoute(route: TrackRoute): void {
    if (route.timer !== null) {
      clearTimeout(route.timer);
      route.timer = null;
    }
    route.audio.onloadedmetadata = null;
    route.audio.onerror = null;
    route.audio.onended = null;
    route.audio.pause();
    safeDisconnect(route.source);
    safeDisconnect(route.envelope);
    this.routes.delete(route);
    if (this.pendingSwitch?.outgoing.includes(route)) {
      this.pendingSwitch.outgoing = this.pendingSwitch.outgoing.filter(
        (candidate) => candidate !== route,
      );
    }
    if (this.currentRoute === route) this.currentRoute = null;
    cleanupAudio(route.audio);
  }

  private hardUnload(): void {
    this.pendingSwitch = null;
    for (const route of [...this.routes]) this.finalizeRoute(route);
    this.currentRoute = null;
    this.dspGeneration += 1;
    this.dspInstall = null;
    destroyNode(this.dspNode);
    this.dspNode = null;
    this.plan = null;
    this.connectDry();
  }

  private holdEnvelope(route: TrackRoute): void {
    const at = this.audioTime();
    const current = envelopeValue(route.envelopeState, at);
    cancelParam(route.envelope.gain, at);
    route.envelope.gain.setValueAtTime(current, at);
    route.envelopeState = { from: current, to: current, start: at, duration: 0 };
  }

  private scheduleEnvelope(route: TrackRoute, target: number, duration: number): void {
    const at = this.audioTime();
    this.scheduleEnvelopeAt(route, target, duration, at);
  }

  private scheduleEnvelopeAt(
    route: TrackRoute,
    target: number,
    duration: number,
    at: number,
  ): void {
    const from = envelopeValue(route.envelopeState, at);
    const boundedDuration = Math.max(0, duration);
    cancelParam(route.envelope.gain, at);
    route.envelope.gain.setValueAtTime(from, at);
    if (boundedDuration === 0) route.envelope.gain.setValueAtTime(target, at);
    else route.envelope.gain.linearRampToValueAtTime(target, at + boundedDuration);
    route.envelopeState = {
      from,
      to: target,
      start: at,
      duration: boundedDuration,
    };
  }
}

function isOutput(value: BrowserAudioOutput | BrowserBgmOptions): value is BrowserAudioOutput {
  return 'context' in value && 'bgmBus' in value;
}

function cloneDsp(dsp: BgmDsp): BgmDsp {
  return { ...dsp, reverb: { ...dsp.reverb } };
}

function cloneFade(fade: BgmFade): BgmFade {
  return { inSeconds: fade.inSeconds, outSeconds: fade.outSeconds };
}

function mergeFade(base: BgmFade, patch: Partial<BgmFade>): BgmFade {
  return {
    inSeconds: patch.inSeconds ?? base.inSeconds,
    outSeconds: patch.outSeconds ?? base.outSeconds,
  };
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

function envelopeValue(state: EnvelopeState, at: number): number {
  if (state.duration <= 0) return state.to;
  const fraction = Math.min(1, Math.max(0, (at - state.start) / state.duration));
  return state.from + (state.to - state.from) * fraction;
}

function cancelParam(param: AudioParam, at: number): void {
  try {
    param.cancelScheduledValues(at);
  } catch {
    /* a test host may expose only a partial AudioParam */
  }
}

function safeDisconnect(node: AudioNode | null): void {
  if (node === null) return;
  try {
    node.disconnect();
  } catch {
    /* already disconnected */
  }
}

function cleanupAudio(audio: HTMLAudioElement | null): void {
  if (audio === null) return;
  try {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } catch {
    /* a test host may expose only a partial media element */
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
