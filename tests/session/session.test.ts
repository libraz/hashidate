import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Director } from '@/engine/director';
import { textToVisemes } from '@/engine/face';
import { HOPS, planJump } from '@/engine/motion';
import { CROUCH_T, RECOVER_T } from '@/engine/motion/jump';
import { PERFORMANCE_TABLE } from '@/engine/performance';
import { buildProfile } from '@/engine/profile';
import { Wardrobe } from '@/engine/scene';
import { Session } from '@/engine/session';
import type {
  Composition,
  LabelledId,
  Placement,
  PlacementReport,
  SessionEvent,
  SessionEventType,
  Shot,
  SlidePlacement,
  SlideReport,
  Slides,
  Take,
  Voice,
  VoiceChainRequest,
  VoiceReport,
  WardrobeTable,
} from '@/engine/types';
import { same } from '@/i18n/locale';
import { buildRig } from '../helpers/scene';

/**
 * The turn queue, driven the way the real loop drives it: `session.update(dt)`
 * first, then `director.update(dt)`, at a fixed step. Everything below the
 * session is real — a synthetic rig, a resolved profile and a live director —
 * because the session's contract is with a director and not with a stub of one.
 */

/** The fixed step the viewer's loop runs at. */
const DT = 1 / 60;

/** `TURN_GAP` in `session.ts`. */
const TURN_GAP = 0.28;

/** `IDLE_AFTER` in `session.ts`. */
const IDLE_AFTER = 1.6;

/** `VOICE_WAIT` in `session.ts`. */
const VOICE_WAIT = 5;

const FACES = ['F_DOYA', 'F_JITO', 'F_SUYASUYA'];
const EFFECTS = ['FX_BLUSH', 'FX_TEARS'];

const WARDROBE: WardrobeTable = {
  slots: {
    top: {
      label: same('トップス'),
      items: [{ id: 'shirt', label: same('シャツ'), meshes: ['Shirt'] }],
    },
  },
  presets: { bare: { label: same('素'), set: { top: null } } },
};

interface Harness {
  session: Session;
  director: Director;
  /** Simulated seconds since the harness was built. */
  now: () => number;
  /** Advance the loop by `frames` steps of `DT`. */
  step: (frames: number) => void;
  /** Advance until `done()` holds, or fail after `limit` seconds. */
  runUntil: (done: () => boolean, limit?: number) => void;
}

function build({
  wardrobe = false,
  idle = false,
  voice,
  camera,
  scenery,
  slides,
  composition,
}: {
  wardrobe?: boolean;
  idle?: boolean;
  /** Handed the harness's own clock, so a fake take can run on simulated time. */
  voice?: (now: () => number) => Voice;
  /** The staging hooks a renderer supplies, for the turns that carry a shot. */
  camera?: (shot: Shot) => void;
  scenery?: { backdrops: LabelledId[]; setBackdrop: (id: string | null) => void };
  /** The document layer, absent on every renderer that has none. */
  slides?: Slides;
  composition?: Composition;
} = {}) {
  const rig = buildRig({
    groups: [
      ['Face', FACES],
      ['FX', EFFECTS],
    ],
    garments: ['Shirt'],
  });
  const profile = buildProfile(rig.root, {
    ...rig.descriptor,
    presets: { group: 'Face', emotion: { joy: 'F_DOYA' } },
    overlays: { group: 'FX' },
    ...(wardrobe ? { wardrobe: WARDROBE } : {}),
  });
  const director = new Director(profile);
  let clock = 0;
  const session = new Session(director, {
    wardrobe: wardrobe ? new Wardrobe(rig.root, profile, WARDROBE) : null,
    idle,
    voice: voice?.(() => clock),
    camera,
    scenery,
    slides,
    composition,
  });

  const step = (frames: number): void => {
    for (let i = 0; i < frames; i++) {
      session.update(DT);
      director.update(DT);
      clock += DT;
    }
  };
  const runUntil = (done: () => boolean, limit = 20): void => {
    const cap = Math.ceil(limit / DT);
    for (let i = 0; i < cap; i++) {
      if (done()) return;
      step(1);
    }
    throw new Error('condition never held within the frame budget');
  };

  const harness: Harness = { session, director, now: () => clock, step, runUntil };
  return harness;
}

/** Event types, in emission order. */
const types = (events: SessionEvent[]): SessionEventType[] => events.map((e) => e.type);

describe('Session.say', () => {
  it('returns the id it queued the turn under', () => {
    const { session } = build();
    const id = session.say({ text: 'あいうえお' });
    expect(id).toMatch(/^t[0-9a-z]+-[0-9a-z]+$/);
    expect(session.queue).toHaveLength(1);
    expect(session.queue[0].id).toBe(id);
  });

  it('keeps a caller-supplied id rather than generating over it', () => {
    const { session } = build();
    expect(session.say({ id: 'turn-7', text: 'あ' })).toBe('turn-7');
    expect(session.queue[0].id).toBe('turn-7');
  });

  it('reports the resulting queue depth on turn.queued', () => {
    const { session } = build();
    session.say({ id: 'a' });
    session.say({ id: 'b' });
    expect(session.takeEvents()).toEqual([
      { type: 'turn.queued', turn: 'a', queued: 1 },
      { type: 'turn.queued', turn: 'b', queued: 2 },
    ]);
  });

  it('defaults every optional field, leaving text empty', () => {
    const { session } = build();
    session.say();
    expect(session.queue[0]).toMatchObject({
      text: '',
      emotion: null,
      expression: null,
      gesture: null,
      hold: false,
    });
  });
});

describe('turn sequencing', () => {
  it('plays queued turns in the order they were given', () => {
    const { session, runUntil } = build();
    const started: string[] = [];
    session.on((ev) => {
      if (ev.type === 'turn.start' && ev.turn) started.push(ev.turn);
    });
    session.say({ id: 'first', text: 'あい' });
    session.say({ id: 'second', text: 'うえ' });
    session.say({ id: 'third', text: 'おか' });
    runUntil(() => !session.busy);
    expect(started).toEqual(['first', 'second', 'third']);
  });

  it('leaves TURN_GAP between the end of one turn and the start of the next', () => {
    const { session, now, runUntil } = build();
    const at = new Map<string, number>();
    session.on((ev) => at.set(`${ev.type}:${ev.turn}`, now()));
    session.say({ id: 'a', text: 'あい' });
    session.say({ id: 'b', text: 'うえ' });
    runUntil(() => !session.busy);

    const gap = (at.get('turn.start:b') as number) - (at.get('turn.end:a') as number);
    expect(gap).toBeGreaterThanOrEqual(TURN_GAP);
    expect(gap).toBeLessThan(TURN_GAP + 2 * DT);
  });

  it('ends the turn when the mouth stops, not when the duration speak() returned elapses', () => {
    const { session, now, runUntil } = build();
    let startedAt = 0;
    let endedAt = 0;
    let seconds = 0;
    session.on((ev) => {
      if (ev.type === 'turn.start') {
        startedAt = now();
        seconds = ev.seconds ?? 0;
      }
      if (ev.type === 'turn.end') endedAt = now();
    });
    session.say({ id: 'a', text: 'あいうえおかきくけこ' });
    runUntil(() => endedAt > 0);

    expect(seconds).toBeGreaterThan(0);
    // The mouth releases the last mora after the estimate runs out, so a turn
    // driven off `seconds` would cut the line short.
    // The mouth holds the last mora for a beat past the estimate, so the turn
    // outlives `seconds` by that release and one frame of detection — a turn
    // driven off the returned duration would close roughly a fifth of a second
    // early, every line, and the error would accumulate down the queue.
    expect(endedAt - startedAt).toBeGreaterThan(seconds + 0.19);
    expect(endedAt - startedAt).toBeLessThan(seconds + 0.24);
  });

  it('builds the viseme track from the reading when one is given, not from the text', () => {
    const { session, runUntil } = build();
    const seen: number[] = [];
    session.on((ev) => {
      if (ev.type === 'turn.start') seen.push(ev.seconds ?? 0);
    });
    // Written, the mouth has to guess: it counts each kanji as two morae, so
    // 三件 comes out four beats long. The kana says it is さ-ん-け-ん, and the
    // two ん are shorter than a full mora — a different length, which is the
    // only way to tell from out here which string the track was built from.
    session.say({ id: 'written', text: '三件' });
    runUntil(() => !session.busy);
    session.say({ id: 'read', text: '三件', reading: 'さんけん' });
    runUntil(() => !session.busy);

    const [written, read] = seen;
    expect(written).toBeCloseTo(textToVisemes('三件').duration, 12);
    expect(read).toBeCloseTo(textToVisemes('さんけん').duration, 12);
    expect(read).not.toBeCloseTo(written, 3);
  });

  it('falls back to the text when no reading is given', () => {
    const { session, runUntil } = build();
    const seen: number[] = [];
    session.on((ev) => {
      if (ev.type === 'turn.start') seen.push(ev.seconds ?? 0);
    });
    session.say({ id: 'a', text: 'さんけん' });
    runUntil(() => !session.busy);
    session.say({ id: 'b', text: 'さんけん', reading: 'さんけん' });
    runUntil(() => !session.busy);

    expect(seen[0]).toBeCloseTo(seen[1], 12);
  });

  it('keeps the turn open while the mouth is still speaking past the estimate', () => {
    const { session, director, step } = build();
    let seconds = 0;
    session.on((ev) => {
      if (ev.type === 'turn.start') seconds = ev.seconds ?? 0;
    });
    session.say({ id: 'a', text: 'あいうえおかきくけこ' });
    step(1);
    step(Math.ceil(seconds / DT));

    expect(director.mouth.speaking).toBe(true);
    expect(session.turn?.id).toBe('a');
  });

  it('emits turn.queued, turn.start, turn.end and queue.empty as the last turn drains', () => {
    const { session, runUntil } = build();
    session.say({ id: 'only', text: 'あい' });
    runUntil(() => !session.busy);
    expect(types(session.takeEvents())).toEqual([
      'turn.queued',
      'turn.start',
      'turn.end',
      'queue.empty',
    ]);
  });

  it('withholds queue.empty until the last turn of a run ends', () => {
    const { session, runUntil } = build();
    session.say({ id: 'a', text: 'あい' });
    session.say({ id: 'b', text: 'うえ' });
    runUntil(() => !session.busy);
    const seen = types(session.takeEvents());
    expect(seen.filter((t) => t === 'queue.empty')).toHaveLength(1);
    expect(seen[seen.length - 1]).toBe('queue.empty');
  });

  it('reports busy from the moment a turn is queued until the queue drains', () => {
    const { session, runUntil } = build();
    expect(session.busy).toBe(false);
    session.say({ id: 'a', text: 'あい' });
    expect(session.busy).toBe(true);
    runUntil(() => !session.busy);
    expect(session.turn).toBeNull();
    expect(session.queue).toHaveLength(0);
  });
});

