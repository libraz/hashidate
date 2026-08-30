import * as THREE from 'three';
import type { Localized } from '../../i18n/locale';
import type {
  ArmDirections,
  ArmSlot,
  FingerName,
  FingerSpec,
  GestureDef,
  GestureGroup,
  GestureVariation,
  Pose,
  Side,
  SpineOffsets,
  SpineSlot,
  Vec3Tuple,
} from '../types';
import { GESTURES, isBuiltInGestureName } from './gestures';

/**
 * Motions an operator wrote, on top of the gesture table this project ships.
 *
 * ## Why this is a second, poorer format rather than the same one
 *
 * A built-in gesture is a function of time: `wave` is a sine whose amplitude
 * decays because a wave held at constant amplitude for three seconds is a
 * metronome, `nod` is a damped oscillation because one beat reads as a twitch.
 * Those are not values anybody types into a file — they were arrived at by
 * watching a render, and the comments beside them say which failure each number
 * exists to prevent.
 *
 * So this format is keyframes, which is what a person editing a text file can
 * actually control: poses at times, interpolated between. It expresses less
 * than `build` does and is meant to. The built-in table is not migrated to it
 * and must not be — a keyframed `nod` is a nod with the tuning taken out.
 *
 * ## Directions and offsets only
 *
 * `arms`, `fingers` and `spine`, and deliberately not `reach` or `point`. Those
 * two are solved against one avatar's measured proportions, and an authored
 * reach that misses does not look approximate — it puts the hand inside the
 * face. The built-in table has the notes that make them authorable; a file
 * dropped in a directory does not. Getting a direction wrong costs an arm at an
 * odd angle, which is a thing you can see and fix.
 *
 * ## Nothing here can replace a built-in
 *
 * An id already in `GESTURES` is refused rather than shadowing it. What the
 * performance table names has to keep meaning what it meant, or a script
 * written against this runtime does something different on the machine next to
 * it.
 */

/** One arm in a keyframe. Character space, exactly as `ArmDirections` is. */
export interface MotionArm {
  shoulder?: Vec3Tuple;
  upperArm?: Vec3Tuple;
  lowerArm?: Vec3Tuple;
  hand?: Vec3Tuple;
  /** Which way the palm faces. Aiming the hand leaves this roll undetermined. */
  palm?: Vec3Tuple;
  /** Axial roll about the hand's own axis, radians. */
  twist?: number;
}

/**
 * A pose at a moment.
 *
 * Every field is optional and an absent one is not "zero" — it is unstated, and
 * whichever neighbouring keyframe does state it is used unchanged. That is what
 * lets a motion move the arms over four keyframes while stating the spine once.
 */
export interface MotionFrame {
  /** Seconds from the start of the motion. The first frame is normally 0. */
  at: number;
  arms?: Partial<Record<Side, MotionArm>>;
  fingers?: Partial<Record<Side, FingerSpec>>;
  spine?: SpineOffsets;
}

export interface MotionDef {
  /** What `gesture` and a performance's `gesture` field will call it. */
  id: string;
  label: Localized;
  group: GestureGroup;
  /** Seconds of entrance. A floor — the real lead scales with how far the arms travel. */
  lead: number;
  /** Seconds held at full weight before the exit begins. */
  hold: number;
  /** A pose that holds until released rather than running out on its own. */
  sustain?: boolean;
  /**
   * Run the keyframes round again instead of settling on the last one.
   *
   * The seam is the author's problem: the last frame is followed immediately by
   * the first, so a loop whose ends differ snaps once per cycle. There is no
   * check for it here because "close enough" is a judgement about a render.
   */
  loop?: boolean;
  frames: MotionFrame[];
}

const ARM_SLOTS: ArmSlot[] = ['shoulder', 'upperArm', 'lowerArm', 'hand'];
const FINGER_NAMES: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'little'];
const SPINE_SLOTS: SpineSlot[] = ['hips', 'spine', 'chest', 'neck', 'head'];
const SIDES: Side[] = ['L', 'R'];

/** Authored as a tuple, consumed as a normalised direction. */
const dir = (v: Vec3Tuple): THREE.Vector3 => new THREE.Vector3(v[0], v[1], v[2]).normalize();

const mix = (a: number, b: number, u: number): number => a + (b - a) * u;

