import * as THREE from 'three';
import type { FingerName, Profile, Side } from '../types';
import { FINGER_NAMES } from '../types';
import { ScalarFollower } from './follow';

/**
 * What a hand does on top of the shape a pose gives it.
 *
 * A pose authors a hand as a constant, and held constant through a gesture it
 * reads as a mitten on a moving arm. Terms added after the blend, the way the
 * arm's idle drift is:
 * - drift and breath: slow per-finger wander, and a slight opening on the inhale;
 * - lag: fingers trail the hand that carries them, curling when it is thrown
 *   toward its back and fanning across the palm when it swings sideways;
 * - droop: palm up they fall open a little, palm down they fall in;
 * - tenodesis: a wrist bending back pulls them in, toward the palm lets them
 *   open — the change only, since each pose's shape was tuned at its own wrist.
 *
 * All of these scale with how slack the finger is: one held straight to point or
 * closed into a fist is held there on purpose, and the pointing solver reads its
 * fingertip off that curl. Enslaving is the exception — a finger moving alone
 * drags its neighbours part of the way whatever their curl, and lets them go once
 * it arrives.
 */

/** Curl the idle drift can add either way, at full slack. About five degrees at the knuckle. */
const DRIFT = 0.05;
/**
 * Curl a full breath takes off a slack hand on the inhale and gives back on the
 * exhale, about two degrees: the arms already rise with the chest, and a hand
 * that alone keeps still reads as held.
 */
const BREATH = 0.02;

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
/** Direct callers' large steps reseed; the viewer caps dt at 0.05, so this cannot detect its resumes. */
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
const LAG_REFERENCE_DT = 1 / 50;
const LAG_W2 = LAG_OMEGA * LAG_OMEGA;
const LAG_A = LAG_ZETA * LAG_OMEGA;
const LAG_B = LAG_OMEGA * Math.sqrt(1 - LAG_ZETA * LAG_ZETA);
const LAG_LOG_D = Math.log(
  1 + 2 * LAG_A * LAG_REFERENCE_DT + LAG_W2 * LAG_REFERENCE_DT * LAG_REFERENCE_DT,
);
const LAG_THETA = Math.atan2(LAG_B * LAG_REFERENCE_DT, 1 + LAG_A * LAG_REFERENCE_DT);

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

/**
 * How far finger f is carried when finger g moves without it, as a fraction of
 * g's travel. Half the involuntary motion measured in Häger-Ross & Schieber,
 * J Neurosci 20 (2000): a performed hand is cleaner than a tested one.
 */
const ENSLAVE: Record<FingerName, Partial<Record<FingerName, number>>> = {
  thumb: {},
  index: { middle: 0.1, ring: 0.05 },
  middle: { index: 0.12, ring: 0.2, little: 0.08 },
  ring: { index: 0.05, middle: 0.2, little: 0.25 },
  little: { middle: 0.08, ring: 0.22 },
};

/** 1 for a half-closed finger, 0 for one straight or fully closed. */
const slack = (v: number): number => {
  const c = THREE.MathUtils.clamp(v, 0, 1);
  return 4 * c * (1 - c);
};

interface HandMotion {
  /** The lagging point, world space. */
  point: THREE.Vector3;
  /** Carried filter state: the old discrete velocity, not the interpolated point's derivative. */
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

/** Actual geometry from the last displayed arm/finger frame. */
export interface HandSensePose {
  readonly knuckle: THREE.Vector3;
  readonly palm: THREE.Vector3;
  readonly forearm: THREE.Vector3;
  readonly index: THREE.Vector3 | null;
  readonly little: THREE.Vector3 | null;
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
const _pending: Record<FingerName, number> = { thumb: 0, index: 0, middle: 0, ring: 0, little: 0 };
const _q = new THREE.Quaternion();

export class FingerLife {
  private readonly _motion: Record<Side, HandMotion> = { L: mkMotion(), R: mkMotion() };
  private readonly _shadow: Partial<Record<Side, Record<FingerName, ScalarFollower>>> = {};

  constructor(
    private readonly p: Profile,
    private readonly palmLocal: Partial<Record<Side, THREE.Vector3>>,
  ) {}

