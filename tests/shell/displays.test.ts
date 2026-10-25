import { describe, expect, it } from 'vitest';
import { boundsOn, type DisplayInfo, displayLabel, displayUnder } from '@/shell/displays';

/**
 * Sending the stage to a display: the menu has to name the screens the way an
 * operator recognises them, and the window has to land on the one chosen before
 * full screen fills it.
 */

const LAPTOP: DisplayInfo = {
  id: 1,
  label: 'Built-in Retina Display',
  internal: true,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 38, width: 1512, height: 944 },
};

const HDMI: DisplayInfo = {
  id: 2,
  label: 'DELL U2720Q',
  internal: false,
  bounds: { x: 1512, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1512, y: 25, width: 1920, height: 1055 },
};

describe('displayLabel', () => {
  it('names the screen, its size, and whether it is the built-in one', () => {
    expect(displayLabel(HDMI, 1)).toBe('DELL U2720Q — 1920×1080');
    expect(displayLabel(LAPTOP, 0)).toBe('Built-in Retina Display — 1512×982 (built-in)');
  });

  it('falls back to a number when the platform gives no name', () => {
    expect(displayLabel({ ...HDMI, label: '' }, 1)).toBe('Display 2 — 1920×1080');
  });
});

describe('boundsOn', () => {
  it('centres the window in the chosen display', () => {
    expect(boundsOn({ x: 100, y: 100, width: 960, height: 540 }, HDMI)).toEqual({
      x: 1512 + 480,
      y: 25 + Math.round((1055 - 540) / 2),
      width: 960,
      height: 540,
    });
  });

  it('shrinks a window larger than the display to fit it', () => {
    const placed = boundsOn({ x: 0, y: 0, width: 4000, height: 3000 }, HDMI);
    expect(placed).toEqual({ x: 1512, y: 25, width: 1920, height: 1055 });
  });
});

describe('displayUnder', () => {
  it('finds the display the window centre is over', () => {
    expect(displayUnder({ x: 1600, y: 0, width: 1920, height: 1080 }, [LAPTOP, HDMI])?.id).toBe(2);
    expect(displayUnder({ x: 0, y: 0, width: 800, height: 600 }, [LAPTOP, HDMI])?.id).toBe(1);
  });

  it('answers null for a window off every display', () => {
    expect(displayUnder({ x: -5000, y: 0, width: 800, height: 600 }, [LAPTOP, HDMI])).toBeNull();
  });
});
