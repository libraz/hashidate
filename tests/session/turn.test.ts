import { describe, expect, it } from 'vitest';
import type { Director } from '@/engine/director';
import { build, types } from './harness';

/**
 * One turn, and what it leaves behind when it ends.
 */

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