  /**
   * Read the posed hand and advance its lag. Call once per side per frame,
   * after the arm is aimed and before the fingers are curled.
   */
  sense(side: Side, dt: number, pose?: HandSensePose | null): void {
    const m = this._motion[side];
    if (pose === null) return;
    const hand = this.p.bones[`hand.${side}`];
    const elbow = this.p.bones[`lowerArm.${side}`];
    const knuckle = this.p.fingerBones[`middle.${side}`]?.[0];
    const palm = this.palmLocal[side];
    if (dt <= 0) return;
    if (pose) {
      _pos.copy(pose.knuckle);
      _normal.copy(pose.palm).normalize();
      _forearm.copy(pose.forearm).normalize();
    } else {
      if (!(hand && elbow && knuckle && palm)) return;
      knuckle.getWorldPosition(_pos);
      hand.getWorldQuaternion(_q);
      _normal.copy(palm).applyQuaternion(_q).normalize();
      hand.getWorldPosition(_forearm).sub(elbow.getWorldPosition(_base)).normalize();
    }
    // Flexion toward the palm is positive: a hand bent by θ tips its palm normal
    // back along the forearm by sin θ.
    const flex = Math.asin(THREE.MathUtils.clamp(-_forearm.dot(_normal), -1, 1));
    const reseed = !m.seeded || dt > STALE_DT || m.point.distanceTo(_pos) > TELEPORT;
    if (reseed) {
      m.point.copy(_pos);
      m.vel.set(0, 0, 0);
      m.wrist.reset(flex);
      m.seeded = true;
    }

    // Fractional powers of the old implicit transition preserve its damping at
    // any Hz, using 50 Hz as the measured reference. This still needs a render check.
    const r = dt / LAG_REFERENCE_DT;
    const decay = Math.exp(-0.5 * LAG_LOG_D * r);
    const c = Math.cos(LAG_THETA * r);
    const s = Math.sin(LAG_THETA * r) / LAG_B;
    _off.subVectors(m.point, _pos);
    m.point
      .copy(_pos)
      .addScaledVector(_off, decay * (c + LAG_A * s))
      .addScaledVector(m.vel, decay * s);
    m.vel.multiplyScalar(decay * (c - LAG_A * s)).addScaledVector(_off, -decay * LAG_W2 * s);

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
    if ((pose && pose.index && pose.little) || (!pose && index && little)) {
      if (pose?.index && pose.little) {
        _lateral.subVectors(pose.little, pose.index);
      } else if (index && little) {
        little.getWorldPosition(_lateral);
        _lateral.sub(index.getWorldPosition(_base));
      }
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
   * character idling. `breath` is the breath curve times its depth, -1 to 1.
   * `amount` scales all of it, for a hand whose fingers are not free to move
   * on their own.
   */
  offset(
    side: Side,
    f: FingerName,
    curl: number,
    t: number,
    idle: number,
    breath: number,
    amount: number,
  ): number {
    const s = slack(curl) * amount;
    if (s <= 0) return 0;
    const i = FINGER_NAMES.indexOf(f);
    // Neighbouring fingers drift near but not in step; a hand whose fingers
    // move together reads as one part flexing.
    const ph = i * 0.7 + (side === 'L' ? 0 : 2.3);
    const drift =
      (DRIFT * idle * (Math.sin(t * 0.7 + ph) + 0.5 * Math.sin(t * 1.3 + 1.7 * ph))) / 1.5;
    const m = this._motion[side];
    return s * (drift - BREATH * breath + m.droop + (m.x + m.teno) * LAG_WEIGHT[f]);
  }

  /**
   * Bend each finger's `target` toward its neighbours' remaining travel, in
   * place. Only the difference carries: a hand closing as a whole drags
   * nothing, and once every finger has arrived the targets are untouched.
   *
   * Travel is read off a shadow of the fingers that follows the uncoupled
   * targets. Read off the coupled fingers themselves it feeds back, and the
   * loop leaves a mode that settles several times slower than the follower.
   */
  enslave(
    side: Side,
    target: Record<FingerName, number>,
    dt: number,
    rate: (f: FingerName) => number,
    amount: number,
  ): void {
    let shadow = this._shadow[side];
    if (!shadow) {
      shadow = {
        thumb: new ScalarFollower(target.thumb),
        index: new ScalarFollower(target.index),
        middle: new ScalarFollower(target.middle),
        ring: new ScalarFollower(target.ring),
        little: new ScalarFollower(target.little),
      };
      this._shadow[side] = shadow;
    }
    for (const f of FINGER_NAMES) _pending[f] = target[f] - shadow[f].step(target[f], dt, rate(f));
    if (amount <= 0) return;
    for (const f of FINGER_NAMES) {
      let c = 0;
      for (const g of FINGER_NAMES) c += (ENSLAVE[f][g] ?? 0) * (_pending[g] - _pending[f]);
      // Dragged, never past the free range: curl 1 is the top of it.
      target[f] = THREE.MathUtils.clamp(target[f] + amount * c, 0, 1);
    }
  }
}
