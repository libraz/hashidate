import { describe, expect, it } from 'vitest';
import type { Vocabulary } from '@/engine/types';
import { buildDemo } from '@/viewer/demo';

/**
 * The self-test's own test, which is only about one property: the walk is built
 * from the avatar's vocabulary rather than from a list written here.
 *
 * That is the whole design. A fixture list of thirty performances goes stale the
 * first time the table grows, and the failure it produces is the worst kind — a
 * demo that runs clean while never touching the thing that broke. So what is
 * pinned below is coverage: every id the vocabulary advertises appears in the
 * walk, and an avatar with fewer of them produces a shorter walk rather than a
 * broken one.
 */

const vocabulary = (over: Partial<Vocabulary> = {}): Vocabulary => ({
  avatar: { id: 'synthetic', label: '合成リグ' },
  emotions: [
    { id: 'neutral', label: '素' },
    { id: 'joy', label: '喜' },
  ],
  expressions: [{ id: 'F_DOYA', label: 'ドヤ' }],
  overlays: [{ id: 'FX_BLUSH', label: '赤面' }],
  performances: [
    {
      id: 'hello',
      label: '挨拶',
      group: 'greeting',
      emotion: { joy: 1 },
      gesture: 'wave',
      hop: null,
      sustain: false,
    },
    {
      id: 'explain',
      label: '説明',
      group: 'explain',
      emotion: {},
      gesture: null,
      hop: null,
      sustain: false,
    },
  ],
  gestures: [{ id: 'wave', label: '手を振る', group: 'greeting', sustain: false }],
  hops: [{ id: 'single', label: 'ひとつ' }],
  cue: { syntax: '[performance]', note: '' },
  cameras: ['bust', 'face'],
  pointing: {
    side: ['L', 'R'],
    azimuth: [-120, 120],
    elevation: [-70, 110],
    extent: [0.1, 1],
    finger: ['index'],
    note: '',
  },
  wardrobe: {},
  wardrobePresets: [{ id: 'bare', label: '素' }],
  rooms: [{ id: 'hall', label: 'ホール' }],
  backdrops: [{ id: 'night', label: '深夜' }],
  voicePresets: [{ id: 'neutral-monitor', label: '素のまま' }],
  ...over,
});

const labels = (v: Vocabulary): string[] => buildDemo(v).map((s) => s.label);

describe('buildDemo', () => {
  it('covers every id the vocabulary advertises', () => {
    const v = vocabulary();
    const walk = labels(v).join('\n');
    for (const id of [
      ...v.cameras,
      ...v.emotions.map((e) => e.label),
      ...v.expressions.map((e) => e.label),
      ...v.overlays.map((o) => o.label),
      ...v.performances.map((p) => p.label),
      ...v.gestures.map((g) => g.label),
      ...v.hops.map((h) => h.label),
      ...v.rooms.map((r) => r.label),
      ...v.wardrobePresets.map((p) => p.label),
    ]) {
      expect(walk).toContain(id);
    }
  });

  it('grows with the avatar rather than being a fixed script', () => {
    const small = buildDemo(vocabulary({ performances: [] })).length;
    const large = buildDemo(vocabulary()).length;
    expect(large).toBeGreaterThan(small);
  });

  it('produces a runnable walk for an avatar with almost nothing on it', () => {
    // A rig with no drawn expressions, no wardrobe and no voice is the ordinary
    // case for a model somebody has just exported for the first time — which is
    // exactly when the demo is reached for.
    const bare = vocabulary({
      expressions: [],
      overlays: [],
      gestures: [],
      hops: [],
      rooms: [],
      wardrobePresets: [],
      performances: [],
    });
    const steps = buildDemo(bare);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.at(-1)?.label).toBe('おわり');
  });

  it('ends on a step that leaves the character presentable', () => {
    const steps = buildDemo(vocabulary());
    // A walk that stopped on a close-up with a held gesture leaves the viewer
    // looking broken to whoever comes back to it.
    expect(steps.at(-1)).toMatchObject({ label: 'おわり', hold: 0 });
  });

  it('writes a cue into a line, which nothing else in the walk exercises', () => {
    const walk = buildDemo(vocabulary());
    const cued = walk.find((s) => s.label === '行中のキュー');
    expect(cued).toBeDefined();
  });

  it('omits the cued line when there are not two performances to cue', () => {
    const walk = labels(vocabulary({ performances: vocabulary().performances.slice(0, 1) }));
    expect(walk).not.toContain('行中のキュー');
  });

  it('sweeps pointing rather than enumerating it, both sides', () => {
    const walk = labels(vocabulary());
    // The failure pointing has is a discontinuity between two elbow solutions,
    // which only appears when the arm travels through the range.
    expect(walk.filter((l) => l.startsWith('指差し L')).length).toBeGreaterThan(2);
    expect(walk.filter((l) => l.startsWith('指差し R')).length).toBeGreaterThan(2);
  });
});
