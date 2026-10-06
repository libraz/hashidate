import { init, Mixer, masteringInsertParamInfo } from '@libraz/libsonare';
import { beforeAll, describe, expect, it } from 'vitest';
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
  pitch: { ...BGM_DSP_DEFAULTS.pitch, ...patch.pitch },
  presence: { ...BGM_DSP_DEFAULTS.presence, ...patch.presence },
});

const SAMPLE_RATE = 48_000;
const BLOCK_SIZE = 128;

interface StereoRender {
  left: number[];
  right: number[];
  warnings: string[];
}

function renderScene(
  scene: ReturnType<typeof buildBgmScene>,
  sampleCount: number,
  input: (sample: number) => [number, number],
): StereoRender {
  const mixer = Mixer.fromSceneJson(JSON.stringify(scene), SAMPLE_RATE, BLOCK_SIZE);
  try {
    mixer.compile();
    const left: number[] = [];
    const right: number[] = [];
    for (let offset = 0; offset < sampleCount; offset += BLOCK_SIZE) {
      const leftIn = new Float32Array(BLOCK_SIZE);
      const rightIn = new Float32Array(BLOCK_SIZE);
      for (let i = 0; i < BLOCK_SIZE; i += 1) {
        const [inLeft, inRight] = input(offset + i);
        leftIn[i] = inLeft;
        rightIn[i] = inRight;
      }
      const output = mixer.processStereo([leftIn], [rightIn]);
      left.push(...output.left);
      right.push(...output.right);
    }
    return { left, right, warnings: mixer.sceneWarnings() };
  } finally {
    mixer.delete();
  }
}

function magnitude(samples: readonly number[], frequency: number, start: number): number {
  const end = samples.length;
  let real = 0;
  let imaginary = 0;
  for (let i = start; i < end; i += 1) {
    const angle = (2 * Math.PI * frequency * i) / SAMPLE_RATE;
    real += samples[i] * Math.cos(angle);
    imaginary -= samples[i] * Math.sin(angle);
  }
  return (2 / (end - start)) * Math.hypot(real, imaginary);
}

function legacyScene(scene: ReturnType<typeof buildBgmScene>): ReturnType<typeof buildBgmScene> {
  const removed = new Set(['spectral.presenceEnhancer', 'effects.modulation.pitchShifter']);
  return {
    ...scene,
    strips: scene.strips.map((strip) => ({
      ...strip,
      inserts: strip.inserts.filter((insert) => !removed.has(insert.processor)),
    })),
  };
}

beforeAll(async () => {
  await init();
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
        pitch: { semitones: 12, mix: 0.8 },
        presence: { amount: 0.6, drive: 4, frequencyHz: 4200 },
      }),
    );
    expect(mapped.inserts.map(({ processor, slot }) => `${slot}:${processor}`)).toEqual([
      'pre:eq.tilt',
      'pre:dynamics.compressor',
      'pre:spectral.presenceEnhancer',
      'post:stereo.imager',
      'post:effects.modulation.pitchShifter',
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
    expect(mapped.pitch).toMatchObject({ semitones: 12, dryWet: 0.8, mixLaw: 0, interpolation: 0 });
    expect(mapped.presence).toEqual({
      amount: 0.6,
      drive: 4,
      centerFrequencyHz: 4200,
      q: BGM_DSP_FIXED.presenceQ,
      aliasing: BGM_DSP_FIXED.presenceAliasing,
    });
    expect(mapped.reverb).toEqual({ dryWet: 0.2, decay: 0.7, damping: 0.3, modRateHz: 0.5 });
    const scene = buildBgmScene(dsp());
    expect(JSON.parse(scene.strips[0].inserts[0].params)).toEqual({
      tiltDb: 0,
      pivotHz: 1_000,
    });
    expect(JSON.parse(scene.strips[0].inserts[2].params)).toMatchObject({
      amount: 0,
      drive: 2,
      centerFrequencyHz: 3200,
      q: 1.2,
      aliasing: 0,
    });
  });
});

