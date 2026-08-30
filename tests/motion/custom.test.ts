import { afterEach, describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import {
  clearMotions,
  compileMotion,
  GESTURES,
  gestureDef,
  gestureEntries,
  isBuiltInGestureName,
  loadMotions,
  type MotionDef,
} from '@/engine/motion';
import { buildProfile } from '@/engine/profile';
import { Session } from '@/engine/session';
import type { GestureVariation } from '@/engine/types';
import { buildRig } from '../helpers/scene';

/**
 * Motions loaded off disk, on top of the gesture table this project ships.
 *
 * Two things are under test and they are different in kind. One is arithmetic:
 * a keyframe track has to sample to the pose that was written at the times it
 * was written for, and to something between them in between. The other is a
 * rule — nothing loaded may take the name of a built-in, because a script
 * written against this runtime has to do the same thing on the machine next to
 * it, and a shadowed `wave` is the way that quietly stops being true.
 */

const PLAIN: GestureVariation = { rate: 1, scale: 1, side: 1 };

const motion = (over: Partial<MotionDef> = {}): MotionDef => ({
  id: 'testWave',
  label: { en: 'Test', ja: 'テスト' },
  group: 'greeting',
  lead: 0.2,
  hold: 1,
  frames: [
    { at: 0, arms: { R: { upperArm: [0, -1, 0], twist: 0 } }, spine: { head: [0, 0, 0] } },
    { at: 1, arms: { R: { upperArm: [0, 1, 0], twist: 1 } }, spine: { head: [0.2, 0, 0] } },
  ],
  ...over,
});

afterEach(() => {
  clearMotions();
});

describe('compileMotion', () => {
  it('lands on the frame that was written, at the time it was written for', () => {
    const built = compileMotion(motion());
    expect(built.build(0, PLAIN).arms?.R?.upperArm?.y).toBeCloseTo(-1);
    expect(built.build(1, PLAIN).arms?.R?.upperArm?.y).toBeCloseTo(1);
  });

  it('interpolates between two keyframes', () => {
    const built = compileMotion(motion());
    expect(built.build(0.5, PLAIN).arms?.R?.twist).toBeCloseTo(0.5);
  });

  /** A direction that came out of a blend is still a direction, or the rig aims
   *  the limb at a length rather than at a bearing. */
  it('keeps a blended direction normalised', () => {
    const built = compileMotion(
      motion({
        frames: [
          { at: 0, arms: { R: { hand: [1, 0, 0] } } },
          { at: 1, arms: { R: { hand: [0, 1, 0] } } },
        ],
      }),
    );
    expect(built.build(0.5, PLAIN).arms?.R?.hand?.length()).toBeCloseTo(1);
  });

  it('settles on the last frame rather than running past it', () => {
    const built = compileMotion(motion());
    expect(built.build(9, PLAIN).arms?.R?.upperArm?.y).toBeCloseTo(1);
  });

  it('runs the track round again when it loops', () => {
    const built = compileMotion(motion({ loop: true }));
    expect(built.build(2.5, PLAIN).arms?.R?.twist).toBeCloseTo(0.5);
  });

  /**
   * `rate` is the only reading of "faster" a keyframe track has, and `scale`
   * reaches the spine alone — a direction has no amplitude, so scaling one aims
   * it somewhere else instead of doing the same pose smaller.
   */
  it('scales time by rate', () => {
    const built = compileMotion(motion());
    expect(built.build(0.25, { ...PLAIN, rate: 2 }).arms?.R?.twist).toBeCloseTo(0.5);
  });

  it('scales the spine by scale and leaves the arms aimed where they were', () => {
    const built = compileMotion(motion());
    const pose = built.build(1, { ...PLAIN, scale: 0.5 });
    expect(pose.spine?.head?.[0]).toBeCloseTo(0.1);
    expect(pose.arms?.R?.upperArm?.y).toBeCloseTo(1);
  });

  /** Unstated is not zero. Fading toward a value nobody wrote down is the
   *  interpretation that produces motion nobody authored. */
  it('uses a field stated by only one of the two frames unchanged', () => {
    const built = compileMotion(
      motion({
        frames: [
          { at: 0, arms: { R: { hand: [0, 1, 0] } } },
          { at: 1, arms: { R: {} }, spine: { chest: [0.1, 0, 0] } },
        ],
      }),
    );
    expect(built.build(0.5, PLAIN).arms?.R?.hand?.y).toBeCloseTo(1);
    expect(built.build(0.5, PLAIN).spine?.chest?.[0]).toBeCloseTo(0.1);
  });

  it('carries the label, the group and the timings through', () => {
    const built = compileMotion(motion({ sustain: true }));
    expect(built.label.ja).toBe('テスト');
    expect(built.group).toBe('greeting');
    expect(built.lead).toBe(0.2);
    expect(built.sustain).toBe(true);
  });

  it('is not sustained unless it says so', () => {
    expect(compileMotion(motion()).sustain).toBeUndefined();
  });
});

describe('loadMotions', () => {
  it('uses the built-in gesture table as the reservation source', () => {
    expect(isBuiltInGestureName('wave')).toBe(true);
    expect(isBuiltInGestureName('testWave')).toBe(false);
  });

  it('makes a motion playable by name', () => {
    expect(gestureDef('testWave')).toBeNull();
    expect(loadMotions([motion()]).loaded).toEqual(['testWave']);
    expect(gestureDef('testWave')?.label.en).toBe('Test');
  });

  it.each(['toString', 'constructor'])('keeps prototype names playable', (id) => {
    const result = loadMotions([motion({ id })]);

    expect(result.loaded).toEqual([id]);
    expect(result.rejected).toEqual([]);
    expect(gestureDef(id)?.label.en).toBe('Test');
  });

  it('refuses to take the name of a built-in gesture', () => {
    const result = loadMotions([motion({ id: 'wave' })]);
    expect(result.loaded).toEqual([]);
    expect(result.rejected).toEqual([{ id: 'wave', reason: 'reserved' }]);
    expect(gestureDef('wave')).toBe(GESTURES.wave);
  });

  it('keeps the first of two motions with one name', () => {
    const result = loadMotions([motion(), motion({ label: { en: 'Second', ja: '二' } })]);
    expect(result.rejected).toEqual([{ id: 'testWave', reason: 'duplicate' }]);
    expect(gestureDef('testWave')?.label.en).toBe('Test');
  });

  /**
   * Replace and not merge. The renderer re-reads the directory on every
   * connect, so a motion whose file was deleted has to actually go away — a
   * registry that only grew would keep answering for it with nothing on screen
   * saying why.
   */
  it('replaces what was loaded before', () => {
    loadMotions([motion()]);
    loadMotions([motion({ id: 'other' })]);
    expect(gestureDef('testWave')).toBeNull();
    expect(gestureDef('other')).not.toBeNull();
  });

  it('leaves the built-in table alone when nothing is loaded', () => {
    loadMotions([]);
    expect(gestureEntries()).toHaveLength(Object.keys(GESTURES).length);
  });
});

describe('gestureEntries', () => {
  it('lists the built-ins first, then what was loaded', () => {
    loadMotions([motion()]);
    const ids = gestureEntries().map(([id]) => id);
    expect(ids.slice(0, Object.keys(GESTURES).length)).toEqual(Object.keys(GESTURES));
    expect(ids.at(-1)).toBe('testWave');
  });
});

describe('the vocabulary', () => {
  it('reports a loaded motion beside the built-in gestures', () => {
    const rig = buildRig({ arkit: false });
    const session = new Session(new Director(buildProfile(rig.root, rig.descriptor)));
    expect(session.vocabulary().gestures.map((g) => g.id)).not.toContain('testWave');
    loadMotions([motion({ sustain: true })]);
    expect(session.vocabulary().gestures).toContainEqual({
      id: 'testWave',
      label: { en: 'Test', ja: 'テスト' },
      group: 'greeting',
      sustain: true,
    });
  });
});
