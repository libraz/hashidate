import { describe, expect, it } from 'vitest';
import type { SlideReport } from '@/engine/types';
import { bar, barText, readout } from '@/viewer/scene/readout';
import type { Hud } from '@/viewer/scene/runtime';
import { readStageMode } from '@/viewer/stage-mode';

/**
 * The readout printed over a live frame.
 *
 * What is worth checking here is the arithmetic behind the layout rather than
 * the layout: this panel may be up while a broadcast is running, and the one
 * way it can be worse than not being there is by moving. A gauge that is not
 * always the same number of cells wide takes the column of readings with it on
 * every sample.
 */

const HUD: Hud = {
  fps: 60,
  channel: 'ARKit 52/52',
  morphs: 142,
  sway: 18,
  breath: 0.5,
  blink: 0,
  gazeX: 0,
  speaking: false,
  gesture: null,
  expression: null,
  auto: false,
  voiceBlocked: false,
};

const NO_DECK: SlideReport = { deck: null, page: 0, pages: 0, ready: false, error: null };

/**
 * The blocked-audio wording, which this file supplies rather than looks up.
 *
 * `readout` takes it as an argument for the reason it takes the avatar name as
 * one: the model is arithmetic, and a test of a gauge should not have to put a
 * locale in force before it can ask how wide the gauge is. So what is checked
 * here is that the flag carries what it was handed, not what the catalogue
 * currently says.
 */
const BLOCKED = 'audio blocked';

const sample = (
  over: { hud?: Partial<Hud>; slides?: Partial<SlideReport>; search?: string } = {},
) =>
  readout({
    hud: { ...HUD, ...over.hud },
    slides: { ...NO_DECK, ...over.slides },
    avatar: 'harmilia',
    problems: 0,
    mode: readStageMode(over.search ?? ''),
    voiceBlocked: BLOCKED,
  });

describe('bar', () => {
  it('is the same width at every reading', () => {
    for (const value of [
      -2,
      -0.4,
      0,
      0.001,
      0.33,
      0.5,
      1,
      4,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(barText(bar(value)), String(value)).toHaveLength(16);
      expect(barText(bar(value, { span: 0.5, centred: true })), String(value)).toHaveLength(16);
    }
  });

  it('fills from the left, and clamps rather than overflowing', () => {
    expect(barText(bar(0))).toBe('░'.repeat(16));
    expect(barText(bar(0.5))).toBe(`${'▓'.repeat(8)}${'░'.repeat(8)}`);
    expect(barText(bar(1))).toBe('▓'.repeat(16));
    expect(barText(bar(9))).toBe('▓'.repeat(16));
  });

  it('fills either side of the middle when the reading has a sign', () => {
    // A bar that always grows from the left cannot say which way the eyes went,
    // which is the only thing the gaze row is for.
    const right = bar(0.25, { span: 0.5, centred: true });
    expect(right.before).toHaveLength(8);
    expect(right.fill).toBe('▓'.repeat(4));

    const left = bar(-0.25, { span: 0.5, centred: true });
    expect(left.after).toHaveLength(8);
    expect(left.fill).toBe('▓'.repeat(4));
    expect(left.before).toHaveLength(4);

    expect(barText(bar(0, { span: 0.5, centred: true }))).toBe('░'.repeat(16));
  });

  it('reads a value against the span it was given, not against one', () => {
    // The gaze channel is radians and small; ±0.5 covers everything the limits
    // allow, so a quarter of a radian is the full half-track.
    expect(bar(0.5, { span: 0.5, centred: true }).fill).toBe('▓'.repeat(8));
  });
});

describe('readout', () => {
  it('names the page and its size, so a report says which source it came from', () => {
    expect(sample().head).toMatchObject({ host: 'hashidate@stage', size: 'window' });
    expect(sample({ search: '?size=1920x1080&console=1' }).head).toMatchObject({
      host: 'hashidate@console',
      size: '1920x1080',
    });
  });

  it('colours the frame rate, and nothing else that is merely a number', () => {
    // The one fault that is invisible in the picture until it is already in the
    // recording, so it is the one figure that changes colour on its own.
    expect(sample().head.fpsTone).toBe('dim');
    expect(sample({ hud: { fps: 44 } }).head.fpsTone).toBe('warn');
    expect(sample({ hud: { fps: 12 } }).head.fpsTone).toBe('bad');
  });

  it('prints the sign of the gaze even when it is zero', () => {
    const gaze = (x: number) => sample({ hud: { gazeX: x } }).gauges[2];
    expect(gaze(0).value).toBe('+0.00');
    expect(gaze(-0.08).value).toBe('-0.08');
  });

  it('says a rig resolved cleanly by saying nothing about it', () => {
    // A row that reads `problems 0` on every sample trains the eye to skip the
    // row it exists for.
    const keys = (problems: number) =>
      readout({
        hud: HUD,
        slides: NO_DECK,
        avatar: 'harmilia',
        problems,
        mode: readStageMode(''),
        voiceBlocked: BLOCKED,
      }).facts.map((f) => f.key);
    expect(keys(0)).not.toContain('problems');
    expect(keys(3)).toContain('problems');
  });

  it('has no document rows until a document is up', () => {
    expect(sample().deck).toBeNull();
    expect(sample({ slides: { deck: 'intro', page: 3, pages: 24, ready: true } }).deck).toEqual([
      { key: 'deck', value: 'intro', tone: 'ink' },
      { key: 'page', value: '3/24', tone: 'accent' },
      { key: 'state', value: 'ready', tone: 'dim' },
    ]);
  });

  it('separates a page that is up from one still being drawn', () => {
    // The only thing an operator holding an arrow key needs, and the one thing
    // the command cannot tell them.
    const drawing = sample({ slides: { deck: 'intro', page: 4, pages: 24, ready: false } });
    expect(drawing.deck?.[2]).toEqual({ key: 'state', value: 'drawing', tone: 'warn' });
  });

  it('carries the three faults nothing can be sent to fix', () => {
    const flags = (over: Parameters<typeof sample>[0]) => sample(over).flags;
    expect(flags({ hud: { voiceBlocked: true } })).toContainEqual({
      text: BLOCKED,
      tone: 'warn',
    });
    expect(flags({ slides: { deck: 'intro', error: '開けません' } })).toContainEqual({
      text: '開けません',
      tone: 'bad',
    });
    // A property of this page rather than of the performance, and the first
    // thing to check when a preview looks right and sounds like nothing.
    expect(flags({ search: '?mute=1' })).toContainEqual({ text: 'MUTED', tone: 'dim' });
  });

  it('leads with whether the character is being watched saying something', () => {
    expect(sample({ hud: { speaking: true } }).flags[0]).toEqual({ text: 'ON AIR', tone: 'live' });
    expect(sample().flags[0]).toEqual({ text: 'IDLE', tone: 'faint' });
  });
});
