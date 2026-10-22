import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActiveGesture } from '@/engine/motion/body';
import type { TurnRequest } from '@/engine/types';
import { build } from './harness';

/**
 * Gestures written close together on one line run into each other instead of
 * returning to rest between them: a gesture whose exit would leave less than
 * `CHAIN_GAP` before the next movement cue's entrance is held until that cue
 * fires. A longer gap, or a cue with no movement, leaves the exit as authored,
 * and a line cut off exits from the cut.
 */

const KANA = 'あいうえおかきくけこさしすせそたちつてとなにぬね';
const LINE = KANA.repeat(3);

/** The line with each tag written before the mora at its index. */
function line(tags: Array<[number, string]>): string {
  let text = '';
  for (let i = 0; i < LINE.length; i++) {
    for (const [at, tag] of tags) if (at === i) text += tag;
    text += LINE[i];
  }
  return text;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const GESTURE = '[@gesture wave]';
const WITH = '[happy]';
const WITHOUT = '[calm]';

/**
 * A mora takes 0.135 s. `nod` leaves 0.82 s after it fires and the next cue
 * starts up to 0.95 s ahead of its word, so these put the gap near 0.6 s or 2.8 s.
 */
const SOURCE_CUE = '[@gesture nod]';
const SOURCE_AT = 20;
const NEXT_UNDER_CUE = 36;
const NEXT_OVER_CUE = 53;
const NEXT_UNDER_HEAD = 18;
const NEXT_OVER_HEAD = 32;

interface Case {
  n: number;
  source: 'cue' | 'turnHead';
  next: string | null;
  gap: 'under' | 'over' | null;
  cut: 'natural' | 'interrupt';
  /** Whether the exit is held for the next gesture. */
  chained: boolean;
}

const CASES: Case[] = [
  { n: 1, source: 'cue', next: GESTURE, gap: 'under', cut: 'natural', chained: true },
  { n: 2, source: 'turnHead', next: WITHOUT, gap: 'over', cut: 'natural', chained: false },
  { n: 3, source: 'cue', next: WITH, gap: 'over', cut: 'natural', chained: false },
  { n: 4, source: 'turnHead', next: null, gap: null, cut: 'interrupt', chained: false },
  { n: 5, source: 'turnHead', next: WITH, gap: 'under', cut: 'interrupt', chained: true },
  { n: 6, source: 'turnHead', next: GESTURE, gap: 'over', cut: 'interrupt', chained: false },
  { n: 7, source: 'cue', next: WITHOUT, gap: 'under', cut: 'interrupt', chained: false },
  { n: 8, source: 'cue', next: null, gap: null, cut: 'natural', chained: false },
];

function request(c: Case): TurnRequest {
  const head = c.source === 'turnHead';
  const tags: Array<[number, string]> = [];
  if (!head) tags.push([SOURCE_AT, SOURCE_CUE]);
  if (c.next) {
    const under = c.gap === 'under';
    const at = head
      ? under
        ? NEXT_UNDER_HEAD
        : NEXT_OVER_HEAD
      : under
        ? NEXT_UNDER_CUE
        : NEXT_OVER_CUE;
    tags.push([at, c.next]);
  }
  return { text: line(tags), ...(head ? { gesture: 'nod' } : {}) };
}

interface Frame {
  time: number;
  blend: number;
}

describe('gestures chain within a line', () => {
  it.each(CASES)('case $n', (c) => {
    vi.spyOn(Math, 'random').mockReturnValue(0.3);
    const h = build();
    const { body } = h.director;
    h.session.say(request(c));

    let source: ActiveGesture | null = null;
    let authoredExit = Number.NaN;
    let cutAt: number | null = null;
    const frames: Frame[] = [];
    for (let i = 0; i < 900 && (i === 0 || h.session.busy || cutAt !== null); i++) {
      h.step(1);
      const g = body.gesture;
      if (!source && g?.id === 'nod') {
        source = g;
        authoredExit = g.lead + g.def.hold;
      }
      if (!source || g !== source) {
        if (source) break;
        continue;
      }
      frames.push({ time: g.time, blend: body.blend });
      // Cut where the case says: inside the hold, or past the authored exit.
      const cutTime = c.chained ? authoredExit + 0.4 : 0.3;
      if (c.cut === 'interrupt' && cutAt === null && g.time >= cutTime) {
        cutAt = frames.length;
        h.session.interrupt();
      }
      if (cutAt !== null && frames.length >= cutAt + 3) break;
    }
    expect(source).not.toBeNull();

    if (cutAt !== null) {
      // The exit starts from the cut frame, whether or not the hold was extended.
      expect(frames.slice(cutAt, cutAt + 2).some((f) => f.blend < 1)).toBe(true);
    }
    if (c.chained) {
      const held = frames.slice(0, cutAt ?? frames.length).filter((f) => f.time >= authoredExit);
      expect(held.length).toBeGreaterThan(0);
      for (const f of held) expect(f.blend).toBe(1);
    } else if (cutAt === null) {
      const first = frames.findIndex((f) => f.time >= authoredExit);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(frames.slice(first, first + 3).some((f) => f.blend < 1)).toBe(true);
    }
  });
});
