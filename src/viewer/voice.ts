import type { Take, Voice } from '@/engine/types';

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
  private readonly buffer: AudioBuffer;
  private readonly envelope: Float32Array;
  private source: AudioBufferSourceNode | null = null;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;

  constructor(ctx: AudioContext, buffer: AudioBuffer, envelope: Float32Array) {
    this.ctx = ctx;
    this.buffer = buffer;
    this.envelope = envelope;
    this.seconds = buffer.duration;
  }

  play(): void {
    if (this.startedAt !== null) return;
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.ctx.destination);
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
}

export class BrowserVoice implements Voice {
  private readonly base: string;
  private ctx: AudioContext | null = null;
  private silentUntil = 0;
  /** Requests are run through this one at a time. See `prepare`. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor({ base = '/api' }: BrowserVoiceOptions = {}) {
    this.base = base;
  }

  /**
   * The audio device, once the browser will give us one.
   *
   * A context built before the page has been interacted with starts suspended,
   * and a suspended one does not advance `currentTime` — so a take played on it
   * would leave the mouth frozen at the first mora for the length of the line.
   * That is worse than no audio, so a suspended context answers null and the
   * line is mouthed silently. The next line after the operator touches anything
   * gets a running context and its voice.
   */
  private async device(): Promise<AudioContext | null> {
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => {});
    }
    return this.ctx.state === 'running' ? this.ctx : null;
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
      const buffer = await ctx.decodeAudioData(encoded);
      return new BufferTake(
        ctx,
        buffer,
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
