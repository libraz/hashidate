/**
 * The readout as a shell prints it.
 *
 * The HUD and this show the same measurements, and they are two instruments
 * rather than two skins. The HUD is drawn with CSS bars and catalogue labels and
 * is a thing to glance at *while working on a pose*; it lives with the console,
 * on a page nobody is watching. This is a thing to read while a broadcast is
 * running, so it is built the other way round: fixed columns, the engine's own
 * names for the values, and every figure in a place it will still be in on the
 * next sample. Nothing here moves except the numbers.
 *
 * The model is assembled here and rendered in `Telemetry.tsx`. That split is
 * what makes the readout testable at all — a component that reads a live
 * runtime can only be checked by running one, whereas the question actually
 * worth asking of this file is arithmetic: does a gauge stay the same width at
 * every value, does a negative gaze fill to the left, does a document that is
 * not up print no rows rather than empty ones.
 */

import type { SlideReport } from '@/engine/types';
import type { StageMode } from '../stage-mode';
import type { Hud } from './runtime';

/**
 * What a figure means, not what colour it is.
 *
 * `warn` and `bad` are the measurement colours, which the tokens reserve for
 * the joint readout. They are used here on the same grounds the HUD uses
 * `warn` for blocked audio: everything on this panel is a measurement, and the
 * three things that take a colour are readings of a fault — a frame rate under
 * the stream's, an audio device the browser will not start, a document that
 * failed to open. `ok` is deliberately absent. Nothing here needs to say that a
 * number is fine; the number says it.
 */
export type Tone = 'ink' | 'dim' | 'faint' | 'accent' | 'warn' | 'bad' | 'live';

/**
 * A gauge, split where it changes colour.
 *
 * Three pieces rather than one string because the filled cells are lit and the
 * track is not, and a component cannot find the boundary in `░░░███░░░` on its
 * own — a centred gauge has track on both sides of the fill. Concatenated they
 * are always exactly `BAR_CELLS` characters, which is the property the whole
 * layout rests on.
 */
export interface Bar {
  before: string;
  fill: string;
  after: string;
}

export interface Gauge {
  key: string;
  bar: Bar;
  value: string;
}

export interface Field {
  key: string;
  value: string;
  tone: Tone;
}

export interface Flag {
  text: string;
  tone: Tone;
}

export interface Readout {
  head: {
    /** `hashidate@stage` — which of the two pages this is. */
    host: string;
    /** The render size, or `window` when the canvas fills whatever it is in. */
    size: string;
    avatar: string;
    fps: string;
    fpsTone: Tone;
    /** How the face is being driven: ARKit, custom shapes, or VRM presets. */
    channel: string;
  };
  gauges: Gauge[];
  facts: Field[];
  /** Null when no document is up. A row of dashes says less than no row. */
  deck: Field[] | null;
  flags: Flag[];
}

/**
 * How many cells a gauge is drawn in.
 *
 * Sixteen, so a full-scale reading is legible as a bar rather than as a word,
 * and so the centred one has a whole number either side of zero. It is also the
 * resolution: a value lands on one of seventeen widths, which is finer than the
 * eye reads off a 3 px CSS bar anyway.
 */
const BAR_CELLS = 16;

/**
 * The two shade blocks, and deliberately not the full block.
 *
 * None of the block elements are in the mono face this page bundles — only its
 * latin subsets are imported at all — so all three are drawn by whatever the
 * system falls back to. The shades come back one cell wide there and `█` comes
 * back at nearly twice that, which is the difference between a bar and a row of
 * squares with gaps in it. So the gauge is dark shade against light shade, and
 * the fill reads as filled because it is lit rather than because it is solid.
 */
const FILL = '▓';
const TRACK = '░';

/**
 * The gaze channel is radians and small; ±0.5 covers everything the limits
 * allow, so that is what its track spans. The same figure the HUD uses, for the
 * same reason.
 */
const GAZE_SPAN = 0.5;

/**
 * When the frame rate is worth colouring.
 *
 * The one number on this panel that changes colour on its own, because it is
 * the one fault that is invisible in the picture until it is already in the
 * recording. Under 50 is a source dropping frames; under 30 it has stopped
 * being a broadcast.
 */
const FPS_SLIPPED = 50;
const FPS_LOST = 30;

/** Nothing there, printed the way a shell prints nothing. */
const NONE = '-';

/**
 * A gauge of fixed width, filled from the left — or from the middle when the
 * reading has a sign.
 *
 * `centred` is what the gaze needs and the other two do not: a bar that always
 * grows from the left cannot say which way the eyes went.
 */