describe('Session.interrupt', () => {
  it('stops the current line, drops the queue and reports both', () => {
    const { session, director, step } = build();
    session.say({ id: 'a', text: 'あいうえおかきくけこ' });
    session.say({ id: 'b', text: 'さしすせそ' });
    step(4);
    expect(session.turn?.id).toBe('a');
    session.takeEvents();

    session.interrupt();

    expect(session.turn).toBeNull();
    expect(session.queue).toHaveLength(0);
    expect(director.mouth.speaking).toBe(false);
    expect(session.takeEvents()).toEqual([
      { type: 'turn.interrupted', turn: 'a' },
      { type: 'queue.dropped', turns: ['b'] },
    ]);
  });

  it('releases the running gesture along with the line', () => {
    const { session, director, step } = build();
    session.say({ id: 'a', text: 'あいうえお', gesture: 'wave' });
    step(4);
    expect(director.body.gesture?.id).toBe('wave');
    session.interrupt();
    expect(director.body.gesture?.released).toBe(true);
  });

  it('emits nothing when there is neither a turn nor a queue', () => {
    const { session } = build();
    session.interrupt();
    expect(session.takeEvents()).toEqual([]);
  });

  it('starts the next queued turn without waiting out a gap', () => {
    const { session, now, step } = build();
    session.say({ id: 'a', text: 'あいうえおかきくけこ' });
    step(4);
    session.interrupt();
    session.takeEvents();

    const interruptedAt = now();
    session.say({ id: 'b', text: 'さし' });
    let startedAt = 0;
    session.on((ev) => {
      if (ev.type === 'turn.start') startedAt = now();
    });
    step(1);
    expect(startedAt - interruptedAt).toBeLessThan(TURN_GAP);
  });
});

describe('Session.clearQueue', () => {
  it('drops what is pending and lets the current line finish', () => {
    const { session, step, runUntil } = build();
    session.say({ id: 'a', text: 'あいうえお' });
    session.say({ id: 'b', text: 'かきくけこ' });
    step(4);
    session.takeEvents();

    session.clearQueue();

    expect(session.turn?.id).toBe('a');
    expect(session.queue).toHaveLength(0);
    expect(session.takeEvents()).toEqual([{ type: 'queue.dropped', turns: ['b'] }]);

    const ended: string[] = [];
    session.on((ev) => {
      if (ev.type === 'turn.end' && ev.turn) ended.push(ev.turn);
    });
    runUntil(() => !session.busy);
    expect(ended).toEqual(['a']);
  });

  it('emits nothing when there is nothing pending', () => {
    const { session, step } = build();
    session.say({ id: 'a', text: 'あいうえお' });
    step(4);
    session.takeEvents();
    session.clearQueue();
    expect(session.takeEvents()).toEqual([]);
  });
});

