import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActiveGesture } from '@/engine/motion/body';
import type { TurnRequest } from '@/engine/types';
import { build, DT, type Harness } from './harness';

/**
 * A movement cue lands on the word it is written before: it starts early by
 * its own lead, so the entrance completes at the cue's time rather than
 * starting there. Everything else fires on its time, and nothing overtakes
 * what was written before it.
 */

const KANA = 'あいうえおかきくけこさしすせそたちつてとなにぬね';

/** A line of `KANA.length` morae with each tag written before the mora at its index. */
function line(tags: Array<[number, string]>): string {
  let text = '';
  for (let i = 0; i < KANA.length; i++) {
    for (const [at, tag] of tags) if (at === i) text += tag;
    text += KANA[i];
  }
  return text;
}

interface Fire {
  /** `head` for the turn's own fields, else the cue's written position among the cues. */
  source: 'head' | number;
  id: string;
  /** Mouth time the session fired it at. */
  at: number;
  frame: number;
  /** The slot it put up, or null when it played no movement. */
  slot: ActiveGesture | null;
  /** `leadFor` as the session saw it on the firing frame. */
  probe: number;
  /** Mouth time at the start of the frame the entrance completed on. */
  done?: number;
}

interface Run {
  fires: Fire[];
  /** Each cue's written time on the mouth clock, in written order. */
  t: number[];
  h: Harness;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Play one turn to its end and log what fired when, and when each entrance completed. */
function play(request: TurnRequest): Run {
  // Pinned before the director is built: it captures its source at construction.
  vi.spyOn(Math, 'random').mockReturnValue(0.3);
  const fires: Fire[] = [];
  let spoken = false;
  let frame = 0;
  let cue = 0;
  const h = build({ camera: () => record('camera', '', 0, () => {}) });
  const { director } = h;
  const record = (
    kind: 'gesture' | 'perform' | 'camera',
    id: string,
    probe: number,
    call: () => void,
  ): void => {
    const before = director.body.gesture;
    call();
    const after = director.body.gesture;
    fires.push({
      source: spoken ? cue++ : 'head',
      id: kind === 'camera' ? 'camera' : id,
      at: director.mouth.time,
      frame,
      slot: after !== before ? after : null,
      probe,
    });
  };
  const gesture = director.gesture.bind(director);
  const perform = director.perform.bind(director);
  const speak = director.speak.bind(director);
  vi.spyOn(director, 'gesture').mockImplementation((id, side) =>
    record('gesture', id, director.leadFor('gesture', id), () => gesture(id, side)),
  );
  // A null is the turn's own release at its end, not a cue.
  vi.spyOn(director, 'perform').mockImplementation((id, side) =>
    id === null
      ? perform(id, side)
      : record('perform', id, director.leadFor('perform', id), () => perform(id, side)),
  );
  vi.spyOn(director, 'speak').mockImplementation((...args) => {
    spoken = true;
    return speak(...args);
  });
  let seconds = 0;
  h.session.on((ev) => {
    if (ev.type === 'turn.start') seconds = ev.seconds ?? 0;
  });

  h.session.say(request);
  h.step(1);
  frame++;
  const t = (h.session.turn?.cues ?? []).map((c) => c.at * seconds);
  for (let i = 0; i < 600 && h.session.busy; i++) {
    const mouth = director.mouth.time;
    h.step(1);
    frame++;
    for (const f of fires) {
      if (f.slot && f.done === undefined && director.body.gesture === f.slot) {
        if (director.body.blend === 1) f.done = mouth;
      }
    }
  }
  return { fires, t, h };
}

const cueFire = (run: Run, index: number): Fire => {
  const f = run.fires.find((x) => x.source === index);
  if (!f) throw new Error(`cue ${index} never fired`);
  return f;
};

/** Mouth time a fresh renderer's entrance for `kind`/`id` would take from rest. */
function restLead(kind: 'gesture' | 'perform', id: string): number {
  vi.spyOn(Math, 'random').mockReturnValue(0.3);
  const lead = build().director.leadFor(kind, id);
  vi.restoreAllMocks();
  return lead;
}

const GESTURE = '[@gesture wave]';
const WITH = '[happy]';
const WITHOUT = '[calm]';
const CAMERA = '[@camera full]';
const MOTION = '[@gesture present]';

type Expect =
  /** Fires on the first frame at or past its time. */
  | 'atT'
  /** Lands on its time: entrance complete within [t - 2·DT, t + DT]. */
  | 'lands'
  /** Fires with the line and lands on its lead. */
  | 'head'
  /** Fires on the same frame as the cue before it, and the later one stays up. */
  | 'sameFrame';

interface Case {
  n: number;
  motion: string;
  /** The cue under test, as written. */
  tags: Array<[number, string]>;
  /** Index of the cue under test among the written cues. */
  under: number;
  head?: string;
  expect: Expect;
}

const AFTER = 14;
const BEFORE = 2;

const CASES: Case[] = [
  {
    n: 1,
    motion: WITHOUT,
    tags: [
      [0, CAMERA],
      [BEFORE, WITHOUT],
    ],
    under: 1,
    expect: 'atT',
  },
  { n: 2, motion: GESTURE, tags: [[BEFORE, GESTURE]], under: 0, expect: 'head' },
  { n: 3, motion: WITHOUT, tags: [[AFTER, WITHOUT]], under: 0, head: 'nod', expect: 'atT' },
  {
    n: 4,
    motion: WITHOUT,
    tags: [
      [3, MOTION],
      [AFTER, WITHOUT],
    ],
    under: 1,
    expect: 'atT',
  },
  {
    n: 5,
    motion: WITHOUT,
    tags: [
      [AFTER - 1, CAMERA],
      [AFTER, WITHOUT],
    ],
    under: 1,
    expect: 'atT',
  },
  {
    n: 6,
    motion: WITH,
    tags: [
      [3, CAMERA],
      [AFTER, WITH],
    ],
    under: 1,
    expect: 'lands',
  },
  { n: 7, motion: WITH, tags: [[BEFORE, WITH]], under: 0, head: 'nod', expect: 'head' },
  {
    n: 8,
    motion: WITH,
    tags: [
      [1, MOTION],
      [BEFORE, WITH],
    ],
    under: 1,
    expect: 'sameFrame',
  },
  {
    n: 9,
    motion: GESTURE,
    tags: [
      [3, CAMERA],
      [AFTER, GESTURE],
    ],
    under: 1,
    expect: 'lands',
  },
  {
    n: 10,
    motion: GESTURE,
    tags: [
      [0, CAMERA],
      [BEFORE, GESTURE],
    ],
    under: 1,
    expect: 'head',
  },
  { n: 11, motion: GESTURE, tags: [[BEFORE, GESTURE]], under: 0, head: 'nod', expect: 'head' },
  { n: 12, motion: WITHOUT, tags: [[BEFORE, WITHOUT]], under: 0, expect: 'atT' },
  {
    n: 13,
    motion: GESTURE,
    tags: [
      [1, MOTION],
      [BEFORE, GESTURE],
    ],
    under: 1,
    expect: 'sameFrame',
  },
  { n: 14, motion: WITH, tags: [[AFTER, WITH]], under: 0, expect: 'lands' },
];

const kindOf = (tag: string): ['gesture' | 'perform', string] =>
  tag.startsWith('[@gesture ') ? ['gesture', tag.slice(10, -1)] : ['perform', tag.slice(1, -1)];

describe('movement cues land on the word', () => {
  it.each(CASES)('case $n', (c) => {
    const [kind, id] = kindOf(c.motion);
    const run = play({ text: line(c.tags), ...(c.head ? { gesture: c.head } : {}) });
    const { fires, t } = run;
    const tU = t[c.under];
    const fire = cueFire(run, c.under);

    // Written order, whatever fired early.
    const order = fires.filter((f) => f.source !== 'head').map((f) => f.source);
    expect(order).toEqual(c.tags.map((_, i) => i));

    // The position the case claims, checked against a renderer at rest.
    const bound = restLead(kind, id);
    if (c.tags[c.under][0] === BEFORE && bound > 0) expect(tU).toBeLessThan(bound);
    if (c.tags[c.under][0] === AFTER) expect(tU).toBeGreaterThan(0.95 + DT);

    switch (c.expect) {
      case 'atT':
        expect(fire.slot).toBeNull();
        expect(fire.at).toBeGreaterThanOrEqual(tU);
        expect(fire.at).toBeLessThan(tU + DT + 1e-9);
        break;
      case 'lands':
        expect(fire.slot).not.toBeNull();
        expect(fire.done).toBeDefined();
        expect(fire.done).toBeGreaterThanOrEqual(tU - 2 * DT);
        expect(fire.done).toBeLessThanOrEqual(tU + DT);
        break;
      case 'head': {
        expect(fire.frame).toBe(0);
        expect(fire.at).toBe(0);
        const lead = fire.slot?.lead ?? Number.NaN;
        expect(fire.done).toBeGreaterThanOrEqual(lead - 2 * DT);
        expect(fire.done).toBeLessThanOrEqual(lead + DT);
        // Anything the line opened with gave way to it on the same frame (D11).
        for (const f of fires) if (f !== fire && f.frame === 0) expect(f.done).toBeUndefined();
        break;
      }
      case 'sameFrame': {
        const prior = cueFire(run, c.under - 1);
        expect(prior.frame).toBe(fire.frame);
        expect(prior.slot).not.toBeNull();
        expect(fire.slot).not.toBeNull();
        expect(prior.done).toBeUndefined();
        expect(fire.done).toBeDefined();
        break;
      }
    }
  });

  it('a movement cue behind a shot waits for the shot, and is late by no more than its lead', () => {
    const run = play({
      text: line([
        [AFTER - 1, CAMERA],
        [AFTER, GESTURE],
      ]),
    });
    const [tC] = run.t;
    const shot = cueFire(run, 0);
    const fire = cueFire(run, 1);
    expect(fire.frame).toBe(shot.frame);
    const lead = fire.slot?.lead ?? Number.NaN;
    expect(fire.done).toBeDefined();
    expect(fire.done).toBeLessThanOrEqual(tC + lead + DT);
  });

  it('a movement cue after another lands on its word, or as soon as its lead allows', () => {
    const run = play({
      text: line([
        [6, '[@gesture nod]'],
        [AFTER, GESTURE],
      ]),
    });
    const tB = run.t[1];
    const a = cueFire(run, 0);
    const b = cueFire(run, 1);
    const lead = b.slot?.lead ?? Number.NaN;
    expect(tB - lead).toBeGreaterThan(run.t[0]);
    expect(b.done).toBeDefined();
    const done = b.done ?? Number.NaN;
    expect(done).toBeLessThanOrEqual(Math.max(tB, a.at + lead) + 3 * DT);
    expect(tB - done).toBeLessThanOrEqual(b.probe - lead + 2 * DT);
  });

  it('times the in-window probe', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.3);
    const { director, step } = build();
    director.gesture('present');
    step(20);
    director.gesture('explain');
    step(8);
    const calls = 500;
    director.leadFor('gesture', 'wave');
    const start = performance.now();
    for (let i = 0; i < calls; i++) director.leadFor('gesture', 'wave');
    const perCall = (performance.now() - start) / calls;
    // Logged, not asserted: a wall-clock figure for the per-frame budget, not a contract.
    console.log(`leadFor in window: ${perCall.toFixed(4)} ms per call`);
    expect(director.leadBound('gesture', 'wave')).toBeGreaterThan(0);
    expect(director.leadBound('perform', 'calm')).toBe(0);
    expect(director.leadFor('perform', 'calm')).toBe(0);
  });
});
