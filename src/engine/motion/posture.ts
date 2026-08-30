import type * as THREE from 'three';
import type { Rig } from '../rig';
import type { Profile } from '../types';
import { breathCurve, settle } from './idle';

/**
 * What a character does while nothing is being asked of it.
 *
 * Breathing, the slow transfer of standing weight, the fold a hop puts through
 * the trunk, and the several incommensurable sines that keep a head from ever
 * returning to exactly the same attitude. All of it is additive spine offsets,
 * all of it runs *through* gestures rather than instead of them — a character
 * that stops breathing the moment it raises a hand reads as a puppet — and
 * every number here was arrived at by watching a render.
 *
 * Held apart from the body layer because none of it depends on what the arms
 * are doing. The one thing that travels back out is the breath, which the arm
 * compose step also rides.
 */

/** What the posture reads off the body layer each frame. */
export interface PostureInput {
  /** Seconds since the layer started. Every oscillation here is a function of it. */
  t: number;
  speaking: boolean;
  speechEnergy: number;
  breathPeriod: number;
  breathDepth: number;
  weightShift: number;
  idleAmount: number;
  hipsRest: THREE.Vector3;
  hipsUnit: number;
  jumpHeight: number;
  /** Hips above rest this frame, metres. See `jump.ts`. */
  rise: number;
  /** 0..1, how far into the dip the body is. */
  load: number;
}

/** The breath terms the arm compose step also needs. */
export interface BreathTerms {
  /** The breath curve, -1 to 1. */
  br: number;
  /** How much of it applies — shallower while speaking. */
  d: number;
}

export class IdlePosture {
  private _breathPhase = 0;
  private _wasSpeaking = false;

  /** Breathing phase, 0..1, exposed so the UI can show it. */
  get breath(): number {
    return breathCurve(this._breathPhase);
  }

  apply(rig: Rig, p: Profile, dt: number, s: PostureInput): BreathTerms {
    // --- breathing --------------------------------------------------------
    // Runs unconditionally, including through gestures. A character that stops
    // breathing the moment it raises a hand reads as a puppet.
    //
    // Phase is accumulated rather than derived from absolute time, so changing
    // the period mid-stream eases instead of teleporting the chest.
    if (s.speaking && !this._wasSpeaking) this._breathPhase = 0.04; // catch a breath
    this._wasSpeaking = s.speaking;
    // Speech rides the exhale: the cycle stretches and shallows while talking,
    // and the breath before a line is the part people actually notice missing.
    const period =
      s.breathPeriod * (s.speaking ? 1.5 : 1) * (1 + 0.11 * Math.sin(s.t * 0.077 + 1.4));
    this._breathPhase = (this._breathPhase + dt / period) % 1;

    const breath = breathCurve(this._breathPhase);
    const br = (breath - 0.5) * 2; // -1 .. 1
    const d = s.breathDepth * (s.speaking ? 0.7 : 1);

    rig.addOffset('spine', -0.014 * d * br, 0, 0);
    rig.addOffset('chest', -0.03 * d * br, 0, 0);
    rig.addOffset('neck', 0.01 * d * br, 0, 0);

    // --- weight shift -----------------------------------------------------
    // Slow lateral transfer of weight with the spine counter-leaning above it,
    // so the head stays roughly over the same point. Deliberately very slow —
    // a ~20 s cycle — and out of phase with the breath so the two never lock
    // into a visible rhythm. Anything faster reads as fidgeting.
    const shift = settle(Math.sin(s.t * 0.31)) * s.weightShift;
    const shiftSlow = settle(Math.sin(s.t * 0.13 + 1.1)) * s.weightShift;

    rig.addOffset('hips', 0, 0.01 * shiftSlow, -0.03 * shift);
    rig.addOffset('spine', 0, 0.008 * shiftSlow, 0.018 * shift);
    rig.addOffset('chest', 0, 0.01 * shiftSlow, 0.01 * shift);
    rig.addOffset('neck', 0, 0, -0.014 * shift);

    // --- jump -------------------------------------------------------------
    // Written into the same translation the weight shift uses, and folded into
    // the spine so the body reads as loading and extending rather than as being
    // moved by a crane. The fold is small: with no legs in the rig the spine is
    // doing the work of the whole body, and a deep fold looks like a bow.
    if (s.rise !== 0) {
      const load = s.load;
      const stretch = Math.max(0, s.rise) / Math.max(0.005, s.jumpHeight);
      rig.addOffset('spine', 0.085 * load - 0.045 * stretch, 0, 0);
      rig.addOffset('chest', 0.07 * load - 0.035 * stretch, 0, 0);
      rig.addOffset('neck', 0.03 * load - 0.02 * stretch, 0, 0);
    }

    const hips = p.bones.hips;
    if (hips) {
      const u = s.hipsUnit;
      hips.position.set(
        s.hipsRest.x + 0.012 * shift * u,
        s.hipsRest.y + (0.0035 * d * br + s.rise) * u,
        s.hipsRest.z,
      );
    }

    // --- head micro-motion and posture ------------------------------------
    // Several incommensurable sines so the head never returns to exactly the
    // same attitude; a single sine reads as a mechanical nod. All well under
    // 0.5 rad/s — the faster harmonics that were here read as a twitch rather
    // than as breathing-scale drift.
    const idle = s.idleAmount;
    rig.addOffset(
      'head',
      idle * (0.022 * Math.sin(s.t * 0.29 + 0.4) + 0.007 * Math.sin(s.t * 0.71 + 1.9)),
      idle * (0.036 * Math.sin(s.t * 0.19 + 2.1) + 0.011 * Math.sin(s.t * 0.47)),
      idle * (0.022 * Math.sin(s.t * 0.24 + 0.8) + 0.006 * Math.sin(s.t * 0.61 + 2.7)),
    );
    rig.addOffset('chest', 0, 0.013 * idle * Math.sin(s.t * 0.21 + 0.9), 0);

    // Posture drifts on a scale far longer than breath — a couple of minutes —
    // which is what keeps a long shot from settling into a recognisable loop.
    const posture = Math.sin(s.t * 0.041 + 0.7) * idle;
    rig.addOffset('spine', 0.009 * posture, 0, 0);
    rig.addOffset('chest', 0.006 * posture, 0, 0);
    rig.addOffset('neck', -0.008 * posture, 0, 0);

    // Speech carries head motion of its own. Driven off the mouth's envelope so
    // it lands with the voice rather than running on a timer of its own.
    const talk = s.speechEnergy;
    if (talk > 0.001) {
      rig.addOffset(
        'head',
        -0.024 * talk * Math.sin(s.t * 2.31 + 0.5),
        0.016 * talk * Math.sin(s.t * 1.73),
        0.011 * talk * Math.sin(s.t * 1.29 + 2.0),
      );
      rig.addOffset('chest', -0.008 * talk * Math.sin(s.t * 2.31 + 0.5), 0, 0);
    }

    return { br, d };
  }
}
