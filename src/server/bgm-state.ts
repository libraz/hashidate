import {
  BGM_DEFAULT_LOOP,
  BGM_DEFAULT_VOLUME,
  BGM_DSP_DEFAULTS,
  type BgmCommand,
  type BgmDsp,
  type BgmDspPatch,
  type BgmReport,
  type BgmState,
  type BgmTransport,
} from '../protocol';

/** Epoch seconds. Kept injectable so transport tests do not sleep. */
export type BgmClock = () => number;

function wallClock(): number {
  return Date.now() / 1000;
}

type LiveTransport = Exclude<BgmTransport, 'ended'>;

interface InternalState {
  track: string | null;
  volume: number;
  loop: boolean;
  dsp: BgmDsp;
  transport: LiveTransport;
  position: number;
  revision: number;
  at: number;
  duration: number | null;
  blocked: boolean;
  error: string | null;
  dspDegraded: boolean;
}

/**
 * Server authority for the BGM clock.
 *
 * A renderer receives a command, but it does not decide what the next command
 * means. This class keeps one timeline and one revision for every renderer,
 * rejects delayed reports, and returns an extra command only when an audible
 * renderer explicitly reports a healthy end that needs to be propagated to its
 * peers. Renderer position and transport are diagnostic, not clock authority.
 */
export class BgmCoordinator {
  private readonly clock: BgmClock;
  private stateValue: InternalState;
  private commanded = false;

  constructor(clock: BgmClock = wallClock) {
    this.clock = clock;
    const at = this.now();
    this.stateValue = {
      track: null,
      volume: BGM_DEFAULT_VOLUME,
      loop: BGM_DEFAULT_LOOP,
      dsp: {
        ...BGM_DSP_DEFAULTS,
        reverb: { ...BGM_DSP_DEFAULTS.reverb },
      },
      transport: 'stopped',
      position: 0,
      revision: 0,
      at,
      duration: null,
      blocked: false,
      error: null,
      dspDegraded: false,
    };
  }

  private now(): number {
    const value = this.clock();
    return Number.isFinite(value) && value >= 0 ? value : wallClock();
  }

  /** Whether a caller has sent any BGM setting or transport command yet. */
  get hasCommand(): boolean {
    return this.commanded;
  }

  /**
   * Apply caller intent and return a complete, server-stamped command.
   *
   * Synchronisation fields supplied by the caller are deliberately ignored;
   * only this coordinator can advance `revision`, `position`, `transport` and
   * `at`.
   */
  apply(command: BgmCommand): BgmCommand {
    const at = this.now();
    this.materialize(at);
    const selected = command.track === null ? null : command.track?.normalize('NFC');

    // A caller command creates a new renderer revision. A degraded worklet
    // report from the previous revision must not make the rebuilt chain look
    // degraded before it has had a chance to report its own status.
    this.stateValue.dspDegraded = false;

    if (command.volume !== undefined) this.stateValue.volume = command.volume;
    if (command.loop !== undefined) this.stateValue.loop = command.loop;
    if (command.dsp !== undefined) this.stateValue.dsp = mergeDsp(this.stateValue.dsp, command.dsp);

    if (selected === null) {
      // Unloading is stronger than an action that happened to accompany it.
      this.stateValue.track = null;
      this.stateValue.transport = 'stopped';
      this.stateValue.position = 0;
      this.clearFeedback();
    } else if (selected !== undefined) {
      // Selecting a track always starts it stopped at the beginning. An
      // explicit play is the only way a track selection starts immediately.
      this.stateValue.track = selected;
      this.stateValue.transport = 'stopped';
      this.stateValue.position = 0;
      this.clearFeedback();
      if (command.action === 'play') this.stateValue.transport = 'playing';
    } else {
      switch (command.action) {
        case 'play':
          if (this.stateValue.track !== null) this.stateValue.transport = 'playing';
          break;
        case 'pause':
          // Pausing an already stopped track is a no-op. This also keeps a
          // selected+pause command at stopped/zero rather than inventing a
          // paused-at-zero transport.
          if (this.stateValue.track !== null && this.stateValue.transport === 'playing') {
            this.stateValue.transport = 'paused';
          }
          break;
        case 'stop':
          this.stateValue.transport = 'stopped';
          this.stateValue.position = 0;
          break;
        case undefined:
          // Settings-only patches deliberately leave the timeline untouched.
          break;
      }
      if (this.stateValue.track === null) {
        this.stateValue.transport = 'stopped';
        this.stateValue.position = 0;
      }
    }

    this.advanceRevision();
    this.stateValue.at = at;
    this.commanded = true;
    return this.commandAt(at, command.action, command.id);
  }

  /** The current state, with playing position advanced to the injected clock. */
  state(): BgmState {
    const at = this.now();
    const materialized = this.snapshotAt(at);
    return materialized;
  }

