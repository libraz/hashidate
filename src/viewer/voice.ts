import type { LabelledId, Take, Voice, VoiceChainRequest, VoiceReport } from '@/engine/types';
import type { VoiceDsp } from '@/protocol';
import { BrowserAudioOutput } from './audio-output';
import { buildImpulse, ROOMS, type RoomId, roomList } from './rooms';
import {
  DEFAULT_PRESET,
  loadBase,
  measure,
  mergeDsp,
  processTake,
  type ResolvedDsp,
  VOICE_PRESETS,
  voicePresetList,
} from './voice-chain';

// Kept exported from this module for the small browser-behaviour tests and for
// callers that used the pre-shared-output voice helper.
export { startContext } from './audio-output';

/**
 * The voice, as the browser can provide one.
 *
 * `Session` states what it needs — a line goes in, a take with a length, a
 * clock and an envelope comes out — and this is the only place that knows any
 * of it involves audio. The engine stays free of `AudioContext`, and a machine
 * without the speech sidecar gets nulls and a mouth driven from the text, which
 * is what every test and every machine that did not buy the voice runs on.
 *
 * ## The whole line, decoded, before any of it plays
 *
 * The speech model does not stream: a line goes in and a finished waveform
 * comes back, about a second later. Rather than work around that, this leans on
 * it. Because the buffer is complete before playback starts, its exact length
 * is known before the turn opens — so the viseme track is stretched onto the
 * real duration once, up front, instead of being started on a guess and jerked
 * into place when the audio arrives. The envelope is measured up front for the
 * same reason: no analyser node, no live gain to tune, and the loudness at any
 * moment is a lookup rather than a measurement that can lag the sound it
 * describes.
 *
 * ## The chain is upstream of the mouth; the room is downstream of both
 *
 * Two pieces of processing sit either side of the envelope, and which side they
 * are on is the point. The voice chain — pitch, formants, EQ, gate, compressor,
 * limiter; see `voice-chain.ts` — runs on the decoded buffer *before* the
 * envelope is measured, because it changes where the loud parts of a line are
 * and the jaw has to follow what will be heard. The room runs *after*, in the
 * graph below, because a convolution tail is the space ringing rather than the
 * character still speaking.
 *
 * ## The room is downstream of everything the mouth reads
 *
 * A take is played into a small fixed graph — dry and a convolver in parallel —
 * rather than at the destination directly, and the room that convolver holds is
 * chosen by `setRoom`. The order matters: the envelope is measured off the dry
 * buffer, before any of this, so the mouth follows the voice and not the room's
 * tail. It also means the tail is nobody's take. It hangs off a node that
 * outlives every line, so it rings on past the end of the turn the way a room
 * does, and an interrupt cuts the voice without cutting the space it was in.
 */

/**
 * Envelope resolution, in samples per second.
 *
 * A hundred is 10 ms per window, which is finer than the mouth can move — it
 * smooths toward its target at about 26/s — and coarse enough that a whole line
 * is a few hundred numbers. Finer would be measuring something nothing
 * downstream can act on.
 */
const ENVELOPE_HZ = 100;

/**
 * Which loudness counts as "fully open".
 *
 * The peak is the wrong reference: one plosive or one clipped sample decides
 * the scale for the whole line and the mouth spends the rest of it barely
 * moving. A high percentile is the level the loud parts of *this* take sit at,
 * which is what the mouth should be wide open for — and it is per take, so a
 * quiet line and a shouted one both use their own range instead of needing a
 * gain constant that would have to be retuned with the voice.
 */
const ENVELOPE_REFERENCE = 0.95;

/**
 * How long to stop asking after the sidecar turns out not to be there.
 *
 * Not running is the normal case rather than the exceptional one, and without
 * this every line of a stream costs a connection refused. Long enough to be out
 * of the way, short enough that starting the sidecar mid-session is noticed
 * within a line or two.
 */
const RETRY_AFTER_MS = 20_000;

