import { describe, expect, it } from 'vitest';
import type { Vocabulary } from '@/engine/types';
import { getLocale, type Localized, pick, same } from '@/i18n/locale';
import type { MessageKey } from '@/i18n/messages';
import { type Params, translate } from '@/i18n/translate';
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
  avatar: { id: 'synthetic', label: same('合成リグ') },
  emotions: [
    { id: 'neutral', label: same('素') },
    { id: 'joy', label: same('喜') },
  ],
  expressions: [{ id: 'F_DOYA', label: same('ドヤ') }],
  overlays: [{ id: 'FX_BLUSH', label: same('赤面') }],
  performances: [
    {
      id: 'hello',
      label: same('挨拶'),
      group: 'greeting',
      emotion: { joy: 1 },
      gesture: 'wave',
      hop: null,
      sustain: false,
    },
    {
      id: 'explain',
      label: same('説明'),
      group: 'explain',
      emotion: {},
      gesture: null,
      hop: null,
      sustain: false,
    },
  ],
  gestures: [{ id: 'wave', label: same('手を振る'), group: 'greeting', sustain: false }],
  hops: [{ id: 'single', label: same('ひとつ') }],
  cue: { syntax: '[performance]', note: same('') },
  cameras: ['bust', 'face'],
  pointing: {
    side: ['L', 'R'],
    azimuth: [-120, 120],
    elevation: [-70, 110],
    extent: [0.1, 1],
    finger: ['index'],
    note: same(''),
  },
  wardrobe: {},
  wardrobePresets: [{ id: 'bare', label: same('素') }],
  rooms: [{ id: 'hall', label: same('ホール') }],
  backdrops: [{ id: 'night', label: same('深夜') }],
  voicePresets: [{ id: 'neutral-monitor', label: same('素のまま') }],
  ...over,
});

const labels = (v: Vocabulary): string[] => buildDemo(v).map((s) => s.label);

/** The same catalogue the walk names its steps from, at the locale in force. */
const step = (key: MessageKey, params?: Params): string => translate(key, getLocale(), params);

describe('buildDemo', () => {
  it('covers every id the vocabulary advertises', () => {
    const v = vocabulary();
    const walk = labels(v).join('\n');
    // The walk resolves each label against the locale in force, which under a
    // test runner is the English fallback.
    const name = (text: Localized): string => pick(text, getLocale());
    for (const id of [
      ...v.cameras,
      ...v.emotions.map((e) => name(e.label)),
      ...v.expressions.map((e) => name(e.label)),
      ...v.overlays.map((o) => name(o.label)),
      ...v.performances.map((p) => name(p.label)),
      ...v.gestures.map((g) => name(g.label)),
      ...v.hops.map((h) => name(h.label)),
      ...v.rooms.map((r) => name(r.label)),
      ...v.wardrobePresets.map((p) => name(p.label)),
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
    expect(steps.at(-1)?.label).toBe(step('console.demo.step.end'));
  });

  it('ends on a step that leaves the character presentable', () => {
    const steps = buildDemo(vocabulary());
    // A walk that stopped on a close-up with a held gesture leaves the viewer
    // looking broken to whoever comes back to it.
    expect(steps.at(-1)).toMatchObject({ label: step('console.demo.step.end'), hold: 0 });
  });

  it('writes a cue into a line, which nothing else in the walk exercises', () => {
    const walk = buildDemo(vocabulary());
    const cued = walk.find((s) => s.label === step('console.demo.step.cueInLine'));
    expect(cued).toBeDefined();
  });

  it('omits the cued line when there are not two performances to cue', () => {
    const walk = labels(vocabulary({ performances: vocabulary().performances.slice(0, 1) }));
    expect(walk).not.toContain(step('console.demo.step.cueInLine'));
  });

  it('sweeps pointing rather than enumerating it, both sides', () => {
    const walk = labels(vocabulary());
    // The failure pointing has is a discontinuity between two elbow solutions,
    // which only appears when the arm travels through the range.
    const pointing = (side: string): string =>
      step('console.demo.step.point', { side, azimuth: 0 }).replace(' 0°', '');
    expect(walk.filter((l) => l.startsWith(pointing('L'))).length).toBeGreaterThan(2);
    expect(walk.filter((l) => l.startsWith(pointing('R'))).length).toBeGreaterThan(2);
  });
});
