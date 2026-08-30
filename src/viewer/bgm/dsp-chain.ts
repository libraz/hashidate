import type { BgmDsp } from '@/protocol';
import type { BrowserAudioOutput } from '../audio-output';
import { type BgmDspPlan, buildBgmDspPlan } from '../bgm-dsp';
import type { BrowserBgmOptions } from './options';
import { safeDisconnect } from './route';
import {
  attachProcessorError,
  type BgmNodeFactory,
  BLOCK_SIZE,
  destroyNode,
  PROCESSOR_NAME,
  processorReady,
} from './worklet';

/**
 * The one shared insert chain between the mix bus and the BGM bus.
 *
 * Every sounding track enters `input`, and one libsonare Mixer worklet
 * processes all of them together — a chain per track would mean a crossfade
 * running two reverbs at once, which sounds like two rooms rather than one.
 *
 * ## It is allowed to not be there
 *
 * The worklet needs a WASM binary, a thread and a scene, and any of those can
 * fail on a machine that is otherwise fine. So the dry edge is the *starting*
 * state and is restored on every failure: the music keeps playing, `degraded`
 * says the processing did not, and nothing about the transport changes. A
 * renderer that fell back silently would be indistinguishable from one whose
 * settings had no audible effect.
 *
 * ## Generations, because installation is asynchronous
 *
 * Building a node takes several awaits, and the selection can be replaced or
 * unloaded during any of them. Every install carries the generation it started
 * in, and anything that invalidates the chain bumps the counter — so a node
 * that finishes building for a selection nobody wants any more is destroyed on
 * arrival rather than connected.
 */
export class BgmDspChain {
  /** All track envelopes feed this one persistent route into BGM DSP. */
  readonly input: GainNode;

  private node: AudioWorkletNode | null = null;
  private plan: BgmDspPlan | null = null;
  private workletLoad: Promise<void> | null = null;
  private wasmLoad: Promise<ArrayBuffer> | null = null;
  private workletInitialized = false;
  /** Invalidates every async shared DSP install when its route is rebuilt. */
  private generation = 0;
  private install: Promise<void> | null = null;
  private degradedFlag = false;
  private disposed = false;

  constructor(
    private readonly output: BrowserAudioOutput,
    private readonly nodeFactory: BgmNodeFactory,
    private readonly workletUrl: string | URL,
    private readonly loadWasm: () => Promise<ArrayBuffer>,
    private readonly suppliedPlan: BrowserBgmOptions['dspPlan'],
    /** What the chain should be running right now, read at each await boundary. */
    private readonly readDsp: () => BgmDsp,
    /** Raised whenever the chain's own state changed what a report would say. */
    private readonly onChange: () => void,
  ) {
    this.input = output.context.createGain();
    this.input.gain.value = 1;
    this.connectDry();
  }

  /** True when the worklet could not be built and the mix is going through dry. */
  get degraded(): boolean {
    return this.degradedFlag;
  }

  /** A new canonical revision starts the diagnosis over. */
  clearDegraded(): void {
    this.degradedFlag = false;
  }

  /** Build the worklet, unless one is already up or already being built. */
  ensure(): void {
    if (this.disposed || this.node !== null || this.install !== null) return;
    const generation = this.generation;
    const task = this.installAsync(generation);
    let tracked: Promise<void>;
    tracked = task.finally(() => {
      if (this.install === tracked) this.install = null;
    });
    this.install = tracked;
  }

  /**
   * Push the resolved macro state onto the node that is up.
   *
   * A settings-only patch applies to the one shared node without replacing
   * media. Nothing happens when the chain is dry, which is correct: the state
   * is re-applied in full the moment a node is built.
   */
  applyDsp(dsp: BgmDsp): void {
    const node = this.node;
    if (!(node && this.plan)) return;
    try {
      this.plan.apply(node, dsp);
    } catch {
      this.fail(this.generation, node);
    }
  }

  /**
   * Tear the chain down and go dry, invalidating anything in flight.
   *
   * `reinstall` is what tells a rebuild from an unload: after a stop the chain
   * is rebuilt so that a plate reverb cannot leak into the next take, and after
   * an unload there is nothing to build it for.
   */
  reset(reinstall: boolean): void {
    this.generation += 1;
    this.install = null;
    destroyNode(this.node);
    this.node = null;
    this.plan = null;
    this.connectDry();
    if (reinstall && !this.disposed) this.ensure();
  }

  /** Release the chain without closing the page's shared output context. */
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.install = null;
    destroyNode(this.node);
    this.node = null;
    this.plan = null;
    safeDisconnect(this.input);
  }

  private async installAsync(generation: number): Promise<void> {
    let plan: BgmDspPlan;
    try {
      plan = await this.getPlan();
      await this.ensureWorklet();
      if (generation !== this.generation || this.disposed) return;
      const node = await this.createNode(plan.sceneJson);
      if (generation !== this.generation || this.disposed) {
        destroyNode(node);
        return;
      }
      if (this.node !== null && this.node !== node) destroyNode(this.node);
      safeDisconnect(this.input);
      this.input.connect(node);
      node.connect(this.output.bgmBus);
      this.node = node;
      this.plan = plan;
      attachProcessorError(node, () => this.fail(generation, node));
      plan.apply(node, this.readDsp());
      this.onChange();
    } catch {
      if (generation === this.generation && !this.disposed) this.fail(generation);
    }
  }

  private async getPlan(): Promise<BgmDspPlan> {
    if (typeof this.suppliedPlan === 'function') return this.suppliedPlan(this.readDsp());
    if (this.suppliedPlan) return this.suppliedPlan;
    return buildBgmDspPlan(this.readDsp());
  }

  private async createNode(sceneJson: string): Promise<AudioWorkletNode> {
    const wasmBinary = this.workletInitialized ? undefined : await this.ensureWasm();
    const node = this.nodeFactory(this.output.context, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        sceneJson,
        sampleRate: this.output.context.sampleRate,
        blockSize: BLOCK_SIZE,
        stripCount: 1,
        ...(wasmBinary === undefined ? {} : { wasmBinary }),
      },
    });
    try {
      await processorReady(node);
      this.workletInitialized = true;
      return node;
    } catch (reason) {
      destroyNode(node);
      throw reason;
    }
  }

  private ensureWorklet(): Promise<void> {
    if (this.workletLoad !== null) return this.workletLoad;
    const addModule = this.output.context.audioWorklet?.addModule;
    if (!addModule) return Promise.reject(new Error('AudioWorklet is unavailable'));
    this.workletLoad = addModule
      .call(this.output.context.audioWorklet, this.workletUrl)
      .catch((reason) => {
        this.workletLoad = null;
        throw reason;
      });
    return this.workletLoad;
  }

  private ensureWasm(): Promise<ArrayBuffer> {
    if (this.wasmLoad !== null) return this.wasmLoad;
    this.wasmLoad = this.loadWasm().catch((reason) => {
      this.wasmLoad = null;
      throw reason;
    });
    return this.wasmLoad;
  }

  private fail(generation: number, failedNode?: AudioWorkletNode): void {
    if (generation !== this.generation || (failedNode !== undefined && this.node !== failedNode))
      return;
    this.generation += 1;
    destroyNode(this.node);
    this.node = null;
    this.plan = null;
    this.connectDry();
    this.degradedFlag = true;
    // A worklet failure is distinct from a media error: dry media keeps
    // playing, and the server can still accept a healthy natural end.
    this.onChange();
  }

  private connectDry(): void {
    safeDisconnect(this.input);
    this.input.connect(this.output.bgmBus);
  }
}
