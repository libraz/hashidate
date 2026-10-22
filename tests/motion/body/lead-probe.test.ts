import { describe, expect, it } from 'vitest';
import { GESTURES } from '@/engine/motion/gestures';
import type { Side } from '@/engine/types';
import { DT, type Harness, harness } from './harness';
import { type AcceptedHandsFrame, observeAcceptedHands } from './observe-accepted';

/**
 * `leadFor` asks what a play would take as its entrance without playing it. It
 * is called every frame a cue waits in its window, so it must leave nothing
 * behind: no draw from the shared source and no state the next play reads.
 */

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** A body on a seeded source that counts its draws. */
function counted(seed: number): { h: Harness; draws: () => number } {
  const source = seeded(seed);
  let n = 0;
  const h = harness(0, {
    random: () => {
      n++;
      return source();
    },
  });
  return { h, draws: () => n };
}

interface Frame {
  hands: AcceptedHandsFrame;
  quaternions: number[][];
}

function trace(h: Harness): Frame[] {
  const frames: Frame[] = [];
  const bones = Object.values(h.profile.bones).filter((b) => b !== undefined);
  observeAcceptedHands(h, (hands) => {
    frames.push({ hands, quaternions: bones.map((b) => b.quaternion.toArray()) });
  });
  return frames;
}

function run(h: Harness, frames: number): void {
  for (let i = 0; i < frames; i++) {
    h.rig.reset();
    h.body.update(DT);
  }
}

describe('lead probe', () => {
  it.each([
    ['from rest', null, 0],
    ['mid-entrance of a spine gesture', 'bow', 10],
    ['mid-hold with a fade behind it', 'explain', 40],
  ] as const)('perturbs nothing a following play reads, %s', (_label, before, frames) => {
    const a = counted(11);
    const b = counted(11);
    const traces = [trace(a.h), trace(b.h)];
    for (const { h } of [a, b]) {
      run(h, 3);
      if (before) {
        h.body.play('wave');
        run(h, 12);
        h.body.play(before);
        run(h, frames);
      }
    }
    const drawsBefore = a.draws();
    expect(a.h.body.leadFor('present')).toBeGreaterThan(0);
    expect(a.draws()).toBe(drawsBefore);

    for (const { h } of [a, b]) h.body.play('present');
    expect(a.h.body.gesture?.v).toEqual(b.h.body.gesture?.v);
    expect(a.h.body.gesture?.lead).toBe(b.h.body.gesture?.lead);
    for (const { h } of [a, b]) run(h, 60);

    expect(traces[0]).toEqual(traces[1]);
    expect(a.draws()).toBe(b.draws());
  });

  it.each(Object.keys(GESTURES))('bounds every variation of %s from rest', (id) => {
    const probe = harness();
    const bound = probe.body.leadFor(id);
    const leads: number[] = [];
    for (const scaleDraw of [0, 1]) {
      for (const side of ['L', 'R'] as Side[]) {
        // Rate at exactly 1, scale at either end of its range, speed anywhere.
        const draws = [0.5, scaleDraw, 0.5];
        const h = harness(0, { random: () => draws.shift() ?? 0.5 });
        h.body.play(id, side);
        leads.push(h.body.gesture?.lead ?? Number.NaN);
      }
    }
    for (const lead of leads) expect(bound).toBeGreaterThanOrEqual(lead - 1e-12);
    expect(Math.abs(bound - Math.max(...leads))).toBeLessThanOrEqual(1e-9);
  });

  it('reports no lead for an id it does not know', () => {
    const h = harness();
    expect(h.body.leadFor('nosuchgesture')).toBe(0);
    expect(h.body.leadBound('nosuchgesture')).toBe(0);
  });

  it('bounds the window by the authored lead or the travel cap, whichever is longer', () => {
    const h = harness();
    expect(h.body.leadBound('nod')).toBe(0.95);
    expect(h.body.leadBound('doze')).toBe(GESTURES.doze.lead);
    expect(GESTURES.doze.lead).toBeGreaterThan(0.95);
  });
});
