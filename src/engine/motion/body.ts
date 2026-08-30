import * as THREE from 'three';
import type { Rig } from '../rig';
import type {
  ArmSlot,
  FingerName,
  GestureDef,
  GestureVariation,
  PointSpec,
  Pose,
  Profile,
  Side,
  SpineSlot,
  Vec3Tuple,
} from '../types';
import { ReachAnchors } from './anchors';
import { gestureDef } from './custom';
import { DirFollower, ScalarFollower } from './follow';
import { CharacterFrame, sideMirror } from './frame';
import { Gaze } from './gaze';
import { BASE_FINGERS, BASE_PALM, BASE_POSE, pointHand } from './gestures';
import { DEFAULT_VARIATION } from './idle';
import { CROUCH_T, type HopSpec, type JumpArc, planJump, sampleJump } from './jump';
import { aimGaze } from './look';
import { IdlePosture } from './posture';
import { ArmResolver } from './resolve';
import { FINGER_ONSET, LINK_ONSET, minJerk, onset, reachEnvelope } from './timing';

/**
 * Body layer: base pose, idle life (breathing / sway / head / gaze), and the
 * playback of built-in or loaded gesture definitions.
 *
 * Directions are authored in "character space" — x outward from the midline,
 * y up, z forward — and mirrored per side at apply time. Authoring this way
 * means a gesture written once works on either arm and on any rig, because the
 * rig resolves directions rather than local angles.
 */

const ARM_SLOTS: ArmSlot[] = ['shoulder', 'upperArm', 'lowerArm', 'hand'];
const FINGER_NAMES: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];

/**
 * Idle drift grows toward the extremity: a shoulder barely moves, a hand is
 * never still. Applying it uniformly makes the whole arm wobble as one rigid
 * piece, which is worse than not applying it at all.
 */
const DRIFT_WEIGHT: Record<ArmSlot, number> = {
  shoulder: 0.3,
  upperArm: 0.6,
  lowerArm: 1.0,
  hand: 1.5,
};

/**
 * The arms follow their composed target rather than being set to it.
 *
 * The target is not continuous and cannot be made so: switching gestures moves
 * it by a large angle in a single frame, and a gesture starting moves it fast
 * while its envelope rises. Blending between poses does not fix that — it only
 * decides *which* discontinuous target is in force. A follower does, because no
 * step in the target survives one.
 *
 * The cutoff sits above the fastest authored oscillation (`deny` swings at
 * ~1.4 Hz), so gestures keep their snap; only steps are removed. The value is a
 * direct trade: it caps the per-frame change at roughly 1-exp(-k/60) of the
 * distance to target, so 13 puts a worst-case switch near 11°/frame while
 * costing a 1.2 Hz swing about 13% of its amplitude. Fingers follow slightly
 * slower because a hand changing shape reads as one motion.
 *
 * Quoted in first-order terms, which is how they were measured; `follow.ts`
 * converts. The filter itself is second-order — see there for why.
 */
const ARM_FOLLOW = 13;
const FINGER_FOLLOW = 13;

/**
 * How fast the limb follows while a reach is carrying the wrist through the
 * room.
 *
 * The follower exists to take steps out of a target that jumps. A travelling
 * reach has no steps in it: the target is interpolated from where the wrist
 * already was, on a curve that is smooth in position, velocity and
 * acceleration. So there is nothing left for the filter to do, and what it does
 * instead is bend the path — a lag in *direction* space pulls the hand off the
 * curve it was being sent along, and the arm arrives at each frame's target one
 * pose behind, which is the one thing a travelling reach must not do.
 *
 * Not switched off outright, because the first frame of a travel can still step:
 * the elbow the search picks for the departure point need not be the one the
 * arm was holding. At four times the standing rate that resolves inside three
 * frames and the rest of the path runs where it was aimed.
 */
const TRAVEL_FOLLOW = ARM_FOLLOW * 4;

/**
 * Sides, in the order the arm loop walks them.
 */
const SIDES: readonly Side[] = ['L', 'R'];

/**
 * Seconds of lead per radian the arms have to travel.
 *
 * A gesture's authored `lead` is a floor, not the whole answer: how long the
 * arm needs depends on how far it is from where the gesture wants it, and that
 * is not knowable when the gesture is written. Raising a hand from the hip to
 * beside the face is ~100° and takes about half a second; going there from a
 * pose that already has the hand up takes almost none.
 *
 * Moving every distance in the same fixed time is one of the strongest tells
 * that something is machine-driven — people take longer over longer reaches.
 */
const LEAD_PER_RAD = 0.32;

/**
 * A fingertip aim as a caller states it: angles in **degrees**, because the
 * control API and `ctl` speak degrees. `point()` converts to the radians the
 * internal `PointSpec` is in.
 */