describe('a held queue', () => {
  it('keeps the lines and does not start one', () => {
    // The third thing that can be done to a run of turns, and the only one that
    // keeps them: `interrupt` cuts and drops, `clear` drops, this drops nothing.
    const { session, step } = build();
    session.paused = true;
    session.say({ id: 'a', text: 'あいうえお' });
    session.say({ id: 'b', text: 'かきくけこ' });
    step(120);

    expect(session.turn).toBeNull();
    expect(session.queue.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('starts the first line as soon as the hold comes off', () => {
    const { session, step } = build();
    session.paused = true;
    session.say({ id: 'a', text: 'あいうえお' });
    step(60);
    expect(session.turn).toBeNull();

    session.paused = false;
    step(1);
    expect(session.turn?.id).toBe('a');
  });

  it('lets the line on air finish rather than cutting it', () => {
    const { session, step, runUntil } = build();
    session.say({ id: 'a', text: 'あいうえお' });
    session.say({ id: 'b', text: 'かきくけこ' });
    step(4);
    expect(session.turn?.id).toBe('a');

    session.paused = true;
    runUntil(() => session.turn === null, 30);
    // 'a' ran to its end; 'b' is still waiting rather than dropped.
    expect(session.queue.map((t) => t.id)).toEqual(['b']);
  });

  it('holds a line said directly, on the same footing as one from a script', () => {
    // A `say` goes onto the same queue as anything else, and a hold some lines
    // could walk past would not be one.
    const { session, step } = build();
    session.paused = true;
    session.say({ id: 'a', text: 'あい' });
    step(60);
    expect(session.turn).toBeNull();
  });

  it('does not count as busy, so the character stays alive while a shot is framed', () => {
    // This is the stretch a recording opens on, and it is the one place a
    // character holding perfectly still would be kept.
    const { session, step } = build({ idle: true });
    session.paused = true;
    session.say({ id: 'a', text: 'あい' });
    step(1);
    expect(session.busy).toBe(false);
    step(Math.ceil((IDLE_AFTER + 0.2) / DT));
    expect(session.d.auto).toBe(true);
  });
});

describe('what a turn leaves behind', () => {
  it('keeps the emotion after the turn ends, because a mood outlives its sentence', () => {
    const { session, runUntil } = build();
    session.say({ id: 'a', text: 'あい', emotion: { joy: 0.9 } });
    runUntil(() => !session.busy);
    expect(session.state().emotion).toEqual({ joy: 0.9 });
  });

  it('releases the drawn expression when the turn ends', () => {
    const { session, director, step, runUntil } = build();
    session.say({ id: 'a', text: 'あいうえお', expression: 'F_JITO' });
    step(2);
    expect(director.pickedExpression).toBe('F_JITO');
    runUntil(() => !session.busy);
    expect(director.pickedExpression).toBeNull();
  });

  it('holds the drawn expression past the turn when hold is set', () => {
    const { session, director, step, runUntil } = build();
    session.say({ id: 'a', text: 'あいうえお', expression: 'F_JITO', hold: true });
    step(2);
    expect(director.pickedExpression).toBe('F_JITO');
    runUntil(() => !session.busy);
    expect(director.pickedExpression).toBe('F_JITO');
  });

  it('leaves an expression set outside the turn alone', () => {
    const { session, director, runUntil } = build();
    session.setExpression('F_DOYA');
    session.say({ id: 'a', text: 'あい' });
    runUntil(() => !session.busy);
    expect(director.pickedExpression).toBe('F_DOYA');
  });

  it('releases the expression of an interrupted turn too', () => {
    const { session, director, step } = build();
    session.say({ id: 'a', text: 'あいうえおかき', expression: 'F_JITO' });
    step(2);
    session.interrupt();
    expect(director.pickedExpression).toBeNull();
  });
});

describe('a turn with no text', () => {
  it('is a pose change and closes on the next frame', () => {
    const { session, director, step } = build();
    session.say({ id: 'pose', gesture: 'wave', emotion: { surprise: 1 } });
    step(1);
    expect(session.turn?.id).toBe('pose');
    expect(director.body.gesture?.id).toBe('wave');

    step(1);
    expect(session.turn).toBeNull();
    expect(types(session.takeEvents())).toEqual([
      'turn.queued',
      'turn.start',
      'turn.end',
      'queue.empty',
    ]);
  });

  it('reports zero seconds on turn.start', () => {
    const { session, step } = build();
    session.say({ id: 'pose', gesture: 'nod' });
    step(1);
    const start = session.takeEvents().find((e) => e.type === 'turn.start');
    expect(start?.seconds).toBe(0);
  });
});

describe('the idle autopilot', () => {
  it('stays off while idleEnabled is false, however long the queue is empty', () => {
    const { session, director, step } = build({ idle: false });
    step(Math.ceil((IDLE_AFTER + 1) / DT));
    expect(session.idleEnabled).toBe(false);
    expect(director.auto).toBe(false);
  });

  it('takes over once idleEnabled is on and the gap has passed', () => {
    const { session, director, now, step } = build({ idle: true });
    expect(session.idleEnabled).toBe(true);
    step(Math.ceil(IDLE_AFTER / DT));
    expect(director.auto).toBe(false);
    step(3);
    expect(director.auto).toBe(true);
    expect(now()).toBeGreaterThan(IDLE_AFTER);
  });

  it('is suspended while a turn is in flight', () => {
    const { session, director, step } = build({ idle: true });
    step(Math.ceil((IDLE_AFTER + 1) / DT));
    expect(director.auto).toBe(true);

    session.say({ id: 'a', text: 'あいうえおかきくけこ' });
    step(2);
    expect(director.auto).toBe(false);
  });

  it('stays suspended for IDLE_AFTER past the end of the last turn', () => {
    const { session, director, now, step, runUntil } = build({ idle: true });
    session.say({ id: 'a', text: 'あい' });
    let endedAt = 0;
    session.on((ev) => {
      if (ev.type === 'turn.end') endedAt = now();
    });
    runUntil(() => !session.busy);
    expect(director.auto).toBe(false);

    step(Math.ceil(IDLE_AFTER / DT) - 2);
    expect(director.auto).toBe(false);
    step(4);
    expect(director.auto).toBe(true);
    expect(now() - endedAt).toBeGreaterThan(IDLE_AFTER);
  });

  it('setIdle(false) hands the autopilot back immediately', () => {
    const { session, director, step } = build({ idle: true });
    step(Math.ceil((IDLE_AFTER + 1) / DT));
    expect(director.auto).toBe(true);
    session.setIdle(false);
    step(1);
    expect(director.auto).toBe(false);
  });
});

describe('events', () => {
  it('takeEvents drains what it returns', () => {
    const { session } = build();
    session.say({ id: 'a' });
    expect(session.takeEvents()).toHaveLength(1);
    expect(session.takeEvents()).toEqual([]);
  });

  it('delivers to a listener and to takeEvents alike', () => {
    const { session } = build();
    const seen: SessionEvent[] = [];
    session.on((ev) => seen.push(ev));
    session.say({ id: 'a' });
    expect(seen).toEqual(session.takeEvents());
  });

  it('on() returns an unsubscribe that stops delivery', () => {
    const { session } = build();
    const seen: SessionEvent[] = [];
    const off = session.on((ev) => seen.push(ev));
    session.say({ id: 'a' });
    off();
    session.say({ id: 'b' });
    expect(seen.map((e) => e.turn)).toEqual(['a']);
  });

  it('leaves other listeners subscribed when one unsubscribes', () => {
    const { session } = build();
    const kept: string[] = [];
    const off = session.on(() => {});
    session.on((ev) => kept.push(ev.turn as string));
    off();
    session.say({ id: 'a' });
    expect(kept).toEqual(['a']);
  });
});

describe('Session.state', () => {
  it('reports the shape types.ts declares', () => {
    const { session } = build({ wardrobe: true });
    const state = session.state();
    expect(Object.keys(state).sort()).toEqual(
      [
        'busy',
        'emotion',
        'expression',
        'gesture',
        'idle',
        'idleEnabled',
        'hopping',
        'lookAt',
        'overlays',
        'performance',
        'pickedExpression',
        'queued',
        'speaking',
        'strain',
        'turn',
        'wardrobe',
      ].sort(),
    );
    expect(state).toMatchObject({
      speaking: false,
      turn: null,
      queued: 0,
      busy: false,
      idle: false,
      idleEnabled: false,
      expression: null,
      pickedExpression: null,
      overlays: {},
      performance: null,
      gesture: null,
      hopping: false,
      strain: { L: 0, R: 0 },
    });
    expect(state.wardrobe).toEqual({ top: null });
  });

  it('reports null wardrobe for a session built without one', () => {
    const { session } = build();
    expect(session.state().wardrobe).toBeNull();
  });

  it('tracks the running turn, the queue depth and the mouth', () => {
    const { session, step } = build();
    session.say({ id: 'a', text: 'あいうえおかきくけこ' });
    session.say({ id: 'b', text: 'さし' });
    step(4);
    const state = session.state();
    expect(state).toMatchObject({ turn: 'a', queued: 1, busy: true, speaking: true });
  });

  it('rounds the emotion vector and drops the weights below a hundredth', () => {
    const { session } = build();
    session.setEmotion({ joy: 0.123_456, sadness: 0.004 });
    expect(session.state().emotion).toEqual({ joy: 0.12 });
  });

  it('reports raised overlays by id and weight', () => {
    const { session } = build();
    session.setOverlay('FX_BLUSH', 0.4);
    expect(session.state().overlays).toEqual({ FX_BLUSH: 0.4 });
  });
});

describe('Session.vocabulary', () => {
  it('reports the shape types.ts declares', () => {
    const { session } = build({ wardrobe: true });
    const vocabulary = session.vocabulary();
    expect(Object.keys(vocabulary).sort()).toEqual(
      [
        'avatar',
        'backdrops',
        'cameras',
        'cue',
        'emotions',
        'expressions',
        'gestures',
        'hops',
        'overlays',
        'performances',
        'pointing',
        'rooms',
        'voicePresets',
        'wardrobe',
        'wardrobePresets',
      ].sort(),
    );
    expect(vocabulary.avatar).toEqual({
      id: 'synthetic',
      label: { en: 'Synthetic rig', ja: '合成リグ' },
    });
    expect(vocabulary.cameras).toEqual(['bust', 'upper', 'face', 'full']);
    expect(vocabulary.pointing).toMatchObject({
      side: ['L', 'R'],
      azimuth: [-120, 120],
      elevation: [-70, 110],
      extent: [0.1, 1],
      finger: ['thumb', 'index', 'middle', 'ring', 'little'],
    });
    expect(vocabulary.emotions.map((e) => e.id)).toContain('joy');
    expect(vocabulary.gestures.find((g) => g.id === 'wave')).toMatchObject({
      group: 'greeting',
      sustain: false,
    });
    expect(vocabulary.gestures.find((g) => g.id === 'thumbsUp')?.sustain).toBe(true);
  });

  it('is discovered from the avatar rather than declared', () => {
    const { session } = build();
    expect(session.vocabulary().expressions.map((e) => e.id)).toEqual(FACES);
    expect(session.vocabulary().overlays.map((o) => o.id)).toEqual(EFFECTS);
  });

  it('yields an empty wardrobe for an avatar that has none, rather than throwing', () => {
    const { session } = build();
    expect(session.vocabulary().wardrobe).toEqual({});
    expect(session.vocabulary().wardrobePresets).toEqual([]);
  });

  it('reports the loaded wardrobe slots and presets', () => {
    const { session } = build({ wardrobe: true });
    const vocabulary = session.vocabulary();
    expect(vocabulary.wardrobe).toEqual({
      top: { label: same('トップス'), items: [{ id: 'shirt', label: same('シャツ') }] },
    });
    expect(vocabulary.wardrobePresets).toEqual([{ id: 'bare', label: same('素') }]);
  });
});

describe('Session.point', () => {
  it('states the bearing in degrees, handing it down unconverted', () => {
    const { session, director } = build();
    const spy = vi.spyOn(director.body, 'point');
    session.point({ side: 'L', azimuth: 45, elevation: -20, extent: 0.6, finger: 'middle' });
    expect(spy).toHaveBeenCalledWith('L', {
      azimuth: 45,
      elevation: -20,
      extent: 0.6,
      finger: 'middle',
    });
  });

  it('defaults to the right index finger straight ahead', () => {
    const { session, director } = build();
    const spy = vi.spyOn(director.body, 'point');
    session.point();
    expect(spy).toHaveBeenCalledWith('R', {
      azimuth: 0,
      elevation: 0,
      extent: 0.8,
      finger: 'index',
    });
  });

  it('lifts the arm for 90 degrees of elevation and not for 90 radians worth', () => {
    const handHeight = (elevation: number): number => {
      const h = build();
      h.session.point({ side: 'R', elevation });
      h.step(90);
      const hand = h.director.p.bones['hand.R'];
      if (!hand) throw new Error('the synthetic rig resolved no right hand');
      return hand.getWorldPosition(new THREE.Vector3()).y;
    };
    // Read as radians, 90 would be a bearing nowhere near shoulder height, and
    // 1.5708 would be the raised one. The degrees reading is the opposite.
    expect(handHeight(90)).toBeGreaterThan(handHeight(90 * (Math.PI / 180)) + 0.05);
  });

  it('runs as a sustained pose the state reports by name', () => {
    const { session, director, step } = build();
    session.point({ side: 'R', azimuth: 30 });
    step(2);
    expect(director.body.gesture?.id).toBe('point.R');
    expect(session.state().gesture).toBe('point.R');
  });
});

describe('direct control between turns', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = build({ wardrobe: true });
  });

  it('wear() dresses a slot and reports that it did', () => {
    expect(harness.session.wear({ slot: 'top', item: 'shirt' })).toBe(true);
    expect(harness.session.state().wardrobe).toEqual({ top: 'shirt' });
  });

  it('wear() applies a whole preset', () => {
    harness.session.wear({ slot: 'top', item: 'shirt' });
    expect(harness.session.wear({ preset: 'bare' })).toBe(true);
    expect(harness.session.state().wardrobe).toEqual({ top: null });
  });

  it('wear() with neither slot nor preset is a no-op rather than an error', () => {
    expect(harness.session.wear({})).toBe(false);
  });

  it('wear() returns false for a session with no wardrobe at all', () => {
    const bare = build();
    expect(bare.session.wear({ slot: 'top', item: 'shirt' })).toBe(false);
  });

  it('setCamera forwards the shot to the viewer callback', () => {
    const rig = buildRig();
    const director = new Director(buildProfile(rig.root, rig.descriptor));
    const camera = vi.fn();
    const session = new Session(director, { camera });
    session.setCamera({ frame: 'face' });
    expect(camera).toHaveBeenCalledWith({ frame: 'face' });
  });

  it('setCamera passes an offset through without a framing', () => {
    // What a drag on the panel's preview sends: two angles and nothing else.
    // An absent framing means "leave it", which is the renderer's business.
    const rig = buildRig();
    const director = new Director(buildProfile(rig.root, rig.descriptor));
    const camera = vi.fn();
    new Session(director, { camera }).setCamera({ yaw: 18, zoom: 1.4 });
    expect(camera).toHaveBeenCalledWith({ yaw: 18, zoom: 1.4 });
  });

  it('setCamera is a no-op when no viewer is attached', () => {
    expect(() => harness.session.setCamera({ frame: 'full' })).not.toThrow();
  });

  it('setBackdrop forwards the room to the scenery, null included', () => {
    const rig = buildRig();
    const director = new Director(buildProfile(rig.root, rig.descriptor));
    const setBackdrop = vi.fn();
    const session = new Session(director, { scenery: { backdrops: [], setBackdrop } });
    session.setBackdrop('night');
    expect(setBackdrop).toHaveBeenCalledWith('night');
    // Null is the flat background and has to reach the renderer as itself. A
    // default applied here would make "take the room away" unsayable.
    session.setBackdrop(null);
    expect(setBackdrop).toHaveBeenLastCalledWith(null);
  });

  it('setBackdrop is a no-op on a renderer with no backdrops', () => {
    expect(() => harness.session.setBackdrop('night')).not.toThrow();
  });

  // The whole reason staging can ride on a turn: a caller can describe the
  // fourth line's shot while the first line is still being said, and the shot
  // still lands on the fourth line. Queued is not applied.
  it('applies a turn staging when the turn starts, not when it is queued', () => {
    const camera = vi.fn();
    const setBackdrop = vi.fn();
    const { session, step, runUntil } = build({
      camera,
      scenery: { backdrops: [], setBackdrop },
    });

    session.say({ text: 'いち', stage: { camera: 'face' } });
    session.say({ text: 'に', stage: { camera: 'full', backdrop: 'night' } });
    // Both are in the queue and neither has begun, so nothing has moved.
    expect(camera).not.toHaveBeenCalled();
    expect(setBackdrop).not.toHaveBeenCalled();

    runUntil(() => session.turn?.text === 'いち');
    expect(camera).toHaveBeenCalledTimes(1);
    expect(camera).toHaveBeenLastCalledWith({ frame: 'face' });
    // The second line's backdrop is still waiting for the second line.
    expect(setBackdrop).not.toHaveBeenCalled();

    runUntil(() => session.turn?.text === 'に');
    expect(camera).toHaveBeenLastCalledWith({ frame: 'full' });
    expect(setBackdrop).toHaveBeenCalledWith('night');
    step(1);
  });

  // Absent and null are different, and the engine is where that survives or is
  // lost: `?? null` here would empty an axis the caller never mentioned.
  it('leaves a staging axis alone when the turn omits it, and empties it on null', () => {
    const camera = vi.fn();
    const setBackdrop = vi.fn();
    const { session, runUntil } = build({
      camera,
      scenery: { backdrops: [], setBackdrop },
    });

    session.say({ text: 'いち', stage: { camera: 'bust', backdrop: 'night' } });
    runUntil(() => session.turn?.text === 'いち');
    expect(setBackdrop).toHaveBeenLastCalledWith('night');

    // No backdrop key at all: the night stays up and the renderer is not told
    // anything about it a second time.
    session.say({ text: 'に', stage: { camera: 'full' } });
    runUntil(() => session.turn?.text === 'に');
    expect(setBackdrop).toHaveBeenCalledTimes(1);

    // An explicit null is the flat background, and has to reach the renderer.
    session.say({ text: 'さん', stage: { backdrop: null } });
    runUntil(() => session.turn?.text === 'さん');
    expect(setBackdrop).toHaveBeenLastCalledWith(null);
  });

  it('says a line with no staging without touching the shot', () => {
    const camera = vi.fn();
    const { session, runUntil } = build({ camera });
    session.say({ text: 'いち' });
    runUntil(() => session.turn?.text === 'いち');
    expect(camera).not.toHaveBeenCalled();
  });

  it('carries the staging of a turn edited in place through the queue', () => {
    const camera = vi.fn();
    const { session, runUntil } = build({ camera });
    session.say({ text: 'いち' });
    session.say({ id: 'second', text: 'に', stage: { camera: 'face' } });
    // Same id and same words, so the take is kept — and the shot has to be
    // updated with everything else that is applied at `start`.
    session.replaceQueue([{ id: 'second', text: 'に', stage: { camera: 'full' } }]);
    runUntil(() => session.turn?.text === 'に');
    expect(camera).toHaveBeenLastCalledWith({ frame: 'full' });
  });

  it('reports an empty backdrop list rather than omitting it', () => {
    // The empty list is the tell that this renderer has no rooms at all, which
    // is how a caller distinguishes "none available" from "none selected"
    // without sending a command and watching for an effect.
    expect(harness.session.vocabulary().backdrops).toEqual([]);
  });

  it('reports the backdrops the scenery advertises', () => {
    const rig = buildRig();
    const director = new Director(buildProfile(rig.root, rig.descriptor));
    const backdrops = [{ id: 'dusk', label: same('夕暮れ') }];
    const session = new Session(director, {
      scenery: { backdrops, setBackdrop: vi.fn() },
    });
    expect(session.vocabulary().backdrops).toEqual(backdrops);
  });

  it('lookAt is reported back through state', () => {
    harness.session.lookAt(0.25);
    expect(harness.session.state().lookAt).toBe(0.25);
  });

  it('resetExpression clears the pick, the overlays and the mood', () => {
    harness.session.setExpression('F_DOYA');
    harness.session.setOverlay('FX_TEARS', 1);
    harness.session.setEmotion({ anger: 1 });
    harness.session.resetExpression();
    const state = harness.session.state();
    expect(state.pickedExpression).toBeNull();
    expect(state.overlays).toEqual({});
    expect(state.emotion).toEqual({ neutral: 1 });
  });
});

