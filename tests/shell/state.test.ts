import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isValidWindowBounds,
  isVisibleWindowBounds,
  restoreWindowBounds,
  ShellState,
  WRITE_DELAY_MS,
} from '@/shell/state';
import type { WindowBounds } from '@/shell/types';

/**
 * What the native shell remembers between runs, and what it refuses to.
 *
 * A settings file is the one part of a window application that can make it
 * unusable without any code being wrong: a rectangle saved on a monitor that is
 * no longer plugged in is a window nobody can reach, and a file half-written by
 * a crash is a shell that will not open. Both are answered the same way, by
 * treating anything that does not read as a rectangle on a screen that exists
 * as if there had been no file at all.
 */

const DISPLAYS = [
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 1920, y: 0, width: 2560, height: 1440 },
];

const FALLBACK: WindowBounds = { x: 100, y: 100, width: 1_200, height: 800 };

let directory: string;
let file: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hashidate-shell-'));
  file = join(directory, 'shell-state.json');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

const read = (): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

describe('what counts as a rectangle', () => {
  it('takes whole numbers that are large enough to be a window', () => {
    expect(isValidWindowBounds({ x: 0, y: 0, width: 1280, height: 720 })).toBe(true);
  });

  it('refuses anything that is not four integers', () => {
    for (const bad of [
      null,
      undefined,
      42,
      'x',
      {},
      { x: 0, y: 0, width: 1280 },
      { x: 0.5, y: 0, width: 1280, height: 720 },
      { x: 0, y: 0, width: '1280', height: 720 },
      { x: 0, y: 0, width: Number.NaN, height: 720 },
    ]) {
      expect(isValidWindowBounds(bad)).toBe(false);
    }
  });

  it('refuses one too small to find again', () => {
    // A window a pixel high is one an operator cannot grab the title bar of.
    expect(isValidWindowBounds({ x: 0, y: 0, width: 8, height: 8 })).toBe(false);
    expect(isValidWindowBounds({ x: 0, y: 0, width: 320, height: 200 })).toBe(true);
  });
});

describe('whether a saved rectangle is still on a screen', () => {
  it('accepts one wholly inside a display', () => {
    expect(isVisibleWindowBounds({ x: 40, y: 40, width: 800, height: 600 }, DISPLAYS)).toBe(true);
  });

  it('accepts one that only overlaps, since the title bar may still be grabbed', () => {
    expect(isVisibleWindowBounds({ x: -700, y: 20, width: 800, height: 600 }, DISPLAYS)).toBe(true);
  });

  it('accepts one on the second display', () => {
    expect(isVisibleWindowBounds({ x: 2400, y: 200, width: 800, height: 600 }, DISPLAYS)).toBe(
      true,
    );
  });

  it('refuses one on a monitor that is no longer there', () => {
    expect(isVisibleWindowBounds({ x: 5000, y: 0, width: 800, height: 600 }, DISPLAYS)).toBe(false);
    expect(isVisibleWindowBounds({ x: 0, y: -4000, width: 800, height: 600 }, DISPLAYS)).toBe(
      false,
    );
  });

  it('refuses one touching an edge without covering a pixel of it', () => {
    expect(isVisibleWindowBounds({ x: -800, y: 0, width: 800, height: 600 }, DISPLAYS)).toBe(false);
  });

  it('refuses everything when nothing is plugged in', () => {
    expect(isVisibleWindowBounds({ x: 0, y: 0, width: 800, height: 600 }, [])).toBe(false);
  });
});

describe('restoring', () => {
  it('gives back a rectangle that is valid and reachable', () => {
    const saved = { x: 40, y: 40, width: 800, height: 600 };
    expect(restoreWindowBounds(saved, FALLBACK, DISPLAYS)).toEqual(saved);
  });

  it('falls back for a rectangle that is either malformed or unreachable', () => {
    expect(restoreWindowBounds({ x: 0 }, FALLBACK, DISPLAYS)).toEqual(FALLBACK);
    expect(
      restoreWindowBounds({ x: 9000, y: 9000, width: 800, height: 600 }, FALLBACK, DISPLAYS),
    ).toEqual(FALLBACK);
  });
});

