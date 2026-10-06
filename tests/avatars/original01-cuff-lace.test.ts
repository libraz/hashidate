import { describe, expect, it } from 'vitest';
import {
  createOriginal01MainCuffLaceGravity,
  createOriginal01MainPoutSpeechCorrective,
} from '@/avatars/original01';

describe('cuff lace candidate', () => {
  it('retains Main contracts and adds only eight cuff lace roots and hand colliders', () => {
    const base = createOriginal01MainPoutSpeechCorrective('/base.glb');
    const candidate = createOriginal01MainCuffLaceGravity('/trial.glb');
    expect(candidate.wardrobe).toEqual(base.wardrobe);
    expect(candidate.materials).toEqual(base.materials);
    expect(candidate.presets).toEqual(base.presets);
    expect(candidate.sway?.groups.slice(0, base.sway?.groups.length)).toEqual(base.sway?.groups);
    const added = candidate.sway!.groups.slice(base.sway!.groups.length);
    expect(added).toHaveLength(8);
    expect(new Set(added.flatMap((group) => group.roots!)).size).toBe(8);
    for (const side of ['L', 'R'])
      for (const sector of ['F', 'U', 'B', 'D']) {
        const group = added.find((g) => g.id === `mainCuffLace${side}${sector}`);
        expect(group?.roots).toEqual([`V02_CuffLace_${side}_${sector}_001`]);
        expect(group?.gravityDir).toEqual([0, -1, 0]);
        expect(group?.colliders).toEqual([`mainCuffHand${side}`]);
        expect(candidate.sway?.colliders?.[`mainCuffHand${side}`]?.[0]?.bone).toBe(`Hand_${side}`);
      }
    expect(base.sway?.groups.some((group) => group.id.startsWith('mainCuffLace'))).toBe(false);
  });
});
