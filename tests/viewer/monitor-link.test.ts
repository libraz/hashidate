import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MUTE_MESSAGE, onMonitorMute } from '@/viewer/monitor-link';

/**
 * The one thing a staged viewer accepts from the page that embedded it.
 *
 * Every other control in the panel goes through `/api`, deliberately. This is
 * the exception, so what it will and will not act on is worth pinning: a page
 * receives messages it never asked for, and this one is holding the audio of a
 * live broadcast.
 */

/**
 * A window that can be framed, or not.
 *
 * `onMonitorMute` attaches nothing at all when nobody framed the page — the
 * viewer OBS opens should not be carrying a listener that can never fire — so
 * the two cases need different globals.
 */
function stubWindow({ embedded }: { embedded: boolean }) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const win = {
    parent: {} as Window,
    location: { origin: 'http://127.0.0.1:8765' },
    addEventListener: (_type: string, fn: (event: MessageEvent) => void) => {
      listeners.add(fn);
    },
    removeEventListener: (_type: string, fn: (event: MessageEvent) => void) => {
      listeners.delete(fn);
    },
  };
  if (!embedded) win.parent = win as unknown as Window;

  vi.stubGlobal('window', win);
  vi.stubGlobal('location', win.location);
  vi.stubGlobal('addEventListener', win.addEventListener);
  vi.stubGlobal('removeEventListener', win.removeEventListener);

  return {
    get count() {
      return listeners.size;
    },
    /** Deliver one message, as the browser would. */
    deliver(data: unknown, origin = 'http://127.0.0.1:8765') {
      for (const fn of [...listeners]) fn({ data, origin } as MessageEvent);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('onMonitorMute, on a page nobody framed', () => {
  it('attaches no listener at all', () => {
    const bus = stubWindow({ embedded: false });
    const apply = vi.fn();
    const off = onMonitorMute(apply);
    // The viewer OBS opens is not a monitor and should carry nothing that only
    // a monitor uses.
    expect(bus.count).toBe(0);
    expect(() => off()).not.toThrow();
  });
});

describe('onMonitorMute, embedded', () => {
  let bus: ReturnType<typeof stubWindow>;
  let apply: ReturnType<typeof vi.fn<(muted: boolean) => void>>;
  let off: () => void;

  beforeEach(() => {
    bus = stubWindow({ embedded: true });
    apply = vi.fn<(muted: boolean) => void>();
    off = onMonitorMute(apply);
  });

  it('applies a mute from its own origin', () => {
    bus.deliver({ type: MUTE_MESSAGE, muted: true });
    expect(apply).toHaveBeenCalledWith(true);
    bus.deliver({ type: MUTE_MESSAGE, muted: false });
    expect(apply).toHaveBeenLastCalledWith(false);
  });

  it('ignores another origin', () => {
    // Nothing else can reach this page — the server binds loopback and sends no
    // CORS header — but the check is what makes that a property of the code
    // rather than of the deployment.
    bus.deliver({ type: MUTE_MESSAGE, muted: true }, 'https://example.com');
    bus.deliver({ type: MUTE_MESSAGE, muted: true }, 'http://127.0.0.1:5173');
    expect(apply).not.toHaveBeenCalled();
  });

  it('ignores anything that is not this message', () => {
    for (const data of [
      null,
      'aituber.mute',
      42,
      {},
      { type: 'aituber.mute' },
      { type: 'aituber.mute', muted: 'yes' },
      { type: 'something.else', muted: true },
      // React DevTools and Vite's HMR client both post objects at every frame.
      { source: 'react-devtools-bridge' },
    ]) {
      bus.deliver(data);
    }
    expect(apply).not.toHaveBeenCalled();
  });

  it('stops listening once unsubscribed', () => {
    off();
    bus.deliver({ type: MUTE_MESSAGE, muted: true });
    expect(apply).not.toHaveBeenCalled();
    expect(bus.count).toBe(0);
  });
});
