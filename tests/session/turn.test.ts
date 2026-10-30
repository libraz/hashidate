import { describe, expect, it, vi } from 'vitest';
import type { Director } from '@/engine/director';
import { HOPS } from '@/engine/motion/jump';
import type { TurnRequest } from '@/engine/types';
import { withSide } from '@/server/side';
import { build, type Harness, types } from './harness';

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

  it.each(['finish', 'interrupt'] as const)(
    'preserves a later expression when the turn ends by %s',
    (ending) => {
      const { session, director, step, runUntil } = build();
      session.say({ id: 'a', text: 'あいうえお', expression: 'F_JITO' });
      step(2);
      session.setExpression('F_DOYA');
      if (ending === 'interrupt') session.interrupt();
      else runUntil(() => !session.busy);
      expect(director.pickedExpression).toBe('F_DOYA');
    },
  );

  it('lets an interrupted hop run land the hop in the air and start no more', () => {
    /** Frames until the hop run is over, from the frame `start` begins it. */
    const airborne = (start: (h: Harness) => void, cut: number | null): number => {
      const harness = build();
      const { session, director, step } = harness;
      start(harness);
      step(1);
      expect(director.body.jumping).toBe(true);
      if (cut !== null) {
        step(cut);
        session.interrupt();
      }
      let frames = 1 + (cut ?? 0);
      while (director.body.jumping && frames < 600) {
        step(1);
        frames += 1;
      }
      return frames;
    };
    const cue = ({ session }: Harness) =>
      session.say({ id: 'a', text: '[@hop bounce]あいうえおかき' });
    const single = airborne(
      ({ director }) => director.body.hop({ ...HOPS.bounce, count: 1 }),
      null,
    );
    // Left alone the bounce's second hop follows; cut during the first, only that one lands.
    expect(airborne(cue, null)).toBeGreaterThan(single + 5);
    expect(airborne(cue, 2)).toBe(single);
  });

  it('releases a cued expression by its pick during a crossfade', () => {
    const { session, director, step, runUntil } = build();
    session.setExpression('F_DOYA');
    step(60);
    expect(director.expression).toBe('F_DOYA');

    session.say({ id: 'cued', text: '[@expression F_JITO]あ' });
    step(1);
    // The old face is still visible while the new pick is fading in. Comparing
    // against `expression` here would miss the turn's own face and leave it
    // selected after the line ends.
    expect(director.expression).toBe('F_DOYA');
    expect(director.pickedExpression).toBe('F_JITO');
    runUntil(() => !session.busy);
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

  it('agrees across renderers on the hand and the tilt of a movement cued mid-line', () => {
    // The server draws one side for the line; each renderer then draws from its own random.
    const line = withSide<TurnRequest>(
      { id: 'a', text: 'あい[@gesture peace]うえお[wonder]かき' },
      () => 0.1,
    );
    expect(line.side).toBe('L');
    const play = (draw: number): { hand?: number; tilt?: string } => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(draw);
      try {
        const harness: Harness = build();
        const { session, director, runUntil } = harness;
        session.say(line);
        runUntil(() => director.body.gesture?.id === 'peace');
        const hand = acting(director);
        runUntil(() => director.performance === 'wonder');
        return { hand, tilt: director.body.attitude?.side };
      } finally {
        random.mockRestore();
      }
    };
    const low = play(0.1);
    const high = play(0.9);
    expect(low).toEqual({ hand: -1, tilt: 'L' });
    expect(high).toEqual(low);
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
