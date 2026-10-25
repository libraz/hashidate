import { CROUCH_T, type HopSpec, type JumpArc, planJump, sampleJump } from './jump';

/** Whether `n` hops of `turn` radians each make a whole number of revolutions. */
function closes(n: number, turn: number): boolean {
  const revolutions = (n * turn) / (2 * Math.PI);
  return Math.abs(revolutions - Math.round(revolutions)) < 1e-9;
}

/**
 * The hop in flight and the one queued behind it. Each frame it leaves the
 * hips' rise, the body's compression, the yaw and the chest's lead for the
 * body to read.
 */
export class HopRun {
  private _jump: JumpArc | null = null;
  private _jumpT = 0;
  /** A run asked for while one was in flight; it starts when that one lands. */
  private _hopQueued: HopSpec | null = null;
  private _rise = 0; // hips above rest this frame, metres
  private _load = 0; // 0..1, how far into the dip the body is
  /** Radians the skeleton is yawed this frame, and the chest's lead over the pelvis. */
  private _yaw = 0;
  private _lead = 0;

  get rise(): number {
    return this._rise;
  }

  get load(): number {
    return this._load;
  }

  get yaw(): number {
    return this._yaw;
  }

  get lead(): number {
    return this._lead;
  }

  start({ height, count, turn }: HopSpec, gravity: number): void {
    // Restarting a run in flight would drop the hips to rest in one frame; the
    // new one waits for the landing, which ends standing and at rest.
    if (this._jump) {
      this._hopQueued = { height, count, turn };
      return;
    }
    this._jump = planJump(height, gravity, count, turn);
    this._jumpT = 0;
  }

  /** Finish the current hop, dropping any later cycles from a run and any run queued after it. */
  finish(): void {
    this._hopQueued = null;
    const jump = this._jump;
    if (!jump) return;
    const cycle = jump.push + jump.flight + jump.brake;
    const elapsed = Math.max(0, this._jumpT - CROUCH_T);
    const current = Math.min(jump.count, Math.floor(elapsed / cycle) + 1);
    // A turning run keeps the hops it needs to face front again.
    let end = current;
    while (end < jump.count && !closes(end, jump.turn)) end++;
    jump.count = end;
  }

  /** Whether a hop is in flight. Read by the panel. */
  get active(): boolean {
    return this._jump !== null;
  }

  /**
   * Advance the hop, leaving the hips' rise and the body's compression in
   * `_rise` and `_load`. Both are zero on every frame that is not part of one.
   */
  step(dt: number, gravity: number): void {
    this._rise = 0;
    this._load = 0;
    this._yaw = 0;
    this._lead = 0;
    const j = this._jump;
    if (!j) return;

    this._jumpT += dt;
    const s = sampleJump(j, this._jumpT);
    if (s.done) {
      this._jump = null;
      const next = this._hopQueued;
      if (next) {
        this._hopQueued = null;
        this._jump = planJump(next.height, gravity, next.count, next.turn);
        this._jumpT = 0;
      }
      return;
    }
    this._rise = s.rise;
    this._load = s.load;
    this._yaw = s.yaw;
    this._lead = s.lead;
  }
}