export interface PointCommand {
  /** Degrees, 0 straight ahead, positive to the character's right. */
  azimuth?: number;
  /** Degrees, 0 at shoulder height, positive up. */
  elevation?: number;
  /** 0..1 of full reach. */
  extent?: number;
  /** Which fingertip the coordinate refers to. */
  finger?: FingerName;
  point?: Vec3Tuple | null;
  palm?: Vec3Tuple | null;
}

/**
 * A gesture in play. Exported because the UI reads the definition's label and
 * the id straight off the live slot.
 */
export interface ActiveGesture {
  def: GestureDef;
  id: string;
  v: GestureVariation;
  time: number;
  released: boolean;
  speed: number;
  /** Seconds of entrance, this playback's own — see `LEAD_PER_RAD`. */
  lead: number;
}

/** The frame's breath and drift terms, shared by every arm slot's compose step. */
interface IdleEnv {
  br: number;
  d: number;
  armDrift: number;
  dt: number;
}

/**
 * The two halves of a gesture's envelope, kept apart rather than multiplied.
 *
 * `blend` — their product — is what the pose is worth this frame and is all
 * most of the layer needs. A reach that travels through the room needs them
 * separately: the entrance says how far along its path the hand is, and only
 * the exit may take the arm back off the pose. Multiplying first loses which of
 * the two a falling weight came from, and a reach cannot tell a hand that has
 * not set out yet from one that is being let go.
 */
interface Envelope {
  /** 0 to 1 over the lead, then held. Never falls. */
  entrance: number;
  /** 1 until the gesture is let go, then back to 0. Never rises. */
  exit: number;
}

/** What the director hands the body layer each frame. */
export interface BodyContext {
  headWorldTarget?: THREE.Vector3 | null;
}

const mkDirs = (): Record<ArmSlot, Vec3Tuple> => ({
  shoulder: [0, 0, 0],
  upperArm: [0, 0, 0],
  lowerArm: [0, 0, 0],
  hand: [0, 0, 0],
});

const mkVecs = (): Record<ArmSlot, THREE.Vector3> => ({
  shoulder: new THREE.Vector3(),
  upperArm: new THREE.Vector3(),
  lowerArm: new THREE.Vector3(),
  hand: new THREE.Vector3(),
});

const mkState = (): Record<ArmSlot, DirFollower> => ({
  shoulder: new DirFollower(BASE_POSE.shoulder),
  upperArm: new DirFollower(BASE_POSE.upperArm),
  lowerArm: new DirFollower(BASE_POSE.lowerArm),
  hand: new DirFollower(BASE_POSE.hand),
});

const mkFingerState = (): Record<FingerName, ScalarFollower> => ({
  thumb: new ScalarFollower(BASE_FINGERS.thumb),
  index: new ScalarFollower(BASE_FINGERS.index),
  middle: new ScalarFollower(BASE_FINGERS.middle),
  ring: new ScalarFollower(BASE_FINGERS.ring),
  little: new ScalarFollower(BASE_FINGERS.little),
});

const mkFingerSpread = (): Record<FingerName, number> => ({
  thumb: 0,
  index: 0,
  middle: 0,
  ring: 0,
  little: 0,
});

const mkFingerSpreadState = (): Record<FingerName, ScalarFollower> => ({
  thumb: new ScalarFollower(0),
  index: new ScalarFollower(0),
  middle: new ScalarFollower(0),
  ring: new ScalarFollower(0),
  little: new ScalarFollower(0),
});

const mkEnv = (): Envelope => ({ entrance: 0, exit: 1 });

const mkArmEnv = (): Record<ArmSlot, Envelope> => ({
  shoulder: mkEnv(),
  upperArm: mkEnv(),
  lowerArm: mkEnv(),
  hand: mkEnv(),
});

export class Body {
  rig: Rig;
  p: Profile;
  t: number;

  breathPeriod: number;
  breathDepth: number;
  idleAmount: number;
  weightShift: number;
  gazeAmount: number;
  lookAt: number;

  speaking: boolean;
  speechEnergy: number;

  gesture: ActiveGesture | null;
  blend: number;
  prev: ActiveGesture | null;
  prevBlend: number;

  hipsRest: THREE.Vector3;
  hipsUnit: number;

  jumpHeight: number;
  gravity: number;

  saccade: number;

  private _jump: JumpArc | null;
  private _jumpT: number;
  private _rise: number;
  private _load: number;

  private _gaze: Gaze;

  private _armDirs: Record<Side, Record<ArmSlot, Vec3Tuple>>;
  private _armWorld: Record<Side, Record<ArmSlot, Vec3Tuple>>;
  private _armVec: Record<Side, Record<ArmSlot, THREE.Vector3>>;
  private _armState: Record<Side, Record<ArmSlot, DirFollower>>;
  private _fingerSpec: Record<Side, Record<FingerName, number>>;
  private _fingerState: Record<Side, Record<FingerName, ScalarFollower>>;
  private _fingerSpreadSpec: Record<Side, Record<FingerName, number>>;
  private _fingerSpreadState: Record<Side, Record<FingerName, ScalarFollower>>;
  private _twist: Record<Side, ScalarFollower>;