/**
 * Between two directions, staying a direction.
 *
 * Normalising a component-wise blend rather than slerping: the two are visibly
 * the same below a right angle, which is as far apart as two keyframes of one
 * limb ever are, and this cannot produce a zero-length result for the pair that
 * are exactly opposed — it produces one of them, which is wrong but is still a
 * direction.
 */
const mixDir = (a: Vec3Tuple, b: Vec3Tuple, u: number): THREE.Vector3 =>
  dir([mix(a[0], b[0], u), mix(a[1], b[1], u), mix(a[2], b[2], u)]);

const mixTuple = (a: Vec3Tuple, b: Vec3Tuple, u: number): Vec3Tuple => [
  mix(a[0], b[0], u),
  mix(a[1], b[1], u),
  mix(a[2], b[2], u),
];

/** How long the keyframes run, which is where the last one sits. */
const span = (frames: MotionFrame[]): number => frames[frames.length - 1].at;

/**
 * The two frames `t` falls between, and how far between them it is.
 *
 * Linear rather than a search: a motion is a handful of keyframes and this runs
 * once a frame, so the loop is cheaper than the arithmetic to avoid it.
 */
function bracket(frames: MotionFrame[], t: number): [MotionFrame, MotionFrame, number] {
  for (let i = 1; i < frames.length; i += 1) {
    if (t > frames[i].at) continue;
    const a = frames[i - 1];
    const b = frames[i];
    const width = b.at - a.at;
    return [a, b, width > 0 ? (t - a.at) / width : 1];
  }
  const last = frames[frames.length - 1];
  return [last, last, 1];
}

/**
 * Build one arm, or nothing if neither frame states it.
 *
 * A slot only one of the two frames states is taken from that one rather than
 * being faded in from a rest pose that was never written down. Fading toward an
 * unstated value is the interpretation that produces motion nobody authored.
 */
function armAt(
  a: MotionArm | undefined,
  b: MotionArm | undefined,
  u: number,
): ArmDirections | null {
  if (!(a || b)) return null;
  const out: ArmDirections = {};
  for (const slot of ARM_SLOTS) {
    const from = a?.[slot];
    const to = b?.[slot];
    if (from && to) out[slot] = mixDir(from, to, u);
    else if (from || to) out[slot] = dir((from ?? to) as Vec3Tuple);
  }
  const palmFrom = a?.palm;
  const palmTo = b?.palm;
  if (palmFrom && palmTo) out.palm = mixDir(palmFrom, palmTo, u);
  else if (palmFrom || palmTo) out.palm = dir((palmFrom ?? palmTo) as Vec3Tuple);
  const twistFrom = a?.twist;
  const twistTo = b?.twist;
  if (twistFrom !== undefined && twistTo !== undefined) out.twist = mix(twistFrom, twistTo, u);
  else if (twistFrom !== undefined || twistTo !== undefined)
    out.twist = (twistFrom ?? twistTo) as number;
  return out;
}

function fingersAt(
  a: FingerSpec | undefined,
  b: FingerSpec | undefined,
  u: number,
): FingerSpec | null {
  if (!(a || b)) return null;
  const out: FingerSpec = {};
  for (const name of FINGER_NAMES) {
    const from = a?.[name];
    const to = b?.[name];
    if (from !== undefined && to !== undefined) out[name] = mix(from, to, u);
    else if (from !== undefined || to !== undefined) out[name] = (from ?? to) as number;
  }
  return out;
}

/**
 * The spine, scaled by the playback's amplitude.
 *
 * `v.scale` reaches here and nowhere else in this format. The arms are stated
 * as directions and a direction has no amplitude to vary — scaling one would
 * aim it somewhere else, which is a different pose rather than the same pose
 * done smaller. Spine offsets are angles and scale correctly.
 */
function spineAt(
  a: SpineOffsets | undefined,
  b: SpineOffsets | undefined,
  u: number,
  scale: number,
): SpineOffsets | null {
  if (!(a || b)) return null;
  const out: SpineOffsets = {};
  for (const slot of SPINE_SLOTS) {
    const from = a?.[slot];
    const to = b?.[slot];
    const value = from && to ? mixTuple(from, to, u) : ((from ?? to) as Vec3Tuple | undefined);
    if (value) out[slot] = [value[0] * scale, value[1] * scale, value[2] * scale];
  }
  return out;
}

