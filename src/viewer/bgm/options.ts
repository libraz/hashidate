import type { BgmDsp, BgmReport } from '@/protocol';
import type { BrowserAudioOutput } from '../audio-output';
import type { BgmDspPlan } from '../bgm-dsp';
import type { BgmNodeFactory } from './worklet';

/**
 * What a `BrowserBgm` is built with.
 *
 * Almost every field is an injection point, and they are here for one reason:
 * this class is the only part of the runtime that cannot be exercised without a
 * browser. A media element, an `AudioWorkletNode`, a WASM fetch and the wall
 * clock are all things a test has to be able to supply, so each is a parameter
 * rather than a global reached for at the point of use.
 */
export interface BrowserBgmOptions {
  /** The page-owned output graph. */
  output: BrowserAudioOutput;
  /** URL prefix for the direct server asset route. */
  base?: string;
  /** Injectable media element factory for tests/embedding hosts. */
  audioFactory?: () => HTMLAudioElement;
  /** Injectable clock, in epoch seconds, for late-join tests. */
  now?: () => number;
  /** Vite-emitted local worklet module; override only for tests. */
  workletUrl?: string | URL;
  /** Injectable AudioWorkletNode constructor for graph tests. */
  nodeFactory?: BgmNodeFactory;
  /** Injectable WASM byte loader for browser tests. */
  wasmLoader?: () => Promise<ArrayBuffer>;
  /** Injectable plan for tests; production validates libsonare's scene/IDs. */
  dspPlan?: BgmDspPlan | ((dsp: BgmDsp) => Promise<BgmDspPlan>);
  /** Called when a report-worthy media event occurs. */
  onReport?: (report: BgmReport) => void;
}

/** The older positional form, kept so an embedding host need not be rewritten. */
export type LegacyBrowserBgmOptions = Omit<BrowserBgmOptions, 'output'>;
