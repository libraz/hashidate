/**
 * The set-once layer, as a value.
 *
 * Breath depth, spring stiffness, gaze limits, jump gravity — the numbers an
 * operator decides while watching one avatar and then leaves alone for the rest
 * of the session. They were reachable only by writing onto the live engine
 * objects (`director.body.breathDepth = v`), which works from a console on the
 * same page as the renderer and from nowhere else.
 *
 * Naming them here does three things at once: it gives a remote surface
 * something to send, it gives the renderer something to report so a fader can
 * be drawn at the value that is actually running, and it puts the ranges those
 * faders sweep in one place instead of one copy per panel.
 *
 * ## The ranges are here, and the defaults are not
 *
 * Every default lives on the engine object that owns it — `Body.breathDepth`,
 * `Spring.stiffnessScale` — and is a number arrived at by watching two real
 * avatars. Nothing in this file may restate one. What is here is only how far a
 * control may travel, which is a property of the control rather than of the
 * character, and which both the wire and both panels need to agree on.
 */

/** How one number may be stated: what it accepts, and how it reads. */
export interface TuningRange {
  min: number;
  max: number;
  step: number;
  /** Decimal places in a readout. */
  precision: number;
  /** Appended to a readout: `s`, `m`, `m/s²`. Empty for a bare ratio. */
  unit: string;
}

/** Idle motion: what the character does when it is doing nothing. */
export interface TuningIdle {
  breathDepth: number;
  breathPeriod: number;
  /** The head's micro-movement, which is what keeps a still frame from reading as a pause. */
  idleAmount: number;
  weightShift: number;
  gazeAmount: number;
  /**
   * A multiplier over the avatar's own measured eye limits rather than an angle.
   * The limits are profile data and differ per model; this scales them.
   */
  eyeLimit: number;
  blink: boolean;
}

/** The spring-bone layer: hair, skirts, ribbons. */
export interface TuningSway {
  enabled: boolean;
  /** Multipliers over what the model itself declares, not absolute figures. */
  stiffness: number;
  inertia: number;
  gravity: number;
}

/** The hop arc. Height and gravity decide it between them; mass cancels. */
export interface TuningHop {
  /** Metres. The console states it in centimetres; the wire does not. */
  height: number;
  gravity: number;
}

export interface TuningTail {
  amount: number;
}

export interface TuningRender {
  /** Off falls back to whatever materials the GLB arrived with. */
  toon: boolean;
  /** Off falls back to the VRM presets, which is the degraded path made visible. */
  arkit: boolean;
}

/**
 * A change to the layer: only the parts being moved.
 *
 * Partial all the way down, on the same rule `voice` follows — a surface with
 * one fader under the mouse sends one number, and the renderer merges it onto
 * what it is already running.
 */
export interface TuningPatch {
  idle?: Partial<TuningIdle>;
  sway?: Partial<TuningSway>;
  hop?: Partial<TuningHop>;
  tail?: Partial<TuningTail>;
  render?: Partial<TuningRender>;
  /**
   * Snap the spring chains to rest, after anything above has landed.
   *
   * The one verb in a patch of values, and it is here rather than as a command
   * of its own because it is only ever wanted next to the sway faders: a chain
   * given new stiffness keeps swinging on the old one until it settles, and
   * comparing two settings means comparing them from the same standstill.
   *
   * It has no value, so it is not part of `Tuning` — there is nothing to report
   * about a thing that already happened.
   */
  settle?: boolean;
}

/**
 * What the layer is actually running, plus what this avatar has to run it with.
 *
 * `has` is the reason this is not simply `Required<TuningPatch>`: an avatar with
 * no spring bones has no sway to tune, and a fader for a chain that is not there
 * is a dead control. The console hides those sections by asking the live engine
 * objects; a remote surface has to be told.
 */
export interface Tuning {
  idle: TuningIdle;
  sway: TuningSway;
  hop: TuningHop;
  tail: TuningTail;
  render: TuningRender;
  has: {
    sway: boolean;
    tail: boolean;
    /** Whether the avatar has the 52 ARKit shapes at all. */
    arkit: boolean;
  };
}

/**
 * How far each control may travel.
 *
 * Read by the wire schema, which refuses a value outside them, and by both
 * panels, which sweep exactly this far. A number changed here changes all three
 * together, which is the point: the two panels drifting apart about what a
 * stiffness slider means is a bug nobody would notice until the numbers were
 * compared side by side.
 */
export const TUNING_RANGES = {
  idle: {
    breathDepth: { min: 0, max: 2, step: 0.01, precision: 2, unit: '' },
    breathPeriod: { min: 2, max: 8, step: 0.1, precision: 1, unit: 's' },
    idleAmount: { min: 0, max: 2, step: 0.01, precision: 2, unit: '' },
    weightShift: { min: 0, max: 2, step: 0.01, precision: 2, unit: '' },
    gazeAmount: { min: 0, max: 2, step: 0.01, precision: 2, unit: '' },
    eyeLimit: { min: 0.2, max: 2, step: 0.05, precision: 2, unit: '' },
  },
  sway: {
    stiffness: { min: 0.2, max: 3, step: 0.05, precision: 2, unit: '' },
    inertia: { min: 0, max: 1.6, step: 0.05, precision: 2, unit: '' },
    gravity: { min: 0, max: 4, step: 0.1, precision: 1, unit: '' },
  },
  hop: {
    // Metres on the wire, because that is the unit the body layer holds it in.
    // The centimetre readout both consoles show is presentation and belongs to
    // them: a jump is stated in centimetres and stored in metres.
    height: { min: 0.01, max: 0.3, step: 0.01, precision: 2, unit: 'm' },
    gravity: { min: 1.5, max: 20, step: 0.1, precision: 1, unit: 'm/s²' },
  },
  tail: {
    amount: { min: 0, max: 4, step: 0.05, precision: 2, unit: '' },
  },
} as const satisfies Record<string, Record<string, TuningRange>>;
