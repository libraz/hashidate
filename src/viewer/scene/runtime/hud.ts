import type { Side } from '@/engine/types';
import { getLocale, pick } from '@/i18n/locale';
import { translate } from '@/i18n/translate';
import type { LoadedAvatar } from './types';

/**
 * The on-canvas readout.
 *
 * Text rather than an instrument, which is why it is sampled at 8 Hz and why
 * every string in it is resolved here: this is the page's own display, so the
 * locale in force on this page is the right answer and there is nothing to
 * carry as a pair.
 */

/** Live figures for the on-canvas readout. Sampled, not per-frame. */
export interface Hud {
  fps: number;
  channel: string;
  morphs: number;
  sway: number | null;
  breath: number;
  blink: number;
  gazeX: number;
  gazeY: number;
  /** How far the mouth is open, 0..1. */
  mouth: number;
  /** Joint strain from the last fingertip solve, per arm; about 1 is a stretch. */
  strain: Record<Side, number>;
  speaking: boolean;
  /** The performance id up, the autopilot's pick included while idle drives. */
  performance: string | null;
  gesture: string | null;
  expression: string | null;
  /** The strongest emotions in force, strongest first, at most two. */
  emotion: Array<[string, number]>;
  /** Camera tracking share, 0 = straight ahead, 1 = follow the camera. */
  lookAt: number;
  auto: boolean;
  /** The browser refusing this page an audio device. See `BrowserVoice.isBlocked`. */
  voiceBlocked: boolean;
}

/** Below this an emotion is residue from an ease, not something being felt. */
const EMOTION_FLOOR = 0.05;

function strongest(emotion: Partial<Record<string, number>>): Array<[string, number]> {
  return Object.entries(emotion)
    .filter((entry): entry is [string, number] => (entry[1] ?? 0) > EMOTION_FLOOR)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
}

/** How often the HUD is sampled. It is text, not an instrument; 8 Hz reads live. */
export const HUD_INTERVAL = 0.125;

export function buildHud(
  cur: LoadedAvatar,
  { fps, voiceBlocked }: { fps: number; voiceBlocked: boolean },
): Hud {
  const { director, profile, avatar } = cur;
  const channel = profile.arkit.supported
    ? `ARKit ${profile.arkit.count}/52`
    : avatar.emotionShapes
      ? translate('console.hud.channel.custom', getLocale())
      : translate('console.hud.channel.vrm', getLocale());
  // Resolved here rather than carried as a pair: the HUD is this page's own
  // instrument, so the locale in force on this page is the right answer.
  const gestureLabel = director.body.gesture?.def.label ?? null;
  return {
    fps,
    channel,
    morphs: Object.keys(profile.dict).length,
    sway: director.spring.enabled ? director.spring.count : null,
    breath: director.body.breath,
    blink: director.blink,
    gazeX: director.body.gaze.x,
    gazeY: director.body.gaze.y,
    mouth: director.mouth.openness,
    strain: { ...director.body.pointStrain },
    speaking: director.mouth.speaking,
    performance: director.performance,
    gesture: gestureLabel ? pick(gestureLabel, getLocale()) : null,
    expression: director.expression,
    emotion: strongest(director.effectiveEmotion),
    lookAt: director.body.lookAt,
    auto: director.auto,
    voiceBlocked,
  };
}
