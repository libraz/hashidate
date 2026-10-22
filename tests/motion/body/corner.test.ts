import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArmDriver } from '@/engine/rig/arm-driver';
import { ArmStepSolver } from '@/engine/rig/arm-path';
import * as armQp from '@/engine/rig/arm-qp';
import { ArmRoute } from '@/engine/rig/arm-route';
import type { Side } from '@/engine/types';
import { DT, type Harness, harness } from './harness';

/**
 * Where the arm solver meets a corner of the joint box.
 *
 * A pose that sits on two joint stops at once, or a face that moves into the
 * hand, used to leave the solver reporting that it could not move: the hand
 * stuck to the face, a hold stopped short of its request, a release that took
 * several frames to register. Measured on the route's own plans, one per frame,
 * on the synthetic rig.
 */

const HOLD_FRAMES = 150;
const RELEASE_FRAMES = 150;
const FRAMES = HOLD_FRAMES + RELEASE_FRAMES;

/** A point off the head bone's pivot, so a turn of the head moves it. */
const HEAD_PROBE: [number, number, number] = [0, 0.2, 0.2];

interface Plan {
  frame: number;
  status: string;
  iterations: number;
}

interface Capture {
  h: Harness;
  /** The right route's plans, in frame order. */
  plans: Plan[];
  /** `restoreEndpointFrom` and `stepTowardRaw` calls made while the right route tracks. */
  recoveries: { frame: number; kind: string }[];
  /** The right route's goal q after each frame. */
  goals: Float64Array[];
  /** The raw q the right route tracked in each frame. */
  raws: Float64Array[];
  /** A point carried by the head bone, in world space, after each frame. */
  heads: THREE.Vector3[];
  /** `makeConstrainedStep` results on the right driver's solver, frame-tagged. */
  steps: { frame: number; ok: boolean }[];
  /** Every `solveDualActiveSet` result in the run, either arm, any phase. */
  qp: armQp.QpResult[];
}

type Privates<T> = { [key: string]: (...args: never[]) => unknown } & T;

/**
 * Play `id` on the right hand for a hold and a release at 60 Hz, recording what
 * the right route's plans return. The solver's output buffer is reused, so
 * status and iterations are copied the moment a plan returns.
 */
function run(id: string, frames = FRAMES): Capture {
  const h = harness(0, { random: () => 0.5 });
  const driver = h.rig.armDriver('R');
  if (!driver) throw new Error('synthetic rig has no right arm driver');
  const route = (h.body as unknown as { _transaction: { _routes: Record<Side, ArmRoute> } })
    ._transaction._routes.R;
  const head = h.profile.bones.head;
  if (!head) throw new Error('synthetic rig has no head bone');

  const capture: Capture = {
    h,
    plans: [],
    recoveries: [],
    goals: [],
    raws: [],
    heads: [],
    steps: [],
    qp: [],
  };
  let frame = -1;
  let tracking = false;

  const track = ArmRoute.prototype.track;
  vi.spyOn(ArmRoute.prototype, 'track').mockImplementation(function (this: ArmRoute, ...args) {
    const mine = this === route;
    if (mine) {
      tracking = true;
      capture.raws[frame] = Float64Array.from(args[2]);
    }
    try {
      return track.apply(this, args);
    } finally {
      if (mine) tracking = false;
    }
  });

  const planFrom = ArmDriver.prototype.planFrom;
  vi.spyOn(ArmDriver.prototype, 'planFrom').mockImplementation(function (this: ArmDriver, ...args) {
    const out = planFrom.apply(this, args);
    if (tracking && this === driver) {
      capture.plans.push({ frame, status: out.status, iterations: out.iterations });
    }
    return out;
  });

  const restore = ArmDriver.prototype.restoreEndpointFrom;
  vi.spyOn(ArmDriver.prototype, 'restoreEndpointFrom').mockImplementation(function (
    this: ArmDriver,
    ...args
  ) {
    if (tracking && this === driver) capture.recoveries.push({ frame, kind: 'restoreEndpoint' });
    return restore.apply(this, args);
  });

  const routePrototype = ArmRoute.prototype as unknown as Privates<object>;
  const stepToward = routePrototype.stepTowardRaw as (
    this: ArmRoute,
    ...args: unknown[]
  ) => boolean;
  vi.spyOn(routePrototype, 'stepTowardRaw').mockImplementation(function (
    this: ArmRoute,
    ...args: unknown[]
  ) {
    if (tracking && this === route) capture.recoveries.push({ frame, kind: 'stepTowardRaw' });
    return stepToward.apply(this, args);
  } as never);

  const solverPrototype = ArmStepSolver.prototype as unknown as Privates<object>;
  const constrained = solverPrototype.makeConstrainedStep as (
    this: ArmStepSolver,
    ...args: unknown[]
  ) => boolean;
  vi.spyOn(solverPrototype, 'makeConstrainedStep').mockImplementation(function (
    this: ArmStepSolver,
    ...args: unknown[]
  ) {
    const ok = constrained.apply(this, args);
    if (this === driver.solver) capture.steps.push({ frame, ok });
    return ok;
  } as never);

  const solve = armQp.solveDualActiveSet;
  vi.spyOn(armQp, 'solveDualActiveSet').mockImplementation((...args) => {
    const result = solve(...args);
    capture.qp.push(result);
    return result;
  });

  h.rig.reset();
  h.body.update(DT);
  h.body.play(id, 'R');
  for (let i = 0; i < frames; i++) {
    if (i === HOLD_FRAMES) h.body.stopGesture();
    frame = i;
    h.rig.reset();
    h.body.update(DT);
    capture.goals.push(Float64Array.from(route.goalQ));
    head.updateWorldMatrix(true, false);
    capture.heads.push(head.localToWorld(new THREE.Vector3(...HEAD_PROBE)));
  }
  return capture;
}