  /**
   * The full command needed by a renderer joining late, or null before a BGM
   * command has ever been chosen.
   */
  command(): BgmCommand | null {
    if (!this.commanded) return null;
    const at = this.now();
    return this.commandAt(at, null);
  }

  /** Alias useful at call sites that describe this as a synchronisation step. */
  currentCommand(): BgmCommand | null {
    return this.command();
  }

  /**
   * Consume one renderer report. Returns an end-transition command only for an
   * explicit healthy `ended` report, otherwise null. Reports from muted
   * renderers contribute duration only; in particular they cannot clear an
   * audible renderer's blocked/error or DSP-degraded status.
   */
  report(report: BgmReport): BgmCommand | null {
    if (report.revision !== this.stateValue.revision) return null;
    const reportedTrack = report.track === null ? null : report.track.normalize('NFC');
    if (reportedTrack !== this.stateValue.track) return null;

    if (report.duration !== null) this.stateValue.duration = report.duration;
    if (report.muted) return null;

    const at = this.now();
    this.materialize(at);
    this.stateValue.blocked = report.blocked;
    this.stateValue.error = report.error;
    if (report.dspDegraded) this.stateValue.dspDegraded = true;

    const ended =
      this.stateValue.transport === 'playing' &&
      !report.blocked &&
      report.error === null &&
      report.transport === 'ended';
    if (ended && this.stateValue.track !== null) {
      if (this.stateValue.loop) {
        this.stateValue.position = 0;
        this.stateValue.transport = 'playing';
      } else {
        // Natural completion has the same stopped-at-zero meaning as an
        // explicit `stop`: selection is retained, but a later play starts at
        // the beginning and every renderer sees the same reset timeline.
        this.stateValue.position = 0;
        this.stateValue.transport = 'stopped';
      }
      this.advanceRevision();
      this.stateValue.at = at;
      return this.commandAt(at, this.stateValue.transport === 'playing' ? 'play' : 'stop');
    }
    return null;
  }

  /** Advance to a new canonical revision and clear per-revision diagnostics. */
  private advanceRevision(): void {
    this.stateValue.revision += 1;
    this.stateValue.dspDegraded = false;
  }

  private clearFeedback(): void {
    this.stateValue.duration = null;
    this.stateValue.blocked = false;
    this.stateValue.error = null;
  }

  /** Advance the canonical position without changing its revision. */
  private materialize(at: number): void {
    const elapsed = Math.max(0, at - this.stateValue.at);
    if (this.stateValue.transport === 'playing' && elapsed > 0) {
      this.stateValue.position += elapsed;
      this.stateValue.at = at;
      if (this.stateValue.duration !== null && this.stateValue.duration > 0) {
        if (this.stateValue.loop) {
          this.stateValue.position %= this.stateValue.duration;
        } else if (this.stateValue.position >= this.stateValue.duration) {
          // The server clock may reach the nominal duration before a browser's
          // decoder does, and a blocked audible renderer may not have started
          // at all. Hold at the boundary while transport remains playing. Only
          // an explicit healthy `ended` report above advances the revision and
          // broadcasts the canonical stop to every renderer.
          this.stateValue.position = this.stateValue.duration;
        }
      }
    } else if (this.stateValue.at !== at) {
      this.stateValue.at = at;
    }
  }

  private snapshotAt(at: number): BgmState {
    this.materialize(at);
    return { ...this.stateValue };
  }

  private commandAt(at: number, action: BgmCommand['action'] | null, id?: string): BgmCommand {
    const state = this.snapshotAt(at);
    const command: BgmCommand = {
      cmd: 'bgm',
      ...(id === undefined ? {} : { id }),
      track: state.track,
      volume: state.volume,
      loop: state.loop,
      dsp: state.dsp,
      revision: state.revision,
      transport: state.transport,
      position: state.position,
      at: state.at,
    };
    if (action !== undefined) {
      command.action =
        action === null
          ? actionFor(state.transport === 'ended' ? 'stopped' : state.transport)
          : action;
    }
    return command;
  }
}

/** Merge one partial effect patch without resetting sibling controls. */
function mergeDsp(base: BgmDsp, patch: BgmDspPatch): BgmDsp {
  return {
    ...base,
    ...(patch.toneDb === undefined ? {} : { toneDb: patch.toneDb }),
    ...(patch.compression === undefined ? {} : { compression: patch.compression }),
    ...(patch.width === undefined ? {} : { width: patch.width }),
    reverb: {
      ...base.reverb,
      ...(patch.reverb?.mix === undefined ? {} : { mix: patch.reverb.mix }),
      ...(patch.reverb?.decay === undefined ? {} : { decay: patch.reverb.decay }),
      ...(patch.reverb?.damping === undefined ? {} : { damping: patch.reverb.damping }),
    },
  };
}

function actionFor(transport: LiveTransport): BgmCommand['action'] {
  switch (transport) {
    case 'playing':
      return 'play';
    case 'paused':
      return 'pause';
    case 'stopped':
      return 'stop';
  }
}