  /**
   * The current gesture's envelope, split per arm link by its onset delay, and
   * the plain one everything else reads. Recomputed each frame; held on the
   * instance only so the arm loop and the reach resolver see the same numbers.
   */
  private _env: Envelope;
  private _armEnv: Record<ArmSlot, Envelope>;
  private _fingerEnv: Envelope;

  private _palm: Record<Side, DirFollower>;
  private _palmTarget: THREE.Vector3;
  private _palmOut: Record<Side, Vec3Tuple>;
  private _palmWorldOut: Record<Side, Vec3Tuple>;
  private _palmW: Record<Side, ScalarFollower>;

  /** The character-space to world boundary. See `frame.ts`. */
  private readonly axes: CharacterFrame;
  /** Where a reach is going, in world space. See `anchors.ts`. */
  private readonly anchors: ReachAnchors;
  /** Breathing, weight, drift — what a standing body does. See `posture.ts`. */
  private readonly _posture = new IdlePosture();
  /** What one arm of a pose actually asks for. See `resolve.ts`. */
  private readonly _arm: ArmResolver;

  /** Joint strain from the last fingertip solve, per arm. */
  get pointStrain(): Record<Side, number> {
    return this._arm.pointStrain;
  }

  constructor(rig: Rig, profile: Profile) {
    this.rig = rig;
    this.p = profile;
    this.axes = new CharacterFrame(rig, profile);
    this.anchors = new ReachAnchors(profile, rig, this.axes);
    this._arm = new ArmResolver(profile, rig, this.axes, this.anchors);
    this.t = 0;

    this.breathPeriod = 4.2;
    this.breathDepth = 1;
    this.idleAmount = 1; // head micro-motion, posture drift, arm drift
    this.weightShift = 1; // slow lateral shift of the standing weight
    this.gazeAmount = 1; // saccades layered on top of camera tracking
    this.lookAt = 1; // 0 = straight ahead, 1 = track the camera

    // Set per frame by the director from the mouth layer.
    this.speaking = false;
    this.speechEnergy = 0;

    // Two gesture slots. The second holds whatever is on its way out, so a
    // switch crossfades instead of cutting.
    this.gesture = null;
    this.blend = 0;
    this.prev = null;
    this.prevBlend = 0;

    const hips = profile.bones.hips;
    this.hipsRest = hips ? hips.position.clone() : new THREE.Vector3();

    /**
     * Local units per metre at the hips.
     *
     * The weight shift below is the one place in the runtime that writes a bone
     * *translation* rather than a rotation, and a translation is in the parent's
     * units. Rotations are radians and are the same number on any rig, which is
     * why nothing else has needed this — and why the omission was invisible.
     *
     * One of these avatars is authored in centimetres under a 0.01 scale at the
     * armature (the same fact `profile/bones.ts` records for the arm lengths),
     * so a figure written as 12 mm landed as 0.12 mm and the hips did not move
     * at all. The other is authored in metres and behaved as written, which is
     * exactly the shape of bug that survives being looked at on one avatar.
     */
    this.hipsUnit = 1;
    if (hips?.parent) {
      profile.root.updateMatrixWorld(true);
      const scale = hips.parent.getWorldScale(new THREE.Vector3()).x;
      if (scale > 1e-6) this.hipsUnit = 1 / scale;
    }

    // --- jump ---------------------------------------------------------------
    // Metres the hips rise at the apex, and the gravity the arc is solved under.
    // Real gravity gives a real arc; lowering it keeps the same height and makes
    // the character hang at the top, which is a look and not an error.
    this.jumpHeight = 0.08;
    this.gravity = 9.81;
    this._jump = null;
    this._jumpT = 0;
    this._rise = 0; // hips above rest this frame, metres
    this._load = 0; // 0..1, how far into the dip the body is

    // Gaze wanders and snaps back rather than staring; `saccade` carries the
    // amplitude on the frame a new fixation starts so the director can blink
    // with it.
    this._gaze = new Gaze();
    this.saccade = 0;

    // Pre-allocated per side and slot. This runs every frame for hours at a
    // time, and steady garbage shows up as dropped frames long before it shows
    // up as memory.
    this._armDirs = { L: mkDirs(), R: mkDirs() };
    this._armWorld = { L: mkDirs(), R: mkDirs() };
    this._armVec = { L: mkVecs(), R: mkVecs() }; // composed target for this frame
    this._armState = { L: mkState(), R: mkState() }; // what the arm is actually doing
    this._fingerSpec = { L: { ...BASE_FINGERS }, R: { ...BASE_FINGERS } };
    this._fingerState = {
      L: mkFingerState(),
      R: mkFingerState(),
    };
    this._fingerSpreadSpec = { L: mkFingerSpread(), R: mkFingerSpread() };
    this._fingerSpreadState = { L: mkFingerSpreadState(), R: mkFingerSpreadState() };
    this._twist = { L: new ScalarFollower(0), R: new ScalarFollower(0) };

    this._env = mkEnv();
    this._armEnv = mkArmEnv();
    this._fingerEnv = mkEnv();

    this._palm = { L: new DirFollower(BASE_PALM), R: new DirFollower(BASE_PALM) };
    this._palmTarget = new THREE.Vector3();
    this._palmOut = { L: [0, 0, 0], R: [0, 0, 0] };
    this._palmWorldOut = { L: [0, 0, 0], R: [0, 0, 0] };
    // How strongly the palm target is honoured. A weight on a constraint rather
    // than something with a trajectory, so it is clamped where it is read: a
    // filter with momentum can undershoot past zero, and a negative weight
    // does not mean "less constrained", it means the palm faces backwards.
    this._palmW = { L: new ScalarFollower(1), R: new ScalarFollower(1) };
  }