/**
 * Turn one channel of audio into a loudness curve, 0..1.
 *
 * RMS rather than peak per window, because the mouth is following how much
 * sound there is rather than how far the waveform swung — and unsmoothed,
 * because the smoothing already exists once in `Mouth.update` and a second
 * filter in front of it would only add lateness.
 */
export function buildEnvelope(samples: Float32Array, sampleRate: number): Float32Array {
  const width = Math.max(1, Math.round(sampleRate / ENVELOPE_HZ));
  const count = Math.max(1, Math.ceil(samples.length / width));
  const out = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const from = i * width;
    const to = Math.min(samples.length, from + width);
    let sum = 0;
    for (let j = from; j < to; j++) sum += samples[j] * samples[j];
    out[i] = to > from ? Math.sqrt(sum / (to - from)) : 0;
  }

  // Scale so the loud parts of this take reach 1. A take of pure silence has no
  // level to normalise against and stays flat at zero, which is a mouth that
  // does not move for audio that makes no sound.
  const sorted = Float32Array.from(out).sort();
  const reference = sorted[Math.min(count - 1, Math.floor(count * ENVELOPE_REFERENCE))];
  if (!(reference > 0)) return out.fill(0);
  for (let i = 0; i < count; i++) out[i] = Math.min(1, out[i] / reference);
  return out;
}

/** Read the envelope at a time, in seconds. Out of range is silence. */
export function envelopeAt(envelope: Float32Array, seconds: number): number {
  const i = Math.floor(seconds * ENVELOPE_HZ);
  return i >= 0 && i < envelope.length ? envelope[i] : 0;
}

class BufferTake implements Take {
  readonly seconds: number;

  private readonly ctx: AudioContext;
  private readonly output: AudioNode;
  private readonly buffer: AudioBuffer;
  private readonly envelope: Float32Array;
  private source: AudioBufferSourceNode | null = null;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;

  constructor(ctx: AudioContext, output: AudioNode, buffer: AudioBuffer, envelope: Float32Array) {
    this.ctx = ctx;
    this.output = output;
    this.buffer = buffer;
    this.envelope = envelope;
    this.seconds = buffer.duration;
  }

  play(): void {
    if (this.startedAt !== null) return;
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.output);
    source.start();
    this.source = source;
    this.startedAt = this.ctx.currentTime;
  }

  stop(): void {
    // Freeze the clock first: a listener reading `elapsed` on the same frame
    // should see where the line stopped, not the device clock running on.
    if (this.stoppedAt === null) this.stoppedAt = this.elapsed;
    if (!this.source) return;
    const source = this.source;
    this.source = null;
    source.disconnect();
    // Already finished, already stopped, or never started — all three are
    // normal here, since a take is stopped on every path out of a turn.
    try {
      source.stop();
    } catch {
      /* nothing to stop */
    }
  }

  get elapsed(): number {
    if (this.stoppedAt !== null) return this.stoppedAt;
    if (this.startedAt === null) return 0;
    // Not clamped to `seconds`. The mouth ends its track by this clock passing
    // the end of it, so a clock that stopped at the last mora would hold the
    // line open until something interrupted it.
    return this.ctx.currentTime - this.startedAt;
  }

  get amplitude(): number {
    return this.source === null ? 0 : envelopeAt(this.envelope, this.elapsed);
  }
}

export interface BrowserVoiceOptions {
  base?: string;
  /** The page-owned graph. Supplying this prevents a second AudioContext. */
  output?: BrowserAudioOutput;
  /**
   * Render silently. See `StageMode.muted` — this is the panel's preview, which
   * is a second renderer of the same commands and must not speak over the one on
   * air.
   *
   * It is applied at the very end of the graph, after the room, so *everything*
   * this voice would have made is silenced by one number. Muting by not
   * synthesising would be cheaper and would put the preview on a different clock
   * from the renderer it is monitoring.
   */
  muted?: boolean;
}

