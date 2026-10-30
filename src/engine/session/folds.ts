import type { VoiceChainRequest } from '../types';

/**
 * What a command leaves behind, stated once for the renderer that applies it and
 * for the standing state that replays it to a renderer attaching later.
 *
 * Each function here is the renderer's own decision, lifted out of the class
 * that acts on it. A second copy on the server would be a second opinion about
 * what the same command means, and the late renderer would be the one to hear
 * it.
 */

/**
 * Fold a voice-chain request onto the chain already asked for.
 *
 * Both sides are requests as a fresh chain would take them: absent `preset` is
 * the default base, absent `dsp` is no overrides. `preset: null` bypasses the
 * chain and clears the overrides with it. Overrides arriving on a bypassed
 * chain turn it back on with the default base — the alternative is silently
 * discarding them, which from the panel looks like a slider that does nothing.
 * Overrides merge one section deep: a later `retune` replaces the earlier one
 * whole, as the renderer has always done.
 *
 * Preset ids are taken as given. The renderer resolves an unknown id before
 * folding; the server cannot, and need not, because a fresh renderer resolves
 * the replayed id the same way.
 */
export function foldVoiceChain<T extends VoiceChainRequest>(chain: T, next: T): T {
  if (next.preset === null) return { preset: null } as T;
  const preset = next.preset !== undefined ? next.preset : (chain.preset ?? undefined);
  const dsp =
    chain.preset === null ? next.dsp : next.dsp ? { ...chain.dsp, ...next.dsp } : chain.dsp;
  return {
    ...(preset === undefined ? {} : { preset }),
    ...(dsp === undefined ? {} : { dsp }),
  } as T;
}

/** What one `wear` does to a wardrobe: apply an outfit, set a slot, or nothing. */
export type WearStep = { preset: string } | { slot: string; item: string | null } | null;

/** Classify a `wear`, which the session applies and the standing state keeps. */
export function wearStep({
  slot,
  item,
  preset,
}: {
  slot?: string;
  item?: string | null;
  preset?: string;
}): WearStep {
  if (preset) return { preset };
  // Absent and null differ: only `item: null` takes the garment off.
  if (slot && item !== undefined) return { slot, item };
  return null;
}

/**
 * Whether an `avatar` command replaces the avatar a renderer holds.
 *
 * Naming the avatar already showing, on its way or queued is a no-op, and the
 * session — wardrobe and all — survives it. That is the ordinary case: a setup
 * restates the avatar it is usually already showing.
 */
export function avatarReplaces(current: string | null | undefined, next: string): boolean {
  return current !== next;
}
