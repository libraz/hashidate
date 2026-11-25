import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@/protocol';
import { ControlClient } from '@/viewer/control-client';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ControlClient.pushEvent', () => {
  it('sends at once instead of waiting for the reporting timer', async () => {
    vi.useFakeTimers();
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const client = new ControlClient(null);
    const event: SessionEvent = { type: 'touch.tap', part: 'arm', side: 'L', count: 1 };

    client.pushEvent(event);
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(send.mock.calls[0][1]?.body));
    expect(body.events).toEqual([event]);
  });

  it('keeps the event for the next report when delivery fails', async () => {
    const send = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValue({ ok: true } as Response);
    const client = new ControlClient(null);
    const event: SessionEvent = { type: 'touch.hold', part: 'head', count: 1 };

    client.pushEvent(event);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await (client as unknown as { report(): Promise<void> }).report();

    const body = JSON.parse(String(send.mock.calls[1][1]?.body));
    expect(body.events).toEqual([event]);
  });
});
