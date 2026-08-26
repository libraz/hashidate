import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { Wardrobe } from '@/engine/scene';
import { Session } from '@/engine/session';
import type { SessionEvent, SessionEventType, WardrobeTable } from '@/engine/types';
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

const FACES = ['F_DOYA', 'F_JITO', 'F_SUYASUYA'];
const EFFECTS = ['FX_BLUSH', 'FX_TEARS'];

const WARDROBE: WardrobeTable = {
  slots: {
    top: {
      label: 'トップス',
      items: [{ id: 'shirt', label: 'シャツ', meshes: ['Shirt'] }],
    },
  },
  presets: { bare: { label: '素', set: { top: null } } },
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

function build({ wardrobe = false, idle = false }: { wardrobe?: boolean; idle?: boolean } = {}) {
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
  const session = new Session(director, {
    wardrobe: wardrobe ? new Wardrobe(rig.root, profile, WARDROBE) : null,
    idle,
  });

  let clock = 0;
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
        'lookAt',
        'overlays',
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
      gesture: null,
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
        'cameras',
        'emotions',
        'expressions',
        'gestures',
        'overlays',
        'pointing',
        'wardrobe',
        'wardrobePresets',
      ].sort(),
    );
    expect(vocabulary.avatar).toEqual({ id: 'synthetic', label: '合成リグ' });
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
      top: { label: 'トップス', items: [{ id: 'shirt', label: 'シャツ' }] },
    });
    expect(vocabulary.wardrobePresets).toEqual([{ id: 'bare', label: '素' }]);
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

  it('setCamera forwards the framing to the viewer callback', () => {
    const rig = buildRig();
    const director = new Director(buildProfile(rig.root, rig.descriptor));
    const camera = vi.fn();
    const session = new Session(director, { camera });
    session.setCamera('face');
    expect(camera).toHaveBeenCalledWith('face');
  });

  it('setCamera is a no-op when no viewer is attached', () => {
    expect(() => harness.session.setCamera('full')).not.toThrow();
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