  /**
   * Blend one arm slot's direction for this frame and write it into `_armDirs`.
   *
   * `pDir`/`cDir` are the outgoing and incoming gesture's directions for this
   * slot, either of which may be absent. `pw`/`cw` are what each is worth this
   * frame — per slot rather than per gesture, because the links of a limb do
   * not start together.
   */
  private composeArmDir(
    slot: ArmSlot,
    side: Side,
    env: IdleEnv,
    pDir: THREE.Vector3 | undefined,
    cDir: THREE.Vector3 | undefined,
    pw: number,
    cw: number,
    rate = ARM_FOLLOW,
  ): Vec3Tuple {
    const v = this._armVec[side][slot].copy(BASE_POSE[slot]);
    // Outgoing first, then incoming: the incoming gesture takes over as its
    // blend rises, and the two never both sit at full weight.
    if (pDir) v.lerp(pDir, pw).normalize();
    if (cDir) v.lerp(cDir, cw).normalize();

    // Breathing and idle drift are added *after* the gesture blend, not before
    // it. Folding them into the base pose means a gesture at full strength
    // lerps them away and the arms go dead mid-motion — a hand held in a pose
    // is still attached to someone who is breathing.
    v.y += (slot === 'shoulder' ? 0.022 : 0.014) * env.d * env.br;

    const ph = side === 'L' ? 0 : 1.9;
    const w = env.armDrift * DRIFT_WEIGHT[slot];
    v.y += w * Math.sin(this.t * 0.27 + ph);
    v.z += w * 0.8 * Math.sin(this.t * 0.19 + ph + 0.6);
    v.x += w * 0.5 * Math.sin(this.t * 0.23 + ph + 1.3);
    v.normalize();

    // Follow the target instead of snapping to it. See ARM_FOLLOW.
    const s = this._armState[side][slot].step(v, env.dt, rate);
    const out = this._armDirs[side][slot];
    // Keep the follower output in character space. It is projected into world
    // space only at the Rig boundary, after the spine has been committed.
    out[0] = s.x;
    out[1] = s.y;
    out[2] = s.z;
    return out;
  }

  /**
   * Aim a fingertip, and hold it there.
   *
   * Built as a gesture rather than as a separate channel. A pointing arm has to
   * crossfade with a wave, take a lead time proportional to how far it travels,
   * hold until released and give way to the next gesture — all of which the
   * gesture slot already does, and none of which is worth a second
   * implementation that would drift out of step with the first.
   *
   *   side       "L" | "R"
   *   azimuth    degrees, 0 straight ahead, positive to the character's right
   *   elevation  degrees, 0 at shoulder height, positive up
   *   extent     0..1 of full reach
   *   finger     which fingertip the coordinate refers to
   *
   * The angles arrive in degrees because that is what the control API and `ctl`
   * state them in, and are converted here: the `PointSpec` everything below
   * this line reads is radians.
   *
   * The torso helps, as it does in life: past about 40 degrees off the midline
   * an arm alone cannot get there comfortably and the chest turns into it. That
   * is stated here rather than in the solver because it has to reach the spine
   * before the frame's spine offsets are committed, and the arms are solved
   * after that.
   */
  point(side: Side, spec: PointCommand = {}): void {
    const D = Math.PI / 180;
    const az = (spec.azimuth ?? 0) * D;
    const el = (spec.elevation ?? 0) * D;
    const extent = THREE.MathUtils.clamp(spec.extent ?? 0.8, 0.1, 1);
    const finger = spec.finger ?? 'index';
    const at: PointSpec = {
      azimuth: az,
      elevation: el,
      extent,
      mirror: false,
      finger,
      point: spec.point ?? null,
      palm: spec.palm ?? null,
    };
    // Shaped for the finger that was asked for, not for the index. The solver
    // reads the fingertip's position off this curl, so a hand shaped to point
    // with the wrong finger aims one that is folded into the palm — and the
    // whole arm then travels to put that knuckle where the target is. Built
    // once here rather than inside `build`, which runs every frame.
    const hand = pointHand(finger);
    // Scaled by extent: turning the chest toward something the hand is not
    // actually reaching for reads as the whole character swivelling.
    const turn = az * 0.22 * extent;
    const lean = -Math.max(0, el) * 0.1 * extent;
    const def: GestureDef = {
      label: { en: 'Pointing', ja: '指し示す' },
      group: 'explain',
      lead: 0.3,
      hold: 1.6,
      sustain: true,
      build: () => ({
        point: { [side]: at },
        fingers: { [side]: hand },
        spine: {
          chest: [lean * 0.6, turn * 0.6, 0],
          spine: [lean * 0.4, turn * 0.4, 0],
        },
      }),
    };
    this.playDef(def, `point.${side}`);
  }

