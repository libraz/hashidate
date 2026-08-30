import { type RendererId, rendererIdSchema } from '@/protocol';

/**
 * The identity of this browser renderer, stable for the lifetime of its page.
 *
 * A renderer can be replaced underneath a long-lived control stream, but it is
 * still one owner of the recording and one endpoint from the server's point of
 * view. Keeping the value at module scope also survives React StrictMode's
 * development-only effect remount without creating a second identity.
 */
export const rendererId: RendererId = rendererIdSchema.parse(createRendererId());

function createRendererId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto);
  return `renderer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