/** The dry and wet halves of the room, and the node a take is played into. */
interface Chain {
  input: GainNode;
  dry: GainNode;
  wet: GainNode;
  convolver: ConvolverNode;
  /**
   * The last node before the device. Both halves of the room meet here, so a
   * mute is one gain rather than two that could come to disagree.
   */
  output: GainNode;
}

export class BrowserVoice implements Voice {
  private readonly base: string;
  /**
   * Read from the URL at construction and never moved afterwards.
   *
   * It was changeable once, over a message from the page that embedded this
   * one. Now the address is the only thing that decides it, so a renderer that
   * is silent is silent for a reason that is written down where an operator can
   * read it. See `monitor-link.ts`.
   */
  private readonly muted: boolean;
  private readonly providedOutput: BrowserAudioOutput | null;
  private ownOutput: BrowserAudioOutput | null = null;
  private ctx: AudioContext | null = null;
  private chainNodes: Chain | null = null;
  private silentUntil = 0;
  /** See `isBlocked`. Set by `device`, which is the only thing that can know. */
  private blocked = false;
  /** Requests are run through this one at a time. See `prepare`. */
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * The chain, in three parts: which base was asked for, what was layered on
   * top of it, and the resolved result the next take will actually be run
   * through.
   *
   * The overrides are kept separately from the resolution because the base can
   * change under them — switching preset while a pitch shift is dialled in has
   * to keep the pitch shift, which means replaying the overrides onto the new
   * base rather than diffing two resolved configurations.
   *
   * Null base means bypass: the take is played exactly as the synthesiser made
   * it, which is also the state a renderer stays in if the WASM will not load.
   */
  private preset: string | null = DEFAULT_PRESET;
  private overrides: VoiceDsp = {};
  private dsp: ResolvedDsp | null = null;
  /** See `roomEpoch` — the same race, for the same reason. */
  private chainEpoch = 0;
  private lastMeasured: { lufs: number | null; truePeakDb: number | null } = {
    lufs: null,
    truePeakDb: null,
  };

  private room: RoomId | null = null;
  /**
   * Which `setRoom` call is the current one.
   *
   * Building an impulse response is asynchronous — the WASM has to load the
   * first time — so two calls in quick succession can finish out of order and
   * leave the graph holding the room that was asked for first. The counter is
   * how a stale result recognises itself.
   */
  private roomEpoch = 0;

  readonly rooms: LabelledId[] = roomList();
  readonly presets: LabelledId[] = voicePresetList();

  constructor({ base = '/api', muted = false, output }: BrowserVoiceOptions = {}) {
    this.base = base;
    this.muted = muted;
    this.providedOutput = output ?? null;
    // Resolve the default chain in the background, so the first line of a
    // session is processed rather than being the one that pays for the load.
    void this.applyChain(this.chainEpoch);
  }

  /**
   * Give up the device and stop listening for the gesture that would start it.
   *
   * For the page going away rather than for an avatar swap — the voice outlives
   * those deliberately. A context left open across a hot reload is one of the
   * handful a document is allowed, spent on a renderer that no longer exists.
   */
  dispose(): void {
    this.ctx = null;
    const nodes = this.chainNodes;
    this.chainNodes = null;
    this.roomEpoch += 1;
    if (nodes) {
      for (const node of [nodes.input, nodes.dry, nodes.wet, nodes.convolver, nodes.output]) {
        try {
          node.disconnect();
        } catch {
          /* graph may already be disconnected */
        }
      }
    }
    // A supplied output belongs to the page/runtime. An output created for
    // backwards-compatible standalone use is owned by this voice instead.
    if (this.ownOutput !== null) this.ownOutput.dispose();
    this.ownOutput = null;
  }

  /** Whether the output is silenced. Fixed for the life of the page. */
  get isMuted(): boolean {
    return this.outputOrNull?.isMuted ?? this.muted;
  }

  /** The shared page output, when one has been created or supplied. */
  get audioOutput(): BrowserAudioOutput | null {
    return this.outputOrNull;
  }

