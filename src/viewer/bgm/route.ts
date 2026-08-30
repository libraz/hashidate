/**
 * One track's path into the mix, and the gain envelope on it.
 *
 * A route is a media element, its source node and its own envelope. There is
 * one per *sounding* track rather than one per selection, because a crossfade
 * is two of them at once — which is also why the envelope is scheduled against
 * an explicit `AudioContext` timestamp everywhere below: both sides of a switch
 * have to start from the same instant, and reading the clock twice would leave
 * a seam.
 */

export interface EnvelopeState {
  from: number;
  to: number;
  start: number;
  duration: number;
}

export interface TrackRoute {
  readonly epoch: number;
  readonly track: string;
  readonly audio: HTMLAudioElement;
  readonly source: MediaElementAudioSourceNode;
  readonly envelope: GainNode;
  envelopeState: EnvelopeState;
  retired: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
}

// --- the graph, defensively -------------------------------------------------
//
// Every one of these swallows its failure. A partial media element or a
// half-built `AudioParam` is the ordinary case in a test host, and none of
// these operations has anything useful to say when it does not apply.

export function safeDisconnect(node: AudioNode | null): void {
  if (node === null) return;
  try {
    node.disconnect();
  } catch {
    /* already disconnected */
  }
}

export function cleanupAudio(audio: HTMLAudioElement | null): void {
  if (audio === null) return;
  try {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } catch {
    /* a test host may expose only a partial media element */
  }
}

export function cancelParam(param: AudioParam, at: number): void {
  try {
    param.cancelScheduledValues(at);
  } catch {
    /* a test host may expose only a partial AudioParam */
  }
}

// --- what a media element has to say ----------------------------------------

export function finiteDuration(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function mediaError(audio: HTMLAudioElement): string {
  const message = audio.error?.message;
  return message && message.length > 0 ? message : 'BGM media could not be loaded';
}

export function isBlockedPlayError(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    ('name' in reason ? (reason as { name?: unknown }).name === 'NotAllowedError' : false)
  );
}

// --- the envelope -----------------------------------------------------------

/**
 * Where a ramp has got to at `at`.
 *
 * Tracked alongside the `AudioParam` rather than read off it, because a param
 * mid-ramp cannot be queried: `value` is only meaningful once the ramp has
 * been cancelled, and cancelling is exactly what the caller is about to do.
 */
export function envelopeValue(state: EnvelopeState, at: number): number {
  if (state.duration <= 0) return state.to;
  const fraction = Math.min(1, Math.max(0, (at - state.start) / state.duration));
  return state.from + (state.to - state.from) * fraction;
}

/** Freeze a ramp where it is. Used when a pause lands mid-fade. */
export function holdEnvelope(route: TrackRoute, at: number): void {
  const current = envelopeValue(route.envelopeState, at);
  cancelParam(route.envelope.gain, at);
  route.envelope.gain.setValueAtTime(current, at);
  route.envelopeState = { from: current, to: current, start: at, duration: 0 };
}

/** Ramp to `target` over `duration`, starting from wherever the last ramp got to. */
export function scheduleEnvelopeAt(
  route: TrackRoute,
  target: number,
  duration: number,
  at: number,
): void {
  const from = envelopeValue(route.envelopeState, at);
  const boundedDuration = Math.max(0, duration);
  cancelParam(route.envelope.gain, at);
  route.envelope.gain.setValueAtTime(from, at);
  if (boundedDuration === 0) route.envelope.gain.setValueAtTime(target, at);
  else route.envelope.gain.linearRampToValueAtTime(target, at + boundedDuration);
  route.envelopeState = {
    from,
    to: target,
    start: at,
    duration: boundedDuration,
  };
}

/**
 * Tear one route's media and nodes down.
 *
 * The graph half of finalizing a route. Which set it belonged to, and whether
 * it was the current one, is the transport's bookkeeping and stays there.
 */
export function releaseRoute(route: TrackRoute): void {
  if (route.timer !== null) {
    clearTimeout(route.timer);
    route.timer = null;
  }
  route.audio.onloadedmetadata = null;
  route.audio.onerror = null;
  route.audio.onended = null;
  route.audio.pause();
  safeDisconnect(route.source);
  safeDisconnect(route.envelope);
  cleanupAudio(route.audio);
}