  play(id: string, side?: Side): void {
    const def = gestureDef(id);
    if (!def) return;
    this.playDef(def, id, side);
  }

  /**
   * Start a gesture from a definition object, named or synthesised.
   *
   * `side` pins the mirror axis the variation would otherwise pick at random —
   * which hand a one-handed gesture acts with, and which way the head turns on
   * the rest. A loaded motion states its own hands and ignores it; see
   * `compileMotion`.
   */
  playDef(def: GestureDef, id: string, side?: Side): void {
    if (!def) return;
    // Hand the outgoing gesture to the second slot so it fades out while the
    // new one fades in. Dropping it outright leaves the standing blend weight
    // pointing at a completely different pose, and the arms teleport on the
    // switch frame — the most visible artefact this layer had.
    if (this.gesture && this.blend > 0.02) {
      this.prev = this.gesture;
      this.prevBlend = this.blend;
    } else {
      this.prev = null;
      this.prevBlend = 0;
    }
    const v: GestureVariation = {
      // Frequency and amplitude, never phase: `build` is called from t=0 and a
      // phase offset would put every oscillation mid-swing on frame one, which
      // snaps the limb into the gesture instead of easing it in.
      rate: 0.92 + Math.random() * 0.16,
      scale: 0.9 + Math.random() * 0.2,
      // Random unless the caller named a hand. Left random on purpose when it
      // did not: a character that greets with the same arm every single time
      // reads as a mechanism, and the table was authored so that either hand
      // works. What a caller pins is a hand it has a reason for — the one away
      // from the slide, the one it used on the line before.
      side: side === undefined ? (Math.random() < 0.5 ? -1 : 1) : sideMirror(side),
    };
    this.gesture = {
      def,
      id,
      v,
      time: 0,
      released: false,
      speed: 0.93 + Math.random() * 0.14,
      // Capped: past about a second an entrance stops reading as deliberate and
      // starts reading as slow, however far the arm has to go.
      lead: Math.min(0.95, Math.max(def.lead, this.travel(def, v) * LEAD_PER_RAD)),
    };
    this.blend = 0;
    this._env.entrance = 0;
    this._env.exit = 1;
    for (const slot of ARM_SLOTS) {
      this._armEnv[slot].entrance = 0;
      this._armEnv[slot].exit = 1;
    }
    this._fingerEnv.entrance = 0;
    this._fingerEnv.exit = 1;
    this._arm.mark();
  }

  /** Largest angle any arm has to cover to reach the gesture's opening pose. */
  private travel(def: GestureDef, v: GestureVariation): number {
    const pose = def.build(0, v);
    let worst = 0;
    for (const side of ['L', 'R'] as const) {
      const mirror = sideMirror(side);
      const arm = this._arm.resolve(pose, side, mirror, 'cur', 1);
      if (!arm) continue;
      for (const slot of ARM_SLOTS) {
        const dir = arm[slot];
        if (!dir) continue;
        worst = Math.max(worst, this._armState[side][slot].dir.angleTo(dir));
      }
    }
    return worst;
  }

  /** Release the current gesture, including a sustained pose. */
  stopGesture(): void {
    if (!this.gesture) return;
    this.gesture.released = true;
    const { def, lead } = this.gesture;
    this.gesture.time = Math.max(this.gesture.time, lead + def.hold);
  }

  /**
   * Start a run of hops. The arc it runs is `planJump`'s, and a run of more
   * than one is continuous — see there for why it needs no gap between them.
   */
  hop({ height = this.jumpHeight, count = 1 }: Partial<HopSpec> = {}): void {
    this._jump = planJump(height, this.gravity, count);
    this._jumpT = 0;
  }