  private get outputOrNull(): BrowserAudioOutput | null {
    return this.providedOutput ?? this.ownOutput;
  }

  private outputForAudio(): BrowserAudioOutput {
    if (this.providedOutput !== null) return this.providedOutput;
    if (this.ownOutput === null) this.ownOutput = new BrowserAudioOutput({ muted: this.muted });
    return this.ownOutput;
  }

  /**
   * Set the chain: a base preset, overrides on top of it, or both.
   *
   * Absent `preset` keeps the current base, so a panel dragging one slider does
   * not have to restate which voice it is dragging it on. `preset: null`
   * bypasses the chain entirely and clears the overrides with it — a bypass that
   * remembered a pitch shift would come back wrong the next time a base was
   * chosen, and "off" is the one setting that has to mean exactly nothing.
   *
   * Returns immediately. Resolving a base loads the WASM on the first call, and
   * a line synthesised in between is heard unprocessed.
   */
  setChain({ preset, dsp }: VoiceChainRequest): void {
    if (preset === null) {
      this.preset = null;
      this.overrides = {};
      this.dsp = null;
      this.chainEpoch += 1;
      return;
    }
    if (preset !== undefined) {
      // An unknown id falls back to the default rather than being refused, on
      // the same rule `setRoom` follows.
      this.preset = Object.hasOwn(VOICE_PRESETS, preset) ? preset : DEFAULT_PRESET;
    } else if (this.preset === null) {
      // Overrides arriving on a bypassed chain turn it back on. The alternative
      // is silently discarding them, which from the panel looks like a slider
      // that does nothing.
      this.preset = DEFAULT_PRESET;
    }
    if (dsp) this.overrides = { ...this.overrides, ...(dsp as VoiceDsp) };
    this.chainEpoch += 1;
    void this.applyChain(this.chainEpoch);
  }

  private async applyChain(epoch: number): Promise<void> {
    const preset = this.preset;
    if (preset === null) return;
    let base: ResolvedDsp;
    try {
      base = await loadBase(preset);
    } catch {
      // No WASM, or a build without the voice changer. Unprocessed is a working
      // stream; a thrown error on this path would not be.
      return;
    }
    if (epoch !== this.chainEpoch) return;
    this.dsp = mergeDsp(base, this.overrides);
  }

  report(): VoiceReport {
    return {
      preset: this.preset,
      dsp: this.dsp,
      room: this.room,
      lufs: this.lastMeasured.lufs,
      truePeakDb: this.lastMeasured.truePeakDb,
      blocked: this.isBlocked,
    };
  }

  /**
   * Whether the browser is refusing to start the audio device.
   *
   * False until a line has actually been asked for: nothing can know before
   * then, and answering true on a page that has simply not spoken yet would put
   * a warning in front of every operator who opened the viewer early.
   *
   * Reported rather than only logged because nothing in this program can clear
   * it. It is the one failure here whose fix is a person touching the page.
   */
  get isBlocked(): boolean {
    return this.blocked || (this.outputOrNull?.isBlocked ?? false);
  }

  /**
   * Everything this voice makes, as a stream something else can record.
   *
   * Tapped off the *output* — the node the mute is on — rather than upstream of
   * it, and that is the whole of the decision: a take is what the frame sounded
   * like, so a muted renderer taps silence. That is also what makes the rule in
   * `recordCommandSchema` consistent rather than merely convenient. A monitor
   * asked to record would record what it is: nothing.
   *
   * The graph is built here if it does not exist yet, which is the one place
   * that legitimately wants a context before there is a line to play — a
   * recorder that started before the first word would otherwise get no audio
   * track at all, and a track cannot be added to a `MediaStream` that a
   * `MediaRecorder` has already been built on.
   *
   * Null when the browser will not give this page an audio device. The take is
   * then silent rather than absent, which is the same trade the mouth makes.
   */
  async captureStream(): Promise<MediaStream | null> {
    const output = this.outputForAudio();
    const ctx = await this.device();
    if (ctx === null) return null;
    // The capture destination belongs to the shared output and is connected
    // after the final master, so it contains both voice and BGM.
    this.chainFor(ctx);
    return output.captureStream();
  }