describe('turn ids', () => {
  it('are unique across calls made inside the same millisecond', () => {
    const { session } = build();
    // The wire format supports batching, and the command handler applies a
    // batch in a tight loop with no yield — so this is the ordinary path, not a
    // stress case. A timestamp alone collides here, and a caller holding three
    // identical ids cannot tell which turn's `turn.end` it is looking at.
    const ids = [
      session.say({ text: 'あ' }),
      session.say({ text: 'い' }),
      session.say({ text: 'う' }),
    ];
    expect(new Set(ids).size).toBe(3);
  });
});

/**
 * A named hand, from the four places a caller can name one.
 *
 * The gesture layer decides which arm acts and is tested at the wrist in
 * `tests/motion/body.test.ts`; what is checked here is that the hand a caller
 * wrote survives the trip — through a direct call, through a performance that
 * owns the movement, through a queued line, and through the in-place update a
 * queue replacement makes.
 */
describe('the hand a caller names', () => {
  /** ±1 as `GestureVariation` states it: R is positive. */
  const acting = (director: Director): number | undefined => director.body.gesture?.v.side;

  it('reaches a gesture asked for directly', () => {
    const { session, director, step } = build();
    session.gesture('peace', 'L');
    step(1);
    expect(director.body.gesture?.id).toBe('peace');
    expect(acting(director)).toBe(-1);
  });

  it('reaches the movement a performance names', () => {
    const { session, director, step } = build();
    session.perform('peace', 'R');
    step(1);
    expect(director.body.gesture?.id).toBe('peace');
    expect(acting(director)).toBe(1);
  });

  it('travels on a line, beside either field that carries a movement', () => {
    for (const [line, id, side, expected] of [
      [{ gesture: 'peace' }, 'peace', 'L', -1],
      [{ perform: 'hello' }, 'wave', 'R', 1],
    ] as const) {
      const { session, director, step } = build();
      session.say({ id: 'a', ...line, side });
      step(1);
      expect(director.body.gesture?.id).toBe(id);
      expect(acting(director)).toBe(expected);
    }
  });

  it('survives the in-place update a queue replacement makes', () => {
    // A line whose words did not change keeps its take and is updated in place.
    // Everything applied at `start` has to be updated with it, or an edited
    // script plays the hand the operator replaced.
    const { session, director, step } = build();
    session.say({ id: 'a', text: 'あいうえお', gesture: 'peace', side: 'R' });
    session.replaceQueue([{ id: 'a', text: 'あいうえお', gesture: 'peace', side: 'L' }]);
    step(1);
    expect(director.body.gesture?.id).toBe('peace');
    expect(acting(director)).toBe(-1);
  });
});

describe('performances', () => {
  it('sets the mood and plays the movement in one call', () => {
    const { session, director, step } = build();
    session.perform('happy');
    step(2);
    expect(session.state().performance).toBe('happy');
    expect(director.target.joy).toBeGreaterThan(0.8);
    expect(director.body.gesture?.id).toBe('cheer');
    expect(director.body.jumping).toBe(true);
    expect(session.state().hopping).toBe(true);
  });

  it('leaves the mood behind when it is released, and nothing else', () => {
    // The one asymmetry in the whole layer, and the same rule a turn's emotion
    // follows: a mood does not end with the thing that carried it.
    const { session, director, step } = build();
    session.perform('doze');
    step(2);
    expect(director.body.gesture?.id).toBe('doze');
    session.perform(null);
    step(2);
    expect(session.state().performance).toBeNull();
    expect(director.target.relaxed).toBeGreaterThan(0.5);
    expect(director.body.gesture?.released).toBe(true);
  });

  it('puts back the lids and the gaze it took', () => {
    const { session, director, step } = build();
    session.lookAt(0.8);
    session.perform('doze');
    step(4);
    expect(director.blink).toBeGreaterThan(0.9);
    expect(director.body.lookAt).toBe(0);
    session.perform(null);
    step(4);
    expect(director.blink).toBeLessThan(0.9);
    expect(director.body.lookAt).toBe(0.8);
  });

  it('releases the last one when the next one starts', () => {
    const { session, director, step } = build();
    session.perform('bored');
    step(2);
    expect(director.body.gesture?.id).toBe('chin');
    session.perform('agree');
    step(2);
    expect(session.state().performance).toBe('agree');
    expect(director.body.gesture?.id).toBe('nod');
  });

  it('ignores an id the table does not have, rather than clearing what is up', () => {
    const { session, step } = build();
    session.perform('bored');
    step(2);
    session.perform('teleport');
    step(2);
    // The unknown id released the current one — a caller who names something
    // that no longer exists gets a character standing still rather than one
    // stuck in a pose they can no longer name to release.
    expect(session.state().performance).toBeNull();
  });

  it('is cleared by resetExpression, lids and all', () => {
    const { session, director, step } = build();
    session.perform('doze');
    step(4);
    expect(director.blink).toBeGreaterThan(0.9);
    session.resetExpression();
    step(4);
    expect(session.state().performance).toBeNull();
    expect(director.blink).toBeLessThan(0.9);
  });
});

describe('a turn that names a performance', () => {
  it('applies it at the start and releases it at the end', () => {
    const { session, director, step, runUntil } = build();
    session.say({ id: 'a', text: 'あいうえお', perform: 'bored' });
    step(2);
    expect(session.state().performance).toBe('bored');
    expect(director.body.gesture?.id).toBe('chin');
    runUntil(() => !session.busy);
    expect(session.state().performance).toBeNull();
  });

  it('keeps it up when the turn asks to hold', () => {
    const { session, runUntil } = build();
    session.say({ id: 'a', text: 'あいうえお', perform: 'bored', hold: true });
    runUntil(() => !session.busy);
    expect(session.state().performance).toBe('bored');
  });

  it('lets the turn override one part of what the performance set', () => {
    const { session, director, step } = build();
    session.say({ id: 'a', text: 'あい', perform: 'happy', gesture: 'wave' });
    step(2);
    // The performance still set the mood and the hops; only the arms differ.
    expect(director.target.joy).toBeGreaterThan(0.8);
    expect(director.body.jumping).toBe(true);
    expect(director.body.gesture?.id).toBe('wave');
  });

  it('does not reach back and cancel a performance something else set later', () => {
    const { session, step, runUntil } = build();
    session.say({ id: 'a', text: 'あい', perform: 'bored' });
    step(2);
    session.perform('guarded');
    runUntil(() => !session.busy);
    expect(session.state().performance).toBe('guarded');
  });

  it('drops a held pose the autopilot was in before the line starts', () => {
    // The autopilot picks performances, and a line delivered with the arms
    // still held from the last idle pick is the bug this ordering removes.
    const { session, director, step } = build({ idle: true });
    step(Math.ceil((IDLE_AFTER + 1) / DT));
    const random = vi.spyOn(Math, 'random').mockReturnValue(11 / 35 + 0.001);
    try {
      const limit = 10;
      let elapsed = 0;
      while (director.performance !== 'agree' && elapsed < limit) {
        step(1);
        elapsed += DT;
      }
      expect(director.performance).toBe('agree');
      expect(director.body.gesture?.id).toBe('nod');

      session.say({ id: 'a', text: 'あいうえお' });
      step(2);
      expect(director.body.gesture?.id).toBe('nod');
      expect(director.body.gesture?.released).toBe(true);
    } finally {
      random.mockRestore();
    }
  });
});

describe('the autopilot picking performances', () => {
  it('eventually puts a face and a movement on the character together', () => {
    const { session, director, step, runUntil } = build({ idle: true });
    step(Math.ceil((IDLE_AFTER + 1) / DT));
    expect(director.auto).toBe(true);
    runUntil(() => !!director.performance, 40);
    const id = director.performance as string;
    expect(session.state().performance).toBe(id);
    // Whatever it picked, the mood it set is the one that entry declares — the
    // point of the layer being that the two are never chosen apart.
    expect(director.effectiveTarget).toEqual(
      PERFORMANCE_TABLE[id as keyof typeof PERFORMANCE_TABLE].emotion,
    );
  });

  it('lets go of a held pose when the autopilot is switched off', () => {
    const { session, director, step } = build({ idle: true });
    const random = vi.spyOn(Math, 'random').mockReturnValue(31 / 35 + 0.001);
    try {
      step(Math.ceil((IDLE_AFTER + 1) / DT));
      let elapsed = 0;
      while (director.performance !== 'guarded' && elapsed < 10) {
        step(1);
        elapsed += DT;
      }
      expect(director.body.gesture?.id).toBe('armCross');

      session.setIdle(false);
      step(2);
      expect(director.performance).toBeNull();
      expect(director.body.gesture?.released).toBe(true);
    } finally {
      random.mockRestore();
    }
  });
});

