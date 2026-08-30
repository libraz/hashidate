import { describe, expect, it } from 'vitest';
import { same } from '@/i18n/locale';
import { build, EFFECTS, FACES } from './harness';

/**
 * What the session can be asked about: what it is doing, and what this avatar
 * can be asked to do.
 */

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
