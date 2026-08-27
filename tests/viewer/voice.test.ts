import { describe, expect, it } from 'vitest';
import { buildEnvelope, envelopeAt, startContext } from '@/viewer/voice';

/**
 * The envelope the mouth follows, measured off a decoded take.
 *
 * Only the arithmetic is tested here — the parts that need an `AudioContext`
 * need a browser, and the reason this is a pure function taking samples rather
 * than an analyser node reading a live graph is so that the part worth checking
 * can be.
 */

const RATE = 48_000;

/** A tone at a given amplitude, for `seconds`. */
function tone(amplitude: number, seconds: number, hz = 220): Float32Array {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE);
  }
  return out;
}

const concat = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe('buildEnvelope', () => {
  it('runs at a hundred windows a second', () => {
    expect(buildEnvelope(tone(0.5, 1), RATE)).toHaveLength(100);
    expect(buildEnvelope(tone(0.5, 2.5), RATE)).toHaveLength(250);
  });

  it('normalises to the take rather than to an absolute level', () => {
    // The same words said quietly and loudly must move the mouth the same
    // amount. Any fixed gain would have to be retuned every time the voice was
    // retrained, or every time a reference clip was normalised differently.
    const quiet = buildEnvelope(tone(0.02, 1), RATE);
    const loud = buildEnvelope(tone(0.9, 1), RATE);
    expect(Math.max(...quiet)).toBeCloseTo(1, 3);
    expect(Math.max(...loud)).toBeCloseTo(1, 3);
  });

  it('is not decided by one loud instant', () => {
    // A single plosive against a whole quiet line. Referenced to the peak, the
    // rest of the line would sit near zero and the mouth would barely open for
    // any of it.
    const envelope = buildEnvelope(concat(tone(1, 0.02), tone(0.1, 2)), RATE);
    const body = Array.from(envelope.slice(20));
    expect(Math.min(...body)).toBeGreaterThan(0.9);
  });

  it('follows the loudness through a line, and closes on the silence in it', () => {
    const envelope = buildEnvelope(concat(tone(0.6, 0.5), tone(0, 0.5), tone(0.6, 0.5)), RATE);
    expect(envelopeAt(envelope, 0.25)).toBeGreaterThan(0.9);
    // The pause the text never predicted. This is the whole reason the mouth is
    // scaled by an envelope and not left to the track alone.
    expect(envelopeAt(envelope, 0.75)).toBe(0);
    expect(envelopeAt(envelope, 1.25)).toBeGreaterThan(0.9);
  });

  it('yields silence for silence rather than dividing by nothing', () => {
    const envelope = buildEnvelope(tone(0, 1), RATE);
    expect(Array.from(envelope).every((v) => v === 0)).toBe(true);
  });

  it('survives an empty take', () => {
    expect(Array.from(buildEnvelope(new Float32Array(0), RATE))).toEqual([0]);
  });
});

/**
 * Starting the audio device.
 *
 * The one part of this that needs a browser and is still worth testing here,
 * because what it exists for is a browser behaviour rather than an arithmetic:
 * a context the page has not earned the right to start leaves `resume()`
 * pending forever rather than rejecting it. Awaiting that directly is what made
 * a viewer nobody had clicked silent for the rest of its life — the requests are
 * chained, so the line that waited took every line behind it with it.
 */
describe('startContext', () => {
  /** A context that answers a `resume()` the way the browser is willing to. */
  const fake = (state: AudioContextState, starts: boolean) => {
    const ctx = {
      state,
      resume: () =>
        starts
          ? Promise.resolve().then(() => {
              ctx.state = 'running';
            })
          : // Refused: never settles. Not a rejection — that would be a kindness
            // the browser does not extend.
            new Promise<void>(() => {}),
    };
    return ctx;
  };

  it('answers immediately for a context that is already running', async () => {
    const ctx = fake('running', true);
    expect(await startContext(ctx, 50)).toBe(true);
  });

  it('starts a suspended context the browser is willing to start', async () => {
    const ctx = fake('suspended', true);
    expect(await startContext(ctx, 50)).toBe(true);
    expect(ctx.state).toBe('running');
  });

  it('gives up on a refusal instead of waiting on a promise that never settles', async () => {
    const ctx = fake('suspended', false);
    expect(await startContext(ctx, 20)).toBe(false);
    expect(ctx.state).toBe('suspended');
  });

  it('can be asked again, which is how the voice comes back after a click', async () => {
    const ctx = fake('suspended', false);
    expect(await startContext(ctx, 20)).toBe(false);
    // The page has been interacted with. The same context starts on a second
    // ask, which is why it is kept rather than thrown away and rebuilt.
    ctx.resume = () =>
      Promise.resolve().then(() => {
        ctx.state = 'running';
      });
    expect(await startContext(ctx, 20)).toBe(true);
  });

  it('will not reopen a context that was closed on teardown', async () => {
    const ctx = fake('closed', true);
    expect(await startContext(ctx, 20)).toBe(false);
    expect(ctx.state).toBe('closed');
  });
});

describe('envelopeAt', () => {
  it('reads silence outside the take, so a clock past the end closes the mouth', () => {
    // `elapsed` runs on past the audio deliberately — it is how the mouth knows
    // the line is over — so being asked beyond the end is the normal case.
    const envelope = buildEnvelope(tone(0.5, 1), RATE);
    expect(envelopeAt(envelope, 1.5)).toBe(0);
    expect(envelopeAt(envelope, -0.2)).toBe(0);
  });
});
