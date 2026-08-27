import { describe, expect, it } from 'vitest';
import { parseSize, readStageMode } from '@/viewer/stage-mode';

/**
 * How the viewer was asked to present itself.
 *
 * Everything here is read from a URL typed into a field inside OBS, or built by
 * the panel for an iframe. There is nowhere for an error to be reported to in
 * either case, so the rule throughout is that a value which does not parse
 * degrades to something that still renders.
 */

describe('parseSize', () => {
  it('reads a source size', () => {
    expect(parseSize('1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseSize('640x360')).toEqual({ width: 640, height: 360 });
  });

  it('falls back to filling the window for anything it cannot read', () => {
    for (const raw of [null, '', '1920', '1920*1080', 'axb', '1920x', 'x1080', '1920 x 1080']) {
      expect(parseSize(raw), String(raw)).toBeNull();
    }
  });

  it('refuses a size the GPU could not back', () => {
    // The device pixel ratio multiplies whatever lands here, so a typo asks for
    // a framebuffer in the tens of gigabytes and takes the tab with it.
    expect(parseSize('99999x99999')).toBeNull();
    expect(parseSize('7680x4320')).toEqual({ width: 7680, height: 4320 });
  });
});

describe('readStageMode', () => {
  it('is a plain viewer with no query at all', () => {
    expect(readStageMode('')).toMatchObject({ stage: false, size: null, muted: false });
  });

  it('reads the mute the panel’s preview is opened with', () => {
    // The preview is a second renderer of the same commands. Without this the
    // operator hears every line twice, a fraction of a second apart.
    expect(readStageMode('?stage=1&mute=1').muted).toBe(true);
    expect(readStageMode('?mute').muted).toBe(true);
  });

  it('treats an explicitly-off flag as off, so a URL can carry one either way', () => {
    for (const raw of ['?mute=0', '?mute=false', '']) {
      expect(readStageMode(raw).muted, raw).toBe(false);
    }
    expect(readStageMode('?stage=0').stage).toBe(false);
  });

  it('reads the panel preview’s own URL', () => {
    // The exact string `Preview.tsx` builds: staged, silent, and sized by the
    // element rather than pinned like a browser source.
    expect(readStageMode('?stage=1&mute=1')).toMatchObject({
      stage: true,
      muted: true,
      size: null,
    });
  });
});
