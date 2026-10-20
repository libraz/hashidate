import * as THREE from 'three';
import type { FingerName, Profile, Side } from '../types';

/**
 * What a hand does on top of the shape a pose gives it.
 *
 * A pose authors a hand as a constant, and held constant through a gesture it
 * reads as a mitten on a moving arm. Two terms are added after the blend, the
 * way the arm's idle drift is: a slow per-finger drift, and a lag behind the
 * hand's own acceleration — fingers trail the hand that carries them, curling
 * toward the palm when the hand is thrown toward its back and opening when it
 * is thrown toward its palm.
 *
 * Both scale with how slack the finger is. A finger held straight to point or
 * closed into a fist is held there on purpose, and the pointing solver reads
 * its fingertip off that curl.
 */

const FINGERS: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];

/** Curl the idle drift can add either way, at full slack. About five degrees at the knuckle. */
const DRIFT = 0.05;

/**
 * The lag is a point hung off the knuckle on a spring, read as how far it sits
 * off the knuckle along the palm normal.
 *
 * Not a differentiated acceleration: the solved wrist jitters by millimetres a
 * frame, and a second difference at 60 Hz multiplies that by 3600 — every
 * gesture read as 7 g and pinned the fingers at their limit. A spring answers
 * slow motion the same way (offset ≈ a/ω²) and passes jitter through at its
 * own size.
 */
const LAG_PER_METRE = 9.7;
/** Most the lag may move a finger either way; approached softly, never clipped. */
const LAG_MAX = 0.15;
/** Further than this from its point and the hand was moved rather than swung — a placement change, a reload. */
const TELEPORT = 0.3;
/** A frame this long is a tab coming back, not motion. */
const STALE_DT = 0.1;
/** The fingers' own spring: about 3.5 Hz, a little under critical so a stop leaves a small follow-through. */
const LAG_OMEGA = 22;
const LAG_ZETA = 0.6;

/** The thumb hangs off the side of the palm and swings least; the little finger, longest from the wrist's axis, most. */
const LAG_WEIGHT: Record<FingerName, number> = {
  thumb: 0.4,
  index: 0.8,
  middle: 1,
  ring: 1.05,
  little: 1.1,
};

/** 1 for a half-closed finger, 0 for one straight or fully closed. */
const slack = (v: number): number => {
  const c = THREE.MathUtils.clamp(v, 0, 1);
  return 4 * c * (1 - c);
};

interface HandMotion {
  /** The lagging point and its velocity, world space. */
  point: THREE.Vector3;
  vel: THREE.Vector3;
  /** False until the point has been placed on the knuckle once. */
  seeded: boolean;
  /** The lag this frame, in curl. */
  x: number;
}

const mkMotion = (): HandMotion => ({
  point: new THREE.Vector3(),
  vel: new THREE.Vector3(),
  seeded: false,
  x: 0,
});

const _pos = new THREE.Vector3();
const _off = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class FingerLife {
  private readonly _motion: Record<Side, HandMotion> = { L: mkMotion(), R: mkMotion() };

  constructor(
    private readonly p: Profile,
    private readonly palmLocal: Partial<Record<Side, THREE.Vector3>>,
  ) {}

  /**
   * Read the posed hand and advance its lag. Call once per side per frame,
   * after the arm is aimed and before the fingers are curled.
   */
  sense(side: Side, dt: number): void {
    const m = this._motion[side];
    const hand = this.p.bones[`hand.${side}`];
    const knuckle = this.p.fingerBones[`middle.${side}`]?.[0];
    const palm = this.palmLocal[side];
    if (!(hand && knuckle && palm) || dt <= 0) return;

    knuckle.updateWorldMatrix(true, false);
    knuckle.getWorldPosition(_pos);
    if (!m.seeded || dt > STALE_DT || m.point.distanceTo(_pos) > TELEPORT) {
      m.point.copy(_pos);
      m.vel.set(0, 0, 0);
      m.seeded = true;
    }

    // Implicit damped spring, stable at any frame length.
    const w2 = LAG_OMEGA * LAG_OMEGA;
    m.vel
      .addScaledVector(_off.copy(_pos).sub(m.point), w2 * dt)
      .divideScalar(1 + 2 * LAG_ZETA * LAG_OMEGA * dt + w2 * dt * dt);
    m.point.addScaledVector(m.vel, dt);

    hand.getWorldQuaternion(_q);
    _normal.copy(palm).applyQuaternion(_q).normalize();
    // Left on the palm side, the hand was thrown toward its back: the fingers
    // fold in after it.
    const lag = LAG_PER_METRE * _off.copy(m.point).sub(_pos).dot(_normal);
    m.x = LAG_MAX * Math.tanh(lag / LAG_MAX);
  }

  /**
   * Curl to add to finger `f` whose blended curl is `curl`.
   *
   * `idle` scales the drift only — the lag is the hand moving, not the
   * character idling. `amount` scales both, for a hand whose fingers are not
   * free to move on their own.
   */
  offset(side: Side, f: FingerName, curl: number, t: number, idle: number, amount: number): number {
    const s = slack(curl) * amount;
    if (s <= 0) return 0;
    const i = FINGERS.indexOf(f);
    // Neighbouring fingers drift near but not in step; a hand whose fingers
    // move together reads as one part flexing.
    const ph = i * 0.7 + (side === 'L' ? 0 : 2.3);
    const drift =
      (DRIFT * idle * (Math.sin(t * 0.7 + ph) + 0.5 * Math.sin(t * 1.3 + 1.7 * ph))) / 1.5;
    return s * (drift + this._motion[side].x * LAG_WEIGHT[f]);
  }
}
