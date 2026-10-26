import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_AFTER } from '@/engine/autopilot';
import { performanceDef } from '@/engine/performance';
import type { Command, StreamMessage } from '@/protocol';
import { Hub, IDLE_TICK_MS } from '@/server/hub';
import { EPOCH_MS, vocabulary } from './fixtures';

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

  it("draws from the pool the loaded avatar's renderer reported", () => {
    const viewer = attach();
    hub.report({ vocabulary: { ...vocabulary(), idleActs: ['shy', 'blank', 'noSuchAct'] } });
    hub.send({ type: 'command', commands: [{ cmd: 'idle', on: true }] });
    seconds(120);
    const acts = viewer.frames
      .flatMap((f) => f.commands)
      .flatMap((c) => (c.cmd === 'idleAct' ? [c.act] : []));
    expect(new Set(acts)).toEqual(new Set(['shy', 'blank']));
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

describe('commands after a batch (a script teardown)', () => {
  const IDLE_ON: Command[] = [{ cmd: 'idle', on: true }];

  /** Every `idle` command a renderer heard after it attached. */
  function idleHeard() {
    const heard: boolean[] = [];
    let connected = false;
    hub.subscribe((message: StreamMessage) => {
      if (!connected) return;
      for (const c of message.commands) if (c.cmd === 'idle') heard.push(c.on ?? true);
    });
    connected = true;
    return heard;
  }

  const say = (id: string, end: 'turn.end' | 'turn.interrupted' = 'turn.end') => {
    hub.report({ events: [{ type: 'turn.start', turn: id }] });
    hub.report({ events: [{ type: end, turn: id }] });
  };

  it('turns idle back on once the batch has been said', () => {
    const heard = idleHeard();
    const [a, b] = hub.queue.add([{ text: 'あ' }, { text: 'い' }], { source: 'demo' });
    hub.afterBatch([a, b], IDLE_ON);
    say(a.id);
    expect(heard).toEqual([]);
    say(b.id);
    expect(heard).toEqual([true]);
  });

  it('waits while anything else is still to say after the batch', () => {
    const heard = idleHeard();
    const [a] = hub.queue.add([{ text: 'あ' }], { source: 'demo' });
    hub.afterBatch([a], IDLE_ON);
    const [typed] = hub.queue.add([{ text: '手で足した行' }]);
    say(a.id);
    expect(heard).toEqual([]);
    say(typed.id);
    expect(heard).toEqual([]);
  });

  it('resumes after a stop too, when the line cut off was the last one left', () => {
    const heard = idleHeard();
    const [a, b] = hub.queue.add([{ text: 'あ' }, { text: 'い' }], { source: 'demo' });
    hub.afterBatch([a, b], IDLE_ON);
    hub.report({ events: [{ type: 'turn.start', turn: a.id }] });
    hub.queue.clear();
    hub.report({ events: [{ type: 'turn.interrupted', turn: a.id }] });
    expect(heard).toEqual([true]);
  });

  it('hands the decision to a newer batch, so a replaced script does not resume', () => {
    const heard = idleHeard();
    const [old] = hub.queue.add([{ text: '前の台本' }], { source: 'one' });
    hub.afterBatch([old], IDLE_ON);
    hub.report({ events: [{ type: 'turn.start', turn: old.id }] });
    hub.queue.clear();
    const [next] = hub.queue.add([{ text: '次の台本' }], { source: 'two' });
    hub.afterBatch([next], IDLE_ON);
    hub.report({ events: [{ type: 'turn.end', turn: old.id }] });
    expect(heard).toEqual([]);
    say(next.id);
    expect(heard).toEqual([true]);
  });

  it('turns it on once however many renderers report the ending', () => {
    const heard = idleHeard();
    const [a] = hub.queue.add([{ text: 'あ' }], { source: 'demo' });
    hub.afterBatch([a], IDLE_ON);
    hub.report({ events: [{ type: 'turn.start', turn: a.id }] });
    for (let i = 0; i < 3; i++) hub.report({ events: [{ type: 'turn.end', turn: a.id }] });
    expect(heard).toEqual([true]);
  });

  it('applies nothing for a batch with an empty teardown, and forgets the one before', () => {
    const heard = idleHeard();
    const [old] = hub.queue.add([{ text: '前の台本' }], { source: 'one' });
    hub.afterBatch([old], IDLE_ON);
    hub.report({ events: [{ type: 'turn.start', turn: old.id }] });
    const [next] = hub.queue.add([{ text: '次の台本' }], { source: 'two' });
    hub.afterBatch([next], []);
    hub.report({ events: [{ type: 'turn.end', turn: old.id }] });
    say(next.id);
    expect(heard).toEqual([]);
  });

  it('leaves idle alone for lines queued without a teardown', () => {
    const heard = idleHeard();
    const [a] = hub.queue.add([{ text: 'あ' }], { source: 'chat' });
    say(a.id);
    expect(heard).toEqual([]);
  });
});
