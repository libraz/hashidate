/**
 * Face layer.
 *
 * Everything that happens above the neck and below the director: the emotion
 * composition, the authored faces the artist drew, the mouth and the blink.
 * None of it knows what the avatar calls its shapes — the director resolves
 * these outputs against the profile.
 */

export type { BlinkContext, BlinkOptions } from './blink';
export { BLINK_CLOSE, Blink, blinkCurve, MIN_BLINK_GAP } from './blink';
export {
  composeArkit,
  composeNative,
  dominantEmotion,
  EMOTION_LABELS,
  EMOTIONS,
} from './emotions';
export type { MouthViseme, MouthWeights, VisemeEvent, VisemeOptions, VisemeTrack } from './lipsync';
export { Mouth, scaleTrack, textToVisemes } from './lipsync';
export type { ExpressionPreset, LidClosure } from './presets';
export { buildIdleFaces, buildOverlays, buildPresets } from './presets';
