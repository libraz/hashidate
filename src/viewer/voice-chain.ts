import {
  init,
  lufs,
  meteringTruePeakDb,
  realtimeVoiceChangerPresetJson,
  voiceChangeRealtime,
} from '@libraz/libsonare';
import type { Localized } from '@/i18n/locale';
import type { VoiceDsp } from '@/protocol';

/**
 * The voice chain — what happens to a line between the synthesiser and the room.
 *
 * The speech model hands back a bare, unprocessed take: it was trained on
 * reference recordings with their acoustics stripped, so what comes out has no
 * EQ, no compression and no level discipline. That is the right raw material and
 * the wrong thing to broadcast. This is where it becomes a stream voice, and it
 * is also where the character can be moved off the reference speaker — pitch and
 * formants shifted independently, which is what makes it a different voice
 * rather than the same one played fast.
 *
 * ## Offline, on the whole take, because the take is already whole
 *
 * Everything else about the voice path leans on the synthesiser not streaming —
 * the line is complete before a single sample plays, which is what lets the
 * viseme track be stretched onto a known duration instead of corrected
 * mid-sentence. The same fact makes an `AudioWorklet` unnecessary here: the
 * buffer can simply be run through the chain before the take is built. Measured
 * on this machine a five-second line costs about 28 ms, against roughly a second
 * of synthesis it is already waiting on.
 *
 * The processor is nonetheless the *realtime* one, run offline. That is
 * deliberate — it is the chain that was designed to hold a voice steady under a
 * gate, a compressor and a limiter, and its parameters are the ones a person
 * mixing a stream already knows the names of.
 *
 * ## The mouth is measured after this, not before
 *
 * The envelope that drives the jaw comes off the *processed* buffer. A chain
 * with a gate and a compressor in it changes where the loud parts of a line are,
 * and a mouth following the unprocessed take would be following a signal nobody
 * can hear. The room is the other way round and stays downstream of everything
 * — see `voice.ts` — because a convolution tail is the space ringing, not the
 * character still talking.
 *
 * ## The chain adds about 10 ms of latency and it is left there
 *
 * `voiceChangeRealtime` compensates most but not all of its own lookahead; the
 * first sample of a line comes out roughly 470 samples later than it went in.
 * Since the envelope is measured after the chain, the mouth moves with the
 * audio and the whole line simply starts ten milliseconds later than it would
 * have. Trimming it would mean guessing at a figure the processor does not
 * publish, to fix something an order of magnitude below what anyone can see.
 */

/**
 * The named chains, with the labels the panel shows.
 *
 * The ids are libsonare's own preset names. They are written out here rather
 * than read from `realtimeVoiceChangerPresetNames()` for the same reason the
 * room impulse responses are built lazily: naming the presets must not cost a
 * four-megabyte WASM download on a machine that is only ever going to run the
 * renderer without a voice.
 */
export const VOICE_PRESETS: Record<string, Localized> = {
  'neutral-monitor': { en: 'As recorded', ja: '素のまま' },
  'bright-idol': { en: 'Bright', ja: '明るい' },
  'soft-whisper': { en: 'Whispered', ja: 'ささやき' },
  'deep-narrator': { en: 'Low and steady', ja: '低く落ち着いた' },
  'robot-mascot': { en: 'Robot', ja: 'ロボット' },
  'dark-villain': { en: 'Dark', ja: '暗い' },
};

/** The default base. Broadcast discipline without a change of character. */
export const DEFAULT_PRESET = 'neutral-monitor';

/** The preset ids and their labels, for the vocabulary. */
export const voicePresetList = () =>
  Object.entries(VOICE_PRESETS).map(([id, label]) => ({ id, label }));

/**
 * The processor's own configuration, section by section.
 *
 * Structurally the same as `VoiceDsp` on the wire, minus the optionality: the
 * processor refuses a partial configuration outright, which is the whole reason
 * the merge below exists.
 */
type Section = Record<string, number | boolean>;
export type ResolvedDsp = Record<string, number | Section>;

