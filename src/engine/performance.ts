/**
 * Performances — a face and a movement, named together.
 *
 * The layers below this one are deliberately separate: the emotion vector is
 * continuous and persists, a gesture is a discrete thing that runs and ends, a
 * hop translates the whole skeleton, an overlay is a drawn effect that layers
 * over whatever face is showing. Each is the right shape for what it does, and
 * none of them is the shape a *caller* thinks in.
 *
 * Nobody asks for "joy 0.9 with the cheer gesture and three hops of 45mm". They
 * ask for 「うれしい」 (happy). This table is that vocabulary, and it is the
 * one an orchestrator, the control API and the idle autopilot all speak — so
 * the character does the same thing whichever of the three is driving.
 *
 * ## Written in canonical terms only
 *
 * Emotions, gestures and hops are engine data and mean the same thing on every
 * avatar; drawn expressions and overlays are *avatar* data, discovered from one
 * model's shape groups. So a performance names the first three and never the
 * fourth — the drawn face arrives on its own, because `AvatarDescriptor.presets`
 * maps each canonical emotion to whichever finished drawing that model ships for
 * it. `happy` therefore lands on Yoka's `F_NIKONIKO`, on Manuka's composed
 * `eye_joy + brow_joy + mouth_smile`, and on a model with neither as a plain
 * ARKit smile, without this file knowing that any of them exist.
 *
 * `overlay` is the one exception and is stated as a wish: an id the avatar does
 * not have is skipped rather than failing the performance.
 *
 * ## Entered and left
 *
 * A performance is a state, not an event. Starting one ends the last: what it
 * raised comes down, what it held is released. The single exception is the mood,
 * which persists — for the same reason a turn's emotion persists, that a mood
 * does not end with the sentence that carried it.
 */

import type { Localized } from '../i18n/locale';
import { GESTURES, type GestureId, type HopId } from './motion';
import type { EmotionVector, GestureDef, PerformanceGroup } from './types';

export const PERFORMANCE_GROUPS: Record<PerformanceGroup, Localized> = {
  mood: { en: 'Mood', ja: '気分' },
  reaction: { en: 'Reaction', ja: '相槌' },
  greeting: { en: 'Greeting', ja: '挨拶' },
  explain: { en: 'Explaining', ja: '説明' },
  emote: { en: 'Feeling', ja: '感情' },
  cute: { en: 'Mannerism', ja: '仕草' },
  pose: { en: 'Pose', ja: 'ポーズ' },
};

export interface PerformanceDef {
  label: Localized;
  group: PerformanceGroup;
  /**
   * The mood. Persists after the performance ends, like any emotion, and is
   * what reaches the avatar's own drawn face — see the note at the top.
   */
  emotion: EmotionVector;
  /** Which gesture the body plays, if any. Checked against the gesture table. */
  gesture?: GestureId;
  /** A run of hops, by id. Runs alongside the gesture rather than instead of it. */
  hop?: HopId;
  /** Drawn effects to raise while it runs. Ids the avatar lacks are skipped. */
  overlay?: string[];
  /**
   * How far the lids sit shut while it runs, 0..1. Held, so it needs releasing,
   * which is part of why a performance is a state rather than an event.
   */
  droop?: number;
  /** How much the gaze tracks the camera while it runs. Restored on release. */
  look?: number;
}

/**
 * The table.
 *
 * Every gesture in `GESTURES` appears here at least once, which is the property
 * that makes this a complete vocabulary rather than a shortlist: a motion with
 * no face attached is one the autopilot will eventually play deadpan, and a
 * deadpan wave is worse than no wave. Adding a gesture means adding a
 * performance for it — there is a test that says so.
 */
