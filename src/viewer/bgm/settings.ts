import type { BgmCommand, BgmDsp, BgmFade, BgmTransport } from '@/protocol';
import type { BrowserAudioOutput } from '../audio-output';
import type { BrowserBgmOptions } from './options';

/**
 * The value work: copying settings, merging a patch onto them, and reading a
 * command's verb as a transport state.
 *
 * Nothing here touches the audio graph. Every function is total and has no
 * state of its own, which is what makes the transport's own code readable — it
 * is left saying only what it does to the graph.
 */

export function isOutput(
  value: BrowserAudioOutput | BrowserBgmOptions,
): value is BrowserAudioOutput {
  return 'context' in value && 'bgmBus' in value;
}

export function cloneDsp(dsp: BgmDsp): BgmDsp {
  return { ...dsp, reverb: { ...dsp.reverb } };
}

export function cloneFade(fade: BgmFade): BgmFade {
  return { inSeconds: fade.inSeconds, outSeconds: fade.outSeconds };
}

export function mergeFade(base: BgmFade, patch: Partial<BgmFade>): BgmFade {
  return {
    inSeconds: patch.inSeconds ?? base.inSeconds,
    outSeconds: patch.outSeconds ?? base.outSeconds,
  };
}

export function normalizeTrack(track: string | null): string | null {
  return track === null ? null : track.normalize('NFC');
}

export function trimBase(base: string): string {
  const trimmed = base.trim();
  if (trimmed === '') return '';
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

export function actionTransport(action: BgmCommand['action']): BgmTransport | undefined {
  switch (action) {
    case 'play':
      return 'playing';
    case 'pause':
      return 'paused';
    case 'stop':
      return 'stopped';
    default:
      return undefined;
  }
}