  /**
   * Put the voice in a room, or take it out of one.
   *
   * An unknown id is dry rather than an error, on the rule the rest of the
   * command set follows: ids are data, the wire carries them as strings, and a
   * caller working from a stale list should get something reasonable rather
   * than a broken stream.
   *
   * Returns immediately. The impulse response is built off the back of this and
   * swapped in when it is ready, which for the first room on a page means after
   * the WASM has loaded — a line spoken in between is heard dry.
   */
  setRoom(id: string | null): void {
    const next = id !== null && Object.hasOwn(ROOMS, id) ? (id as RoomId) : null;
    if (next === this.room) return;
    this.room = next;
    this.roomEpoch += 1;
    void this.applyRoom(this.roomEpoch);
  }

  /** The room that is up, by id. Null is dry. */
  get roomId(): string | null {
    return this.room;
  }

  /**
   * Build the graph a take is played into.
   *
   * Made once per context and kept, because the convolver holding the tail is
   * the reason the tail survives the take that caused it.
   */
  private chainFor(ctx: AudioContext): Chain {
    if (this.chainNodes) return this.chainNodes;
    const input = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const convolver = ctx.createConvolver();
    const output = ctx.createGain();
    // Dry at unity and wet at zero: no room until one is asked for, and the
    // voice at full level either way.
    dry.gain.value = 1;
    wet.gain.value = 0;
    // Silence, if this renderer is a monitor. Nothing upstream of here knows or
    // cares: the take is made, played and clocked exactly as it would have been.
    input.connect(dry).connect(output);
    input.connect(convolver).connect(wet).connect(output);
    output.connect(this.outputForAudio().voiceBus);
    this.chainNodes = { input, dry, wet, convolver, output };
    return this.chainNodes;
  }

  private async applyRoom(epoch: number): Promise<void> {
    const ctx = this.ctx;
    // No device yet. The room is remembered and applied by `device()` when one
    // appears, so setting it before the first line is not a lost setting.
    if (!ctx) return;
    const chain = this.chainFor(ctx);
    const room = this.room === null ? null : ROOMS[this.room];

    if (room === null) {
      chain.dry.gain.value = 1;
      chain.wet.gain.value = 0;
      return;
    }

    let impulse: AudioBuffer;
    try {
      impulse = await buildImpulse(ctx, room);
    } catch {
      // No acoustic support in the build, or the WASM would not load. Dry is a
      // working stream; a thrown error here would not be.
      return;
    }
    if (epoch !== this.roomEpoch) return;

    chain.convolver.buffer = impulse;
    // Equal power, so the voice does not drop as the room comes up. `mix` is
    // the fraction of the *power*, which is what makes 0.22 in one room sound
    // like the same amount of room as 0.22 in another.
    chain.wet.gain.value = Math.sqrt(room.mix);
    chain.dry.gain.value = Math.sqrt(1 - room.mix);
  }

  /**
   * The audio device, once the browser will give us one.
   *
   * A context built before the page has been interacted with starts suspended,
   * and a suspended one does not advance `currentTime` — so a take played on it
   * would leave the mouth frozen at the first mora for the length of the line.
   * That is worse than no audio, so a refused context answers null and the line
   * is mouthed silently. The next line after the operator touches anything gets
   * a running context and its voice.
   *
   * Being refused is a state of the page rather than a property of the context,
   * which is why the same one is kept and asked again rather than rebuilt: a
   * context that was refused starts on a later `resume()` once the page has been
   * interacted with. What must not happen is waiting on the first one — see
   * `RESUME_WAIT_MS`.
   */
  private async device(): Promise<AudioContext | null> {
    const output = this.outputForAudio();
    if (this.ctx === null) {
      this.ctx = output.context;
      // A room chosen before there was anything to play it in. Applying it here
      // is what makes `setRoom` order-independent against the first line.
      if (this.room !== null) void this.applyRoom(this.roomEpoch);
    }
    const started = await output.ensureRunning();
    this.blocked = !started;
    return started ? this.ctx : null;
  }