describe('idle ownership', () => {
  it('keeps baseline mood and a manual expression untouched through an idle cycle', () => {
    const { session, director, step } = build({ idle: true });
    session.setEmotion({ joy: 0.8 });
    session.setExpression('F_DOYA');
    const target = { ...director.target };

    step(Math.ceil(6 / DT));

    expect(director.auto).toBe(true);
    expect(director.performance).not.toBeNull();
    expect(director.target).toEqual(target);
    expect(director.pickedExpression).toBe('F_DOYA');

    session.setIdle(false);
    step(1);
    expect(director.target).toEqual(target);
    expect(director.pickedExpression).toBe('F_DOYA');
  });

  it('drops idle face and mood when a turn starts without either field', () => {
    const { session, director, step } = build({ idle: true });
    const random = vi.spyOn(Math, 'random').mockReturnValue(32 / 35 + 0.001);
    try {
      step(Math.ceil((IDLE_AFTER + 1) / DT));
      let elapsed = 0;
      while (director.performance !== 'nice' && elapsed < 10) {
        step(1);
        elapsed += DT;
      }
      step(120);
      expect(director.auto).toBe(true);
      expect(director.expression).toBe('F_DOYA');

      session.say({ id: 'plain', text: 'あい' });
      step(1);

      expect(director.auto).toBe(false);
      expect(session.state().emotion).toEqual({ neutral: 1 });
      expect(director.expression).toBeNull();
    } finally {
      random.mockRestore();
    }
  });

  it('gives a direct face or body command a grace period without disabling idle', () => {
    const { session, director, step } = build({ idle: true });
    step(Math.ceil((IDLE_AFTER + 1) / DT));
    expect(director.auto).toBe(true);

    session.setEmotion({ joy: 1 });
    expect(session.idleEnabled).toBe(true);
    expect(director.auto).toBe(false);
    step(Math.ceil((IDLE_AFTER - DT) / DT));
    expect(director.auto).toBe(false);
    step(2);
    expect(director.auto).toBe(true);
  });

  it.each(['guarded', 'doze'] as const)(
    'keeps the caller-owned held performance %s ahead of idle',
    (id) => {
      const { session, director, step } = build({ idle: true });
      session.perform(id);
      director.auto = true;
      step(Math.ceil((IDLE_AFTER + 1) / DT));

      expect(director.baselinePerformanceHeld).toBe(true);
      expect(director.auto).toBe(false);
      expect(session.state().performance).toBe(id);
      expect(director.body.gesture?.id).toBe(id === 'guarded' ? 'armCross' : 'doze');
      expect(director.body.gesture?.released).toBe(false);
    },
  );

  it('releases a held performance, waits the grace period, then resumes idle', () => {
    const { session, director, step } = build({ idle: true });
    session.perform('guarded');
    step(Math.ceil((IDLE_AFTER + 1) / DT));
    expect(director.auto).toBe(false);

    session.perform(null);
    expect(director.baselinePerformanceHeld).toBe(false);
    expect(director.body.gesture?.released).toBe(true);
    step(Math.ceil(IDLE_AFTER / DT));
    expect(director.auto).toBe(false);
    step(2);
    expect(director.auto).toBe(true);
  });

  it('releases an unowned held gesture when a face-only idle act starts', () => {
    const { session, director, step } = build({ idle: true });
    session.gesture('armCross');
    // Pinned to the first row of the autopilot's pool, which is face-only.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      step(Math.ceil((IDLE_AFTER + 1) / DT));
      expect(director.auto).toBe(true);

      let elapsed = 0;
      while (director.performance !== 'blank' && elapsed < 10) {
        step(1);
        elapsed += DT;
      }
      expect(director.performance).toBe('blank');
      const gesture = director.body.gesture;
      expect(gesture === null || (gesture.id === 'armCross' && gesture.released)).toBe(true);
    } finally {
      random.mockRestore();
    }
  });

  it('finishes an idle bounce at its current hop when a turn takes over', () => {
    const { session, director, step, now } = build({ idle: true });
    const bouncy = PERFORMANCE_TABLE.bouncy;
    const priorHop = bouncy.hop;
    const random = vi.spyOn(Math, 'random').mockReturnValue(27 / 35 + 0.001);
    bouncy.hop = 'bounce';
    try {
      step(Math.ceil((IDLE_AFTER + 1) / DT));
      let elapsed = 0;
      while (director.performance !== 'bouncy' && elapsed < 10) {
        step(1);
        elapsed += DT;
      }
      expect(director.performance).toBe('bouncy');
      expect(director.body.jumping).toBe(true);

      const one = planJump(HOPS.bounce.height, director.body.gravity, 1);
      const cycle = one.push + one.flight + one.brake;
      // Move just into the second bounce. `finishHop` must keep this one so the
      // hips still land continuously, while dropping the third from the run.
      step(Math.ceil((CROUCH_T + cycle) / DT));
      expect(director.body.jumping).toBe(true);

      session.say({ id: 'plain', text: 'あ' });
      const releaseAt = now();
      step(1);
      const settle = cycle + RECOVER_T + 3 * DT;
      while (director.body.jumping && now() - releaseAt < settle) step(1);
      expect(director.body.jumping).toBe(false);
      expect(now() - releaseAt).toBeLessThan(settle);
    } finally {
      bouncy.hop = priorHop;
      random.mockRestore();
    }
  });

  it('composes idle overlays over the caller weight and restores it on wake', () => {
    const { session, director, step } = build({ idle: true });
    session.setOverlay('FX_BLUSH', 0.4);
    const blank = PERFORMANCE_TABLE.blank;
    const prior = blank.overlay;
    // Pinned to the first row of the autopilot's pool.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    blank.overlay = ['FX_BLUSH'];
    try {
      step(Math.ceil((IDLE_AFTER + 1) / DT));
      let elapsed = 0;
      while (director.performance !== 'blank' && elapsed < 10) {
        step(1);
        elapsed += DT;
      }
      expect(director.performance).toBe('blank');
      expect(session.state().overlays).toEqual({ FX_BLUSH: 1 });

      session.setIdle(false);
      expect(director.auto).toBe(false);
      expect(session.state().overlays).toEqual({ FX_BLUSH: 0.4 });
    } finally {
      blank.overlay = prior;
      random.mockRestore();
    }
  });
});

describe('the autopilot and a pose nothing owns', () => {
  it('moves on from a held gesture an operator left behind', () => {
    // The deadlock this guards: the pick waits for a running gesture to finish
    // so as not to cut it short, and a sustained pose never finishes. Left
    // asking whether the current *performance* holds, a pose pressed on the
    // panel — which no performance owns — stalled the autopilot for good, and
    // the character stood in it until the page was reloaded.
    const { session, director, step, runUntil } = build({ idle: true });
    step(Math.ceil((IDLE_AFTER + 1) / DT));
    session.gesture('armCross');
    step(2);
    expect(director.body.gesture?.id).toBe('armCross');
    expect(director.performance).toBeNull();
    runUntil(() => !!director.performance, 40);
    expect(director.performance).not.toBeNull();
  });

  it('still waits for a gesture that is going to end on its own', () => {
    const { session, director, step } = build({ idle: true });
    step(Math.ceil((IDLE_AFTER + 1) / DT));
    session.perform(null);
    session.gesture('nod');
    // `nod` runs about three quarters of a second; nothing may replace it
    // inside that.
    for (let i = 0; i < 30; i++) {
      step(1);
      if (director.body.gesture?.id !== 'nod') break;
    }
    expect(director.body.gesture?.id).toBe('nod');
  });
});

describe('cues in a line', () => {
  /** Ten morae, so a cue at the middle of it lands at a time worth asserting on. */
  const TEN = 'あいうえおかきくけこ';

  /** Step until the performance is no longer `from`, and report the mouth time. */
  const firesAt = (
    { director, step }: Pick<Harness, 'director' | 'step'>,
    from: string | null = null,
  ): number => {
    for (let i = 0; i < 400; i++) {
      step(1);
      if (director.performance !== from) return director.mouth.time;
    }
    throw new Error('no cue fired within the frame budget');
  };

  it('keeps the markup out of the mouth, which is the whole reason it is parsed on the way in', () => {
    const { session, step } = build();
    const seen: number[] = [];
    session.on((ev) => {
      if (ev.type === 'turn.start') seen.push(ev.seconds ?? 0);
    });
    session.say({ text: '[hello]こんばんは[happy]' });
    step(1);

    // Said as written, the ids would be eight morae of nonsense on top of the
    // line. The track is the length of the words alone.
    expect(seen[0]).toBeCloseTo(textToVisemes('こんばんは').duration, 12);
  });

  it('queues the spoken line, so nothing downstream can find markup to leak', () => {
    const { session, step } = build();
    session.say({ text: '[hello]こんばんは[explain]ところで' });
    step(1);
    expect(session.turn?.text).toBe('こんばんはところで');
  });

  it('plays a cue partway through the line rather than at either end of it', () => {
    const harness = build();
    harness.session.say({ text: 'あいうえお[happy]かきくけこ' });
    const at = firesAt(harness);

    expect(harness.director.performance).toBe('happy');
    // Halfway: after the first five morae and before the line is over.
    const half = textToVisemes('あいうえお').duration;
    expect(at).toBeGreaterThanOrEqual(half);
    expect(at).toBeLessThan(half + 4 * DT);
  });

  it('opens on a cue written at the top of the line, without a frame of the old face first', () => {
    const { session, director, step } = build();
    session.say({ text: '[happy]あいうえお' });
    step(1);
    expect(director.performance).toBe('happy');
  });

  it('plays several in the order they were written', () => {
    const { session, director, runUntil } = build();
    const seen: string[] = [];
    session.say({ text: 'あい[calm]うえお[happy]かきく[gloomy]けこ' });
    runUntil(() => {
      const showing = director.performance;
      if (showing && seen.at(-1) !== showing) seen.push(showing);
      return seen.length === 3;
    });
    expect(seen).toEqual(['calm', 'happy', 'gloomy']);
  });

  it('rescales to the line that is actually spoken, because the position is a fraction', () => {
    // The reading is half again as long as the text. A cue held as a time in
    // seconds would fire a third of the way into this and be wrong by 0.3 s;
    // held as a fraction it stays in the middle of the sentence — which is where
    // it was written, and where it will still be when TTS audio is the clock.
    const harness = build();
    const reading = 'あいうえおかきくけこさしすせそ';
    harness.session.say({ text: 'あいうえお[happy]かきくけこ', reading });
    const at = firesAt(harness);

    const half = textToVisemes(reading).duration / 2;
    expect(at).toBeGreaterThanOrEqual(half);
    expect(at).toBeLessThan(half + 4 * DT);
    expect(at).toBeGreaterThan(textToVisemes(TEN).duration / 2 + 0.2);
  });

  it('drops a cue the performance table has no name for, rather than playing it', () => {
    const { session, director, step } = build();
    session.say({ text: 'あいうえお[nosuchthing]かきくけこ', perform: 'hello' });
    step(1);
    expect(session.turn?.cues).toEqual([]);

    // And specifically does not take the face down on the way past. `perform()`
    // releases what is showing when handed an id it does not know, which is
    // right for a caller who can see they got no face and wrong in the middle of
    // a word.
    step(Math.ceil(0.9 / DT));
    expect(director.performance).toBe('hello');
  });

  it('takes down the performance the last cue left up, not the one the turn opened with', () => {
    const { session, director, runUntil } = build();
    session.say({ text: 'あいうえお[happy]かきくけこ', perform: 'hello' });
    runUntil(() => !session.busy);
    // What a turn leaves behind is whatever was showing last. Released against
    // `perform` instead, `happy` would sit on the character's face for good —
    // the turn would look for `hello`, not find it, and put nothing back.
    expect(director.performance).toBeNull();
  });

  it('holds the last cue past the line when the turn asked to hold', () => {
    const { session, director, runUntil } = build();
    session.say({ text: 'あいうえお[happy]かきくけこ', perform: 'hello', hold: true });
    runUntil(() => !session.busy);
    expect(director.performance).toBe('happy');
  });

  it('drops what has not fired when the line is cut off', () => {
    const { session, director, step } = build();
    session.say({ text: 'あいうえお[happy]かきくけこ' });
    step(2);
    expect(director.performance).toBeNull();
    session.interrupt();
    step(Math.ceil(3 / DT));
    // A line that was stopped should stop changing face. Left queued, the cue
    // would land seconds later over whatever the stream had moved on to.
    expect(director.performance).toBeNull();
  });

  it('is a pose change when the line is nothing but cues', () => {
    const { session, director, step } = build();
    session.say({ text: '[happy]' });
    step(1);
    expect(director.performance).toBe('happy');
    expect(session.turn?.text).toBe('');
  });

  it('runs typed visual cues on the same mouth clock as performances', () => {
    const shots: Shot[] = [];
    const slides = new FakeSlides();
    const { session, director, step } = build({
      camera: (shot) => shots.push(shot),
      slides,
    });
    session.say({
      text: '[@camera full][@slide 3][@expression F_JITO][@gesture nod][@hop bounce]あ',
    });
    step(1);

    expect(shots).toEqual([{ frame: 'full' }]);
    expect(slides.calls).toEqual([{ call: 'setSlide', page: 3 }]);
    expect(director.expression).toBe('F_JITO');
    expect(director.body.gesture?.id).toBe('nod');
    expect(director.body.jumping).toBe(true);
  });

  it('fires a typed camera cue at its written mouth-clock position', () => {
    const shots: Shot[] = [];
    const { session, director, step } = build({ camera: (shot) => shots.push(shot) });
    session.say({ text: 'あいうえお[@camera full]かきくけこ' });

    for (let i = 0; i < 400 && shots.length === 0; i++) step(1);

    const half = textToVisemes('あいうえお').duration;
    expect(shots).toEqual([{ frame: 'full' }]);
    expect(director.mouth.time).toBeGreaterThanOrEqual(half);
    expect(director.mouth.time).toBeLessThan(half + 4 * DT);
  });

  it('reports typed BGM cues once per source cue and retains their source ordinals', () => {
    const { session, step } = build();
    session.say({
      id: 'bgm-line',
      text: '[@perform typo][@bgm play 日本語の曲 name.mp3][@bgm pause][@bgm stop]',
    });
    step(1);

    expect(session.takeEvents().filter((event) => event.type === 'cue.fire')).toEqual([
      {
        type: 'cue.fire',
        turn: 'bgm-line',
        cueId: 'bgm-line:cue:1',
        cue: { kind: 'bgm', action: 'play', track: '日本語の曲 name.mp3' },
      },
      {
        type: 'cue.fire',
        turn: 'bgm-line',
        cueId: 'bgm-line:cue:2',
        cue: { kind: 'bgm', action: 'pause' },
      },
      {
        type: 'cue.fire',
        turn: 'bgm-line',
        cueId: 'bgm-line:cue:3',
        cue: { kind: 'bgm', action: 'stop' },
      },
    ]);
  });

  it('drops an unknown typed expression instead of clearing the current face', () => {
    const { session, director, step } = build();
    director.setExpression('F_DOYA');
    session.say({ text: '[@expression DOES_NOT_EXIST]あ' });
    step(1);
    expect(director.expression).toBe('F_DOYA');
  });
});