/**
 * A configuration in the form the processor accepts it.
 *
 * `category` is pinned to `'custom'` rather than left open, because that is the
 * only one anything built here can honestly claim — the six named categories
 * describe the presets libsonare ships, and a merged configuration is no longer
 * any of them however lightly it was touched.
 */
interface Preset {
  schemaVersion: 1;
  id: string;
  name: string;
  category: 'custom';
  dsp: ResolvedDsp;
}

/** Base presets, parsed once each. Loading one requires the WASM. */
const bases = new Map<string, ResolvedDsp>();

/**
 * Merge overrides onto a base, one level of nesting deep.
 *
 * Deliberately not a general deep merge. The configuration is exactly two
 * levels — scalars at the top, scalars inside a named section — and a recursive
 * merge would silently accept a shape the processor is going to reject anyway,
 * turning a wrong command into a wrong sound instead of a refusal.
 */
export function mergeDsp(base: ResolvedDsp, overrides: VoiceDsp | undefined): ResolvedDsp {
  if (!overrides) return base;
  const out: ResolvedDsp = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (typeof value === 'object' && value !== null) {
      const under = out[key];
      // A section the base does not have is one this build of the processor
      // does not know about. Dropped rather than invented: a half-populated
      // section is refused by the processor, and refusing the whole command
      // over one unknown knob would take the voice down for a cosmetic reason.
      if (typeof under !== 'object') continue;
      const merged: Section = { ...under };
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v !== undefined && (typeof v === 'number' || typeof v === 'boolean')) merged[k] = v;
      }
      out[key] = merged;
      continue;
    }
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}

/**
 * Resolve a base preset by id, loading the WASM on the first call.
 *
 * An unknown id falls back to the default rather than throwing, on the rule the
 * rest of the command set follows: ids are data, the wire carries them as
 * strings, and a caller working from a stale list should get a voice rather than
 * a broken stream.
 */
export async function loadBase(id: string): Promise<ResolvedDsp> {
  const name = Object.hasOwn(VOICE_PRESETS, id) ? id : DEFAULT_PRESET;
  const cached = bases.get(name);
  if (cached) return cached;
  await init();
  // Only the `dsp` block is wanted; the metadata beside it describes the shipped
  // preset and stops being true the moment anything is merged onto it.
  const parsed = JSON.parse(realtimeVoiceChangerPresetJson(name as never)) as { dsp: ResolvedDsp };
  bases.set(name, parsed.dsp);
  return parsed.dsp;
}

/**
 * Run one take's samples through a resolved chain.
 *
 * The processor is handed a whole preset rather than a bare configuration
 * because that is the only form it accepts — the flat parameter block is for the
 * streaming API, and the two are not the same shape.
 */
export function processTake(
  samples: Float32Array,
  sampleRate: number,
  dsp: ResolvedDsp,
): Float32Array {
  const preset: Preset = {
    schemaVersion: 1,
    id: 'hashidate',
    name: 'hashidate',
    category: 'custom',
    dsp,
  };
  return voiceChangeRealtime({ samples, sampleRate, preset });
}

/** Loudness and true peak of one take, for the panel's meters. */
export function measure(
  samples: Float32Array,
  sampleRate: number,
): { lufs: number | null; truePeakDb: number | null } {
  try {
    const loudness = lufs({ samples, sampleRate });
    const peak = meteringTruePeakDb({ samples, sampleRate });
    // A line short enough to fall below the loudness gate's own window measures
    // as -infinity, which is a number a meter cannot draw. Reported as null,
    // which the panel already has to handle for "nothing has played yet".
    return {
      lufs: Number.isFinite(loudness.integratedLufs) ? loudness.integratedLufs : null,
      truePeakDb: Number.isFinite(peak) ? peak : null,
    };
  } catch {
    // Metering is a readout. A build without it, or a take it will not accept,
    // costs the panel two numbers and must not cost the stream its voice.
    return { lufs: null, truePeakDb: null };
  }
}
