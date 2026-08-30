import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatTime,
  fromBgmDspValue,
  fromBgmFadeValue,
  toBgmDspPatch,
  toBgmFadePatch,
  trackSelectionIntent,
} from '@/panel/bgm/BgmTab';
import { EMPTY_BGM } from '@/panel/hooks';
import { BGM_DSP_DEFAULTS, BGM_FADE_DEFAULTS, BGM_FADE_LIMITS } from '@/protocol';

describe('BGM panel formatting', () => {
  it('formats short and long timeline values without moving the units', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65.9)).toBe('1:05');
    expect(formatTime(3665)).toBe('1:01:05');
    expect(formatTime(null)).toBe('—');
    expect(formatTime(Number.NaN)).toBe('—');
  });

  it('formats bytes in readable binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('BGM DSP display mapping', () => {
  it('converts percentage controls to normalized leaf patches', () => {
    expect(toBgmDspPatch('toneDb', -2.5)).toEqual({ toneDb: -2.5 });
    expect(toBgmDspPatch('compression', 35)).toEqual({ compression: 0.35 });
    expect(toBgmDspPatch('width', 125)).toEqual({ width: 1.25 });
    expect(toBgmDspPatch('reverb.mix', 20)).toEqual({ reverb: { mix: 0.2 } });
    expect(toBgmDspPatch('reverb.decay', 70)).toEqual({ reverb: { decay: 0.7 } });
    expect(toBgmDspPatch('reverb.damping', 40)).toEqual({ reverb: { damping: 0.4 } });
  });

  it('reads the same leaves back into operator-facing values', () => {
    const dsp = {
      ...BGM_DSP_DEFAULTS,
      compression: 0.35,
      width: 1.25,
      reverb: { ...BGM_DSP_DEFAULTS.reverb, mix: 0.2, decay: 0.7, damping: 0.4 },
    };
    expect(fromBgmDspValue(dsp, 'toneDb')).toBe(0);
    expect(fromBgmDspValue(dsp, 'compression')).toBe(35);
    expect(fromBgmDspValue(dsp, 'width')).toBe(125);
    expect(fromBgmDspValue(dsp, 'reverb.mix')).toBe(20);
    expect(fromBgmDspValue(dsp, 'reverb.decay')).toBe(70);
    expect(fromBgmDspValue(dsp, 'reverb.damping')).toBe(40);
  });
});

describe('BGM fade display mapping', () => {
  it('keeps transition controls in seconds on the wire', () => {
    expect(toBgmFadePatch('inSeconds', 2.5)).toEqual({ inSeconds: 2.5 });
    expect(toBgmFadePatch('outSeconds', 0.7)).toEqual({ outSeconds: 0.7 });
  });

  it('reads the resolved transition durations back unchanged', () => {
    const fade = { inSeconds: 2.5, outSeconds: 0.7 };
    expect(fromBgmFadeValue(fade, 'inSeconds')).toBe(2.5);
    expect(fromBgmFadeValue(fade, 'outSeconds')).toBe(0.7);
  });

  it('uses the bounded one-second defaults in the empty panel state', () => {
    expect(BGM_FADE_LIMITS).toEqual({
      inSeconds: { min: 0, max: 10 },
      outSeconds: { min: 0, max: 10 },
    });
    expect(EMPTY_BGM.fade).toEqual(BGM_FADE_DEFAULTS);
    expect(EMPTY_BGM.fade).not.toBe(BGM_FADE_DEFAULTS);
  });
});

describe('BGM track selection', () => {
  it('starts a true crossfade when changing tracks while playing', () => {
    expect(trackSelectionIntent('opening.mp3', 'ending.flac', 'playing')).toEqual({
      track: 'ending.flac',
      action: 'play',
    });
  });

  it('does nothing when the current track is clicked again', () => {
    expect(trackSelectionIntent('opening.mp3', 'opening.mp3', 'playing')).toBeNull();
  });

  it.each(['paused', 'stopped'] as const)(
    'only selects a different track while %s',
    (transport) => {
      expect(trackSelectionIntent('opening.mp3', 'ending.flac', transport)).toEqual({
        track: 'ending.flac',
      });
    },
  );
});