export const PERFORMANCES = {
  // --- mood ---------------------------------------------------------------
  // Face only, and the reason the autopilot does not gesture constantly. A
  // character who changes what they are feeling and then simply stands there is
  // most of what watching one actually looks like.
  calm: { label: { en: 'Calm', ja: 'おだやか' }, group: 'mood', emotion: { relaxed: 0.85 } },
  blank: { label: { en: 'Neutral', ja: 'ふつう' }, group: 'mood', emotion: { neutral: 1 } },
  wonder: {
    label: { en: 'Puzzled', ja: 'ふしぎ' },
    group: 'mood',
    emotion: { thinking: 0.6, surprise: 0.25 },
  },
  gloomy: {
    label: { en: 'Downcast', ja: 'しょんぼり' },
    group: 'mood',
    emotion: { sadness: 0.75 },
  },
  startled: {
    label: { en: 'Startled', ja: 'びっくり' },
    group: 'mood',
    emotion: { surprise: 0.9 },
  },
  bashful: { label: { en: 'Bashful', ja: 'もじもじ' }, group: 'mood', emotion: { shy: 0.8 } },

  /**
   * Falling asleep.
   *
   * The three parts are all load-bearing and none of them does it alone. The
   * pose puts the head down and keeps it drifting; the mood picks up whatever
   * soft face the avatar has; the droop closes the eyes, and it is the eyes that
   * decide whether a viewer reads it as asleep or as sulking at the floor.
   * `look: 0` is the fourth: with the gaze still tracking the camera the head
   * keeps being pulled back up to it, and the pose visibly fights the tracking.
   */
  doze: {
    label: { en: 'Dozing off', ja: 'ねおち' },
    group: 'mood',
    emotion: { relaxed: 0.9 },
    gesture: 'doze',
    droop: 0.95,
    look: 0,
  },

  // --- reaction -----------------------------------------------------------
  agree: {
    label: { en: 'Nodding', ja: 'うなずく' },
    group: 'reaction',
    emotion: { neutral: 0.6, joy: 0.35 },
    gesture: 'nod',
  },
  curious: {
    label: { en: 'Curious', ja: 'きになる' },
    group: 'reaction',
    emotion: { thinking: 0.55, surprise: 0.3 },
    gesture: 'tilt',
  },
  interested: {
    label: { en: 'Absorbed', ja: 'みいる' },
    group: 'reaction',
    emotion: { joy: 0.45, surprise: 0.4 },
    gesture: 'lean',
  },
  ponder: {
    label: { en: 'Thinking', ja: 'かんがえる' },
    group: 'reaction',
    emotion: { thinking: 0.9 },
    gesture: 'think',
  },
  dunno: {
    label: { en: 'No idea', ja: 'さあ？' },
    group: 'reaction',
    emotion: { thinking: 0.4, sadness: 0.25 },
    gesture: 'shrug',
  },

  // --- greeting -----------------------------------------------------------
  hello: {
    label: { en: 'Greeting', ja: 'あいさつ' },
    group: 'greeting',
    emotion: { joy: 0.85 },
    gesture: 'wave',
  },
  invite: {
    label: { en: 'Come over', ja: 'おいでおいで' },
    group: 'greeting',
    emotion: { joy: 0.5, relaxed: 0.4 },
    gesture: 'comeHere',
  },
  thanks: {
    label: { en: 'Thank you', ja: 'ありがとう' },
    group: 'greeting',
    emotion: { joy: 0.55, shy: 0.3 },
    gesture: 'bow',
  },

  // --- explain ------------------------------------------------------------
  explain: {
    label: { en: 'Explaining', ja: 'せつめい' },
    group: 'explain',
    emotion: { neutral: 0.65, thinking: 0.3 },
    gesture: 'explain',
  },
  present: {
    label: { en: 'This way', ja: 'こちらです' },
    group: 'explain',
    emotion: { joy: 0.45, neutral: 0.45 },
    gesture: 'present',
  },
  notice: {
    label: { en: 'Right here', ja: 'ここ！' },
    group: 'explain',
    emotion: { joy: 0.4, surprise: 0.35 },
    gesture: 'pointUp',
  },

  // --- emote --------------------------------------------------------------
  /**
   * Pleased about something, and the reason the hop table exists.
   *
   * The arms alone are a cheer, which is a reaction to something; the hops are
   * what make it the character's own delight. Three small ones rather than one
   * big one — a single tall jump reads as a leap and takes the head out of a
   * bust framing, and the cadence of a short repeated bounce is the whole tell.
   */
  happy: {
    label: { en: 'Delighted', ja: 'うれしい' },
    group: 'emote',
    emotion: { joy: 1 },
    gesture: 'cheer',
    hop: 'bounce',
  },
  applause: {
    label: { en: 'Applause', ja: 'はくしゅ' },
    group: 'emote',
    emotion: { joy: 0.8, surprise: 0.2 },
    gesture: 'clap',
  },
  peace: {
    label: { en: 'Peace sign', ja: 'ピース' },
    group: 'emote',
    emotion: { joy: 0.75 },
    gesture: 'peace',
  },
  giggle: {
    label: { en: 'Giggling', ja: 'くすくす' },
    group: 'emote',
    emotion: { joy: 0.5, shy: 0.45 },
    gesture: 'cover',
  },
  nope: {
    label: { en: 'Not quite', ja: 'ちがうよ' },
    group: 'emote',
    emotion: { surprise: 0.4, sadness: 0.3 },
    gesture: 'deny',
  },
  sulk: {
    label: { en: 'Cross', ja: 'ぷんすか' },
    group: 'emote',
    emotion: { anger: 0.85 },
    gesture: 'pout',
  },

  // --- cute ---------------------------------------------------------------
  shy: {
    label: { en: 'Shy', ja: 'てれる' },
    group: 'cute',
    emotion: { shy: 0.9 },
    gesture: 'cheekPoke',
  },
  catPaw: {
    label: { en: 'Meow', ja: 'にゃー' },
    group: 'cute',
    emotion: { joy: 0.6, shy: 0.3 },
    gesture: 'catPaw',
  },
  sparkle: {
    label: { en: 'Sparkling', ja: 'きらきら' },
    group: 'cute',
    emotion: { joy: 0.7, surprise: 0.3 },
    gesture: 'sparkle',
  },
  plead: {
    label: { en: 'Please', ja: 'おねがい' },
    group: 'cute',
    emotion: { shy: 0.5, sadness: 0.35 },
    gesture: 'beg',
  },
  secret: {
    label: { en: 'A secret', ja: 'ないしょ' },
    group: 'cute',
    emotion: { shy: 0.55, joy: 0.35 },
    gesture: 'whisper',
  },
  // Not `doze`. This is the yawn a character gets away with mid-stream — the
  // lids come down a little and go back up, and the mood is still awake.
  sleepy: {
    label: { en: 'Sleepy', ja: 'ねむい' },
    group: 'cute',
    emotion: { relaxed: 0.8 },
    gesture: 'yawn',
    droop: 0.3,
  },
  refresh: {
    label: { en: 'Stretching', ja: 'のび' },
    group: 'cute',
    emotion: { relaxed: 0.9 },
    gesture: 'stretch',
  },
  bouncy: {
    label: { en: 'In good spirits', ja: 'ごきげん' },
    group: 'cute',
    emotion: { joy: 0.7, relaxed: 0.25 },
    gesture: 'sparkle',
    hop: 'hop',
  },

  // --- pose ---------------------------------------------------------------
  // Held until something else is asked for. That is a property of the gesture
  // rather than of this table — see `holdsUntilReleased`.
  guarded: {
    label: { en: 'Arms folded', ja: 'うでぐみ' },
    group: 'pose',
    emotion: { thinking: 0.5, anger: 0.25 },
    gesture: 'armCross',
  },
  polite: {
    label: { en: 'Prim', ja: 'おすまし' },
    group: 'pose',
    emotion: { neutral: 0.7, relaxed: 0.3 },
    gesture: 'handsClasp',
  },
  bored: {
    label: { en: 'Chin on hand', ja: 'ほおづえ' },
    group: 'pose',
    emotion: { relaxed: 0.5, thinking: 0.4 },
    gesture: 'chin',
  },
  nice: {
    label: { en: 'Nice', ja: 'いいね' },
    group: 'pose',
    emotion: { joy: 0.9 },
    gesture: 'thumbsUp',
  },
  love: {
    label: { en: 'Love it', ja: 'すき' },
    group: 'pose',
    emotion: { joy: 0.6, shy: 0.4 },
    gesture: 'fingerHeart',
  },
  doublePeace: {
    label: { en: 'Double peace sign', ja: 'ダブルピース' },
    group: 'pose',
    emotion: { joy: 1 },
    gesture: 'bothPeace',
  },
  bang: {
    label: { en: 'Bang', ja: 'ばーん' },
    group: 'pose',
    emotion: { joy: 0.5, surprise: 0.35 },
    gesture: 'gun',
  },
  promise: {
    label: { en: 'Promise', ja: 'やくそく' },
    group: 'pose',
    emotion: { joy: 0.5, shy: 0.4 },
    gesture: 'promise',
  },
  listening: {
    label: { en: 'Listening', ja: 'きいてる' },
    group: 'pose',
    emotion: { thinking: 0.5, neutral: 0.4 },
    gesture: 'listen',
  },
} satisfies Record<string, PerformanceDef>;

