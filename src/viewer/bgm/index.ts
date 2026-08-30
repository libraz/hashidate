import type { BgmCommand, BgmDsp, BgmFade, BgmReport, BgmTransport } from '@/protocol';
import {
  BGM_DEFAULT_LOOP,
  BGM_DEFAULT_VOLUME,
  BGM_DSP_DEFAULTS,
  BGM_FADE_DEFAULTS,
} from '@/protocol';
import type { BrowserAudioOutput } from '../audio-output';
import { mergeBgmDsp } from '../bgm-dsp';
import bgmWorkletUrl from '../bgm-worklet.ts?worker&url';
import { BgmDspChain } from './dsp-chain';
import type { BrowserBgmOptions, LegacyBrowserBgmOptions } from './options';
import {
  cleanupAudio,
  finiteDuration,
  holdEnvelope,
  isBlockedPlayError,
  mediaError,
  releaseRoute,
  safeDisconnect,
  scheduleEnvelopeAt,
  type TrackRoute,
} from './route';
import {
  actionTransport,
  cloneDsp,
  cloneFade,
  isOutput,
  mergeFade,
  normalizeTrack,
  trimBase,
} from './settings';
import { type BgmNodeFactory, fetchBgmWasm } from './worklet';

export type { BrowserBgmOptions } from './options';

/**
 * The browser-side BGM transport.
 *
 * The server's revision/position/at fields are authoritative. Every media
 * source enters its own envelope, then a persistent mix bus feeds one shared
 * libsonare Mixer worklet (or its dry fallback) and finally the BGM bus. The
 * mix is deliberately separate from voice and the final master remains the
 * only renderer mute point.
 *
 * What is left here is the transport and the routes: which track is selected,
 * where the timeline says it is, which routes are still sounding, and how one
 * hands over to the next. The processing between the mix bus and the BGM bus
 * is `dsp-chain.ts`, the envelope arithmetic is `route.ts`, and the value work
 * — merging a patch, reading a verb as a transport — is `settings.ts`.
 */
interface PendingSwitch {
  incomingEpoch: number;
  outgoing: TrackRoute[];
  fade: BgmFade;
}

export class BrowserBgm {
  private readonly output: BrowserAudioOutput;
  private readonly base: string;
  private readonly makeAudio: () => HTMLAudioElement;
  private readonly now: () => number;
  private readonly onReport?: (report: BgmReport) => void;
  private readonly offUnlock: (() => void) | null;
  private readonly chain: BgmDspChain;
  private readonly routes = new Set<TrackRoute>();

