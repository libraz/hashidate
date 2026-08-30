/**
 * Local AudioWorklet entry for the BGM Mixer.
 *
 * AudioWorkletGlobalScope deliberately has no `fetch`, so the page fetches the
 * WASM bytes and passes them through `processorOptions`. Registration itself
 * stays synchronous; each processor announces when its Mixer is ready, and the
 * page keeps the dry media edge connected until then.
 */

// libsonare's public init() normally discovers this factory with import(). A
// WorkletGlobalScope forbids dynamic import, so bind the package's Emscripten
// factory statically. This is the same factory shipped by the pinned package;
// the build alias deliberately bypasses package exports because this must be
// bundled into the worklet realm rather than loaded there dynamically.
import createSonare from '@libraz/libsonare/emscripten-factory';
import {
  init,
  type SonareWorkletMessage,
  SonareWorkletProcessor,
  type SonareWorkletProcessorOptions,
} from '@libraz/libsonare/worklet';

interface BgmProcessorOptions extends SonareWorkletProcessorOptions {
  wasmBinary?: ArrayBuffer;
}

interface WorkletPort {
  addEventListener?(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  onmessage?: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  start?(): void;
}

interface WorkletHost {
  readonly port: WorkletPort;
}

type WorkletInput = Float32Array[][];
type WorkletOutput = Float32Array[][];

const processorBase = Reflect.get(globalThis, 'AudioWorkletProcessor') as
  | (new () => WorkletHost)
  | undefined;
const register = Reflect.get(globalThis, 'registerProcessor') as
  | ((name: string, processor: unknown) => void)
  | undefined;

if (!(processorBase && register)) {
  throw new Error('AudioWorkletProcessor is not available in this context.');
}

const Base = processorBase;

class HashidateBgmProcessor extends Base {
  private bridge: SonareWorkletProcessor | null = null;
  private destroyed = false;

  constructor(options?: { processorOptions?: BgmProcessorOptions }) {
    super();
    const processorOptions = options?.processorOptions;
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (!isSonareMessage(event.data)) return;
      if (event.data.type === 'destroy') this.destroyed = true;
      this.bridge?.receiveMessage(event.data);
    };
    if (this.port.addEventListener) {
      this.port.addEventListener('message', onMessage);
      this.port.start?.();
    } else {
      this.port.onmessage = onMessage;
    }
    void this.initialize(processorOptions);
  }

  process(inputs: WorkletInput, outputs: WorkletOutput): boolean {
    if (this.destroyed) return false;
    if (this.bridge !== null) return this.bridge.process(inputs, outputs);
    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }
    return true;
  }

  private async initialize(options: BgmProcessorOptions | undefined): Promise<void> {
    try {
      if (options === undefined) throw new Error('BGM processor options are required.');
      const { wasmBinary, ...mixerOptions } = options;
      // The Emscripten factory resolves a nominal WASM filename even when the
      // bytes are already supplied. AudioWorkletGlobalScope has no URL
      // constructor, so make that otherwise-unused resolution explicit.
      await init({
        locateFile: () => 'sonare.wasm',
        wasmBinary,
        moduleFactory: createSonare,
      });
      if (this.destroyed) return;
      this.bridge = new SonareWorkletProcessor(mixerOptions, {
        postMessage: (message) => this.port.postMessage(message),
      });
      this.port.postMessage({ type: 'ready' });
    } catch (reason) {
      this.port.postMessage({
        type: 'error',
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }
}

register('hashidate-bgm', HashidateBgmProcessor);

function isSonareMessage(value: unknown): value is SonareWorkletMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'destroy' || type === 'setMeterInterval' || type === 'scheduleInsertAutomation';
}