export function bar(value: number, opts: { span?: number; centred?: boolean } = {}): Bar {
  const span = opts.span ?? 1;
  const magnitude = Number.isFinite(value) ? Math.min(1, Math.abs(value) / span) : 0;

  if (!opts.centred) {
    const filled = Math.round(magnitude * BAR_CELLS);
    return { before: '', fill: FILL.repeat(filled), after: TRACK.repeat(BAR_CELLS - filled) };
  }

  const half = BAR_CELLS / 2;
  const filled = Math.round(magnitude * half);
  return value < 0
    ? {
        before: TRACK.repeat(half - filled),
        fill: FILL.repeat(filled),
        after: TRACK.repeat(half),
      }
    : {
        before: TRACK.repeat(half),
        fill: FILL.repeat(filled),
        after: TRACK.repeat(half - filled),
      };
}

/** The three pieces as one line, which is what a test wants to measure. */
export const barText = (b: Bar): string => b.before + b.fill + b.after;

/** A reading in the fixed two places every gauge prints, sign and all. */
const signed = (value: number): string => `${value < 0 ? '' : '+'}${value.toFixed(2)}`;

/** Everything the panel prints, from one sample of the running scene. */
export function readout(sample: {
  hud: Hud;
  slides: SlideReport;
  avatar: string;
  /** What the profile, wardrobe or sway layer could not resolve. */
  problems: number;
  mode: StageMode;
  /**
   * The wording for blocked audio, already in the language of this page.
   *
   * Handed in for the reason `avatar` is: this file is arithmetic and layout,
   * and reading the locale store here would make every figure it prints depend
   * on module state a test would have to set up before it could ask what a
   * gauge is. The caller is a component and already holds the translator.
   */
  voiceBlocked: string;
}): Readout {
  const { hud, slides, avatar, problems, mode, voiceBlocked } = sample;

  const facts: Field[] = [
    { key: 'morph', value: String(hud.morphs), tone: 'ink' },
    { key: 'sway', value: hud.sway === null ? 'off' : String(hud.sway), tone: 'ink' },
    { key: 'gesture', value: hud.gesture ?? NONE, tone: hud.gesture ? 'accent' : 'faint' },
    { key: 'expr', value: hud.expression ?? NONE, tone: hud.expression ? 'accent' : 'faint' },
    { key: 'auto', value: hud.auto ? 'on' : 'off', tone: hud.auto ? 'accent' : 'faint' },
  ];
  // Only when there is something to say. A rig that resolved cleanly printing
  // `problems 0` every sample trains the eye to skip the row it is there for.
  if (problems > 0) facts.push({ key: 'problems', value: String(problems), tone: 'warn' });

  const flags: Flag[] = [
    hud.speaking
      ? { text: 'ON AIR', tone: 'live' as const }
      : { text: 'IDLE', tone: 'faint' as const },
  ];
  // A property of this page rather than of the performance, and the first thing
  // to check when a preview looks right and sounds like nothing.
  if (mode.muted) flags.push({ text: 'MUTED', tone: 'dim' });
  if (hud.voiceBlocked) flags.push({ text: voiceBlocked, tone: 'warn' });
  if (slides.error) flags.push({ text: slides.error, tone: 'bad' });

  return {
    head: {
      host: `hashidate@${mode.console ? 'console' : 'stage'}`,
      size: mode.size ? `${mode.size.width}x${mode.size.height}` : 'window',
      avatar,
      fps: `${hud.fps}fps`,
      fpsTone: hud.fps < FPS_LOST ? 'bad' : hud.fps < FPS_SLIPPED ? 'warn' : 'dim',
      channel: hud.channel,
    },
    gauges: [
      { key: 'breath', bar: bar(hud.breath), value: hud.breath.toFixed(2) },
      { key: 'blink', bar: bar(hud.blink), value: hud.blink.toFixed(2) },
      {
        key: 'gaze.x',
        bar: bar(hud.gazeX, { span: GAZE_SPAN, centred: true }),
        value: signed(hud.gazeX),
      },
    ],
    facts,
    deck:
      slides.deck === null
        ? null
        : [
            { key: 'deck', value: slides.deck, tone: 'ink' },
            { key: 'page', value: `${slides.page}/${slides.pages}`, tone: 'accent' },
            // The difference between a page that is up and one still being
            // drawn, which is the only thing an operator holding an arrow key
            // needs and the one thing the command cannot tell them.
            {
              key: 'state',
              value: slides.ready ? 'ready' : 'drawing',
              tone: slides.ready ? 'dim' : 'warn',
            },
          ],
    flags,
  };
}