  private currentRoute: TrackRoute | null = null;
  private pendingSwitch: PendingSwitch | null = null;
  private pendingPlay: {
    epoch: number;
    route: TrackRoute;
    generation: number;
    promise: Promise<void>;
  } | null = null;
  /** Defers the post-stop worklet rebuild until the faded tail has left. */
  private tailTimer: ReturnType<typeof setTimeout> | null = null;

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
    const nodeFactory: BgmNodeFactory =
      options.nodeFactory ??
      ((context, name, nodeOptions) => {
        if (typeof AudioWorkletNode === 'undefined')
          throw new Error('AudioWorkletNode unavailable');
        return new AudioWorkletNode(context, name, nodeOptions);
      });
    this.onReport = options.onReport;
    this.chain = new BgmDspChain(
      this.output,
      nodeFactory,
      options.workletUrl ?? bgmWorkletUrl,
      options.wasmLoader ?? fetchBgmWasm,
      options.dspPlan,
      () => this.dsp,
      () => this.emitReport(),
    );
    this.offUnlock = this.output.onUnlock(() => {
      void this.retryPlay();
    });
    this.setBusVolume();
  }

  apply(command: BgmCommand): boolean {
    if (this.disposed) return false;
    const nextRevision = command.revision ?? this.revision;
    if (nextRevision < this.revision) return false;
    const revisionChanged = nextRevision !== this.revision;
    this.revision = nextRevision;
    if (revisionChanged) this.chain.clearDegraded();

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
      // A stop carries position zero because that is where the canonical
      // timeline goes, but the route it stops is still sounding through its
      // fade. Seeking it would restart the track underneath its own fade-out.
      // The route is leaving, so where it is no longer matters.
      if (this.currentRoute !== null && command.action !== 'stop')
        this.syncPosition(this.currentRoute, projected);
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
        holdEnvelope(route, this.audioTime());
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
    if (command.dsp !== undefined) this.chain.applyDsp(this.dsp);
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
      dspDegraded: this.chain.degraded,
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
    this.clearTailTimer();
    this.offUnlock?.();
    for (const route of [...this.routes]) this.finalizeRoute(route);
    this.currentRoute = null;
    this.chain.dispose();
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
    return this.chain.degraded;
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
      envelope.connect(this.chain.input);
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
    this.chain.ensure();
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

  /**
   * Stop: the selection is kept, the timeline resets to zero, and the sound
   * leaves over `fade.outSeconds`.
   *
   * The tail is the whole difficulty, and three things follow from it. A media
   * element has to keep sounding while its envelope falls, so the route is
   * *retired* rather than torn down — the same retirement the outgoing half of
   * a crossfade uses.
   *
   * `currentRoute` is released now rather than when the tail ends. A play
   * arriving mid-fade has to build a new route beside the leaving one: handed
   * the retiring route instead, `playCurrent` would find it already started and
   * unpaused, return early, and let the envelope finish falling on the very
   * track it was asked to bring back.
   *
   * Nothing is seeked back to zero. `position` is the canonical timeline and is
   * zero from this instant, but moving an element that is still sounding would
   * restart the track underneath its own fade.
   *
   * The worklet outlives the tail. Rebuilding it is what keeps a plate reverb
   * from leaking into the next take, but the tail is still being processed by
   * that very chain, so the rebuild waits — and is skipped if a play has since
   * claimed a new route, which is a continuation rather than the next take.
   *
   * `outSeconds: 0` is the hard edge this used to be unconditionally. Unloading
   * the track (`track: null`) remains the boundary that leaves no tail at all.
   */
  private stopAtBoundary(): void {
    this.transport = 'stopped';
    this.position = 0;
    this.positionAt = this.now();
    const hadPendingSwitch = this.pendingSwitch !== null;
    this.pendingSwitch = null;
    const outSeconds = Math.max(0, this.fade.outSeconds);
    const at = this.audioTime();
    for (const route of [...this.routes]) {
      // A route already leaving keeps the envelope and the timer it was given.
      // Stopping twice must neither restart its fade from the level it has
      // decayed to — which would make the second stop take longer than the
      // first — nor cut short a tail the operator has already asked for.
      if (route.retired) continue;
      if (outSeconds > 0 && this.isAudible(route)) this.retireRouteAt(route, outSeconds, at);
      else this.finalizeRoute(route);
    }
    // Whatever is still held is still leaving: retiring keeps a route until its
    // own timer finalizes it, and finalizing removes it here and now.
    const tail = this.routes.size;
    this.currentRoute = null;
    // The incoming half of an interrupted switch never sounded, so its duration
    // was never measured and must not be reported against the kept selection.
    if (hadPendingSwitch) this.duration = null;
    this.pendingPlay = null;
    this.epoch += 1;
    this.playGeneration += 1;
    this.clearTailTimer();
    if (tail === 0) {
      this.chain.reset(this.currentRoute !== null);
    } else {
      this.tailTimer = setTimeout(() => {
        this.tailTimer = null;
        if (!this.disposed && this.currentRoute === null) {
          this.chain.reset(this.currentRoute !== null);
        }
      }, outSeconds * 1000);
    }
    this.emitReport();
  }

  private clearTailTimer(): void {
    if (this.tailTimer === null) return;
    clearTimeout(this.tailTimer);
    this.tailTimer = null;
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

  /** Start both sides of a switch from one AudioContext timestamp. */
  private beginCrossfade(incoming: TrackRoute, outgoing: TrackRoute[], fade: BgmFade): void {
    const at = this.audioTime();
    for (const route of outgoing) {
      if (route === incoming || !this.routes.has(route) || !this.isAudible(route)) continue;
      this.retireRouteAt(route, fade.outSeconds, at);
    }
    scheduleEnvelopeAt(incoming, 1, fade.inSeconds, at);
  }

  private retireRouteAt(route: TrackRoute, duration: number, at: number): void {
    if (route.timer !== null) {
      clearTimeout(route.timer);
      route.timer = null;
    }
    route.retired = true;
    scheduleEnvelopeAt(route, 0, duration, at);
    if (duration <= 0) {
      this.finalizeRoute(route);
      return;
    }
    route.timer = setTimeout(() => this.finalizeRoute(route), duration * 1000);
  }

  private finalizeRoute(route: TrackRoute): void {
    releaseRoute(route);
    this.routes.delete(route);
    if (this.pendingSwitch?.outgoing.includes(route)) {
      this.pendingSwitch.outgoing = this.pendingSwitch.outgoing.filter(
        (candidate) => candidate !== route,
      );
    }
    if (this.currentRoute === route) this.currentRoute = null;
  }

  private hardUnload(): void {
    this.pendingSwitch = null;
    // An unload outranks a stop still waiting to rebuild: the tail it was
    // waiting for is being finalized here, and letting the timer survive would
    // tear down whatever chain the next selection has since installed.
    this.clearTailTimer();
    for (const route of [...this.routes]) this.finalizeRoute(route);
    this.currentRoute = null;
    this.chain.reset(false);
  }

  private scheduleEnvelope(route: TrackRoute, target: number, duration: number): void {
    scheduleEnvelopeAt(route, target, duration, this.audioTime());
  }
}
