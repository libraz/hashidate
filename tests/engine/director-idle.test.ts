import { describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import { performanceDef } from '@/engine/performance';
import { buildProfile } from '@/engine/profile';
import type { Side } from '@/engine/types';
import { buildRig } from '../helpers/scene';

/**
 * The renderer half of the idle: it plays the choices the server sends and
 * draws none of them, so two renderers fed the same choices show the same idle
 * whatever their frame rate and whatever their own cosmetic draws.
 */

const FACES = ['F_DOYA', 'F_JITO', 'F_SUYASUYA'];

/** Deterministic draws, different per director, for the cosmetic layer. */
function lcg(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 2 ** 32;
  };
}

function director(seed: number): Director {
  const rig = buildRig({ groups: [['Face', FACES]] });
  const profile = buildProfile(rig.root, {
    ...rig.descriptor,
    presets: { group: 'Face', emotion: { joy: 'F_DOYA' } },
  });
  const d = new Director(profile, undefined, { random: lcg(seed) });
  d.auto = true;
  return d;
}

type Choice = { at: number } & ({ act: string; side?: Side } | { face: number | null });

/** What a viewer could tell apart: which performance, which gesture on which hand, which face. */
interface Seen {
  acts: string[];
  gestures: string[];
  faces: string[];
}

function play(d: Director, hz: number, choices: Choice[], seconds: number): Seen {
  const dt = 1 / hz;
  const seen: Seen = { acts: [], gestures: [], faces: [] };
  const due = [...choices];
  for (let t = 0; t < seconds; t += dt) {
    while (due.length && due[0].at <= t) {
      const c = due.shift() as Choice;
      if ('face' in c) d.idleFace(c.face);
      else d.idleAct(c.act, c.side);
    }
    d.update(dt);
    const act = d.performance;
    if (act && seen.acts.at(-1) !== act) seen.acts.push(act);
    const g = d.body.gesture;
    const gesture = g && !g.released ? `${g.id}:${g.v.side}` : null;
    if (gesture && seen.gestures.at(-1) !== gesture) seen.gestures.push(gesture);
    const face = d.expression;
    if (face && seen.faces.at(-1) !== face) seen.faces.push(face);
  }
  return seen;
}

describe('a director playing the idle it is sent', () => {
  const choices: Choice[] = [
    { at: 0, act: 'blank' },
    { at: 0, face: 0.5 },
    { at: 2, act: 'peace', side: 'L' },
    { at: 5, face: null },
    { at: 7, act: 'curious', side: 'R' },
    { at: 7, face: 0.9 },
    { at: 11, act: 'guarded', side: 'R' },
    { at: 14, act: 'applause', side: 'L' },
    { at: 14, face: 0.1 },
  ];

  it('plays the same gestures on the same hands and the same faces at 20 Hz and 60 Hz', () => {
    const slow = play(director(1), 20, choices, 20);
    const fast = play(director(2), 60, choices, 20);
    expect(slow).toEqual(fast);
    expect(slow.acts).toEqual(['blank', 'peace', 'curious', 'guarded', 'applause']);
    const sides = slow.gestures.map((g) => g.split(':')[1]);
    expect(slow.gestures.map((g) => g.split(':')[0])).toEqual(
      ['peace', 'curious', 'guarded', 'applause']
        .map((id) => performanceDef(id)?.gesture)
        .filter(Boolean),
    );
    expect(sides.length).toBeGreaterThan(0);
    expect(slow.faces).toContain('F_JITO');
    expect(slow.faces).toContain('F_SUYASUYA');
  });

  it('waits for a gesture that will end on its own rather than cutting it', () => {
    const d = director(3);
    d.gesture('nod');
    d.idleAct('peace', 'R');
    d.update(1 / 60);
    expect(d.body.gesture?.id).toBe('nod');
    for (let i = 0; i < 600 && d.performance !== 'peace'; i++) d.update(1 / 60);
    expect(d.performance).toBe('peace');
    expect(d.body.gesture?.id).toBe(performanceDef('peace')?.gesture);
  });

  it('drops a choice that arrives while its idle is not engaged', () => {
    const d = director(4);
    d.auto = false;
    d.idleAct('peace', 'L');
    d.idleFace(0.5);
    d.auto = true;
    for (let i = 0; i < 120; i++) d.update(1 / 60);
    expect(d.performance).toBeNull();
    expect(d.expression).toBeNull();
  });
});
