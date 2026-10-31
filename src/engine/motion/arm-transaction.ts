import { allocating, core, handleFinalizer } from '../../core';
import { ARM_SLOTS, FINGERS, SIDES } from '../../core/abi/profile';
import {
  FOLLOWED_ARM_DIRS,
  FOLLOWED_FINGER_SPEC,
  FOLLOWED_FINGER_SPREAD_SPEC,
  FOLLOWED_PALM_OUT,
  FOLLOWED_PALM_W,
  FOLLOWED_TWIST,
  NOTE,
  TX_FOLLOWED,
  TX_NOTES,
  TX_Q,
  TX_WORK,
} from '../../core/abi/rig';
import type { RigHandle } from '../rig/handle';
import { readTuple, sideCode, writeFingers, writeVec } from '../rig/records';
import { heap, recordView } from '../rig/views';
import type { ArmSlot, FingerName, Side, Vec3Tuple } from '../types';
import type { ScalarFollower } from './follow';
import type { ArmResolver } from './resolve';

/** The followed arm state the transaction reads, owned by `Body`. */
export interface ArmFollowed {
  _armDirs: Record<Side, Record<ArmSlot, Vec3Tuple>>;
  _palmOut: Record<Side, Vec3Tuple>;
  _palmW: Record<Side, ScalarFollower>;
  _twist: Record<Side, ScalarFollower>;
  _fingerSpec: Record<Side, Record<FingerName, number>>;
  _fingerSpreadSpec: Record<Side, Record<FingerName, number>>;
}

const WORK_KEYS = [
  'plans',
  'validations',
  'repairs',
  'stopTails',
  'holds',
  'solverCalls',
  'solverIterations',
  'environmentBatches',
] as const;

/** Frees the core's half of a transaction dropped without its rig's `dispose()`. */
const finalizer = handleFinalizer((c, t) => c.hd_rig_free_transaction(t));

/**
 * `rig.armTransaction(...)`: the constrained arm commit of one frame, run in the core.
 *
 * Body's followed records are copied in before each call that reads them. The notes the core's
 * `commit` leaves are replayed into `ArmResolver.note` after it returns, in its order: nothing in
 * the commit reads what `note` writes.
 */
export class ArmTransaction {
  readonly #rig: RigHandle;
  readonly #arm: ArmResolver;
  readonly #followed: ArmFollowed;
  #t: number;
  /** f64 index of the transaction's buffer. */
  readonly #at: number;
  readonly #notes: Record<Side, Record<'upperArm' | 'lowerArm' | 'hand', Vec3Tuple>> = {
    L: { upperArm: [0, 0, 0], lowerArm: [0, 0, 0], hand: [0, 0, 0] },
    R: { upperArm: [0, 0, 0], lowerArm: [0, 0, 0], hand: [0, 0, 0] },
  };
  /** What the last frame's commit spent, as the core counted it. */
  readonly _armFrameWork: Record<(typeof WORK_KEYS)[number], number>;

  constructor(rig: RigHandle, arm: ArmResolver, output: ArmFollowed, leadFloor: number) {
    this.#rig = rig;
    this.#arm = arm;
    this.#followed = output;
    const c = core();
    const h = rig.h;
    const t = allocating(() => c.hd_rig_new_transaction(h, leadFloor));
    this.#t = t;
    this.#at = c.hd_rig_tx_buffer(t) / 8;
    this._armFrameWork = recordView(8 * (this.#at + TX_WORK), WORK_KEYS);
    finalizer.register(this, t);
  }

  get #handle(): number {
    if (this.#t === 0) throw new Error('ArmTransaction: used after dispose()');
    return this.#t;
  }

  /** Clear the work counters at the start of a frame. */
  beginFrame(): void {
    const t = this.#handle;
    this.#rig.direct((c) => c.hd_rig_tx_begin_frame(t));
  }

  /** Give every route the same entrance length. */
  retime(seconds: number): void {
    const t = this.#handle;
    this.#rig.direct((c) => c.hd_rig_tx_retime(t, seconds));
  }

  /** Restart a side's route from a pose set from outside. */
  resetRoute(side: Side, q: Float64Array): void {
    const t = this.#handle;
    const s = sideCode(side);
    heap().set(q.subarray(0, 7), this.#at + TX_Q);
    this.#rig.direct((c) => c.hd_rig_tx_reset_route(t, s));
  }

  /** Form and stage the clasp leader's command ahead of the commit. */
  stageClaspLeader(side: Side, dt: number, frameReady: boolean): void {
    const t = this.#handle;
    const s = sideCode(side);
    this.#writeFollowed();
    this.#rig.run((c, h) => c.hd_rig_tx_stage_clasp_leader(t, h, s, dt, frameReady ? 1 : 0));
  }

  /** Commit both arms against the body as followed. */
  commit(dt: number, hipsRise: number, hipsTurn = 0): void {
    const t = this.#handle;
    this.#writeFollowed();
    const count = this.#rig.run((c, h) => c.hd_rig_tx_commit(t, h, dt, hipsRise, hipsTurn));
    const f = heap();
    for (let k = 0; k < count; k++) {
      const at = this.#at + TX_NOTES + NOTE * k;
      const side = SIDES[f[at]];
      const note = this.#notes[side];
      readTuple(f, at + 1, note.upperArm);
      readTuple(f, at + 4, note.lowerArm);
      readTuple(f, at + 7, note.hand);
      this.#arm.note(side, note.upperArm, note.lowerArm, note.hand);
    }
  }

  /** Free the core's half. */
  dispose(): void {
    const t = this.#t;
    if (t === 0) return;
    this.#t = 0;
    finalizer.unregister(this);
    allocating(() => core().hd_rig_free_transaction(t));
  }

  #writeFollowed(): void {
    const f = heap();
    const o = this.#followed;
    const at = this.#at + TX_FOLLOWED;
    for (const [s, side] of SIDES.entries()) {
      const dirs = o._armDirs[side];
      for (const [k, slot] of ARM_SLOTS.entries()) {
        writeVec(f, at + FOLLOWED_ARM_DIRS + 12 * s + 3 * k, dirs[slot]);
      }
      writeVec(f, at + FOLLOWED_PALM_OUT + 3 * s, o._palmOut[side]);
      f[at + FOLLOWED_PALM_W + s] = o._palmW[side].value;
      f[at + FOLLOWED_TWIST + s] = o._twist[side].value;
      writeFingers(f, at + FOLLOWED_FINGER_SPEC + FINGERS.length * s, o._fingerSpec[side]);
      writeFingers(
        f,
        at + FOLLOWED_FINGER_SPREAD_SPEC + FINGERS.length * s,
        o._fingerSpreadSpec[side],
      );
    }
  }
}
