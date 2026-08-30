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
  speaking: boolean;
  gesture: string | null;
  expression: string | null;
  auto: boolean;
  /** The browser refusing this page an audio device. See `BrowserVoice.isBlocked`. */
  voiceBlocked: boolean;
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
    speaking: director.mouth.speaking,
    gesture: gestureLabel ? pick(gestureLabel, getLocale()) : null,
    expression: director.expression,
    auto: director.auto,
    voiceBlocked,
  };
}
