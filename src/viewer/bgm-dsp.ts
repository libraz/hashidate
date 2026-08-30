import { init, Mixer, masteringInsertParamInfo } from '@libraz/libsonare';
import type { BgmDsp, BgmDspPatch } from '@/protocol';

/** The one strip and the four inserts used by the background track. */
export const BGM_STRIP_ID = 'bgm';
export const BGM_INSERT_PROCESSORS = [
  'eq.tilt',
  'dynamics.compressor',
  'stereo.imager',
  'effects.reverb.plate',
] as const;

/** libsonare's fixed values are part of the public macro contract. */
export const BGM_DSP_FIXED = {
  pivotHz: 1_000,
  attackMs: 20,
  releaseMs: 180,
  kneeDb: 6,
  makeupGainDb: 0,
  autoMakeup: false,
  modRateHz: 0.5,
} as const;

/** A JSON-friendly insert as consumed by libsonare's Mixer scene parser. */
export interface BgmInsert {
  processor: (typeof BGM_INSERT_PROCESSORS)[number];
  slot: 'pre' | 'post';
  params: Record<string, number | boolean>;
}

/** Purely mapped values, useful to both the scene builder and focused tests. */
export interface BgmDspMapping {
  dsp: BgmDsp;
  inserts: BgmInsert[];
  eq: { tiltDb: number; pivotHz: number };
  compressor: {
    thresholdDb: number;
    ratio: number;
    attackMs: number;
    releaseMs: number;
    kneeDb: number;
    makeupGainDb: number;
    autoMakeup: boolean;
  };
  imager: { width: number };
  reverb: { dryWet: number; decay: number; damping: number; modRateHz: number };
}

/** Map the BGM compression macro onto the compressor's physical controls. */
export function compressionThresholdDb(value: number): number {
  return -6 - 18 * value;
}

/** Map the BGM compression macro onto the compressor's physical controls. */
export function compressionRatio(value: number): number {
  return 1 + 3 * value;
}

/** Merge a strict partial command patch without resetting sibling controls. */
export function mergeBgmDsp(base: BgmDsp, patch: BgmDspPatch | undefined): BgmDsp {
  return {
    toneDb: patch?.toneDb ?? base.toneDb,
    compression: patch?.compression ?? base.compression,
    width: patch?.width ?? base.width,
    reverb: {
      mix: patch?.reverb?.mix ?? base.reverb.mix,
      decay: patch?.reverb?.decay ?? base.reverb.decay,
      damping: patch?.reverb?.damping ?? base.reverb.damping,
    },
  };
}

/**
 * Turn the four public BGM macros into the exact fixed Mixer insert chain.
 *
 * This function has no WASM or browser dependency. The returned `params` are
 * objects for inspection; {@link buildBgmScene} serialises them at the boundary
 * where libsonare expects its scene format.
 */
export function mapBgmDsp(dsp: BgmDsp): BgmDspMapping {
  const eq = { tiltDb: dsp.toneDb, pivotHz: BGM_DSP_FIXED.pivotHz };
  const compressor = {
    thresholdDb: compressionThresholdDb(dsp.compression),
    ratio: compressionRatio(dsp.compression),
    attackMs: BGM_DSP_FIXED.attackMs,
    releaseMs: BGM_DSP_FIXED.releaseMs,
    kneeDb: BGM_DSP_FIXED.kneeDb,
    makeupGainDb: BGM_DSP_FIXED.makeupGainDb,
    autoMakeup: BGM_DSP_FIXED.autoMakeup,
  };
  const imager = { width: dsp.width };
  const reverb = {
    dryWet: dsp.reverb.mix,
    decay: dsp.reverb.decay,
    damping: dsp.reverb.damping,
    modRateHz: BGM_DSP_FIXED.modRateHz,
  };
  const inserts: BgmInsert[] = [
    { processor: 'eq.tilt', slot: 'pre', params: eq },
    { processor: 'dynamics.compressor', slot: 'pre', params: compressor },
    { processor: 'stereo.imager', slot: 'post', params: imager },
    { processor: 'effects.reverb.plate', slot: 'post', params: reverb },
  ];
  return { dsp, inserts, eq, compressor, imager, reverb };
}

/** The minimal valid one-stereo-strip Mixer scene for BGM. */
export function buildBgmScene(dsp: BgmDsp): {
  version: 1;
  buses: Array<{ id: 'master'; role: 'master'; inserts: [] }>;
  connections: Array<{ destination: 'master'; source: 'bgm' }>;
  strips: Array<{ id: 'bgm'; inserts: Array<{ processor: string; slot: string; params: string }> }>;
} {
  const mapping = mapBgmDsp(dsp);
  return {
    version: 1,
    buses: [{ id: 'master', role: 'master', inserts: [] }],
    connections: [{ destination: 'master', source: BGM_STRIP_ID }],
    strips: [
      {
        id: BGM_STRIP_ID,
        inserts: mapping.inserts.map((insert) => ({
          processor: insert.processor,
          slot: insert.slot,
          params: JSON.stringify(insert.params),
        })),
      },
    ],
  };
}