describe('libsonare BGM plan', () => {
  it('parses without scene warnings and applies discovered rt-safe IDs', async () => {
    const plan = await createBgmDspPlan(dsp());
    expect(plan.sceneWarnings).toEqual([]);
    expect(plan.targets).toHaveLength(19);
    expect(plan.targets.every(({ paramId }) => Number.isInteger(paramId))).toBe(true);
    expect(
      plan.targets.filter(
        ({ processor }) =>
          processor === 'spectral.presenceEnhancer' ||
          processor === 'effects.modulation.pitchShifter',
      ),
    ).toHaveLength(5);
    for (const target of plan.targets) {
      const metadata = masteringInsertParamInfo(target.processor).find(
        (entry) => entry.name === target.paramName,
      );
      expect(target.paramId).toBe(metadata?.id);
    }

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
    expect(messages).toHaveLength(18);
    expect(
      messages.every(
        (message) => (message as { type: string }).type === 'scheduleInsertAutomation',
      ),
    ).toBe(true);
  });
});

describe('real libsonare BGM processing', () => {
  it('keeps the neutral six-insert chain bit-exact with the legacy four-insert chain', () => {
    const scene = buildBgmScene(dsp());
    const sampleCount = 64 * BLOCK_SIZE;
    const input = (sample: number): [number, number] => [
      0.17 * Math.sin((2 * Math.PI * 173 * sample) / SAMPLE_RATE) + 0.03,
      0.11 * Math.cos((2 * Math.PI * 271 * sample) / SAMPLE_RATE) - 0.02,
    ];
    const legacy = renderScene(legacyScene(scene), sampleCount, input);
    const extended = renderScene(scene, sampleCount, input);
    expect(legacy.warnings).toEqual([]);
    expect(extended.warnings).toEqual([]);
    expect(extended.left).toHaveLength(sampleCount);
    expect(extended.right).toHaveLength(sampleCount);
    expect(extended.left).toEqual(legacy.left);
    expect(extended.right).toEqual(legacy.right);
  });

  it('shifts a sine by an octave with the active pitch macro', () => {
    const scene = buildBgmScene(dsp({ pitch: { semitones: 12, mix: 1 } }));
    const sampleCount = SAMPLE_RATE;
    const input = (sample: number): [number, number] => {
      const value = 0.2 * Math.sin((2 * Math.PI * 220 * sample) / SAMPLE_RATE);
      return [value, value];
    };
    const rendered = renderScene(scene, sampleCount, input);
    expect(rendered.warnings).toEqual([]);
    expect(rendered.left).toHaveLength(sampleCount);
    expect(rendered.right).toHaveLength(sampleCount);
    expect(rendered.left.every(Number.isFinite)).toBe(true);
    const start = Math.floor(SAMPLE_RATE * 0.25);
    const inputPeak = magnitude(rendered.left, 220, start);
    const shiftedPeak = magnitude(rendered.left, 440, start);
    expect(shiftedPeak).toBeGreaterThan(0.005);
    expect(shiftedPeak).toBeGreaterThan(inputPeak * 10);
  });

  it('adds finite presence harmonics only when the presence macro is on', () => {
    const sampleCount = SAMPLE_RATE;
    const input = (sample: number): [number, number] => {
      const value = 0.2 * Math.sin((2 * Math.PI * 3200 * sample) / SAMPLE_RATE);
      return [value, value];
    };
    const off = renderScene(buildBgmScene(dsp()), sampleCount, input);
    const on = renderScene(
      buildBgmScene(dsp({ presence: { amount: 1, drive: 8, frequencyHz: 3200 } })),
      sampleCount,
      input,
    );
    expect(off.warnings).toEqual([]);
    expect(on.warnings).toEqual([]);
    expect(on.left.every(Number.isFinite)).toBe(true);
    expect(on.right.every(Number.isFinite)).toBe(true);
    const start = Math.floor(SAMPLE_RATE * 0.25);
    const offHarmonic = magnitude(off.left, 9600, start);
    const onHarmonic = magnitude(on.left, 9600, start);
    expect(onHarmonic).toBeGreaterThan(offHarmonic + 0.01);
  });
});