describe('the file', () => {
  it('starts at defaults when there is none', () => {
    const state = new ShellState(file);
    expect(state.restore('control', FALLBACK, DISPLAYS)).toEqual(FALLBACK);
    expect(state.stageMuted).toBe(false);
  });

  it('starts at defaults rather than failing on a file that is not JSON', () => {
    writeFileSync(file, '{ half a wr', 'utf8');
    const state = new ShellState(file);
    expect(state.restore('stage', FALLBACK, DISPLAYS)).toEqual(FALLBACK);
    expect(state.stageMuted).toBe(false);
  });

  it('keeps the windows it can read and drops the ones it cannot', () => {
    const stage = { x: 200, y: 120, width: 1280, height: 720 };
    writeFileSync(
      file,
      JSON.stringify({ windows: { stage, control: { x: 'no' } }, stageMuted: true }),
      'utf8',
    );

    const state = new ShellState(file);
    expect(state.restore('stage', FALLBACK, DISPLAYS)).toEqual(stage);
    expect(state.restore('control', FALLBACK, DISPLAYS)).toEqual(FALLBACK);
    expect(state.stageMuted).toBe(true);
  });

  it('does not open a settings file for writing when there is nothing to write', () => {
    const state = new ShellState(file);
    state.flush();
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });
});

describe('writing a placement down', () => {
  it('waits, rather than writing once per frame of a drag', () => {
    vi.useFakeTimers();
    const state = new ShellState(file);

    for (let x = 100; x < 160; x += 1) {
      state.remember('control', { x, y: 100, width: 1200, height: 800 });
    }
    // Dragging a window across a desk is hundreds of these, and the write is
    // synchronous on the process holding the stage renderer's audio.
    expect(() => readFileSync(file, 'utf8')).toThrow();

    vi.advanceTimersByTime(WRITE_DELAY_MS);
    expect(read().windows).toEqual({ control: { x: 159, y: 100, width: 1200, height: 800 } });
  });

  it('takes the pending write when a window closes rather than losing it', () => {
    vi.useFakeTimers();
    const state = new ShellState(file);
    state.remember('stage', { x: 10, y: 20, width: 1280, height: 720 });

    state.flush();

    expect(read().windows).toEqual({ stage: { x: 10, y: 20, width: 1280, height: 720 } });
  });

  it('ignores a placement that is not a placement', () => {
    const state = new ShellState(file);
    state.remember('control', { x: 0, y: 0, width: 4, height: 4 });
    state.flush();
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('schedules nothing for a window that has not actually moved', () => {
    vi.useFakeTimers();
    const state = new ShellState(file);
    const bounds = { x: 10, y: 20, width: 1280, height: 720 };
    state.remember('stage', bounds);
    state.flush();

    rmSync(file);
    state.remember('stage', { ...bounds });
    vi.advanceTimersByTime(WRITE_DELAY_MS * 4);
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('survives a directory it cannot write to', () => {
    const state = new ShellState(join(directory, 'nowhere', 'shell-state.json'));
    state.remember('control', FALLBACK);
    // A read-only profile is not a reason to refuse to open a window; the next
    // launch simply starts at its defaults again.
    expect(() => state.flush()).not.toThrow();
  });
});

describe('whether the stage speaks', () => {
  it('is written straight through, since a reload follows it', () => {
    vi.useFakeTimers();
    const state = new ShellState(file);
    state.setStageMuted(true);

    expect(read().stageMuted).toBe(true);
    expect(state.stageMuted).toBe(true);
  });

  it('comes back on the next launch', () => {
    new ShellState(file).setStageMuted(true);
    expect(new ShellState(file).stageMuted).toBe(true);
  });

  it('writes nothing when it is set to what it already is', () => {
    const state = new ShellState(file);
    state.setStageMuted(false);
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('is kept alongside the windows rather than instead of them', () => {
    const state = new ShellState(file);
    state.remember('control', FALLBACK);
    state.setStageMuted(true);

    expect(read()).toEqual({ windows: { control: FALLBACK }, stageMuted: true });
  });
});
