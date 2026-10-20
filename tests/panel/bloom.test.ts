import { describe, expect, it } from 'vitest';
import { reconcileBloom } from '@/panel/tune/TuneTab';
import { BLOOM_DEFAULTS, type BloomSettings } from '@/protocol';

const reported: BloomSettings = { ...BLOOM_DEFAULTS };

describe('reconcileBloom', () => {
  it('keeps the local value while the next report is still stale', () => {
    const result = reconcileBloom(reported, { patch: { enabled: true }, until: 1_000 }, 500);

    expect(result).toEqual({
      settings: { ...reported, enabled: true },
      pending: true,
    });
  });

  it('adopts a matching renderer report and clears the pending patch', () => {
    const result = reconcileBloom(
      { ...reported, enabled: true },
      { patch: { enabled: true }, until: 1_000 },
      500,
    );

    expect(result).toEqual({ settings: { ...reported, enabled: true }, pending: false });
  });

  it('eventually follows an external bloom change that disagrees with the local request', () => {
    const external = { ...reported, enabled: false, strength: 1.1 };
    const result = reconcileBloom(external, { patch: { enabled: true }, until: 1_000 }, 1_000);

    expect(result).toEqual({ settings: external, pending: false });
  });
});
