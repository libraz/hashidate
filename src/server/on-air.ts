import type { TurnQueue } from './queue';

/**
 * Which renderers own each line on air, and the grace before an abandoned line
 * is filed as interrupted.
 *
 * Reaches the rest of the hub only through the functions it is constructed
 * with, so it never imports the hub.
 */

/** Internal owner marker for a legacy report that carried no renderer id. */
const ANONYMOUS_OWNER = '';

export class OnAirOwners {
  /** Number of live SSE connections for each renderer identity. */
  private readonly rendererConnections = new Map<string, number>();
  /** Distinct renderers that have acknowledged each line currently on air. */
  private readonly onAirOwners = new Map<string, Set<string>>();
  /** Grace timers for lines whose last known owner disconnected. */
  private readonly onAirTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * @param queue Read only: which lines are pending or airing.
   * @param hasOtherClient Whether any connection other than this renderer's is open.
   * @param onAbandoned Files a line still airing whose owners are all gone.
   * @param graceMs How long an ownerless line waits before it is abandoned.
   */
  constructor(
    private readonly queue: TurnQueue,
    private readonly hasOtherClient: (rendererId: string) => boolean,
    private readonly onAbandoned: (turnId: string) => void,
    private readonly graceMs: number,
  ) {}

  /** Live connections held by one renderer. */
  connections(owner: string): number {
    return this.rendererConnections.get(owner) ?? 0;
  }

  /** Count one more connection for a renderer. */
  attach(rendererId: string): void {
    this.rendererConnections.set(rendererId, this.connections(rendererId) + 1);
  }

  /**
   * Count one connection fewer for a renderer. Answers whether it was the last,
   * in which case the renderer's lines have already had their grace armed.
   */
  detach(rendererId: string): boolean {
    const count = (this.rendererConnections.get(rendererId) ?? 1) - 1;
    if (count > 0) {
      this.rendererConnections.set(rendererId, count);
      return false;
    }
    this.rendererConnections.delete(rendererId);
    this.rendererDisconnected(rendererId);
    return true;
  }

  /** Cancel or recover on-air grace when a renderer attaches. */
  rendererConnected(rendererId: string): void {
    for (const [turnId, owners] of [...this.onAirOwners]) {
      if (owners.has(ANONYMOUS_OWNER)) continue;
      if (owners.has(rendererId)) {
        this.clearOnAirTimer(turnId);
        continue;
      }
      // Another connected page may still be posting its first turn.start.
      // A newcomer must not shorten that page's report grace and prematurely
      // file its live line as interrupted.
      if (!this.hasLiveOwner(owners)) {
        if (this.hasOtherClient(rendererId)) {
          this.armOnAirTimer(turnId);
        } else {
          this.recoverOnAir(turnId);
        }
      }
    }
  }

  /** Arm grace for every on-air line owned by a renderer that just left. */
  private rendererDisconnected(rendererId: string): void {
    for (const [turnId, owners] of this.onAirOwners) {
      if (!owners.has(rendererId) || owners.has(ANONYMOUS_OWNER)) continue;
      if (!this.hasLiveOwner(owners)) this.armOnAirTimer(turnId);
    }
  }

  private hasLiveOwner(owners: Set<string>): boolean {
    for (const owner of owners) {
      if (owner !== ANONYMOUS_OWNER && (this.rendererConnections.get(owner) ?? 0) > 0) {
        return true;
      }
    }
    return false;
  }

  /** Remember one renderer's ownership of a line, including duplicate starts. */
  noteTurnOwner(turnId: string, rendererId?: string): void {
    const known = this.onAirOwners.get(turnId);
    const active =
      known !== undefined ||
      this.queue.list().some((entry) => entry.id === turnId) ||
      this.queue.airing().some((entry) => entry.id === turnId);
    if (!active) return;

    const owners = known ?? new Set<string>();
    owners.add(rendererId ?? ANONYMOUS_OWNER);
    this.onAirOwners.set(turnId, owners);
    if (rendererId !== undefined && (this.rendererConnections.get(rendererId) ?? 0) > 0) {
      this.clearOnAirTimer(turnId);
    } else if (rendererId !== undefined) {
      // A report may race the stream handshake (or come from a caller that
      // never opened SSE). Treat that owner as already absent until it connects.
      this.armOnAirTimer(turnId);
    }
  }

  /** Start a grace timer after all named owners of a line have disconnected. */
  private armOnAirTimer(turnId: string): void {
    if (this.onAirTimers.has(turnId)) return;
    const owners = this.onAirOwners.get(turnId);
    if (owners === undefined || owners.has(ANONYMOUS_OWNER) || this.hasLiveOwner(owners)) return;
    const timer = setTimeout(() => {
      this.onAirTimers.delete(turnId);
      const current = this.onAirOwners.get(turnId);
      if (current === undefined || current.has(ANONYMOUS_OWNER) || this.hasLiveOwner(current)) {
        return;
      }
      this.recoverOnAir(turnId);
    }, this.graceMs);
    timer.unref?.();
    this.onAirTimers.set(turnId, timer);
  }

  private clearOnAirTimer(turnId: string): void {
    const timer = this.onAirTimers.get(turnId);
    if (timer !== undefined) clearTimeout(timer);
    this.onAirTimers.delete(turnId);
  }

  /** Forget owner state when a turn completes normally or by an interrupt. */
  clearTurnOwners(turnId: string): void {
    this.clearOnAirTimer(turnId);
    this.onAirOwners.delete(turnId);
  }

  /** Hand an abandoned line to the filing side, if it is still on air. */
  private recoverOnAir(turnId: string): void {
    const airing = this.queue.airing().some((entry) => entry.id === turnId);
    this.clearTurnOwners(turnId);
    if (airing) this.onAbandoned(turnId);
  }

  /** Stop every grace timer and forget every owner. */
  dispose(): void {
    for (const timer of this.onAirTimers.values()) clearTimeout(timer);
    this.onAirTimers.clear();
    this.onAirOwners.clear();
  }
}
