import { describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import type { HeadBeat } from '@/engine/motion';
import { buildProfile } from '@/engine/profile';
import type { GestureVariation } from '@/engine/types';
import { splitmix64 } from '../helpers/director-fixtures';
import { buildRig } from '../helpers/scene';

/** Thirty morae (about 4 s) with breaks: long enough for an onset aversion, several break draws. */
const LINE = 'あいうえおかきくけこ、さしすせそたちつてと。なにぬねのはひふへほ';

/** The private draw sites a seeded turn feeds, as the test reads them. */
interface Internals {
  _beats: { _plan: readonly HeadBeat[] };
  _turnBlink: (() => number) | null;
  body: { _gaze: { turnRandom: (() => number) | null } };
}

function make(random: () => number): Director {
  const rig = buildRig();
  const director = new Director(buildProfile(rig.root, rig.descriptor), undefined, { random });
  // At the measured rates, so the plan has nods to compare.
  director.nodRate = 1;
  return director;
}

/** Record every draw a stream hands out, leaving the values unchanged. */
function tap(draw: () => number, log: number[]): () => number {
  return () => {
    const v = draw();
    log.push(v);
    return v;
  };
}

interface Draws {
  gesture: { v: GestureVariation; speed: number };
  plan: HeadBeat[];
  blink: number[];
  gaze: number[];
}

function perform(director: Director, id: string | null, dt: number): Draws {
  const seen = director as unknown as Internals;
  const blink: number[] = [];
  const gaze: number[] = [];
  director.beginTurn(id);
  if (id !== null) {
    const turnBlink = seen._turnBlink;
    const turnGaze = seen.body._gaze.turnRandom;
    if (!(turnBlink && turnGaze)) throw new Error('a seeded turn installed no streams');
    seen._turnBlink = tap(turnBlink, blink);
    seen.body._gaze.turnRandom = tap(turnGaze, gaze);
  }
  director.gesture('peace');
  const g = director.body.gesture;
  if (!g) throw new Error('the gesture did not start');
  const gesture = { v: { ...g.v }, speed: g.speed };
  director.speak(LINE);
  const plan = [...seen._beats._plan];
  for (let t = 0; t < 5; t += dt) director.update(dt);
  return { gesture, plan, blink, gaze };
}

describe('Director / seeded turn draws', () => {
  it('agrees across global random and frame rate for one turn id', () => {
    const a = perform(make(splitmix64(1n)), 'q-1', 1 / 60);
    const b = perform(make(splitmix64(2n)), 'q-1', 1 / 72);
    expect(a.plan.length).toBeGreaterThan(0);
    expect(a.blink.length).toBeGreaterThan(1);
    expect(a.gaze.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  it('draws differently for a different turn id', () => {
    const a = perform(make(splitmix64(1n)), 'q-1', 1 / 60);
    const b = perform(make(splitmix64(1n)), 'q-2', 1 / 60);
    expect(b.gesture).not.toEqual(a.gesture);
  });

  it('keeps the global random for an unseeded turn and after a seeded one', () => {
    const director = make(() => 0.25);
    const fromGlobal = { rate: 0.92 + 0.25 * 0.16, scale: 0.9 + 0.25 * 0.2, side: -1 };
    expect(perform(director, null, 1 / 60).gesture.v).toEqual(fromGlobal);

    director.beginTurn('q-1');
    director.gesture('nod');
    expect(director.body.gesture?.v).not.toEqual(fromGlobal);

    director.beginTurn(null);
    director.gesture('peace');
    expect(director.body.gesture?.v).toEqual(fromGlobal);
    expect(director.body.gesture?.speed).toBe(0.93 + 0.25 * 0.14);
  });
});
