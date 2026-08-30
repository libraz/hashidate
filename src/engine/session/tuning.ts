import type { Director } from '../director';
import type { Tuning, TuningPatch } from '../tuning';
import type { GazeLimits, Shading } from '../types';

/**
 * The set-once layer: breath, sway, hop, tail, shading.
 *
 * Two directions, and they are not symmetrical. A patch names the faders that
 * moved and leaves everything else alone; a report is the whole layer, read
 * back off the engine objects that own it rather than remembered from whatever
 * was last sent.
 */
export class TuningControl {
  /**
   * The avatar's own eye limits, as they were measured.
   *
   * `eyeLimit` is a multiplier and the profile is what it multiplies, so the
   * figures it started from have to survive being scaled — reading the current
   * profile back would compound every drag of the fader. Captured per session,
   * which is per avatar: a swap builds a new one.
   */
  private readonly _baseGaze: GazeLimits;
  /** The last `eyeLimit` applied, so the layer can report what it is running. */
  private _eyeLimit = 1;

  constructor(
    private readonly d: Director,
    private readonly shading: Shading | null,
  ) {
    this._baseGaze = { ...d.p.gaze };
  }

  /**
   * Move part of the set-once layer. See `tuning.ts` for what is in it.
   *
   * Absent is not the same as a value, all the way down: a patch names the
   * faders that moved and leaves every other number exactly where it was. That
   * is what lets a surface send one knob per drag instead of the whole layer,
   * and it is the same rule `setVoiceChain` follows for the same reason.
   *
   * A group this avatar does not have is a no-op rather than an error — sway on
   * a model with no spring bones, a tail on a model with no tail — which is the
   * shape `wear` and `setRoom` already have.
   */
  apply(patch: TuningPatch): void {
    const d = this.d;
    const { idle, sway, hop, tail, render, settle } = patch;

    if (idle) {
      if (idle.breathDepth !== undefined) d.body.breathDepth = idle.breathDepth;
      if (idle.breathPeriod !== undefined) d.body.breathPeriod = idle.breathPeriod;
      if (idle.idleAmount !== undefined) d.body.idleAmount = idle.idleAmount;
      if (idle.weightShift !== undefined) d.body.weightShift = idle.weightShift;
      if (idle.gazeAmount !== undefined) d.body.gazeAmount = idle.gazeAmount;
      if (idle.blink !== undefined) d.blinkEnabled = idle.blink;
      // Scaled off the measured limits rather than off the current ones, so
      // dragging the fader twice does not square the multiplier.
      if (idle.eyeLimit !== undefined) {
        this._eyeLimit = idle.eyeLimit;
        d.p.gaze.eyeYaw = this._baseGaze.eyeYaw * idle.eyeLimit;
        d.p.gaze.eyePitch = this._baseGaze.eyePitch * idle.eyeLimit;
      }
    }

    if (sway) {
      if (sway.enabled !== undefined) d.spring.enabled = sway.enabled;
      if (sway.stiffness !== undefined) d.spring.stiffnessScale = sway.stiffness;
      if (sway.inertia !== undefined) d.spring.inertiaScale = sway.inertia;
      if (sway.gravity !== undefined) d.spring.gravityScale = sway.gravity;
    }

    if (hop) {
      if (hop.height !== undefined) d.body.jumpHeight = hop.height;
      if (hop.gravity !== undefined) d.body.gravity = hop.gravity;
    }

    if (tail?.amount !== undefined) d.tail.amount = tail.amount;

    if (render) {
      if (render.toon !== undefined) this.shading?.setToon(render.toon);
      // Asked for on an avatar with no ARKit shapes, this stays where it is:
      // the director reads it together with `arkit.supported`, so setting it
      // would advertise a mode the face cannot actually be driven in.
      if (render.arkit !== undefined && d.p.arkit.supported) d.useArkit = render.arkit;
    }

    // Last, so that a patch which changes the stiffness and asks for a
    // standstill in one breath gets the standstill under the new stiffness.
    if (settle) d.spring.reset();
  }

  /**
   * What that layer is running, and what this avatar has to run it with.
   *
   * Reported rather than remembered, on the same footing as `Voice.report`: a
   * fader drawn from the last command sent is a fader that lies about an avatar
   * that was swapped underneath it, and every default here belongs to the
   * engine object that owns it rather than to whoever last touched a panel.
   */
  report(): Tuning {
    const d = this.d;
    return {
      idle: {
        breathDepth: d.body.breathDepth,
        breathPeriod: d.body.breathPeriod,
        idleAmount: d.body.idleAmount,
        weightShift: d.body.weightShift,
        gazeAmount: d.body.gazeAmount,
        eyeLimit: this._eyeLimit,
        blink: d.blinkEnabled,
      },
      sway: {
        enabled: d.spring.enabled,
        stiffness: d.spring.stiffnessScale,
        inertia: d.spring.inertiaScale,
        gravity: d.spring.gravityScale,
      },
      hop: { height: d.body.jumpHeight, gravity: d.body.gravity },
      tail: { amount: d.tail.amount },
      render: { toon: this.shading?.toon ?? true, arkit: d.useArkit },
      has: { sway: d.spring.active, tail: d.tail.active, arkit: d.p.arkit.supported },
    };
  }
}