  /** Finish the current hop, dropping any later cycles from a run. */
  finishHop(): void {
    const jump = this._jump;
    if (!jump) return;
    const cycle = jump.push + jump.flight + jump.brake;
    const elapsed = Math.max(0, this._jumpT - CROUCH_T);
    const current = Math.min(jump.count, Math.floor(elapsed / cycle) + 1);
    jump.count = current;
  }

  /** Whether a hop is in flight. Read by the panel. */
  get jumping(): boolean {
    return this._jump !== null;
  }

  /**
   * Advance the hop, leaving the hips' rise and the body's compression in
   * `_rise` and `_load`. Both are zero on every frame that is not part of one.
   */
  private jumpStep(dt: number): void {
    this._rise = 0;
    this._load = 0;
    const j = this._jump;
    if (!j) return;

    this._jumpT += dt;
    const s = sampleJump(j, this._jumpT);
    if (s.done) {
      this._jump = null;
      return;
    }
    this._rise = s.rise;
    this._load = s.load;
  }

  /** Current gaze offset in radians, x = yaw, y = pitch. */
  get gaze(): THREE.Vector2 {
    return this._gaze.offset;
  }

  /** Breathing phase, 0..1, exposed so the UI can show it. */
  get breath(): number {
    return this._posture.breath;
  }

  /** Advance one gesture slot and return its pose. */
  private advance(slot: ActiveGesture, dt: number): Pose {
    slot.time += dt;
    return slot.def.build(slot.time * slot.speed, slot.v);
  }

