import { beforeEach, describe, expect, it, vi } from 'vitest';

type ShotHandler = (event: unknown, payload: unknown) => void;

const electron = vi.hoisted(() => ({
  exposed: {} as Record<string, unknown>,
  handlers: new Map<string, ShotHandler>(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      electron.exposed[name] = api;
    },
  },
  ipcRenderer: {
    send: electron.send,
    on: (channel: string, handler: ShotHandler) => electron.handlers.set(channel, handler),
  },
}));

type Bridge = import('../../src/viewer/shell-bridge').MascotBridge;

async function load(): Promise<Bridge> {
  vi.resetModules();
  electron.handlers.clear();
  electron.send.mockClear();
  await import('../../src/mascot/preload');
  return electron.exposed.hashidateMascot as Bridge;
}

const emit = (payload: unknown) => electron.handlers.get('mascot:shot')?.({}, payload);

describe('mascot preload', () => {
  let bridge: Bridge;
  beforeEach(async () => {
    bridge = await load();
  });

  it('sends each call on its own channel', () => {
    bridge.setInteractive(true);
    bridge.moveBy(3, -4);
    bridge.scaleBy(1.25);
    bridge.turnTo({ yaw: 0.5, pitch: -0.1 });
    expect(electron.send.mock.calls).toEqual([
      ['mascot:set-interactive', true],
      ['mascot:move-by', 3, -4],
      ['mascot:scale-by', 1.25],
      ['mascot:turn-to', 0.5, -0.1],
    ]);
  });

  it('has no step-scale call', () => {
    expect('stepScale' in bridge).toBe(false);
  });

  it('passes shots to listeners and stops after unsubscribe', () => {
    const fn = vi.fn();
    const off = bridge.onShot(fn);
    emit({ yaw: 1, pitch: 2 });
    off();
    emit({ yaw: 3, pitch: 4 });
    expect(fn.mock.calls).toEqual([[{ yaw: 1, pitch: 2 }]]);
  });

  it('replays the latest shot to a late subscriber', () => {
    const early = vi.fn();
    bridge.onShot(early);
    emit({ yaw: 1, pitch: 2 });
    emit({ yaw: 5, pitch: 6 });
    const late = vi.fn();
    bridge.onShot(late);
    expect(late.mock.calls).toEqual([[{ yaw: 5, pitch: 6 }]]);
  });

  it('gives nothing to a subscriber before any shot', () => {
    const fn = vi.fn();
    bridge.onShot(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    null,
    undefined,
    7,
    {},
    { yaw: 1 },
    { yaw: '1', pitch: 2 },
    { yaw: Number.NaN, pitch: 0 },
    { yaw: 0, pitch: Number.POSITIVE_INFINITY },
  ])('drops a malformed shot %j and keeps the last good one', (bad) => {
    const fn = vi.fn();
    bridge.onShot(fn);
    emit({ yaw: 1, pitch: 2 });
    emit(bad);
    expect(fn.mock.calls).toEqual([[{ yaw: 1, pitch: 2 }]]);
    const late = vi.fn();
    bridge.onShot(late);
    expect(late.mock.calls).toEqual([[{ yaw: 1, pitch: 2 }]]);
  });
});
