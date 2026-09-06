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

/** One authored value and the time at which it applies. */
interface Sample<T> {
  at: number;
  value: T;
}

type DirectionTrack = Sample<THREE.Vector3>[];
type ScalarTrack = Sample<number>[];
type TupleTrack = Sample<Vec3Tuple>[];
type DirectionSlot = ArmSlot | 'palm';

interface ArmTracks {
  directions: Partial<Record<DirectionSlot, DirectionTrack>>;
  twist?: ScalarTrack;
  stated: boolean;
}

interface MotionTracks {
  arms: Record<Side, ArmTracks>;
  fingers: Record<Side, Partial<Record<FingerName, ScalarTrack>>>;
  fingersStated: Record<Side, boolean>;
  spine: Partial<Record<SpineSlot, TupleTrack>>;
  spineStated: boolean;
}

/** Authored as a tuple, consumed as a normalised direction. */
const dir = (v: Vec3Tuple): THREE.Vector3 => new THREE.Vector3(v[0], v[1], v[2]).normalize();

const mix = (a: number, b: number, u: number): number => a + (b - a) * u;

/**
 * Between two directions, staying a direction.
 *
 * Normalise each endpoint before blending rather than slerping: the two are
 * visibly the same below a right angle, which is as far apart as two keyframes
 * of one limb ever are. At the exact midpoint of an opposed pair the component
 * blend cancels; keep the first endpoint there, which is wrong but is still a
 * deterministic direction rather than a zero vector.
 */
const mixDir = (a: THREE.Vector3, b: THREE.Vector3, u: number): THREE.Vector3 => {
  const from = a.clone().normalize();
  const to = b.clone().normalize();
  const blended = from.clone().lerp(to, u);
  return blended.lengthSq() > 0 ? blended.normalize() : from.lengthSq() > 0 ? from : to;
};

const mixTuple = (a: Vec3Tuple, b: Vec3Tuple, u: number): Vec3Tuple => [
  mix(a[0], b[0], u),
  mix(a[1], b[1], u),
  mix(a[2], b[2], u),
];

function addSample<K extends string, T>(
  tracks: Partial<Record<K, Sample<T>[]>>,
  key: K,
  sample: Sample<T>,
): void {
  const track = tracks[key];
  if (track) track.push(sample);
  else tracks[key] = [sample];
}

/** How long the keyframes run, which is where the last one sits. */
const span = (frames: MotionFrame[]): number => frames[frames.length - 1].at;

/**
 * Sample one channel's independent track.
 *
 * A motion is a handful of keyframes and this runs once per channel per frame,
 * so the loop is cheaper than the arithmetic to avoid it. Values outside the
 * channel's own authored range clamp to its first or last sample.
 */
function sampleTrack<T>(
  track: Sample<T>[] | undefined,
  t: number,
  interpolate: (a: T, b: T, u: number) => T,
  copy: (value: T) => T = (value) => value,
): T | undefined {
  if (!track) return undefined;
  const first = track[0];
  if (t <= first.at) return copy(first.value);
  for (let i = 1; i < track.length; i += 1) {
    const b = track[i];
    if (t > b.at) continue;
    const a = track[i - 1];
    const width = b.at - a.at;
    return width > 0 ? interpolate(a.value, b.value, (t - a.at) / width) : copy(b.value);
  }
  return copy(track[track.length - 1].value);
}

/**
 * Compile every authored channel independently of the other channels.
 *
 * An operator can state a spine once while moving an arm over several frames,
 * or leave one finger out of an otherwise complete hand. Each channel therefore
 * gets its own samples rather than inheriting the global frame bracket.
 */
function compileTracks(frames: MotionFrame[]): MotionTracks {
  const arms: Record<Side, ArmTracks> = {
    L: { directions: {}, stated: false },
    R: { directions: {}, stated: false },
  };
  const fingers: Record<Side, Partial<Record<FingerName, ScalarTrack>>> = {
    L: {},
    R: {},
  };
  const fingersStated: Record<Side, boolean> = { L: false, R: false };
  const spine: Partial<Record<SpineSlot, TupleTrack>> = {};
  let spineStated = false;

  for (const frame of frames) {
    for (const side of SIDES) {
      const arm = frame.arms?.[side];
      if (arm !== undefined) {
        arms[side].stated = true;
        for (const slot of ARM_SLOTS) {
          const value = arm[slot];
          if (value === undefined) continue;
          addSample(arms[side].directions, slot, { at: frame.at, value: dir(value) });
        }
        if (arm.palm !== undefined) {
          addSample(arms[side].directions, 'palm', { at: frame.at, value: dir(arm.palm) });
        }
        if (arm.twist !== undefined) {
          if (arms[side].twist) arms[side].twist.push({ at: frame.at, value: arm.twist });
          else arms[side].twist = [{ at: frame.at, value: arm.twist }];
        }
      }

      const hand = frame.fingers?.[side];
      if (hand !== undefined) {
        fingersStated[side] = true;
        for (const name of FINGER_NAMES) {
          const value = hand[name];
          if (value === undefined) continue;
          addSample(fingers[side], name, { at: frame.at, value });
        }
      }
    }

    if (frame.spine !== undefined) {
      spineStated = true;
      for (const slot of SPINE_SLOTS) {
        const value = frame.spine[slot];
        if (value === undefined) continue;
        addSample(spine, slot, { at: frame.at, value });
      }
    }
  }

  return { arms, fingers, fingersStated, spine, spineStated };
}

function fingersAt(
  tracks: Partial<Record<FingerName, ScalarTrack>>,
  stated: boolean,
  t: number,
): FingerSpec | null {
  if (!stated) return null;
  const out: FingerSpec = {};
  for (const name of FINGER_NAMES) {
    const value = sampleTrack(tracks[name], t, mix);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function armAt(tracks: ArmTracks, t: number): ArmDirections | null {
  if (!tracks.stated) return null;
  const out: ArmDirections = {};
  for (const slot of ARM_SLOTS) {
    const value = sampleTrack(tracks.directions[slot], t, mixDir, (item) => item.clone());
    if (value !== undefined) out[slot] = value;
  }
  const palm = sampleTrack(tracks.directions.palm, t, mixDir, (item) => item.clone());
  if (palm !== undefined) out.palm = palm;
  const twist = sampleTrack(tracks.twist, t, mix);
  if (twist !== undefined) out.twist = twist;
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
  tracks: Partial<Record<SpineSlot, TupleTrack>>,
  stated: boolean,
  t: number,
  scale: number,
): SpineOffsets | null {
  if (!stated) return null;
  const out: SpineOffsets = {};
  for (const slot of SPINE_SLOTS) {
    const value = sampleTrack(tracks[slot], t, mixTuple);
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
  const tracks = compileTracks(frames);
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
      const arms: NonNullable<Pose['arms']> = {};
      const fingers: NonNullable<Pose['fingers']> = {};
      for (const side of SIDES) {
        const arm = armAt(tracks.arms[side], at);
        if (arm) arms[side] = arm;
        const curl = fingersAt(tracks.fingers[side], tracks.fingersStated[side], at);
        if (curl) fingers[side] = curl;
      }
      const spine = spineAt(tracks.spine, tracks.spineStated, at, v.scale);
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
