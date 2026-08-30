import wasmUrl from '@libraz/libsonare/wasm?url';
import { safeDisconnect } from './route';

/**
 * Talking to the libsonare processor.
 *
 * The worklet is a separate thread that has to be handed a WASM binary, told a
 * scene, and then waited on — and every one of those can fail on a machine that
 * is otherwise fine. So each function here is written to be *told* about the
 * failure rather than to assume success: `processorReady` resolves or rejects
 * once and cleans up either way, and `destroyNode` asks a processor that may
 * already be gone to go.
 */

export const PROCESSOR_NAME = 'hashidate-bgm';
export const BLOCK_SIZE = 128;

export type BgmNodeFactory = (
  context: BaseAudioContext,
  name: string,
  options: AudioWorkletNodeOptions,
) => AudioWorkletNode;

export function destroyNode(node: AudioWorkletNode | null): void {
  if (node === null) return;
  try {
    node.port.postMessage({ type: 'destroy' });
  } catch {
    /* processor may already be gone */
  }
  safeDisconnect(node);
}

export function attachProcessorError(node: AudioWorkletNode, listener: () => void): void {
  const candidate = node as AudioWorkletNode & {
    addEventListener?: (type: string, listener: EventListener) => void;
    onprocessorerror?: ((event: Event) => void) | null;
  };
  if (candidate.addEventListener) candidate.addEventListener('processorerror', listener);
  else candidate.onprocessorerror = listener;
}

export async function fetchBgmWasm(): Promise<ArrayBuffer> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`BGM DSP WASM request failed: ${response.status}`);
  return response.arrayBuffer();
}

export function processorReady(node: AudioWorkletNode): Promise<void> {
  return new Promise((resolve, reject) => {
    const port = node.port;
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (!isProcessorStatus(event.data)) return;
      cleanup();
      if (event.data.type === 'ready') resolve();
      else reject(new Error(event.data.message));
    };
    const onProcessorError = (): void => {
      cleanup();
      reject(new Error('BGM DSP processor failed during initialization'));
    };
    const cleanup = (): void => {
      port.removeEventListener('message', onMessage);
      node.removeEventListener('processorerror', onProcessorError);
    };
    port.addEventListener('message', onMessage);
    node.addEventListener('processorerror', onProcessorError);
    port.start();
  });
}

function isProcessorStatus(
  value: unknown,
): value is { type: 'ready' } | { type: 'error'; message: string } {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const status = value as { type?: unknown; message?: unknown };
  return status.type === 'ready' || (status.type === 'error' && typeof status.message === 'string');
}