/** Serialised scene passed to SonareWorkletProcessor. */
export function buildBgmSceneJson(dsp: BgmDsp): string {
  return JSON.stringify(buildBgmScene(dsp));
}

/** A numeric automation destination discovered from libsonare, not guessed. */
export interface BgmAutomationTarget {
  insertIndex: number;
  processor: (typeof BGM_INSERT_PROCESSORS)[number];
  paramName: string;
  paramId: number;
}

export interface BgmDspPlan {
  readonly sceneJson: string;
  readonly targets: readonly BgmAutomationTarget[];
  /** Scene diagnostics from Mixer; successful plans always have none. */
  readonly sceneWarnings: readonly string[];
  apply(node: Pick<AudioWorkletNode, 'port'>, dsp: BgmDsp): void;
}

interface TargetSpec {
  processor: (typeof BGM_INSERT_PROCESSORS)[number];
  params: readonly string[];
}

/** Every parameter in the scene is checked for realtime safety before use. */
const TARGET_SPECS: readonly TargetSpec[] = [
  { processor: 'eq.tilt', params: ['tiltDb', 'pivotHz'] },
  {
    processor: 'dynamics.compressor',
    params: [
      'thresholdDb',
      'ratio',
      'attackMs',
      'releaseMs',
      'kneeDb',
      'makeupGainDb',
      'autoMakeup',
    ],
  },
  { processor: 'stereo.imager', params: ['width'] },
  { processor: 'effects.reverb.plate', params: ['dryWet', 'decay', 'damping', 'modRateHz'] },
];

/**
 * Initialise libsonare, parse the scene and discover stable numeric IDs.
 *
 * IDs are deliberately not hard-coded: the pinned 1.7.2 package is queried at
 * startup, and any scene warning or non-rt-safe target turns into a dry BGM
 * fallback instead of silently misrouting a live fader.
 */
export async function createBgmDspPlan(dsp: BgmDsp): Promise<BgmDspPlan> {
  await init();
  const sceneJson = buildBgmSceneJson(dsp);
  const mixer = Mixer.fromSceneJson(sceneJson, 48_000, 128);
  try {
    mixer.compile();
    const warnings = mixer.sceneWarnings();
    if (warnings.length > 0) throw new Error(`BGM Mixer scene warning: ${warnings.join('; ')}`);

    const targets: BgmAutomationTarget[] = [];
    for (const [insertIndex, spec] of TARGET_SPECS.entries()) {
      const info = masteringInsertParamInfo(spec.processor);
      for (const paramName of spec.params) {
        const found = info.find((entry) => entry.name === paramName);
        if (!found) throw new Error(`BGM parameter not found: ${spec.processor}.${paramName}`);
        if (!found.rtSafe)
          throw new Error(`BGM parameter is not realtime-safe: ${spec.processor}.${paramName}`);
        targets.push({ insertIndex, processor: spec.processor, paramName, paramId: found.id });
      }
    }

    return {
      sceneJson,
      targets,
      sceneWarnings: warnings,
      apply(node, next) {
        const mapping = mapBgmDsp(next);
        const values: Record<string, number> = {
          'eq.tilt.tiltDb': mapping.eq.tiltDb,
          'eq.tilt.pivotHz': mapping.eq.pivotHz,
          'dynamics.compressor.thresholdDb': mapping.compressor.thresholdDb,
          'dynamics.compressor.ratio': mapping.compressor.ratio,
          'dynamics.compressor.attackMs': mapping.compressor.attackMs,
          'dynamics.compressor.releaseMs': mapping.compressor.releaseMs,
          'dynamics.compressor.kneeDb': mapping.compressor.kneeDb,
          'dynamics.compressor.makeupGainDb': mapping.compressor.makeupGainDb,
          'stereo.imager.width': mapping.imager.width,
          'effects.reverb.plate.dryWet': mapping.reverb.dryWet,
          'effects.reverb.plate.decay': mapping.reverb.decay,
          'effects.reverb.plate.damping': mapping.reverb.damping,
          'effects.reverb.plate.modRateHz': mapping.reverb.modRateHz,
        };
        for (const target of targets) {
          const value = values[`${target.processor}.${target.paramName}`];
          if (value === undefined) continue;
          node.port.postMessage({
            type: 'scheduleInsertAutomation',
            stripIndex: 0,
            insertIndex: target.insertIndex,
            paramId: target.paramId,
            value,
            curve: 'linear',
          });
        }
      },
    };
  } finally {
    mixer.delete();
  }
}

/** Backwards-friendly name for callers that think of this as a chain factory. */
export const buildBgmDspPlan = createBgmDspPlan;
