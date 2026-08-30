import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMotions, GESTURES, HOPS, loadMotions, planJump } from '@/engine/motion';
import { CROUCH_T, RECOVER_T } from '@/engine/motion/jump';
import { PERFORMANCE_TABLE } from '@/engine/performance';
import { build, DT, IDLE_AFTER } from './harness';

afterEach(() => {
  clearMotions();
});

/**
 * The idle autopilot: when it is allowed to take over, and what it may not
 * take away from whoever asked for it.
 */

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

  it('keeps loaded motions out of the idle performance and gesture pools', () => {
    const loadedId = 'fileOnlyIdle';
    loadMotions([
      {
        id: loadedId,
        label: { en: 'File only', ja: 'ファイル専用' },
        group: 'greeting',
        lead: 0.2,
        hold: 0.8,
        frames: [
          { at: 0, arms: { R: { upperArm: [0, -1, 0] } } },
          { at: 0.5, arms: { R: { upperArm: [0, 1, 0] } } },
        ],
      },
    ]);

    const { director, step, runUntil } = build({ idle: true });
    step(Math.ceil((IDLE_AFTER + 1) / DT));
    runUntil(() => !!director.performance, 12);

    const performances = new Set<string>();
    const gestures = new Set<string>();
    for (let i = 0; i < Math.ceil(18 / DT); i++) {
      step(1);
      if (director.performance) performances.add(director.performance);
      if (director.body.gesture) gestures.add(director.body.gesture.id);
    }

    expect(performances.size).toBeGreaterThan(0);
    for (const id of performances) expect(Object.hasOwn(PERFORMANCE_TABLE, id)).toBe(true);
    expect(gestures).not.toContain(loadedId);
    for (const id of gestures) expect(Object.hasOwn(GESTURES, id)).toBe(true);
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