describe('a cued turn, over every combination of the fields around it', () => {
  /**
   * The cross product rather than a sample of it: 40 cases is cheap, and what
   * a turn leaves showing is decided by four things at once — the last cue, the
   * `perform` it opened with, whether it holds, and whether the mouth ran on a
   * reading. Three of the four have been wrong at some point in this file's
   * history.
   */
  const LINES = {
    none: { text: 'あいうえおかきくけこ', last: null },
    leading: { text: '[happy]あいうえおかきくけこ', last: 'happy' },
    middle: { text: 'あいうえお[happy]かきくけこ', last: 'happy' },
    multiple: { text: 'あい[calm]うえお[happy]かきくけこ', last: 'happy' },
    unknown: { text: 'あいうえお[nosuchthing]かきくけこ', last: null },
  } as const;

  const CASES = Object.entries(LINES).flatMap(([kind, line]) =>
    [undefined, 'あいうえおかきくけこさしすせそ'].flatMap((reading) =>
      [undefined, 'hello'].flatMap((perform) =>
        [false, true].map((hold) => ({ kind, line, reading, perform, hold })),
      ),
    ),
  );

  it.each(CASES)(
    '$kind cues, reading $reading, perform $perform, hold $hold',
    ({ line, reading, perform, hold }) => {
      const { session, director, runUntil } = build();
      session.say({ text: line.text, reading, perform, hold });
      runUntil(() => !session.busy);

      // Whatever the turn put up last is what it has to put back — unless it
      // was told to hold, in which case that same thing is what stays.
      const showing = line.last ?? perform ?? null;
      expect(director.performance).toBe(hold ? showing : null);
    },
  );
});

/**
 * A line that has been spoken, on the harness's simulated clock.
 *
 * The rate is a multiplier on how fast that clock runs for *this* take, and it
 * is the only way from out here to tell a mouth driven by the audio from one
 * driven by the frame: in the harness both advance together at 1.0, so a take
 * that runs at half speed is the whole experiment.
 */
class FakeTake implements Take {
  playedAt: number | null = null;
  stopped = false;
  amplitude = 1;

  constructor(
    readonly seconds: number,
    private readonly now: () => number,
    private readonly rate = 1,
  ) {}

  play(): void {
    this.playedAt = this.now();
  }

  stop(): void {
    this.stopped = true;
  }

  get elapsed(): number {
    if (this.playedAt === null) return 0;
    // Past the end, like a real one: the mouth needs a clock that keeps going
    // to notice that the line is over.
    return (this.now() - this.playedAt) * this.rate;
  }
}

/** A voice that answers immediately with a take of a stated length. */
class FakeVoice implements Voice {
  readonly asked: string[] = [];
  readonly takes: FakeTake[] = [];
  /** Resolvers for every outstanding request, when `defer` is on. */
  private readonly pending: Array<(take: Take | null) => void> = [];

  constructor(
    private readonly now: () => number,
    private readonly opts: {
      seconds?: number;
      rate?: number;
      defer?: boolean;
      fail?: boolean;
      /** Answer null from this request onward — a sidecar that went away. */
      nullAfter?: number;
    } = {},
  ) {}

  prepare(text: string): Promise<Take | null> {
    this.asked.push(text);
    if (this.opts.fail) return Promise.reject(new Error('no voice'));
    if (this.opts.nullAfter !== undefined && this.asked.length > this.opts.nullAfter) {
      return Promise.resolve(null);
    }
    const take = new FakeTake(this.opts.seconds ?? 1, this.now, this.opts.rate);
    this.takes.push(take);
    if (!this.opts.defer) return Promise.resolve(take);
    return new Promise((resolve) => this.pending.push(resolve));
  }

  /** Answer everything outstanding. */
  answer(): Promise<void> {
    for (const [i, resolve] of this.pending.entries()) resolve(this.takes[i]);
    this.pending.length = 0;
    return settle();
  }

  readonly rooms = [
    { id: 'booth', label: same('ブース') },
    { id: 'hall', label: same('ホール') },
  ];

  /** Every room this was put in, so a test can see what the session forwarded. */
  readonly roomsSet: Array<string | null> = [];

  setRoom(id: string | null): void {
    this.roomsSet.push(id);
  }

  readonly presets = [{ id: 'neutral-monitor', label: same('素のまま') }];

  /** Every chain this was set to, on the same footing as `roomsSet`. */
  readonly chainsSet: VoiceChainRequest[] = [];

  setChain(request: VoiceChainRequest): void {
    this.chainsSet.push(request);
  }

  report(): VoiceReport {
    return {
      preset: this.chainsSet.at(-1)?.preset ?? 'neutral-monitor',
      dsp: null,
      room: this.roomsSet.at(-1) ?? null,
      lufs: null,
      truePeakDb: null,
      blocked: false,
    };
  }
}