/**
 * Turn a keyframed motion into something the body layer can play.
 *
 * `v.rate` scales time, which is the only reading of "faster" a keyframe track
 * has. `v.side` is deliberately not applied: the built-in table authors one
 * pose and mirrors it onto whichever hand is free, and it can do that because
 * every entry was checked on both. A file states `L` or `R` and gets it.
 */
export function compileMotion(motion: MotionDef): GestureDef {
  const frames = motion.frames;
  const duration = span(frames);
  return {
    label: motion.label,
    group: motion.group,
    lead: motion.lead,
    hold: motion.hold,
    ...(motion.sustain ? { sustain: true as const } : {}),
    build(t: number, v: GestureVariation): Pose {
      const scaled = t * v.rate;
      const at =
        motion.loop && duration > 0 ? scaled % duration : Math.min(Math.max(scaled, 0), duration);
      const [a, b, u] = bracket(frames, at);
      const arms: NonNullable<Pose['arms']> = {};
      const fingers: NonNullable<Pose['fingers']> = {};
      for (const side of SIDES) {
        const arm = armAt(a.arms?.[side], b.arms?.[side], u);
        if (arm) arms[side] = arm;
        const curl = fingersAt(a.fingers?.[side], b.fingers?.[side], u);
        if (curl) fingers[side] = curl;
      }
      const spine = spineAt(a.spine, b.spine, u, v.scale);
      // Each half is left off entirely when the motion states none of it. An
      // empty `arms: {}` is not the same as no arms downstream: the compose
      // step reads the key rather than its contents.
      const pose: Pose = {};
      if (arms.L || arms.R) pose.arms = arms;
      if (fingers.L || fingers.R) pose.fingers = fingers;
      if (spine) pose.spine = spine;
      return pose;
    },
  };
}

/** Why one motion in a batch did not make it in. */
export interface MotionRejection {
  id: string;
  reason: 'reserved' | 'duplicate';
}

export interface MotionLoad {
  loaded: string[];
  rejected: MotionRejection[];
}

/**
 * The motions currently loaded, keyed by id.
 *
 * Module state, like the gesture table beside it, and for the same reason: the
 * body layer looks a gesture up by a string that arrived on the wire, and
 * threading a registry down to it would mean every caller of `gesture` knowing
 * which set of motions the renderer happened to load.
 */
const loaded = new Map<string, GestureDef>();

/**
 * Replace everything that was loaded with this list.
 *
 * Replace and not merge: the renderer re-reads the directory whenever it
 * reconnects, and a motion whose file was deleted has to actually go away — a
 * registry that only ever grows would keep answering for it until the page was
 * reloaded, which is the one state an operator cannot see from the outside.
 */
export function loadMotions(motions: MotionDef[]): MotionLoad {
  loaded.clear();
  const result: MotionLoad = { loaded: [], rejected: [] };
  for (const motion of motions) {
    if (isBuiltInGestureName(motion.id)) {
      result.rejected.push({ id: motion.id, reason: 'reserved' });
      continue;
    }
    if (loaded.has(motion.id)) {
      result.rejected.push({ id: motion.id, reason: 'duplicate' });
      continue;
    }
    loaded.set(motion.id, compileMotion(motion));
    result.loaded.push(motion.id);
  }
  return result;
}

/** Drop everything loaded. For a test that has to start from the built-ins. */
export function clearMotions(): void {
  loaded.clear();
}

const BUILT_IN: Record<string, GestureDef> = GESTURES;

/**
 * Look a gesture up: the built-in table first, then what was loaded.
 *
 * Built-in first is not an ordering preference, it is the collision rule stated
 * a second time — `loadMotions` already refuses a reserved id, and this makes
 * the refusal hold even if something ever puts one in the map another way.
 */
export function gestureDef(id: string): GestureDef | null {
  const builtIn = Object.hasOwn(BUILT_IN, id) ? BUILT_IN[id] : undefined;
  return builtIn ?? loaded.get(id) ?? null;
}

/**
 * Every gesture that can be played, built-in and loaded, for the vocabulary.
 *
 * Built-ins first and in table order, so an orchestrator reading the list sees
 * the set that means the same thing on every machine before the set that does
 * not.
 */
export function gestureEntries(): Array<[string, GestureDef]> {
  return [...(Object.entries(BUILT_IN) as Array<[string, GestureDef]>), ...loaded.entries()];
}
