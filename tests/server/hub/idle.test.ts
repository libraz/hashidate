import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_AFTER } from '@/engine/autopilot';
import { performanceDef } from '@/engine/performance';
import type { Command, StreamMessage } from '@/protocol';
import { Hub, IDLE_TICK_MS } from '@/server/hub';
import { EPOCH_MS } from './fixtures';

/**
 * The idle autopilot, run once on the server: every renderer is sent the same
 * choice, so the preview shows the idle that is on air.
 */

const IDLE_CMDS = new Set<Command['cmd']>(['idleAct', 'idleFace']);

/** Deterministic draws for the hub, so a run is the same run every time. */
function lcg(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 2 ** 32;
  };
}

let hub: Hub;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH_MS);
  hub = new Hub(null, null, null, null, null, undefined, lcg(5));
});

afterEach(() => {
  hub.dispose();
  vi.useRealTimers();
});

/** One attached renderer: every idle frame it heard, stamped with when. */
function attach() {
  const frames: { at: number; commands: Command[] }[] = [];
  const connect: Command[] = [];
  let connected = false;
  hub.subscribe((message: StreamMessage) => {
    if (!connected) connect.push(...message.commands);
    const idle = message.commands.filter((c) => IDLE_CMDS.has(c.cmd));
    if (connected && idle.length) frames.push({ at: Date.now(), commands: idle });
  });
  connected = true;
  return { frames, connect };
}

const seconds = (s: number) => vi.advanceTimersByTime(s * 1000);

describe('the idle autopilot on the server', () => {
  it('sends one frame per tick, identical for every renderer, each act with its hand', () => {
    const viewers = [attach(), attach(), attach()];
    hub.send({ type: 'command', commands: [{ cmd: 'idle', on: true }] });
    seconds(60);

    const [first, ...rest] = viewers;
    expect(first.frames.length).toBeGreaterThan(3);
    for (const viewer of rest) expect(viewer.frames).toEqual(first.frames);
    // One broadcast per tick, never one per renderer or one per choice.
    const stamps = first.frames.map((f) => f.at);
    expect(new Set(stamps).size).toBe(stamps.length);

    const acts = first.frames
      .flatMap((f) => f.commands)
      .filter((c): c is Extract<Command, { cmd: 'idleAct' }> => c.cmd === 'idleAct');
    expect(acts.length).toBeGreaterThan(2);
    // The first pick of a run is a standing row.
    expect(performanceDef(acts[0].act)?.gesture).toBeUndefined();
    const moving = acts.filter((c) => performanceDef(c.act)?.gesture);
    expect(moving.length).toBeGreaterThan(0);
    for (const act of moving) expect(['L', 'R']).toContain(act.side);
  });

  it('waits IDLE_AFTER of quiet before the first choice', () => {
    const viewer = attach();
    hub.send({ type: 'command', commands: [{ cmd: 'idle', on: true }] });
    seconds(IDLE_AFTER - IDLE_TICK_MS / 1000);
    expect(viewer.frames).toEqual([]);
    seconds(0.2);
    expect(viewer.frames.length).toBeGreaterThan(0);
  });

  it('stays out of a line that is waiting, but not of a held queue', () => {
    const viewer = attach();
    hub.send({
      type: 'command',
      commands: [
        { cmd: 'idle', on: true },
        { cmd: 'say', text: 'あ' },
      ],
    });
    seconds(10);
    expect(viewer.frames).toEqual([]);
    hub.send({ type: 'command', commands: [{ cmd: 'pause', on: true }] });
    seconds(IDLE_AFTER + 0.5);
    expect(viewer.frames.length).toBeGreaterThan(0);
  });

  it('restarts the quiet on a direct face or body command', () => {
    const viewer = attach();
    hub.send({ type: 'command', commands: [{ cmd: 'idle', on: true }] });
    for (let i = 0; i < 10; i++) {
      seconds(IDLE_AFTER / 2);
      hub.send({ type: 'command', commands: [{ cmd: 'emotion', vec: { joy: 1 } }] });
    }
    expect(viewer.frames).toEqual([]);
  });

  it('stops when idle is switched off', () => {
    const viewer = attach();
    hub.send({ type: 'command', commands: [{ cmd: 'idle', on: true }] });
    seconds(20);
    const heard = viewer.frames.length;
    expect(heard).toBeGreaterThan(0);
    hub.send({ type: 'command', commands: [{ cmd: 'idle', on: false }] });
    seconds(30);
    expect(viewer.frames.length).toBe(heard);
  });

  it('never replays a choice to a renderer that joins late; it gets the next one', () => {
    const early = attach();
    hub.send({ type: 'command', commands: [{ cmd: 'idle', on: true }] });
    seconds(20);
    expect(early.frames.length).toBeGreaterThan(0);

    const late = attach();
    expect(late.connect).toContainEqual({ cmd: 'idle', on: true });
    expect(late.connect.some((c) => IDLE_CMDS.has(c.cmd))).toBe(false);
    const before = early.frames.length;
    seconds(30);
    expect(late.frames.length).toBeGreaterThan(0);
    expect(late.frames).toEqual(early.frames.slice(before));
  });
});
