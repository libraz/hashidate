import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isValidMascotState, type MascotState, ShellState } from '@/shell/state';

/**
 * What the mascot remembers between runs, in the shell's own settings file.
 *
 * The mascot and the broadcast desk share a profile and so share this file,
 * each holding a part the other never reads. Either one writing has to leave
 * the other's part as it found it, and a part that does not read as a mascot
 * placement is treated as if it had never been written.
 */

const SAVED: MascotState = {
  mode: 'free',
  scale: 0.75,
  muted: true,
  saved: { x: 1200.5, y: 900, display: { id: 7, label: 'DELL U2720Q', width: 2560, height: 1440 } },
};

let directory: string;
let file: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hashidate-mascot-'));
  file = join(directory, 'shell-state.json');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const read = (): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

describe('what counts as a mascot placement', () => {
  it('takes every mode, with or without a saved point', () => {
    for (const mode of ['full', 'bottom-right', 'bottom-left', 'free']) {
      expect(isValidMascotState({ mode, scale: 0.5, muted: false })).toBe(true);
    }
    expect(isValidMascotState(SAVED)).toBe(true);
  });

  it('takes both ends of the size range and nothing past them', () => {
    const at = (scale: unknown) => isValidMascotState({ mode: 'free', scale, muted: false });
    expect(at(0.25)).toBe(true);
    expect(at(1)).toBe(true);
    for (const bad of [0, -0, 0.2, 1.05, -0.5, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null]) {
      expect(at(bad), String(bad)).toBe(false);
    }
  });

  it('refuses anything that is not the whole shape', () => {
    for (const bad of [
      null,
      undefined,
      42,
      'free',
      [],
      {},
      { mode: 'free', scale: 0.5 },
      { mode: 'free', muted: false },
      { scale: 0.5, muted: false },
      { mode: 'centre', scale: 0.5, muted: false },
      { mode: 'free', scale: 0.5, muted: 'yes' },
      { mode: 'free', scale: 0.5, muted: 1 },
    ]) {
      expect(isValidMascotState(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses a saved point that could not be put back', () => {
    const display = { id: 7, label: 'DELL U2720Q', width: 2560, height: 1440 };
    const withSaved = (saved: unknown) =>
      isValidMascotState({ mode: 'free', scale: 0.5, muted: false, saved });
    expect(withSaved({ x: 0, y: 0, display })).toBe(true);
    // A display left of the primary one has negative coordinates.
    expect(withSaved({ x: -1800, y: 900, display })).toBe(true);
    // Some platforms give a display no name at all.
    expect(withSaved({ x: 0, y: 0, display: { ...display, label: '' } })).toBe(true);
    for (const bad of [
      null,
      'here',
      {},
      { x: 0, y: 0 },
      { x: '0', y: 0, display },
      { x: 0, y: Number.NaN, display },
      { x: Number.NEGATIVE_INFINITY, y: 0, display },
      { x: 0, y: 0, display: null },
      { x: 0, y: 0, display: { ...display, id: '7' } },
      { x: 0, y: 0, display: { ...display, id: 7.5 } },
      { x: 0, y: 0, display: { ...display, label: 7 } },
      { x: 0, y: 0, display: { ...display, width: 0 } },
      { x: 0, y: 0, display: { ...display, height: -1440 } },
      { x: 0, y: 0, display: { ...display, width: Number.NaN } },
      { x: 0, y: 0, display: { id: 7, label: 'DELL U2720Q', width: 2560 } },
    ]) {
      expect(withSaved(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('the direction a mascot faces', () => {
  const withAngle = (angle: unknown) =>
    isValidMascotState({ mode: 'free', scale: 0.5, muted: false, angle });

  it('takes a missing angle, the front, and both ends of each range', () => {
    expect(isValidMascotState({ mode: 'free', scale: 0.5, muted: false })).toBe(true);
    for (const angle of [
      { yaw: 0, pitch: 0 },
      { yaw: 180, pitch: 85 },
      { yaw: -180, pitch: -85 },
      { yaw: 10, pitch: 5, zoom: 2 },
    ]) {
      expect(withAngle(angle), JSON.stringify(angle)).toBe(true);
    }
  });

  it('refuses an angle that is not whole or is past the wire limits', () => {
    for (const bad of [
      null,
      'front',
      {},
      { yaw: 10 },
      { pitch: 10 },
      { yaw: null, pitch: 0 },
      { yaw: '10', pitch: 0 },
      { yaw: Number.NaN, pitch: 0 },
      { yaw: 0, pitch: Number.POSITIVE_INFINITY },
      { yaw: 180.0001, pitch: 0 },
      { yaw: -180.0001, pitch: 0 },
      { yaw: 0, pitch: 85.0001 },
      { yaw: 0, pitch: -85.0001 },
    ]) {
      expect(withAngle(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('comes back as it was written, and a bad one drops the whole placement', () => {
    const turned: MascotState = { ...SAVED, angle: { yaw: -120, pitch: 30 } };
    new ShellState(file).setMascot(turned);
    expect(new ShellState(file).mascot).toEqual(turned);

    writeFileSync(
      file,
      JSON.stringify({
        windows: {},
        stageMuted: false,
        mascot: { ...SAVED, angle: { yaw: 181, pitch: 0 } },
      }),
      'utf8',
    );
    expect(new ShellState(file).mascot).toBeNull();
  });
});

describe('the mascot in the settings file', () => {
  it('is absent until one has been placed', () => {
    expect(new ShellState(file).mascot).toBeNull();
  });

  it('comes back as it was written', () => {
    new ShellState(file).setMascot(SAVED);
    expect(new ShellState(file).mascot).toEqual(SAVED);
  });

  it('is written at once, since the window reload that follows wants it true', () => {
    new ShellState(file).setMascot(SAVED);
    expect(read().mascot).toEqual(SAVED);
  });

  it('keeps what the broadcast desk wrote beside it', () => {
    const stage = { x: 200, y: 120, width: 1280, height: 720 };
    writeFileSync(file, JSON.stringify({ windows: { stage }, stageMuted: true }), 'utf8');

    new ShellState(file).setMascot(SAVED);

    expect(read()).toEqual({ windows: { stage }, stageMuted: true, mascot: SAVED });
  });

  it('survives the broadcast desk writing its own part', () => {
    new ShellState(file).setMascot(SAVED);

    new ShellState(file).setStageMuted(true);

    expect(new ShellState(file).mascot).toEqual(SAVED);
    expect(new ShellState(file).stageMuted).toBe(true);
  });

  it('adds nothing to a file the mascot never touched', () => {
    new ShellState(file).setStageMuted(true);
    expect(read()).toEqual({ windows: {}, stageMuted: true });
  });

  it('reads a placement that is not one as no placement', () => {
    for (const bad of [
      'free',
      { mode: 'free', scale: 7, muted: false },
      { mode: 'sideways', scale: 0.5, muted: false },
      { mode: 'free', scale: 0.5, muted: false, saved: { x: 'left', y: 0 } },
    ]) {
      writeFileSync(file, JSON.stringify({ windows: {}, stageMuted: true, mascot: bad }), 'utf8');
      const state = new ShellState(file);
      expect(state.mascot, JSON.stringify(bad)).toBeNull();
      // The rest of the file is still read.
      expect(state.stageMuted).toBe(true);
    }
  });

  it('refuses to write a placement that is not one', () => {
    const state = new ShellState(file);
    state.setMascot({ mode: 'free', scale: 3, muted: false });
    expect(state.mascot).toBeNull();
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('hands out a copy, so a caller cannot edit what is held', () => {
    const state = new ShellState(file);
    state.setMascot(SAVED);
    const held = state.mascot;
    if (held?.saved) held.saved.x = -1;
    expect(state.mascot).toEqual(SAVED);
  });
});