const inWindow = (plans: Plan[], from: number, to: number): Plan[] =>
  plans.filter((p) => p.frame >= from && p.frame <= to);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('arm solver at a corner of the joint box', () => {
  it('cover holds with a handful of iterations, not the whole budget', () => {
    const { plans } = run('cover');
    // f150 is the release request's jump, not the hold.
    const window = inWindow(plans, 100, 149);
    expect(window.length).toBeGreaterThanOrEqual(50);
    const over = window.filter((p) => p.iterations > 3).map((p) => `f${p.frame}:${p.iterations}`);
    expect(over, `plans over 3 iterations: ${over.length}`).toEqual([]);
  });

  it('cuteSalute keeps moving while the head moves into the hand', () => {
    const { plans, goals, heads } = run('cuteSalute', 137);
    const window = inWindow(plans, 36, 136);
    expect(window.length).toBeGreaterThanOrEqual(101);
    // The head must actually move in this window, or nothing pushes on the hand.
    let travel = 0;
    for (let f = 36; f <= 136; f++) travel = Math.max(travel, heads[f].distanceTo(heads[36]));
    expect(travel).toBeGreaterThanOrEqual(1e-3);
    // A start the head pushed into must be cleared, never refused outright; a hand
    // pressed flat by the head may still report blocked while it cannot slide.
    const refused = window.filter((p) => p.status === 'blocked' && p.iterations === 0);
    expect(refused.map((p) => `f${p.frame}`)).toEqual([]);
    const blocked = window.filter((p) => p.status === 'blocked');
    expect(
      blocked.length,
      `blocked plans: ${blocked.map((p) => p.frame).join(',')}`,
    ).toBeLessThanOrEqual(15);
    let change = 0;
    for (let f = 36; f <= 136; f++) {
      for (let i = 0; i < goals[f].length; i++) {
        change = Math.max(change, Math.abs(goals[f][i] - goals[36][i]));
      }
    }
    expect(change).toBeGreaterThanOrEqual(0.01);
  });

  it('listen settles in its hold and returns to rest after it', () => {
    const { plans, goals, raws } = run('listen');
    expect(plans.length).toBeGreaterThanOrEqual(FRAMES);
    // f150 is the release request's jump, not the hold.
    const hold = inWindow(plans, 75, HOLD_FRAMES - 1);
    expect(hold.length).toBeGreaterThanOrEqual(HOLD_FRAMES - 75);
    const unsettled = hold.filter((p) => p.status !== 'settled');
    expect(unsettled.map((p) => `f${p.frame}:${p.status}`)).toEqual([]);
    // A hand pressed by the returning head cannot slide along it, which plans
    // report as blocked; none of the release is a minimum short of rest.
    const release = inWindow(plans, HOLD_FRAMES, FRAMES);
    const stationary = release.filter((p) => p.status === 'stationary');
    expect(stationary.map((p) => `f${p.frame}`)).toEqual([]);
    const blocked = release.filter((p) => p.status === 'blocked');
    expect(
      blocked.length,
      `blocked in release: ${blocked.map((p) => p.frame).join(',')}`,
    ).toBeLessThanOrEqual(15);
    const last = FRAMES - 1;
    let gap = 0;
    for (let i = 0; i < 7; i++) gap = Math.max(gap, Math.abs(goals[last][i] - raws[last][i]));
    expect(gap).toBeLessThanOrEqual(1e-3);
  });

  it('cover settles on the frame after its release stops making progress', () => {
    const { plans } = run('cover');
    const release = plans.filter((p) => p.frame >= HOLD_FRAMES);
    expect(release.length).toBeGreaterThanOrEqual(RELEASE_FRAMES);
    const first = release.findIndex((p) => p.status !== 'progress');
    expect(first, 'the release never stopped progressing').toBeGreaterThanOrEqual(0);
    expect(first + 1, 'the release ended with no plan after it').toBeLessThan(release.length);
    expect(release[first + 1].status).toBe('settled');
  });

  it.each(['cover', 'yawn', 'faceFrame', 'heartHands'])(
    '%s never fails a constrained step it could take',
    (id) => {
      const { steps, qp } = run(id);
      expect(qp.length).toBeGreaterThanOrEqual(HOLD_FRAMES);
      const qpFailed = qp.filter((r) => r === 'failed').length;
      const infeasible = qp.filter((r) => r === 'infeasible').length;
      expect(qpFailed, `${qpFailed} of ${qp.length} QPs failed, ${infeasible} infeasible`).toBe(0);
      expect(steps.length).toBeGreaterThanOrEqual(HOLD_FRAMES);
      const failed = steps.filter((s) => !s.ok);
      expect(failed.length, `${failed.length} of ${steps.length} steps failed`).toBe(0);
    },
  );
});