/** Let the microtask chain in `synthesise` run to the end. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('a turn with a voice', () => {
  it('holds the turn back until the line has been synthesised', async () => {
    let voice: FakeVoice | null = null;
    const { session, step } = build({
      voice: (now) => {
        voice = new FakeVoice(now, { defer: true });
        return voice;
      },
    });
    session.say({ text: 'あいうえお' });
    step(60);
    // Starting on the estimate and correcting when the audio turns up would put
    // a visible jump in the middle of every line. The take arrives first or the
    // line does not open.
    expect(session.turn).toBeNull();
    expect(session.queue).toHaveLength(1);

    await (voice as unknown as FakeVoice).answer();
    step(1);
    expect(session.turn?.text).toBe('あいうえお');
  });

  it('asks for every queued line at once, so only the first turn of a run waits', async () => {
    let voice: FakeVoice | null = null;
    const { session } = build({
      voice: (now) => {
        voice = new FakeVoice(now, { defer: true });
        return voice;
      },
    });
    session.say({ text: 'あい' });
    session.say({ text: 'うえ' });
    session.say({ text: 'おか' });
    // Queued, not played: three requests are in flight before the first line
    // has opened, so the second and third are ready by the time they come up.
    expect((voice as unknown as FakeVoice).asked).toEqual(['あい', 'うえ', 'おか']);
  });

  it('stretches the viseme track onto the length the audio turned out to be', async () => {
    const { session, step } = build({ voice: (now) => new FakeVoice(now, { seconds: 3 }) });
    let seconds = 0;
    session.on((ev) => {
      if (ev.type === 'turn.start') seconds = ev.seconds ?? 0;
    });
    session.say({ text: 'あいうえお' });
    await settle();
    step(1);

    // The estimate for five morae is 0.675 s. The take is three seconds, and it
    // is the take that gets said.
    expect(textToVisemes('あいうえお').duration).toBeCloseTo(0.675, 6);
    expect(seconds).toBe(3);
  });

  it('keeps the line open for as long as the audio lasts', async () => {
    const { session, step, runUntil } = build({
      voice: (now) => new FakeVoice(now, { seconds: 3 }),
    });
    session.say({ text: 'あ' });
    await settle();
    step(1);
    // One mora is 0.135 s of estimate. Without the stretch the turn would be
    // over in a sixth of a second while the voice kept talking for another two.
    step(Math.ceil(2 / DT));
    expect(session.turn).not.toBeNull();
    runUntil(() => !session.busy);
  });

  it('puts the mouth on the audio clock rather than on the frame clock', async () => {
    // The take runs at half the harness's rate — a stand-in for the renderer
    // stalling, which is the only direction this ever goes wrong in: a frame is
    // never delivered early, so a mouth adding up `dt` can only run ahead.
    const { session, director, step } = build({
      voice: (now) => new FakeVoice(now, { seconds: 4, rate: 0.5 }),
    });
    session.say({ text: 'あいうえおかきくけこ' });
    await settle();
    step(1);
    step(60);

    // A second of frames, half a second of audio.
    expect(director.mouth.time).toBeGreaterThan(0.4);
    expect(director.mouth.time).toBeLessThan(0.6);
  });

  it('places a cue at the same fraction of the line the audio actually is', async () => {
    const { session, director, step } = build({
      voice: (now) => new FakeVoice(now, { seconds: 3 }),
    });
    session.say({ text: 'あいうえお[happy]かきくけこ' });
    await settle();
    step(1);

    // Halfway is 1.5 s of audio, not 0.675 s of estimate. A cue held as a time
    // rather than as a fraction would have fired at a fifth of the way in.
    step(Math.ceil(1.2 / DT));
    expect(director.performance).toBeNull();
    step(Math.ceil(0.5 / DT));
    expect(director.performance).toBe('happy');
  });

  it('scales mouth travel by how loud the take is right now', async () => {
    const { session, director, step } = build({
      voice: (now) => new FakeVoice(now, { seconds: 2 }),
    });
    session.say({ text: 'あいうえお' });
    await settle();
    step(1);
    const mouth = director.mouth;
    const take = session.turn?.take as FakeTake;
    step(30);
    expect(mouth.amplitude).toBe(1);

    // Silence in the middle of a take closes the mouth, whatever the track
    // thinks is being said there — which is what keeps a pause the text never
    // predicted from being mouthed through.
    take.amplitude = 0;
    step(30);
    expect(mouth.amplitude).toBe(0);
    expect(Object.values(mouth.weights).every((w) => w < 0.02)).toBe(true);
  });

  it('goes back to full travel on a line that has no audio', async () => {
    const { session, director, step, runUntil } = build({
      voice: (now) => new FakeVoice(now, { seconds: 1, nullAfter: 1 }),
    });
    session.say({ id: 'spoken', text: 'あいうえお' });
    session.say({ id: 'silent', text: 'かきくけこ' });
    await settle();
    step(1);
    (session.turn?.take as FakeTake).amplitude = 0.2;
    step(10);
    expect(director.mouth.amplitude).toBe(0.2);

    // The sidecar went away between the two lines, so the second has no
    // envelope to follow. Left alone the mouth would spend it a fifth open, for
    // no reason visible anywhere near the cause.
    runUntil(() => session.turn?.id === 'silent');
    step(1);
    expect(director.mouth.amplitude).toBe(1);
  });

  it('stops the audio when the line is cut off', async () => {
    let voice: FakeVoice | null = null;
    const { session, step } = build({
      voice: (now) => {
        voice = new FakeVoice(now, { seconds: 5 });
        return voice;
      },
    });
    session.say({ text: 'あいうえお' });
    await settle();
    step(2);
    session.interrupt();
    // Otherwise the kill switch stops everything except the thing the viewer
    // can actually hear.
    expect((voice as unknown as FakeVoice).takes[0].stopped).toBe(true);
  });

  it('plays the line silently when the voice never answers', async () => {
    let voice: FakeVoice | null = null;
    const { session, step } = build({
      voice: (now) => {
        voice = new FakeVoice(now, { defer: true });
        return voice;
      },
    });
    session.say({ text: 'あいうえお' });
    step(Math.ceil((VOICE_WAIT + 0.2) / DT));
    // A wedged sidecar must cost the line its sound and nothing else. A stream
    // that stops dead is the worse failure.
    expect(session.turn?.text).toBe('あいうえお');
    expect(session.turn?.take).toBeUndefined();
    void voice;
  });

  it('plays the line silently when synthesis fails, rather than dropping the turn', async () => {
    const { session, step } = build({ voice: (now) => new FakeVoice(now, { fail: true }) });
    session.say({ text: 'あいうえお' });
    await settle();
    step(1);
    expect(session.turn?.text).toBe('あいうえお');
    expect(session.turn?.take).toBeNull();
  });

  it('does not ask the voice for a turn with no words in it', async () => {
    let voice: FakeVoice | null = null;
    const { session, step } = build({
      voice: (now) => {
        voice = new FakeVoice(now);
        return voice;
      },
    });
    session.say({ perform: 'hello' });
    await settle();
    step(1);
    // A pose change has nothing to say, and a turn that waited for a take that
    // was never coming would stall the queue for `VOICE_WAIT` every time.
    expect((voice as unknown as FakeVoice).asked).toEqual([]);
    expect(session.turn?.perform).toBe('hello');
  });
});

describe('the room the voice is heard in', () => {
  it('forwards the room to the voice and keeps it there', () => {
    let voice: FakeVoice | null = null;
    const { session } = build({
      voice: (now) => {
        voice = new FakeVoice(now);
        return voice;
      },
    });
    session.setRoom('hall');
    session.setRoom(null);
    session.setRoom('booth');
    // Verbatim, including the null: deciding what an unknown or absent id means
    // is the voice's job, because the room table is its data and not the
    // session's. The session only carries the name across.
    expect((voice as unknown as FakeVoice).roomsSet).toEqual(['hall', null, 'booth']);
  });

  it('advertises the voice’s rooms in the vocabulary', () => {
    const { session } = build({ voice: (now) => new FakeVoice(now) });
    expect(session.vocabulary().rooms).toEqual([
      { id: 'booth', label: same('ブース') },
      { id: 'hall', label: same('ホール') },
    ]);
  });

  it('has no rooms and does nothing without a voice', () => {
    const { session } = build();
    // The distinction a caller needs: an empty list says `room` will not do
    // anything here, rather than leaving them to send one and watch for a
    // change that never comes.
    expect(session.vocabulary().rooms).toEqual([]);
    expect(() => session.setRoom('hall')).not.toThrow();
  });
});

describe('the voice chain', () => {
  it('forwards the request verbatim, including an absent preset', () => {
    let voice: FakeVoice | null = null;
    const { session } = build({
      voice: (now) => {
        voice = new FakeVoice(now);
        return voice;
      },
    });
    session.setVoiceChain({ preset: 'bright-idol' });
    session.setVoiceChain({ dsp: { retune: { semitones: 3 } } });
    session.setVoiceChain({ preset: null });
    // Absent and null are different answers — keep the base, versus bypass —
    // and defaulting either of them here would take that distinction away from
    // the only layer that can act on it.
    expect((voice as unknown as FakeVoice).chainsSet).toEqual([
      { preset: 'bright-idol', dsp: undefined },
      { preset: undefined, dsp: { retune: { semitones: 3 } } },
      { preset: null, dsp: undefined },
    ]);
  });

  it('advertises the voice’s presets, and none without a voice', () => {
    expect(build({ voice: (now) => new FakeVoice(now) }).session.vocabulary().voicePresets).toEqual(
      [{ id: 'neutral-monitor', label: same('素のまま') }],
    );
    const { session } = build();
    expect(session.vocabulary().voicePresets).toEqual([]);
    expect(() => session.setVoiceChain({ preset: 'bright-idol' })).not.toThrow();
  });
});

/**
 * A document layer that keeps every call it was handed, in order.
 *
 * The order is the thing being tested and a stub that only kept the resulting
 * state could not show it: a line naming a document *and* a page in it has to
 * open the document first, and doing it the other way round turns to a page of
 * the one being replaced before opening the new one at its first.
 *
 * It never opens anything, so `pages` stays 0 — that is what the report says
 * for a document that has not been read, and nothing here depends on the count.
 */
class FakeSlides implements Slides {
  readonly calls: Array<
    | { call: 'setDeck'; id: string | null; page?: number }
    | { call: 'setSlide'; page: number }
    | { call: 'turnSlide'; by: number }
  > = [];

  private deck: string | null = null;
  private page = 0;

  setDeck(id: string | null, page?: number): void {
    this.calls.push({ call: 'setDeck', id, page });
    this.deck = id;
    this.page = id === null ? 0 : (page ?? 1);
  }

  setSlide(page: number): void {
    this.calls.push({ call: 'setSlide', page });
    this.page = page;
  }

  turnSlide(by: number): void {
    this.calls.push({ call: 'turnSlide', by });
    this.page += by;
  }

  report(): SlideReport {
    return { deck: this.deck, page: this.page, pages: 0, ready: true, error: null };
  }
}

/** A frame layout that keeps every patch it was handed, on the same footing. */
class FakeComposition implements Composition {
  readonly placements: Array<{ avatar?: Placement; slide?: SlidePlacement }> = [];
  /** Where both layers are, merged as a renderer would merge them. */
  private readonly current: PlacementReport = {
    avatar: { anchor: 'center', width: 1, height: 1, margin: 0 },
    slide: { anchor: 'center', width: 1, height: 1, margin: 0, fit: 'contain' },
  };

  setPlacement(placement: { avatar?: Placement; slide?: SlidePlacement }): void {
    this.placements.push(placement);
    Object.assign(this.current.avatar, placement.avatar);
    Object.assign(this.current.slide, placement.slide);
  }

  report(): PlacementReport {
    return { avatar: { ...this.current.avatar }, slide: { ...this.current.slide } };
  }
}

describe('the document behind the character', () => {
  it('forwards the document and the page it opens on, null included', () => {
    const slides = new FakeSlides();
    const { session } = build({ slides });
    session.setDeck('intro', 4);
    session.setDeck('outro');
    // Null takes it down and has to arrive as itself, exactly as the backdrop's
    // does: a default applied on the way would make "put it away" unsayable.
    session.setDeck(null);
    expect(slides.calls).toEqual([
      { call: 'setDeck', id: 'intro', page: 4 },
      { call: 'setDeck', id: 'outro', page: undefined },
      { call: 'setDeck', id: null, page: undefined },
    ]);
  });

  it('leaves the page absent when the caller named none, rather than sending the first', () => {
    // Which page an unqualified `deck` opens on is the renderer's answer, and
    // the session must not decide it here — the port can tell "open it as you
    // would" from "open it at page one" only if the absence survives.
    const slides = new FakeSlides();
    build({ slides }).session.setDeck('intro');
    expect(slides.calls[0]).not.toHaveProperty('page', 1);
    expect(slides.report()).toEqual({
      deck: 'intro',
      page: 1,
      pages: 0,
      ready: true,
      error: null,
    });
  });

  it('forwards an absolute page and a relative move as the two different calls they are', () => {
    const slides = new FakeSlides();
    const { session } = build({ slides });
    session.setSlide(7);
    session.turnSlide(1);
    session.turnSlide(-3);
    // "The next one" is not a page number, and a signed `setSlide` would make
    // the caller that does not know which page is up say that it does.
    expect(slides.calls).toEqual([
      { call: 'setSlide', page: 7 },
      { call: 'turnSlide', by: 1 },
      { call: 'turnSlide', by: -3 },
    ]);
  });

  it('does nothing on a renderer with no document layer, which is most of them', () => {
    // The same shape `setBackdrop` has without scenery and `wear` has without a
    // wardrobe: a renderer that cannot show a document is not a broken one.
    const { session } = build();
    expect(session.slides).toBeNull();
    expect(() => {
      session.setDeck('intro', 2);
      session.setDeck(null);
      session.setSlide(3);
      session.turnSlide(1);
    }).not.toThrow();
  });

  it('forwards a layout patch verbatim, both halves at once', () => {
    const composition = new FakeComposition();
    const { session } = build({ composition });
    const patch = {
      avatar: { anchor: 'bottom-right' as const, width: 0.3 },
      slide: { anchor: 'center' as const, width: 1, fit: 'contain' as const },
    };
    session.setPlacement(patch);
    // One call, because they are one decision: sent as two, the frame is
    // briefly wrong in the most visible direction — two layers overlapping.
    expect(composition.placements).toEqual([patch]);
  });

  it('forwards one number on its own, which is what a slider under the pointer sends', () => {
    const composition = new FakeComposition();
    build({ composition }).session.setPlacement({ avatar: { width: 0.5 } });
    // Merging is the renderer's, and it can only merge what it is given: absent
    // has to stay absent all the way down or every drag resets the other three.
    expect(composition.placements).toEqual([{ avatar: { width: 0.5 } }]);
  });

  it('setPlacement is a no-op on a renderer that draws one way', () => {
    const { session } = build();
    expect(session.composition).toBeNull();
    expect(() => session.setPlacement({ avatar: { width: 0.5 } })).not.toThrow();
  });
});

