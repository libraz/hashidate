import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hub, STATE_STALE_SECONDS } from '@/server/hub';
import { EPOCH_MS, event, state, vocabulary } from './fixtures';

/**
 * Whether what the hub is holding is still true, and waiting until it is.
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

describe('state freshness', () => {
  it('keeps avatar-only heartbeat and state freshness independent', () => {
    hub.subscribe(() => {});
    hub.report({ avatar: { phase: 'failed', error: 'model missing' } });

    expect(hub.snapshot().avatar).toEqual({ phase: 'failed', error: 'model missing' });
    expect(hub.snapshot().connected).toBe(true);
    expect(hub.snapshot().state).toEqual({});

    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000 + 1);
    expect(hub.snapshot().connected).toBe(false);
    expect(hub.snapshot().avatar).toEqual({ phase: 'failed', error: 'model missing' });
    expect(hub.snapshot().state).toEqual({});

    hub.report({ state: state({ speaking: true }) });
    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000 + 1);
    hub.report({ avatar: { phase: 'failed', error: 'model reloaded unsuccessfully' } });

    expect(hub.snapshot().connected).toBe(true);
    expect(hub.snapshot().avatar).toEqual({
      phase: 'failed',
      error: 'model reloaded unsuccessfully',
    });
    expect(hub.snapshot().state).toEqual({});
  });

  it('reports connected while a viewer is attached and its report is recent', () => {
    hub.subscribe(() => {});
    hub.report({ state: state({ speaking: true }) });
    const snapshot = hub.snapshot();
    expect(snapshot.connected).toBe(true);
    expect(snapshot.state.speaking).toBe(true);
  });

  it('is not connected before anything has been reported, viewer or not', () => {
    hub.subscribe(() => {});
    const snapshot = hub.snapshot();
    expect(snapshot.connected).toBe(false);
    expect(snapshot.state).toEqual({});
    expect(snapshot.viewers).toBe(1);
  });

  it('is not connected with a fresh report but no viewer attached', () => {
    hub.report({ state: state() });
    expect(hub.snapshot().connected).toBe(false);
  });

  it('holds the state right up to the staleness cut-off', () => {
    hub.subscribe(() => {});
    hub.report({ state: state({ speaking: true }) });
    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000 - 1);
    const snapshot = hub.snapshot();
    expect(snapshot.connected).toBe(true);
    expect(snapshot.state.speaking).toBe(true);
  });

  it('withholds the state once the report goes stale, even with a viewer subscribed', () => {
    hub.subscribe(() => {});
    hub.report({ state: state({ speaking: true }) });

    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000);

    const snapshot = hub.snapshot();
    // A tab that was closed leaves its last state behind, and answering with it
    // would say the avatar is mid-sentence forever.
    expect(snapshot.connected).toBe(false);
    expect(snapshot.state).toEqual({});
    expect(snapshot.viewers).toBe(1);
  });

  it('becomes fresh again on the next report', () => {
    hub.subscribe(() => {});
    hub.report({ state: state() });
    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000 + 500);
    expect(hub.snapshot().connected).toBe(false);

    hub.report({ state: state({ queued: 2 }) });

    expect(hub.snapshot().connected).toBe(true);
    expect(hub.snapshot().state.queued).toBe(2);
  });

  it('refreshes heartbeat without making a stale state current', () => {
    hub.subscribe(() => {});
    hub.report({ state: state({ speaking: true }) });
    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000);
    hub.report({ events: [event('a')] });
    expect(hub.snapshot().connected).toBe(true);
    expect(hub.snapshot().state).toEqual({});
  });

  it('keeps serving the vocabulary and the event log while the state is stale', () => {
    hub.subscribe(() => {});
    hub.report({ state: state(), events: [event('a')], vocabulary: vocabulary() });
    vi.advanceTimersByTime(STATE_STALE_SECONDS * 1000 + 1000);

    const snapshot = hub.snapshot();
    expect(snapshot.state).toEqual({});
    expect(snapshot.vocabulary).toEqual(vocabulary());
    expect(snapshot.events).toHaveLength(1);
  });
});

describe('Hub.waitFor', () => {
  it('resolves immediately when the predicate already holds', async () => {
    hub.report({ events: [event('a')] });
    const result = await hub.waitFor((s) => s.seq >= 1, 5_000);
    expect(result.completed).toBe(true);
    expect(result.snapshot.seq).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves when a later report makes the predicate hold', async () => {
    const pending = hub.waitFor((s) => s.events.some((e) => e.type === 'turn.end'), 5_000);
    hub.report({ events: [event('a', 'turn.start')] });
    hub.report({ events: [event('a', 'turn.end')] });

    const result = await pending;
    expect(result.completed).toBe(true);
    expect(result.snapshot.events.map((e) => e.type)).toEqual(['turn.start', 'turn.end']);
  });

  it('clears its timeout once the predicate holds', async () => {
    const pending = hub.waitFor((s) => s.seq > 0, 5_000);
    expect(vi.getTimerCount()).toBe(1);
    hub.report({ events: [event('a')] });
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves rather than rejects on timeout, reporting that it timed out', async () => {
    const pending = hub.waitFor(() => false, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await pending;
    // False means the timeout expired, not that anything failed.
    expect(result.completed).toBe(false);
    expect(result.snapshot).toMatchObject({ connected: false, viewers: 0, seq: 0 });
  });

  it('carries the state as of the timeout, not as of the call', async () => {
    hub.subscribe(() => {});
    const pending = hub.waitFor((s) => s.state.speaking === false, 1_000);
    hub.report({ state: state({ speaking: true }) });
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await pending;
    expect(result.completed).toBe(false);
    expect(result.snapshot.state.speaking).toBe(true);
  });

  it('does not settle before its timeout while the predicate stays false', async () => {
    let settled = false;
    const pending = hub
      .waitFor(() => false, 1_000)
      .then((r) => {
        settled = true;
        return r;
      });
    hub.report({ events: [event('a')] });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it('settles every waiter whose predicate the same report satisfies', async () => {
    const first = hub.waitFor((s) => s.seq >= 1, 5_000);
    const second = hub.waitFor((s) => s.seq >= 1, 5_000);
    const third = hub.waitFor((s) => s.seq >= 5, 5_000);

    hub.report({ events: [event('a')] });

    expect((await first).completed).toBe(true);
    expect((await second).completed).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    hub.report({ events: [event('b'), event('c'), event('d'), event('e')] });
    expect((await third).completed).toBe(true);
  });

  it('lets a caller block on the turn it just queued', async () => {
    hub.subscribe(() => {});
    hub.report({ state: state({ speaking: true, turn: 'turn-1', busy: true }) });

    const pending = hub.waitFor(
      (s) => s.events.some((e) => e.type === 'turn.end' && e.turn === 'turn-1'),
      2_000,
    );
    hub.report({ state: state(), events: [event('turn-1')] });

    const result = await pending;
    expect(result.completed).toBe(true);
    expect(result.snapshot.state.busy).toBe(false);
  });
});
