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
    expect(attach()).toEqual([
      { cmd: 'camera', frame: 'face' },
      { cmd: 'queue', turns: [] },
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
 * What the hub does with a turn that has ended, and with a rewind.
 *
 * The interesting case is the interaction between the two: a rewind that cuts
 * the line on air produces the same `turn.interrupted` the kill switch does, and
 * the hub has to tell them apart — one empties the pending list, the other must
 * leave the list the rewind had just filled.
 */
