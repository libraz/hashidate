import { describe, expect, it } from 'vitest';
import { BGM_DSP_DEFAULTS, type BgmDsp } from '@/protocol';
import {
  BGM_DSP_FIXED,
  buildBgmScene,
  compressionRatio,
  compressionThresholdDb,
  createBgmDspPlan,
  mapBgmDsp,
} from '@/viewer/bgm-dsp';

const dsp = (patch: Partial<BgmDsp> = {}): BgmDsp => ({
  ...BGM_DSP_DEFAULTS,
  ...patch,
  reverb: { ...BGM_DSP_DEFAULTS.reverb, ...patch.reverb },
});

describe('BGM DSP mapping', () => {
  it('maps compression to the documented physical controls', () => {
    expect(compressionThresholdDb(0)).toBe(-6);
    expect(compressionThresholdDb(1)).toBe(-24);
    expect(compressionRatio(0)).toBe(1);
    expect(compressionRatio(1)).toBe(4);
  });

  it('builds one stereo strip with the fixed insert order and values', () => {
    const mapped = mapBgmDsp(
      dsp({
        toneDb: 2,
        compression: 0.5,
        width: 1.4,
        reverb: { mix: 0.2, decay: 0.7, damping: 0.3 },
      }),
    );
    expect(mapped.inserts.map(({ processor, slot }) => `${slot}:${processor}`)).toEqual([
      'pre:eq.tilt',
      'pre:dynamics.compressor',
      'post:stereo.imager',
      'post:effects.reverb.plate',
    ]);
    expect(mapped.eq).toEqual({ tiltDb: 2, pivotHz: BGM_DSP_FIXED.pivotHz });
    expect(mapped.compressor).toMatchObject({
      thresholdDb: -15,
      ratio: 2.5,
      attackMs: 20,
      releaseMs: 180,
      kneeDb: 6,
      makeupGainDb: 0,
      autoMakeup: false,
    });
    expect(mapped.reverb).toEqual({ dryWet: 0.2, decay: 0.7, damping: 0.3, modRateHz: 0.5 });
    expect(JSON.parse(buildBgmScene(dsp()).strips[0].inserts[0].params)).toEqual({
      tiltDb: 0,
      pivotHz: 1_000,
    });
  });
});

describe('libsonare BGM plan', () => {
  it('parses without scene warnings and applies discovered rt-safe IDs', async () => {
    const plan = await createBgmDspPlan(dsp());
    expect(plan.sceneWarnings).toEqual([]);
    expect(plan.targets.length).toBeGreaterThan(10);
    expect(plan.targets.every(({ paramId }) => Number.isInteger(paramId))).toBe(true);

    const messages: unknown[] = [];
    plan.apply(
      {
        port: {
          postMessage: (message: unknown): void => {
            messages.push(message);
          },
        } as MessagePort,
      },
      dsp({
        toneDb: -2,
        compression: 0.25,
        width: 0.8,
        reverb: { mix: 0.1, decay: 0.4, damping: 0.6 },
      }),
    );
    expect(messages).toHaveLength(13);
    expect(
      messages.every(
        (message) => (message as { type: string }).type === 'scheduleInsertAutomation',
      ),
    ).toBe(true);
  });
});
