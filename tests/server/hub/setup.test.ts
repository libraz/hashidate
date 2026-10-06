import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamMessage } from '@/protocol';
import { Hub } from '@/server/hub';
import { EPOCH_MS } from './fixtures';

/**
 * The standing settings a renderer is handed the moment it connects.
 */

let hub: Hub;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH_MS);
  hub = new Hub();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the setup, replayed on connect', () => {
  /** Attach a viewer and hand back the commands it was given on connect. */
  const attach = (): StreamMessage['commands'] => {
    const seen: StreamMessage[] = [];
    hub.subscribe((message) => seen.push(message));
    return seen.flatMap((message) => message.commands);
  };

  it('hands a late viewer the shot, the set and the costume', () => {
    hub.send({
      type: 'command',
      commands: [
        { cmd: 'camera', frame: 'full' },
        { cmd: 'backdrop', id: 'night' },
        { cmd: 'wear', slot: 'top', item: 'coat' },
      ],
    });
    expect(attach()).toEqual([
      { cmd: 'wear', slot: 'top', item: 'coat' },
      { cmd: 'camera', frame: 'full' },
      { cmd: 'backdrop', id: 'night' },
      { cmd: 'queue', turns: [] },
    ]);
  });

  it('clears a viewer queue when it attaches before anything has been set', () => {
    expect(attach()).toEqual([{ cmd: 'queue', turns: [] }]);
  });

  it('leaves out the commands that were a moment rather than a setting', () => {
    hub.send({
      type: 'command',
      commands: [
        { cmd: 'camera', frame: 'face' },
        { cmd: 'gesture', id: 'wave' },
        { cmd: 'say', text: 'あ' },
        { cmd: 'perform', id: 'hello' },
      ],
    });
    // The say is a queued line and the performance leaves only its mood.
    expect(attach()).toEqual([
      { cmd: 'camera', frame: 'face' },
      { cmd: 'emotion', vec: { joy: 0.85 } },
      { cmd: 'queue', turns: [{ id: expect.any(String), text: 'あ' }] },
    ]);
  });

  it('sends the setup and the queue in one frame, setup first', () => {
    // Two frames would be wrong rather than merely untidy: a renderer told to
    // load a different avatar holds everything behind it until that avatar is
    // standing, and a queue arriving on its own after the hold had ended would
    // be applied to the scene that was being replaced.
    hub.send({ type: 'command', commands: [{ cmd: 'avatar', id: 'other' }] });
    hub.queue.add([{ text: 'あ' }]);
    const seen: StreamMessage[] = [];
    hub.subscribe((message) => seen.push(message));
    expect(seen).toHaveLength(1);
    expect(seen[0].commands.map((c) => c.cmd)).toEqual(['avatar', 'queue']);
  });

  it('keeps the setup for every later viewer, not just the first', () => {
    hub.send({ type: 'command', commands: [{ cmd: 'room', id: 'hall' }] });
    expect(attach()).toEqual([
      { cmd: 'room', id: 'hall' },
      { cmd: 'queue', turns: [] },
    ]);
    expect(attach()).toEqual([
      { cmd: 'room', id: 'hall' },
      { cmd: 'queue', turns: [] },
    ]);
  });

  it('does not record what it replays, so a reconnect cannot double an outfit', () => {
    hub.send({ type: 'command', commands: [{ cmd: 'wear', slot: 'top', item: 'coat' }] });
    attach();
    expect(attach()).toEqual([
      { cmd: 'wear', slot: 'top', item: 'coat' },
      { cmd: 'queue', turns: [] },
    ]);
  });

  it('carries the pending queue with an avatar swap for an attached renderer', () => {
    const [entry] = hub.queue.add([{ text: '待機中' }]);
    const seen: StreamMessage[] = [];
    hub.subscribe((message) => seen.push(message), 'renderer-a');
    seen.length = 0;

    hub.send({ type: 'command', commands: [{ cmd: 'avatar', id: 'other' }] });

    expect(seen).toEqual([
      {
        type: 'command',
        commands: [
          { cmd: 'avatar', id: 'other' },
          { cmd: 'queue', turns: [{ id: entry.id, text: '待機中' }] },
        ],
      },
    ]);
  });

  it('does not replace an explicit queue in an avatar batch', () => {
    hub.queue.add([{ text: 'server' }]);
    const seen: StreamMessage[] = [];
    hub.subscribe((message) => seen.push(message), 'renderer-a');
    seen.length = 0;

    hub.send({
      type: 'command',
      commands: [
        { cmd: 'avatar', id: 'other' },
        { cmd: 'queue', turns: [] },
      ],
    });

    expect(seen[0]).toEqual({
      type: 'command',
      commands: [
        { cmd: 'avatar', id: 'other' },
        { cmd: 'queue', turns: [] },
      ],
    });
  });

  it('carries the newest value of a setting that was changed twice', () => {
    hub.send({ type: 'command', commands: [{ cmd: 'camera', frame: 'face' }] });
    hub.send({ type: 'command', commands: [{ cmd: 'camera', frame: 'bust' }] });
    expect(attach()).toEqual([
      { cmd: 'camera', frame: 'bust' },
      { cmd: 'queue', turns: [] },
    ]);
  });

  it('is not disturbed by the queue frames the hub sends on its own', () => {
    hub.send({ type: 'command', commands: [{ cmd: 'camera', frame: 'upper' }] });
    hub.queue.add([{ text: 'あ' }]);
    hub.publishQueue();
    expect(attach().map((c) => c.cmd)).toEqual(['camera', 'queue']);
  });
});

