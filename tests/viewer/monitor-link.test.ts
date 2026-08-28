import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shot } from '@/engine/types';
import { onMonitorShot, SHOT_MESSAGE, sendMonitorShot } from '@/viewer/monitor-link';

/**
 * The one thing a staged viewer says to the page that embedded it, and what it
 * will accept coming back.
 *
 * Every other control in the panel goes through `/api`, deliberately. This is
 * the exception, so what it will and will not act on is worth pinning: a page
 * receives messages it never asked for, and what this one ends in is a `camera`
 * command sent to every renderer including the one on air.
 */

const shot = (over: Partial<Required<Shot>> = {}): Required<Shot> => ({
  frame: 'bust',
  yaw: 0.2,
  pitch: -0.1,
  zoom: 1.4,
  ...over,
});

/**
 * A window that can be framed, or not.
 *
 * `sendMonitorShot` says nothing at all when nobody framed the page — the
 * viewer OBS opens has no embedder to tell, and its camera cannot be dragged —
 * so the two cases need different globals.
 */
function stubWindow({ embedded }: { embedded: boolean }) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const posted: { data: unknown; origin: string }[] = [];
  const win = {
    parent: {
      postMessage: (data: unknown, origin: string) => {
        posted.push({ data, origin });
      },
    } as unknown as Window,
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
    posted,
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

describe('sendMonitorShot', () => {
  it('says nothing on a page nobody framed', () => {
    const bus = stubWindow({ embedded: false });
    sendMonitorShot(shot());
    // The viewer OBS opens has no embedder, and posting to itself would be a
    // renderer handing itself a message it also listens for.
    expect(bus.posted).toEqual([]);
  });

  it('tells the embedder where the camera ended up, to its own origin', () => {
    const bus = stubWindow({ embedded: true });
    sendMonitorShot(shot({ yaw: 0.5 }));
    expect(bus.posted).toEqual([
      {
        data: { type: SHOT_MESSAGE, shot: shot({ yaw: 0.5 }) },
        origin: 'http://127.0.0.1:8765',
      },
    ]);
  });
});

describe('onMonitorShot', () => {
  let bus: ReturnType<typeof stubWindow>;
  let apply: ReturnType<typeof vi.fn<(shot: Required<Shot>) => void>>;
  let off: () => void;

  beforeEach(() => {
    bus = stubWindow({ embedded: true });
    apply = vi.fn<(shot: Required<Shot>) => void>();
    off = onMonitorShot(apply);
  });

  it('applies a shot from its own origin', () => {
    bus.deliver({ type: SHOT_MESSAGE, shot: shot() });
    expect(apply).toHaveBeenCalledWith(shot());
  });

  it('ignores another origin', () => {
    // Nothing else can reach this page — the server binds loopback and sends no
    // CORS header — but the check is what makes that a property of the code
    // rather than of the deployment.
    bus.deliver({ type: SHOT_MESSAGE, shot: shot() }, 'https://example.com');
    bus.deliver({ type: SHOT_MESSAGE, shot: shot() }, 'http://127.0.0.1:5173');
    expect(apply).not.toHaveBeenCalled();
  });

  it('ignores anything that is not this message', () => {
    for (const data of [
      null,
      'hashidate.shot',
      42,
      {},
      { type: SHOT_MESSAGE },
      { type: SHOT_MESSAGE, shot: null },
      { type: SHOT_MESSAGE, shot: { frame: 'bust' } },
      { type: SHOT_MESSAGE, shot: { ...shot(), zoom: 'near' } },
      { type: 'something.else', shot: shot() },
      // React DevTools and Vite's HMR client both post objects at every frame.
      { source: 'react-devtools-bridge' },
    ]) {
      bus.deliver(data);
    }
    expect(apply).not.toHaveBeenCalled();
  });

  it('stops listening once unsubscribed', () => {
    off();
    bus.deliver({ type: SHOT_MESSAGE, shot: shot() });
    expect(apply).not.toHaveBeenCalled();
    expect(bus.count).toBe(0);
  });
});