  update(dt: number, { headWorldTarget = null }: BodyContext = {}): void {
    this.t += dt;
    const { rig, p } = this;
    // The rig's anatomical limiter is the one thing below this line with a
    // speed of its own — see `Rig.slew` — and this is where it learns the frame.
    rig.dt = dt;

    // --- gesture envelopes ------------------------------------------------
    let g: Pose | null = null;
    const variation = this.gesture?.v ?? DEFAULT_VARIATION;
    if (this.gesture) {
      const { def, lead } = this.gesture;
      const t = this.gesture.time + dt;
      const out = lead * 1.25;
      // A sustained pose holds at full weight until it is released.
      const held = def.sustain && !this.gesture.released;
      // Eased in and out. A linear ramp starts and stops with a visible corner,
      // which is exactly the frame the eye picks up as machine-driven.
      //
      // The two phases are computed apart and multiplied at the end rather than
      // being decided between: only one of them is ever off 1, so the product
      // is the same number the branch used to produce, and a reach can ask
      // which of the two a weight below 1 came from. See `Envelope`.
      const xIn = lead > 0 ? Math.min(1, t / lead) : 1;
      const xOut = held || t < lead + def.hold ? 1 : Math.max(0, 1 - (t - lead - def.hold) / out);
      this._env.entrance = minJerk(xIn);
      this._env.exit = minJerk(xOut);

      // Per link, staggered outward along the limb and allowed to overshoot.
      for (const slot of ARM_SLOTS) {
        const e = this._armEnv[slot];
        e.entrance = reachEnvelope(onset(xIn, LINK_ONSET[slot]));
        e.exit = this._env.exit;
      }
      // No overshoot on a curl: a finger that opens past straight to settle
      // back is a joint bending the wrong way, not a limb carrying momentum.
      this._fingerEnv.entrance = minJerk(onset(xIn, FINGER_ONSET));
      this._fingerEnv.exit = this._env.exit;

      // The envelope *is* the weight, with nothing chasing it. It is already
      // zero-velocity and zero-acceleration at both ends, so a lag on top adds
      // nothing but lateness and an exponential tail that never quite arrives —
      // and that tail was most of what made a finished gesture read as still
      // settling into itself.
      const target = this._env.entrance * this._env.exit * variation.scale;
      this.blend = target;
      // Built from t=0, not from t-lead. Freezing the pose through the lead and
      // only starting the motion afterwards makes the gesture appear to begin
      // twice: once as the blend rises, again as the motion kicks in.
      g = this.advance(this.gesture, dt);
      if (target === 0 && this.blend < 0.01) {
        this.gesture = null;
        this.blend = 0;
        g = null;
      }
    } else if (this.blend > 0) {
      this.blend *= Math.exp(-dt * 10);
    }

    let gPrev: Pose | null = null;
    if (this.prev) {
      this.prevBlend *= Math.exp(-dt * 6);
      if (this.prevBlend < 0.01) {
        this.prev = null;
        this.prevBlend = 0;
      }
      // The outgoing gesture keeps moving while it fades. Dissolving a frozen
      // pose looks different from a gesture being abandoned partway through,
      // and the second is what actually happened.
      else gPrev = this.advance(this.prev, dt);
    }

    // Everything a standing body does on its own — breathing, the weight
    // shift, the hop's fold through the trunk, the head's drift. See
    // `posture.ts`. The hop is advanced first because the fold reads its
    // output; nothing about it touches the rig.
    this.jumpStep(dt);
    const { br, d } = this._posture.apply(rig, p, dt, {
      t: this.t,
      speaking: this.speaking,
      speechEnergy: this.speechEnergy,
      breathPeriod: this.breathPeriod,
      breathDepth: this.breathDepth,
      weightShift: this.weightShift,
      idleAmount: this.idleAmount,
      hipsRest: this.hipsRest,
      hipsUnit: this.hipsUnit,
      jumpHeight: this.jumpHeight,
      rise: this._rise,
      load: this._load,
    });
    const idle = this.idleAmount;
    // Both gesture slots contribute to the spine; the outgoing one is fading.
    if (gPrev?.spine) {
      for (const [slot, o] of Object.entries(gPrev.spine) as Array<[SpineSlot, Vec3Tuple]>) {
        rig.addOffset(slot, o[0] * this.prevBlend, o[1] * this.prevBlend, o[2] * this.prevBlend);
      }
    }
    if (g?.spine) {
      for (const [slot, o] of Object.entries(g.spine) as Array<[SpineSlot, Vec3Tuple]>) {
        rig.addOffset(slot, o[0] * this.blend, o[1] * this.blend, o[2] * this.blend);
      }
    }

    // --- gaze -------------------------------------------------------------
    this._gaze.update(dt, this.t);
    this.saccade = this._gaze.saccade;
    aimGaze(
      rig,
      p,
      this._gaze,
      { lookAt: this.lookAt, gazeAmount: this.gazeAmount },
      headWorldTarget,
    );

    rig.commitSpine();
    // Spine offsets change the body frame. Resolve it once here, after commit,
    // so every direction sent to Rig in this frame uses the same live basis.
    const frameReady = rig.anat.update();

    // --- arms -------------------------------------------------------------
    const armDrift = 0.016 * idle;
    const env: IdleEnv = { br, d, armDrift, dt };
    const scale = variation.scale;

    /**
     * What the current gesture is worth for one channel this frame.
     *
     * Per channel rather than one number for the whole gesture, because the
     * links of a limb do not start together — `this.blend` is what the same
     * expression gives for a channel with no onset delay of its own.
     */
    const plain = (e: Envelope): number => e.entrance * e.exit * scale;

    for (const side of SIDES) {
      const mirror = sideMirror(side);
      const dirs = this._armDirs[side];
      const worldDirs = this._armWorld[side];
      // Set by `resolveArm` below, for this frame only: whether the current
      // gesture is carrying this hand through the room rather than posing it.
      this._arm.clearTravelling(side);

      // The shoulder is posed before the arm is solved, not with it. A reach
      // starts from the upper arm's world position, and posing the shoulder
      // moves that position — by a quarter of an interpupillary distance on
      // this rig. Solving first and posing after leaves every reach short by
      // exactly that, permanently: the shoulder is back at its rest orientation
      // by the time the next frame solves, so there is nothing to converge on.
      // Only authored directions are read here; a reach never states a shoulder.
      const es = this._armEnv.shoulder;
      this.composeArmDir(
        'shoulder',
        side,
        env,
        gPrev?.arms?.[side]?.shoulder,
        g?.arms?.[side]?.shoulder,
        this.prevBlend,
        plain(es),
      );

      // Give the girdle its say before the shoulder is posed. Only for a reach,
      // and only where the pose has no shoulder of its own to state — a gesture
      // that says where the shoulder goes means it.
      const gr = g?.reach?.[side];
      if (gr && !g?.arms?.[side]?.shoulder) {
        const gt = this.anchors.target(gr, side, frameReady);
        this.axes.tupleToWorld(worldDirs.shoulder, dirs.shoulder, side, mirror, frameReady);
        if (gt) rig.girdleRoom(side, gt, worldDirs.shoulder, this.blend);
      } else {
        this.axes.tupleToWorld(worldDirs.shoulder, dirs.shoulder, side, mirror, frameReady);
      }
      rig.aimShoulder(side, worldDirs.shoulder);

      const pArm = this._arm.resolve(
        gPrev,
        side,
        mirror,
        'prev',
        this._armEnv.hand.entrance,
        false,
        frameReady,
      );
      const cArm = this._arm.resolve(
        g,
        side,
        mirror,
        'cur',
        this._armEnv.hand.entrance,
        true,
        frameReady,
      );

      /**
       * A link is *carried* when a travelling reach is deciding where it goes,
       * and blended when a pose is.
       *
       * Only the two links that decide where the wrist *is*. The hand's own
       * direction is stated by the pose rather than solved from the target, so
       * there is nothing about it the interpolated point has already eased —
       * carrying it would put the wrist at the gesture's angle while the arm is
       * still down by the hip, which is a request no wrist has the range for.
       * It rides the staggered envelope with the palm and the twist instead.
       *
       * A carried link takes the incoming pose at full weight, because the
       * entrance is already in the target: applying it twice would ease the arm
       * toward a point that is itself still easing, and the hand would leave
       * late and creep the last part of the way. Only the exit may take it back
       * off. The amplitude variation goes too — a travel ends on an anchor that
       * is a point on the body, and scaling a contact by 0.92 is a hand that
       * stops short of the cheek it was reaching for. Variation belongs to the
       * oscillations a gesture writes on top, and they still carry it.
       *
       * The outgoing gesture drops out entirely for the same reason: the travel
       * departs from where the wrist actually was, which already includes
       * whatever the outgoing pose was contributing. Crossfading it back in on
       * top would count it twice.
       */
      const travelling = this._arm.travelling(side);

      for (const slot of ARM_SLOTS) {
        if (slot === 'shoulder') continue;
        const carried = travelling && slot !== 'hand';
        this.composeArmDir(
          slot,
          side,
          env,
          pArm?.[slot],
          cArm?.[slot],
          carried ? 0 : this.prevBlend,
          carried ? this._armEnv[slot].exit : plain(this._armEnv[slot]),
          carried ? TRAVEL_FOLLOW : ARM_FOLLOW,
        );
        this.axes.tupleToWorld(worldDirs[slot], dirs[slot], side, mirror, frameReady);
      }

      // The wrist's own channels ride the hand link's envelope: a palm roll and
      // a forearm twist are part of the hand arriving, not of the arm setting
      // out, and starting them with the shoulder is what made a hand appear to
      // present itself before it had gone anywhere.
      //
      // Not travel-aware, unlike the limb directions above. A palm and a twist
      // are stated by the pose rather than solved from the target, so there is
      // nothing about them that the interpolated target has already eased —
      // taking them at full weight from the first frame would be a step. They
      // arrive late instead, which is what a wrist does.
      const cw = plain(this._armEnv.hand);
      const twistTarget = (pArm?.twist ?? 0) * this.prevBlend + (cArm?.twist ?? 0) * cw;
      this._twist[side].step(twistTarget, dt, ARM_FOLLOW);

      // Palm direction blends and follows like the limb directions do.
      const pt = this._palmTarget.copy(BASE_PALM);
      if (pArm?.palm) pt.lerp(pArm.palm, this.prevBlend).normalize();
      if (cArm?.palm) pt.lerp(cArm.palm, cw).normalize();
      const ps = this._palm[side].step(pt, dt, ARM_FOLLOW);
      const po = this._palmOut[side];
      // Palm state follows the same canonical frame as the arm directions.
      po[0] = ps.x;
      po[1] = ps.y;
      po[2] = ps.z;
      const palmWorld = this.axes.tupleToWorld(
        this._palmWorldOut[side],
        po,
        side,
        mirror,
        frameReady,
      );

      // BASE_PALM describes an arm hanging at the side, and only that. A pose
      // that raises the hand and states no palm of its own must not be held to
      // it — keeping a lifted hand rolled as though it were still by the hip
      // demands most of a half turn, which is where the wrist collapsed. Such a
      // pose releases the constraint as it blends in and the roll falls back to
      // whatever the aim itself produces.
      let hold = 1;
      if (pArm && !pArm.palm) hold -= this.prevBlend;
      if (cArm && !cArm.palm) hold -= cw;
      const palmW = Math.max(0, this._palmW[side].step(Math.max(0, hold), dt, ARM_FOLLOW));

      rig.aimArm(
        side,
        worldDirs,
        this._twist[side].value * this.axes.axialMirror(side, frameReady),
        palmWorld,
        palmW,
      );

      const pf = gPrev?.fingers?.[side];
      const cf = g?.fingers?.[side];
      const pfSpread = gPrev?.fingerSpread?.[side];
      const cfSpread = g?.fingerSpread?.[side];
      const spec = this._fingerSpec[side];
      const spread = this._fingerSpreadSpec[side];
      const fw = plain(this._fingerEnv);
      for (const f of FINGER_NAMES) {
        let val = BASE_FINGERS[f];
        const pv = pf?.[f];
        const cv = cf?.[f];
        if (pv !== undefined) val += (pv - val) * this.prevBlend;
        if (cv !== undefined) val += (cv - val) * fw;
        spec[f] = this._fingerState[side][f].step(val, dt, FINGER_FOLLOW);

        let spreadVal = 0;
        const pvSpread = pfSpread?.[f];
        const cvSpread = cfSpread?.[f];
        if (pvSpread !== undefined) spreadVal += pvSpread * this.prevBlend;
        if (cvSpread !== undefined) spreadVal += (cvSpread - spreadVal) * fw;
        spread[f] = this._fingerSpreadState[side][f].step(spreadVal, dt, FINGER_FOLLOW);
      }
      rig.curlHand(side, spec, spread);
    }
  }
}
