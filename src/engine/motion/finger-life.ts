import * as THREE from 'three';
import type { FingerName, Profile, Side } from '../types';
import { ScalarFollower } from './follow';

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
 * The lag's sideways part, across the palm, fans the four fingers toward
 * whichever side the hand left behind — a wave swings in the palm plane, and
 * would otherwise move nothing.
 *
 * Slack fingers also hang: a hand turned palm up lets them fall open a little,
 * and palm down lets them fall in.
 *
 * And they answer the wrist through the long flexor tendons (tenodesis): a wrist
 * bending back pulls them in, one bending toward the palm lets them open. Only
 * the change shows — the shape a pose holds still was tuned at its own wrist
 * angle, and tone restores it once the wrist stops.
 *
 * All of it scales with how slack the finger is. A finger held straight to point or
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
/** Curl gravity takes off a slack hand turned fully palm up, or adds palm down. */
const DROOP = 0.04;
/**
 * How far the palm may tip from vertical before gravity shows; tone holds the
 * rest. A hand hanging at the side tips about 0.22 on the test rig, and that
 * shape is tuned by eye.
 */
const DROOP_DEAD = 0.35;
/**
 * Curl per radian of wrist bend. Relaxed fingers flex roughly a third of a
 * degree at the knuckle per degree of wrist extension, and curl 1 is about 90°.
 */
const TENODESIS = 0.2;
/** Most the wrist may move a finger either way; approached softly. */
const TENO_MAX = 0.12;
/** How fast tone takes the hand back to its shape once the wrist settles: ω ≈ 4, about a second. */
const TENO_RATE = 2.4;
/** Splay per metre of sideways lag, radians. */
const SPLAY_PER_METRE = 3.5;
/** Most the sideways lag may splay a finger, radians. About eight degrees. */
const SPLAY_MAX = 0.14;
/** The fingers' own spring: about 3.5 Hz, a little under critical so a stop leaves a small follow-through. */
const LAG_OMEGA = 22;
const LAG_ZETA = 0.6;

/**
 * How freely each finger is carried by the hand's motion and the wrist's bend.
 * The thumb hangs off the side of the palm and swings least; the little finger,
 * longest from the wrist's axis, most.
 */
const LAG_WEIGHT: Record<FingerName, number> = {
  thumb: 0.4,
  index: 0.8,
  middle: 1,
  ring: 1.05,
  little: 1.1,
};

/** The thumb's splay carries it across the palm, a different motion; it takes none. */
const SPLAY_WEIGHT: Record<FingerName, number> = {
  thumb: 0,
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
  /** The sideways lag this frame, in splay radians. */
  splay: number;
  /** What gravity does to the curl this frame. */
  droop: number;
  /** The wrist's flexion, followed slowly: the angle the hand's shape was last held at. */
  wrist: ScalarFollower;
  /** What the wrist's bend does to the curl this frame. */
  teno: number;
}

const mkMotion = (): HandMotion => ({
  point: new THREE.Vector3(),
  vel: new THREE.Vector3(),
  seeded: false,
  x: 0,
  splay: 0,
  droop: 0,
  wrist: new ScalarFollower(0),
  teno: 0,
});

const _pos = new THREE.Vector3();
const _off = new THREE.Vector3();
const _normal = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const _lateral = new THREE.Vector3();
const _base = new THREE.Vector3();
const _forearm = new THREE.Vector3();
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
    const elbow = this.p.bones[`lowerArm.${side}`];
    const knuckle = this.p.fingerBones[`middle.${side}`]?.[0];
    const palm = this.palmLocal[side];
    if (!(hand && elbow && knuckle && palm) || dt <= 0) return;

    knuckle.getWorldPosition(_pos);
    hand.getWorldQuaternion(_q);
    _normal.copy(palm).applyQuaternion(_q).normalize();
    // Flexion toward the palm is positive: a hand bent by θ tips its palm normal
    // back along the forearm by sin θ.
    hand.getWorldPosition(_forearm).sub(elbow.getWorldPosition(_base)).normalize();
    const flex = Math.asin(THREE.MathUtils.clamp(-_forearm.dot(_normal), -1, 1));
    const reseed = !m.seeded || dt > STALE_DT || m.point.distanceTo(_pos) > TELEPORT;
    if (reseed) {
      m.point.copy(_pos);
      m.vel.set(0, 0, 0);
      m.wrist.reset(flex);
      m.seeded = true;
    }

    // Implicit damped spring, stable at any frame length.
    const w2 = LAG_OMEGA * LAG_OMEGA;
    m.vel
      .addScaledVector(_off.copy(_pos).sub(m.point), w2 * dt)
      .divideScalar(1 + 2 * LAG_ZETA * LAG_OMEGA * dt + w2 * dt * dt);
    m.point.addScaledVector(m.vel, dt);

    const bend = flex - m.wrist.step(flex, dt, TENO_RATE);
    m.teno = TENO_MAX * Math.tanh((-TENODESIS * bend) / TENO_MAX);

    // Left on the palm side, the hand was thrown toward its back: the fingers
    // fold in after it.
    const up = _normal.dot(UP);
    m.droop = -DROOP * Math.sign(up) * Math.max(0, (Math.abs(up) - DROOP_DEAD) / (1 - DROOP_DEAD));
    _off.copy(m.point).sub(_pos);
    const lag = LAG_PER_METRE * _off.dot(_normal);
    m.x = LAG_MAX * Math.tanh(lag / LAG_MAX);

    // Across the palm, read off where the knuckles actually are this frame.
    const index = this.p.fingerBones[`index.${side}`]?.[0];
    const little = this.p.fingerBones[`little.${side}`]?.[0];
    m.splay = 0;
    if (index && little) {
      little.getWorldPosition(_lateral);
      _lateral.sub(index.getWorldPosition(_base));
      _lateral.addScaledVector(_normal, -_lateral.dot(_normal));
      if (_lateral.lengthSq() > 1e-12) {
        // Left on the little-finger side, the hand went toward the thumb: the
        // fingers fan back after it.
        const sideways = SPLAY_PER_METRE * _off.dot(_lateral.normalize());
        m.splay = SPLAY_MAX * Math.tanh(sideways / SPLAY_MAX);
      }
    }
  }

  /**
   * Splay to add to finger `f` whose blended curl is `curl`, radians.
   *
   * A closed finger has no room to fan, so this falls with the curl rather
   * than with slack: a straight finger swings sideways most freely of all.
   */
  spread(side: Side, f: FingerName, curl: number, amount: number): number {
    const free = (1 - THREE.MathUtils.clamp(curl, 0, 1)) * amount;
    return free * this._motion[side].splay * SPLAY_WEIGHT[f];
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
    const m = this._motion[side];
    return s * (drift + m.droop + (m.x + m.teno) * LAG_WEIGHT[f]);
  }
}