describe('a turn that stages a document', () => {
  it('opens the document before the page, so the page is the new document’s', () => {
    const slides = new FakeSlides();
    const { session, runUntil } = build({ slides });
    session.setDeck('outro', 9);
    slides.calls.length = 0;

    session.say({ text: 'いち', stage: { deck: 'intro', slide: 4 } });
    runUntil(() => session.turn?.text === 'いち');

    // The other order turns to page 4 of the document being replaced and then
    // opens the new one at its first, which is neither of the two things the
    // line said. One call and not two: the page rides on the document change,
    // so nothing downstream sees the same page asked for twice.
    expect(slides.calls).toEqual([{ call: 'setDeck', id: 'intro', page: 4 }]);
    expect(slides.report()).toMatchObject({ deck: 'intro', page: 4 });
  });

  it('turns a page of the document already up when the line names only a page', () => {
    const slides = new FakeSlides();
    const { session, runUntil } = build({ slides });
    session.setDeck('intro', 1);
    slides.calls.length = 0;

    session.say({ text: 'いち', stage: { slide: 3 } });
    runUntil(() => session.turn?.text === 'いち');

    expect(slides.calls).toEqual([{ call: 'setSlide', page: 3 }]);
    expect(slides.report()).toMatchObject({ deck: 'intro', page: 3 });
  });

  it('takes the document down on a null deck', () => {
    const slides = new FakeSlides();
    const { session, runUntil } = build({ slides });
    session.setDeck('intro', 2);
    slides.calls.length = 0;

    session.say({ text: 'いち', stage: { deck: null } });
    runUntil(() => session.turn?.text === 'いち');

    expect(slides.calls).toEqual([{ call: 'setDeck', id: null, page: undefined }]);
    expect(slides.report()).toMatchObject({ deck: null, page: 0 });
  });

  // Absent is not null, the same rule the backdrop follows: a staging that says
  // nothing about the document is a staging that leaves it exactly where it is.
  it('leaves the document alone when the staging names neither field', () => {
    const slides = new FakeSlides();
    const camera = vi.fn();
    const { session, runUntil } = build({ slides, camera });
    session.setDeck('intro', 5);
    slides.calls.length = 0;

    session.say({ text: 'いち', stage: { camera: 'full' } });
    runUntil(() => session.turn?.text === 'いち');

    expect(camera).toHaveBeenCalledWith({ frame: 'full' });
    expect(slides.calls).toEqual([]);
    expect(slides.report()).toMatchObject({ deck: 'intro', page: 5 });
  });

  it('says a line with no staging at all without touching the document', () => {
    const slides = new FakeSlides();
    const { session, runUntil } = build({ slides });
    session.say({ text: 'いち' });
    runUntil(() => session.turn?.text === 'いち');
    expect(slides.calls).toEqual([]);
  });

  /**
   * The reason a layout is on the turn at all. A deck that fills the frame
   * wants the character out of the middle of it, and the two sent separately
   * arrive at different moments — with her standing over the page in between.
   */
  it('moves the character aside on the same line that puts the document up', () => {
    const slides = new FakeSlides();
    const composition = new FakeComposition();
    const { session, runUntil } = build({ slides, composition });
    const place = { avatar: { anchor: 'bottom-right' as const, width: 0.26 } };

    session.say({ text: 'いち', stage: { deck: 'intro', slide: 1, place } });
    runUntil(() => session.turn?.text === 'いち');

    expect(slides.calls).toEqual([{ call: 'setDeck', id: 'intro', page: 1 }]);
    // Forwarded verbatim, exactly as the standalone command forwards it: absent
    // has to stay absent all the way down or a line that moves her sideways
    // resets her size too.
    expect(composition.placements).toEqual([place]);
  });

  it('leaves the layout alone when the staging does not name one', () => {
    const composition = new FakeComposition();
    const { session, runUntil } = build({ composition });
    session.say({ text: 'いち', stage: { camera: 'full' } });
    runUntil(() => session.turn?.text === 'いち');
    expect(composition.placements).toEqual([]);
  });

  it('leaves the layout where the line put it after the turn ends', () => {
    const composition = new FakeComposition();
    const { session, runUntil } = build({ composition });
    session.say({ text: 'いち', stage: { place: { avatar: { width: 0.3 } } } });
    runUntil(() => session.turn?.text === 'いち');
    runUntil(() => !session.busy);
    // Where the picture sits in the broadcast frame is a property of the
    // stream, not of a sentence. A turn that put it back would drop the
    // character into the middle of the document on the next line.
    expect(composition.placements).toEqual([{ avatar: { width: 0.3 } }]);
  });

  it('leaves the document up after the turn ends, like the camera and the backdrop', () => {
    const slides = new FakeSlides();
    const { session, runUntil } = build({ slides });
    session.say({ text: 'いち', stage: { deck: 'intro', slide: 2 } });
    runUntil(() => session.turn?.text === 'いち');
    const applied = [...slides.calls];

    runUntil(() => !session.busy);

    // A document is where the stream is, not a property of a sentence. A turn
    // that put its own away would leave the next line on a blank layer.
    expect(slides.calls).toEqual(applied);
    expect(slides.report()).toMatchObject({ deck: 'intro', page: 2 });
  });
});

describe('Session.replaceQueue', () => {
  it('reorders without asking the voice for anything again', async () => {
    let voice: FakeVoice | null = null;
    const { session } = build({
      voice: (now) => {
        voice = new FakeVoice(now, { seconds: 1 });
        return voice;
      },
    });
    session.say({ id: 'a', text: 'ひとつめ' });
    session.say({ id: 'b', text: 'ふたつめ' });
    await settle();
    const asked = (voice as unknown as FakeVoice).asked.length;
    const takes = session.queue.map((turn) => turn.take);

    session.replaceQueue([
      { id: 'b', text: 'ふたつめ' },
      { id: 'a', text: 'ひとつめ' },
    ]);

    expect(session.queue.map((turn) => turn.id)).toEqual(['b', 'a']);
    // The whole point: a drag costs one message and no synthesis. Re-asking
    // would take the stream quiet for a second per line, every reorder.
    expect((voice as unknown as FakeVoice).asked).toHaveLength(asked);
    expect(session.queue.map((turn) => turn.take)).toEqual([takes[1], takes[0]]);
  });

  it('re-synthesises a line whose words changed, and only that one', async () => {
    let voice: FakeVoice | null = null;
    const { session } = build({
      voice: (now) => {
        voice = new FakeVoice(now, { seconds: 1 });
        return voice;
      },
    });
    session.say({ id: 'a', text: 'そのまま' });
    session.say({ id: 'b', text: 'まちがい' });
    await settle();
    const kept = session.queue[0].take;

    session.replaceQueue([
      { id: 'a', text: 'そのまま' },
      { id: 'b', text: 'なおした' },
    ]);
    await settle();

    expect((voice as unknown as FakeVoice).asked).toEqual([
      'そのまま',
      'まちがい',
      // An edited line is a different line and has to be spoken again.
      'なおした',
    ]);
    expect(session.queue[0].take).toBe(kept);
  });

  it('treats a changed reading as a changed line', async () => {
    let voice: FakeVoice | null = null;
    const { session } = build({
      voice: (now) => {
        voice = new FakeVoice(now, { seconds: 1 });
        return voice;
      },
    });
    session.say({ id: 'a', text: '三件', reading: 'さんけん' });
    await settle();
    session.replaceQueue([{ id: 'a', text: '三件', reading: 'みっけん' }]);
    await settle();
    // The words are identical and the sound is not. Matching on text alone
    // would leave the corrected pronunciation unspoken.
    expect((voice as unknown as FakeVoice).asked).toHaveLength(2);
  });

  it('updates the fields around the line in place, keeping the take', async () => {
    const { session } = build({ voice: (now) => new FakeVoice(now, { seconds: 1 }) });
    session.say({ id: 'a', text: 'あ', perform: 'hello' });
    await settle();
    const take = session.queue[0].take;

    session.replaceQueue([{ id: 'a', text: 'あ', perform: null, emotion: { joy: 1 }, hold: true }]);

    // Everything outside the line itself is applied when the turn starts, so it
    // can be rewritten without costing the audio.
    expect(session.queue[0]).toMatchObject({ perform: null, emotion: { joy: 1 }, hold: true });
    expect(session.queue[0].take).toBe(take);
  });

  it('refreshes typed cues when only cue markup changes, keeping the take', async () => {
    const { session } = build({ voice: (now) => new FakeVoice(now, { seconds: 1 }) });
    session.say({ id: 'a', text: 'あ[@bgm play first.mp3]' });
    await settle();
    const take = session.queue[0].take;

    session.replaceQueue([{ id: 'a', text: 'あ[@bgm pause]' }]);

    expect(session.queue[0].take).toBe(take);
    expect(session.queue[0].cues).toEqual([
      { action: { kind: 'bgm', action: 'pause' }, at: expect.any(Number) },
    ]);
  });

  it('stops the take of a line the new list dropped', async () => {
    const { session } = build({ voice: (now) => new FakeVoice(now, { seconds: 1 }) });
    session.say({ id: 'a', text: 'のこる' });
    session.say({ id: 'b', text: 'きえる' });
    await settle();
    const dropped = session.queue[1].take as FakeTake;

    session.replaceQueue([{ id: 'a', text: 'のこる' }]);

    // A take that is not stopped arrives a second later and starts talking over
    // whatever replaced it — the same failure a `clear` mid-synthesis has.
    expect(dropped.stopped).toBe(true);
  });

  it('does not touch the turn that is already being said', () => {
    const { session, step } = build();
    session.say({ id: 'running', text: 'いま' });
    step(2);
    expect(session.turn?.id).toBe('running');

    session.replaceQueue([{ id: 'next', text: 'つぎ' }]);

    // A queue edit is about what comes next. Stopping the line in the air is
    // what `interrupt` is for, and doing it here would make every reorder cut
    // the character off mid-word.
    expect(session.turn?.id).toBe('running');
    expect(session.queue.map((turn) => turn.id)).toEqual(['next']);
  });

  it('reports the resulting depth on queue.replaced', () => {
    const { session } = build();
    session.say({ id: 'a' });
    session.takeEvents();
    session.replaceQueue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(session.takeEvents()).toEqual([{ type: 'queue.replaced', queued: 3 }]);
  });

  it('empties the queue when given nothing', () => {
    const { session } = build();
    session.say({ id: 'a' });
    session.replaceQueue([]);
    expect(session.queue).toHaveLength(0);
  });
});