export type PerformanceId = keyof typeof PERFORMANCES;

/**
 * The table again, every entry widened to the declared shape.
 *
 * `satisfies` keeps each entry's own literal type, which is what makes
 * `PerformanceId` a union of the real ids — and also means an entry that states
 * no `gesture` has no such property to read at all. Anything iterating the table
 * wants the declared shape rather than the inferred one.
 */
export const PERFORMANCE_TABLE: Record<PerformanceId, PerformanceDef> = PERFORMANCES;

/** The ids, in table order. */
export const PERFORMANCE_IDS = Object.keys(PERFORMANCES) as PerformanceId[];

/** Look one up without asserting that an arbitrary string is an id. */
export const performanceDef = (id: string): PerformanceDef | null =>
  Object.hasOwn(PERFORMANCE_TABLE, id)
    ? (PERFORMANCE_TABLE as Record<string, PerformanceDef>)[id]
    : null;

const GESTURE_TABLE: Record<string, GestureDef> = GESTURES;

/**
 * Whether this one stays up until something else replaces it.
 *
 * Derived rather than declared, so it cannot drift from the gesture table: a
 * performance is held exactly when it has something outstanding to put back —
 * a sustained pose, a raised overlay, a lid droop, or a gaze it overrode.
 */
export const holdsUntilReleased = (def: PerformanceDef): boolean =>
  (!!def.gesture && !!GESTURE_TABLE[def.gesture]?.sustain) ||
  !!def.overlay?.length ||
  def.droop !== undefined ||
  def.look !== undefined;

/** One group, with the ids that belong to it. */
export interface PerformanceGroupEntry {
  key: PerformanceGroup;
  label: Localized;
  ids: PerformanceId[];
}

/** Grouped, for the UI and for the autopilot's pool. */
export const PERFORMANCES_BY_GROUP: PerformanceGroupEntry[] = (
  Object.entries(PERFORMANCE_GROUPS) as Array<[PerformanceGroup, Localized]>
).map(([key, label]) => ({
  key,
  label,
  ids: PERFORMANCE_IDS.filter((id) => PERFORMANCE_TABLE[id].group === key),
}));
