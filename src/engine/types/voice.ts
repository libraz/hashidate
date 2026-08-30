/**
 * What the voice is asked for and what it says back about itself.
 *
 * The processing chain is deliberately opaque here — see `VoiceChainRequest`.
 * The port that applies it is in `ports.ts`.
 */

/**
 * How the voice is processed on its way out, as the engine passes it along.
 *
 * `dsp` is deliberately opaque here. What a voice chain *is* — which processors,
 * in what order, with what parameters — belongs to whatever implements `Voice`,
 * on exactly the footing rooms and the wardrobe are already on: the engine names
 * the thing and does not describe it. The real shape is stated once, in the
 * protocol layer, and once more in the renderer that applies it.
 */
export interface VoiceChainRequest {
  /** Base preset id. `null` bypasses the chain; absent keeps the current base. */
  preset?: string | null;
  /** Overrides applied on top of the base. */
  dsp?: Record<string, unknown>;
}

/**
 * What the voice can say about itself, for a control surface to display.
 *
 * The resolved configuration comes back rather than being assumed by whoever
 * sent it, for the same reason `SessionState` is reported rather than inferred
 * from the last command: a panel that draws its own sliders from what it last
 * sent will keep drawing them after the renderer has refused, reloaded or
 * resolved a preset differently.
 */
export interface VoiceReport {
  /** The base preset in use, or null when the chain is bypassed. */
  preset: string | null;
  /** The complete resolved configuration, or null when nothing is applied. */
  dsp: Record<string, unknown> | null;
  /** The acoustic space, downstream of the chain. */
  room: string | null;
  /** Integrated loudness of the last take, LUFS. Null before anything is spoken. */
  lufs: number | null;
  /** True peak of the last take, dBTP. */
  truePeakDb: number | null;
  /**
   * Whether the renderer is being refused an audio device.
   *
   * A browser will not start one until the page it is on has been interacted
   * with, so a viewer nobody has clicked plays every line silently. Nothing an
   * orchestrator sends can clear it — the fix is a person touching that page —
   * which is exactly why it is reported: from anywhere else the failure looks
   * the same as a speech sidecar that is not running.
   */
  blocked: boolean;
}
