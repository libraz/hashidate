import { describe, expect, it } from 'vitest';
import {
  createOriginal01MainCuffCharmGravity,
  createOriginal01MainPoutSpeechCorrective,
} from '@/avatars/original01';

describe('Pout speech corrective candidate', () => {
  it('clones the cuff charm profile and maps Pout to its excluded helper key', () => {
    const base = createOriginal01MainCuffCharmGravity('/base.glb');
    const candidate = createOriginal01MainPoutSpeechCorrective('/candidate.glb');
    const helper = 'V02_SpeechNeutralizer_Pout';

    expect(candidate.id).toBe('original-01-main-pout-speech-corrective');
    expect(candidate.url).toBe('/candidate.glb');
    expect(candidate.sway).toEqual(base.sway);
    expect(candidate.wardrobe).toEqual(base.wardrobe);
    expect(candidate.materials).toEqual(base.materials);
    expect(candidate.presets).not.toBe(base.presets);
    expect(candidate.presets?.exclude).toEqual([...(base.presets?.exclude ?? []), helper]);
    expect(candidate.presets?.composition?.V02_06_Pout).toEqual({
      speechNeutralizer: helper,
    });
    expect(base.presets?.exclude).not.toContain(helper);
    expect(base.presets?.composition?.V02_06_Pout).toBeUndefined();
  });
});
