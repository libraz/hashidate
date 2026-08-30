import { describe, expect, it, vi } from 'vitest';
import { build, DT, IDLE_AFTER } from './harness';

/**
 * Performances — a face and a movement named together.
 */

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