  /**
   * One line at a time, in the order they were queued.
   *
   * The session asks for every line the moment it is queued, so a batch of
   * seven arrives here as seven calls in the same tick. Sent together they are
   * seven concurrent requests at one GPU — which is not merely wasteful: it
   * took the sidecar down on an MPS driver assertion the first time a real
   * script was played through it. The sidecar refuses to run them in parallel
   * now, and this is the near half of the same rule.
   *
   * Nothing is lost by waiting. A line takes about a second to make and several
   * to say, so the next one is ready long before it is wanted, and serialising
   * also hands them back in the order the queue will play them.
   */
  prepare(text: string, reading?: string): Promise<Take | null> {
    const next = this.chain.then(
      () => this.synthesise(text, reading),
      () => this.synthesise(text, reading),
    );
    // The chain waits on completion, not on success: a line that failed must
    // not wedge every line behind it.
    this.chain = next.catch(() => null);
    return next;
  }

  /**
   * Run a decoded line through the chain, and measure what came out.
   *
   * Mono, because the synthesiser is: taking channel 0 and processing that is
   * not a simplification here, it is the whole signal. The result is written
   * into a fresh single-channel buffer rather than back into the decoded one,
   * so a failure part-way leaves the original intact to be played unprocessed.
   *
   * Nothing here is allowed to throw. The chain is a finish, and a stream that
   * loses its voice because a limiter refused a buffer is a far worse outcome
   * than one that sounds raw for a line.
   */
  private processed(ctx: AudioContext, decoded: AudioBuffer): AudioBuffer {
    const dsp = this.dsp;
    if (!dsp) return decoded;
    try {
      const samples = decoded.getChannelData(0);
      const out = processTake(samples, decoded.sampleRate, dsp);
      this.lastMeasured = measure(out, decoded.sampleRate);
      const buffer = ctx.createBuffer(1, out.length, decoded.sampleRate);
      buffer.getChannelData(0).set(out);
      return buffer;
    } catch {
      this.lastMeasured = { lufs: null, truePeakDb: null };
      return decoded;
    }
  }

  private async synthesise(text: string, reading?: string): Promise<Take | null> {
    if (Date.now() < this.silentUntil) return null;
    const ctx = await this.device();
    if (!ctx) return null;

    let encoded: ArrayBuffer;
    try {
      const res = await fetch(`${this.base}/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reading === undefined ? { text } : { text, reading }),
      });
      if (!res.ok) {
        // 503 is the sidecar not being there, which is a state rather than an
        // event: back off instead of asking again on the next line.
        if (res.status === 503) this.silentUntil = Date.now() + RETRY_AFTER_MS;
        return null;
      }
      encoded = await res.arrayBuffer();
    } catch {
      this.silentUntil = Date.now() + RETRY_AFTER_MS;
      return null;
    }

    try {
      const decoded = await ctx.decodeAudioData(encoded);
      const buffer = this.processed(ctx, decoded);
      return new BufferTake(
        ctx,
        this.chainFor(ctx).input,
        buffer,
        // Measured off the buffer that will be *played*, which after the chain
        // is not the one that arrived: a gate and a compressor move where the
        // loud parts of a line are, and a mouth following the take as
        // synthesised would be following a signal nobody can hear.
        buildEnvelope(buffer.getChannelData(0), buffer.sampleRate),
      );
    } catch {
      // Audio that arrived but will not decode. Nothing to retry — the same
      // line would produce the same bytes — so this one goes silent and the
      // next is asked for normally.
      return null;
    }
  }
}