/**
 * What a renderer attaching mid-show is handed: the setup as every line and
 * command so far left it, and a queue it cannot start ahead of the others.
 */
describe('a renderer that attaches mid-show', () => {
  const attach = (): StreamMessage[] => {
    const seen: StreamMessage[] = [];
    hub.subscribe((message) => seen.push(message));
    return seen;
  };
  const setup = (frames: StreamMessage[]) => frames[0].commands;

  it('is handed the stage and mood of a line that has started', () => {
    const [line] = hub.queue.add([
      {
        text: 'あ',
        emotion: { anger: 1 },
        stage: { camera: 'full', deck: 'intro', slide: 4, place: { avatar: { width: 0.3 } } },
      },
    ]);
    hub.report({ events: [{ type: 'turn.start', turn: line.id }] });
    hub.report({ events: [{ type: 'turn.end', turn: line.id }] });

    expect(setup(attach())).toEqual([
      { cmd: 'camera', frame: 'full' },
      { cmd: 'place', avatar: { width: 0.3 } },
      { cmd: 'deck', id: 'intro', page: 4 },
      { cmd: 'emotion', vec: { anger: 1 } },
      { cmd: 'queue', turns: [] },
    ]);
  });

  it('is handed a neutral mood after a reset', () => {
    hub.send({
      type: 'command',
      commands: [{ cmd: 'emotion', vec: { joy: 1 } }, { cmd: 'reset' }],
    });
    expect(setup(attach())).toContainEqual({ cmd: 'emotion', vec: { neutral: 1 } });
  });

  it('is handed the camera and page a fired cue set, once however many renderers report it', () => {
    const fire = (
      cue: { kind: 'camera'; frame: 'face' } | { kind: 'slide'; page: number },
      n: number,
    ) => hub.report({ events: [{ type: 'cue.fire', turn: 't', cueId: `t:cue:${n}`, cue }] });
    fire({ kind: 'slide', page: 2 }, 0);
    hub.send({ type: 'command', commands: [{ cmd: 'slide', page: 7 }] });
    // A second renderer's late report of the same cue must not turn the page back.
    fire({ kind: 'slide', page: 2 }, 0);
    fire({ kind: 'camera', frame: 'face' }, 1);

    expect(setup(attach())).toEqual([
      { cmd: 'camera', frame: 'face' },
      { cmd: 'slide', page: 7 },
      { cmd: 'queue', turns: [] },
    ]);
    // Folded into the setup, not logged as something that happened to a line.
    expect(hub.snapshot().events).toEqual([]);
  });

  it('is held while a line is on air, and released at the setup value when it ends', () => {
    const [running, next] = hub.queue.add([{ text: 'on air' }, { text: 'next' }]);
    hub.report({ events: [{ type: 'turn.start', turn: running.id }] });

    const frames = attach();
    expect(setup(frames)).toEqual([
      { cmd: 'pause', on: true },
      { cmd: 'queue', turns: [{ id: next.id, text: 'next' }] },
    ]);
    // An unpause meanwhile is not a release for it: it would start ahead.
    hub.send({ type: 'command', commands: [{ cmd: 'pause', on: false }] });
    expect(frames.at(-1)?.commands).toEqual([{ cmd: 'pause', on: true }]);

    hub.report({ events: [{ type: 'turn.end', turn: running.id }] });
    expect(frames.at(-1)?.commands).toEqual([{ cmd: 'pause', on: false }]);
  });

  it('is not held when nothing is on air', () => {
    hub.queue.add([{ text: 'next' }]);
    expect(setup(attach()).map((c) => c.cmd)).toEqual(['queue']);
  });
});

/**
 * What each command in a batch became, decided once by the hub.
 */
describe('command fates', () => {
  it('retains what the server keeps and loses only what nobody holds', () => {
    const { viewers, fates } = hub.command([
      { cmd: 'camera', frame: 'bust' },
      { cmd: 'say', text: 'あ' },
      { cmd: 'bgm', action: 'stop' },
      { cmd: 'gesture', id: 'wave' },
      { cmd: 'perform', id: 'hello' },
    ]);
    expect(viewers).toBe(0);
    expect(fates).toEqual(['retained', 'retained', 'retained', 'lost', 'lost']);
  });

  it('delivers everything when a viewer is attached', () => {
    hub.subscribe(() => {});
    const { fates } = hub.command([{ cmd: 'gesture', id: 'wave' }, { cmd: 'camera' }]);
    expect(fates).toEqual(['delivered', 'delivered']);
  });
});

/**
 * What the hub does with a turn that has ended, and with a rewind.
 *
 * The interesting case is the interaction between the two: a rewind that cuts
 * the line on air must leave the list it travelled with, however many renderers
 * answer the cut, while an interrupt a caller sends empties it on arrival.
 */
