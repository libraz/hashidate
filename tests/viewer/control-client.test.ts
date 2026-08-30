import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { Session } from '@/engine/session';
import { same } from '@/i18n/locale';
import type { BgmCommand, BgmReport, Command, SessionEvent } from '@/protocol';
import { ControlClient, type RendererControls } from '@/viewer/control-client';
import { buildRig } from '../helpers/scene';

/**
 * Commands landing on a session, with the one command that replaces the session.
 *
 * Nothing here touches the network: `apply` is the translation between the wire
 * format and `Session` method calls, and that translation is the whole contract.
 * The interesting part is `avatar`, which is the only verb that cannot be one
 * session call — it swaps the scene the session is built over, and a model takes
 * a second or two to arrive. What happens to the commands sent during that
 * second is the difference between "swap and dress in one breath" working and
 * silently dressing the character being replaced.
 */

function build() {
  const rig = buildRig({ arkit: false });
  const profile = buildProfile(rig.root, rig.descriptor);
  const session = new Session(new Director(profile));

  const loads: string[] = [];
  /** Every readout switch that reached the page, in order. */
  const readout: boolean[] = [];
  /** Every recording instruction that reached the page, in order. */
  const takes: Array<{ on: boolean; session: string }> = [];
  /** What the renderer is showing, so a redundant swap can answer false. */
  let standing = 'a';
  const bgm: BgmCommand[] = [];
  const bgmState: BgmReport = {
    revision: 0,
    track: null,
    transport: 'stopped',
    position: 0,
    duration: null,
    muted: false,
    blocked: false,
    error: null,
    dspDegraded: false,
  };
  const renderer: RendererControls = {
    avatars: [
      { id: 'a', label: same('あ') },
      { id: 'b', label: same('い') },
    ],
    setDebug: (on) => {
      readout.push(on);
    },
    setRecording: (on, take) => {
      takes.push({ on, session: take.session });
    },
    setBgm: (command) => {
      bgm.push(command);
    },
    bgmReport: () => bgmState,
    load: (id) => {
      if (!renderer.avatars.some((avatar) => avatar.id === id)) return false;
      if (id === standing) return false;
      standing = id;
      loads.push(id);
      return true;
    },
  };

  const client = new ControlClient(session, { renderer });
  return { client, session, renderer, loads, readout, takes, bgm, bgmState };
}

/**
 * Inject an event as the engine would have raised it.
 *
 * `_events` is private because callers should reach the session through its
 * public actions; these tests only need the event a BGM cue produces, without
 * the turn around it.
 */
function inject(session: Session, event: SessionEvent): void {
  (
    session as unknown as {
      _events: { emit(type: SessionEvent['type'], extra: Omit<SessionEvent, 'type'>): void };
    }
  )._events.emit(event.type, event);
}

/** A second session, standing in for the one a swap would build. */
function nextSession(): Session {
  const rig = buildRig({ arkit: false });
  return new Session(new Director(buildProfile(rig.root, rig.descriptor)));
}

let harness: ReturnType<typeof build>;

/** A deterministic EventSource with manual lifecycle signals. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closeCalls++;
  }

  open(): void {
    this.onopen?.();
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }

  error(): void {
    this.onerror?.();
  }
}

beforeEach(() => {
  harness = build();
});

afterEach(() => {
  FakeEventSource.instances = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ControlClient.apply', () => {
  it('turns a say into a queued turn', () => {
    harness.client.apply({ cmd: 'say', id: 'turn-1', text: 'あ' });
    expect(harness.session.queue.map((turn) => turn.id)).toEqual(['turn-1']);
  });

  it('turns a tune into a moved fader', () => {
    harness.client.apply({ cmd: 'tune', idle: { breathDepth: 1.9 } });
    expect(harness.session.tuning().idle.breathDepth).toBe(1.9);
  });

  it('turns a pause into a held queue, without touching the line on air', () => {
    harness.client.apply({ cmd: 'say', id: 'turn-1', text: 'あ' });
    harness.client.apply({ cmd: 'pause', on: true });
    expect(harness.session.paused).toBe(true);
    expect(harness.session.queue.map((turn) => turn.id)).toEqual(['turn-1']);
    harness.client.apply({ cmd: 'pause', on: false });
    expect(harness.session.paused).toBe(false);
  });

  it('reads a pause with no argument as a hold, as the schema states', () => {
    harness.client.apply({ cmd: 'pause' });
    expect(harness.session.paused).toBe(true);
  });

  it('hands a record straight to the page, since it reaches nothing in the scene', () => {
    harness.client.apply({
      cmd: 'record',
      on: true,
      session: 'r1',
      width: 1280,
      height: 720,
      fps: 60,
    });
    harness.client.apply({ cmd: 'record', on: false, session: 'r1' });
    expect(harness.takes).toEqual([
      { on: true, session: 'r1' },
      { on: false, session: 'r1' },
    ]);
  });

  it('hands BGM to the page before an avatar-load hold', () => {
    harness.client.apply({ cmd: 'avatar', id: 'b' });
    harness.client.apply({
      cmd: 'bgm',
      id: 'bgm-1',
      revision: 1,
      track: 'one.mp3',
      action: 'play',
    });
    harness.client.apply({ cmd: 'say', id: 'held', text: 'あ' });
    expect(harness.bgm.map(({ id }) => id)).toEqual(['bgm-1']);
    expect(harness.session.queue).toHaveLength(0);
  });

  it('includes the page BGM report in the heartbeat', async () => {
    let body: string | undefined;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      body = String(init?.body);
      return { ok: true } as Response;
    });
    try {
      await (harness.client as unknown as { report(): Promise<void> }).report();
      expect(JSON.parse(body ?? '{}').bgm).toEqual(harness.bgmState);
    } finally {
      fetch.mockRestore();
    }
  });

  it('reports an inline BGM cue immediately rather than waiting for the heartbeat', async () => {
    const bodies: Array<{ events?: SessionEvent[] }> = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { events?: SessionEvent[] });
      return { ok: true } as Response;
    });
    try {
      inject(harness.session, {
        type: 'cue.fire',
        turn: 'turn-1',
        cueId: 'turn-1:cue:0',
        cue: { kind: 'bgm', action: 'play', track: 'song.mp3' },
      });

      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0].events).toMatchObject([
        {
          type: 'cue.fire',
          turn: 'turn-1',
          cueId: 'turn-1:cue:0',
        },
      ]);
    } finally {
      fetch.mockRestore();
    }
  });

  it('retries an inline BGM cue after a report fails', async () => {
    const bodies: Array<{ events?: SessionEvent[] }> = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { events?: SessionEvent[] });
      if (bodies.length === 1) throw new Error('offline');
      return { ok: true } as Response;
    });
    try {
      inject(harness.session, {
        type: 'cue.fire',
        turn: 'turn-1',
        cueId: 'turn-1:cue:0',
        cue: { kind: 'bgm', action: 'play', track: 'song.mp3' },
      });

      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      await (harness.client as unknown as { report(): Promise<void> }).report();
      expect(bodies).toHaveLength(2);
      expect(bodies[1].events).toMatchObject([
        {
          type: 'cue.fire',
          turn: 'turn-1',
          cueId: 'turn-1:cue:0',
        },
      ]);
    } finally {
      fetch.mockRestore();
    }
  });

  it('ignores a verb it has no case for rather than throwing', () => {
    // A newer caller talking to an older renderer should degrade, not crash the
    // stream. The cast is the point: this is a command from the future.
    expect(() => harness.client.apply({ cmd: 'teleport' } as unknown as Command)).not.toThrow();
  });
});

/**
 * A session with the two ports a renderer that composes a frame supplies.
 *
 * Both are absent everywhere else in this suite, which is the ordinary case: a
 * renderer with no document layer answers `deck`, `slide` and `place` by doing
 * nothing at all. Here they record, because what is worth pinning is that each
 * of the three verbs is exactly one call — the moment one of them needs two,
 * the session is missing something.
 */
function composed() {
  const calls: string[] = [];
  const rig = buildRig({ arkit: false });
  const session = new Session(new Director(buildProfile(rig.root, rig.descriptor)), {
    slides: {
      setDeck: (id, page) => calls.push(`deck ${id} ${page}`),
      setSlide: (page) => calls.push(`slide ${page}`),
      turnSlide: (by) => calls.push(`turn ${by}`),
      report: () => ({ deck: null, page: 0, pages: 0, ready: true, error: null }),
    },
    composition: {
      setPlacement: (placement) => calls.push(JSON.stringify(placement)),
      report: () => ({
        avatar: { anchor: 'center', width: 1, height: 1, margin: 0 },
        slide: { anchor: 'center', width: 1, height: 1, margin: 0, fit: 'contain' },
      }),
    },
  });
  return { client: new ControlClient(session), calls };
}

describe('the document behind the character', () => {
  it('puts one up by id, and takes it down with no id at all', () => {
    const { client, calls } = composed();
    client.apply({ cmd: 'deck', id: 'intro', page: 3 });
    client.apply({ cmd: 'deck' });
    // Absent is the first page rather than the page the last document was on.
    expect(calls).toEqual(['deck intro 3', 'deck null undefined']);
  });

  it('turns to an absolute page, and moves by one when told neither', () => {
    const { client, calls } = composed();
    client.apply({ cmd: 'slide', page: 4 });
    client.apply({ cmd: 'slide', by: -2 });
    // The bare command is "next", which is the one an operator sends all
    // broadcast and the one a hotkey should not have to spell out.
    client.apply({ cmd: 'slide' });
    expect(calls).toEqual(['slide 4', 'turn -2', 'turn 1']);
  });

  it('prefers the page a script knows to the move an operator makes', () => {
    const { client, calls } = composed();
    client.apply({ cmd: 'slide', page: 2, by: 5 });
    expect(calls).toEqual(['slide 2']);
  });

  it('lays out both layers in one call, because they are one decision', () => {
    // Sent as two, the frame is briefly wrong in the way that shows most: the
    // character over the document.
    const { client, calls } = composed();
    client.apply({ cmd: 'place', avatar: { anchor: 'bottom-right', width: 0.32 } });
    expect(calls).toEqual([
      JSON.stringify({ avatar: { anchor: 'bottom-right', width: 0.32 }, slide: undefined }),
    ]);
  });

  it('does nothing on a renderer with no document layer, which is every test', () => {
    expect(() => {
      harness.client.apply({ cmd: 'deck', id: 'intro' });
      harness.client.apply({ cmd: 'slide' });
      harness.client.apply({ cmd: 'place', slide: { fit: 'cover' } });
    }).not.toThrow();
  });
});

describe('an avatar swap', () => {
  it('asks the renderer to load rather than touching the session', () => {
    harness.client.apply({ cmd: 'avatar', id: 'b' });
    expect(harness.loads).toEqual(['b']);
  });

  it('does not hold a record behind it, since the load is part of what is being recorded', () => {
    harness.client.apply({ cmd: 'avatar', id: 'b' });
    harness.client.apply({ cmd: 'record', on: true, session: 'r1' });
    expect(harness.takes).toEqual([{ on: true, session: 'r1' }]);
  });

  it('holds what arrives behind it until the new session is bound', () => {
    harness.client.apply({ cmd: 'avatar', id: 'b' });
    harness.client.apply({ cmd: 'say', id: 'turn-1', text: 'あ' });
    // Applied now, this line would be spoken by the character being replaced.
    expect(harness.session.queue).toHaveLength(0);

    const arrived = nextSession();
    harness.client.bind(arrived, 'b');
    expect(arrived.queue.map((turn) => turn.id)).toEqual(['turn-1']);
  });

  it('applies the held commands in the order they arrived', () => {
    harness.client.apply({ cmd: 'avatar', id: 'b' });
    harness.client.apply({ cmd: 'say', id: 'first', text: 'あ' });
    harness.client.apply({ cmd: 'say', id: 'second', text: 'い' });
    const arrived = nextSession();
    harness.client.bind(arrived, 'b');
    expect(arrived.queue.map((turn) => turn.id)).toEqual(['first', 'second']);
  });

  it('keeps holding through a session for some other avatar', () => {
    // A swap asked for while another model was still loading lands second. The
    // first one to arrive is not the one these commands were meant for, and
    // flushing onto it would dress a character about to be replaced.
    harness.client.apply({ cmd: 'avatar', id: 'b' });
    harness.client.apply({ cmd: 'say', id: 'turn-1', text: 'あ' });

    const intermediate = nextSession();
    harness.client.bind(intermediate, 'a');
    expect(intermediate.queue).toHaveLength(0);

    const arrived = nextSession();
    harness.client.bind(arrived, 'b');
    expect(arrived.queue.map((turn) => turn.id)).toEqual(['turn-1']);
  });

  it('does not hold for the avatar already on screen', () => {
    // The ordinary case, not the odd one: the setup a viewer is handed the
    // moment it connects names the avatar it is usually already showing, and a
    // hold nothing can end would take the renderer off the air for good.
    harness.client.apply({ cmd: 'avatar', id: 'a' });
    expect(harness.loads).toEqual([]);
    harness.client.apply({ cmd: 'say', id: 'turn-1', text: 'あ' });
    expect(harness.session.queue).toHaveLength(1);
  });

  it('does not hold for an avatar this renderer does not have', () => {
    // Nothing is going to arrive, so holding would mute the renderer forever.
    harness.client.apply({ cmd: 'avatar', id: 'nosuchavatar' });
    expect(harness.loads).toEqual([]);
    harness.client.apply({ cmd: 'say', id: 'turn-1', text: 'あ' });
    expect(harness.session.queue).toHaveLength(1);
  });

  it('carries a hold onto the new session, since it belongs to the run of turns', () => {
    // A swap builds a whole new session and a fresh one starts moving. Without
    // this, a segment loaded and held for framing plays itself out the moment
    // somebody changes avatar — and the queue survives the swap, so there would
    // be a full run of lines for it to play.
    harness.client.apply({ cmd: 'pause', on: true });
    harness.client.apply({ cmd: 'avatar', id: 'b' });
    const next = nextSession();
    harness.client.bind(next, 'b');
    expect(next.paused).toBe(true);
  });

  it('does not invent a hold for a swap made while the queue was moving', () => {
    harness.client.apply({ cmd: 'avatar', id: 'b' });
    const next = nextSession();
    harness.client.bind(next, 'b');
    expect(next.paused).toBe(false);
  });

  it('holds a second swap behind the first rather than racing it', () => {
    harness.client.apply({ cmd: 'avatar', id: 'b' });
    harness.client.apply({ cmd: 'avatar', id: 'a' });
    expect(harness.loads).toEqual(['b']);
    harness.client.bind(nextSession(), 'b');
    expect(harness.loads).toEqual(['b', 'a']);
  });

  it('lets go of the held commands when the load produced nothing', () => {
    harness.client.apply({ cmd: 'avatar', id: 'b' });
    harness.client.apply({ cmd: 'say', id: 'lost', text: 'あ' });
    harness.client.discardHeld();
    // The line is gone with the swap that failed, and the channel is live again.
    harness.client.apply({ cmd: 'say', id: 'after', text: 'い' });
    expect(harness.session.queue.map((turn) => turn.id)).toEqual(['after']);
  });

  it('binds normally when nothing was held', () => {
    const arrived = nextSession();
    harness.client.bind(arrived);
    harness.client.apply({ cmd: 'say', id: 'turn-1', text: 'あ' });
    expect(arrived.queue).toHaveLength(1);
  });

  it('does nothing at all on a renderer that cannot switch avatars', () => {
    // Every test, and any embedding that loads one avatar and stays on it.
    const rig = buildRig({ arkit: false });
    const session = new Session(new Director(buildProfile(rig.root, rig.descriptor)));
    const client = new ControlClient(session);
    client.apply({ cmd: 'avatar', id: 'b' });
    client.apply({ cmd: 'say', id: 'turn-1', text: 'あ' });
    expect(session.queue).toHaveLength(1);
  });
});

describe('the telemetry readout', () => {
  it('reaches the page rather than the session, and defaults to on', () => {
    harness.client.apply({ cmd: 'debug', on: true });
    harness.client.apply({ cmd: 'debug', on: false });
    harness.client.apply({ cmd: 'debug' });
    expect(harness.readout).toEqual([true, false, true]);
  });

  it('is not held behind an avatar swap', () => {
    // The one command that goes ahead of the hold. It touches nothing a swap
    // replaces, and an operator raising the readout to watch a slow load would
    // otherwise be given it once the load had finished.
    harness.client.apply({ cmd: 'avatar', id: 'b' });
    harness.client.apply({ cmd: 'debug', on: true });
    expect(harness.readout).toEqual([true]);
  });

  it('is dropped on a renderer with no readout to draw', () => {
    const rig = buildRig({ arkit: false });
    const session = new Session(new Director(buildProfile(rig.root, rig.descriptor)));
    const client = new ControlClient(session);
    expect(() => client.apply({ cmd: 'debug', on: true })).not.toThrow();
  });
});

describe('the control stream lifecycle', () => {
  it('starts before a session exists and reports the avatar load state', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false } as Response);
    const client = new ControlClient(null, {
      base: '/control',
      rendererId: 'renderer-test',
    });
    client.setAvatarStatus({ phase: 'loading', error: 'x'.repeat(5000) });

    client.start();
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe('/control/stream?renderer=renderer-test');
    source.open();

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(send.mock.calls[1][1]?.body)) as {
      avatar?: { phase?: string; error?: string };
    };
    expect(body.avatar).toEqual({ phase: 'loading', error: 'x'.repeat(1024) });
    client.stop();
  });

  it('applies known stream commands and surfaces rejected elements individually', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const rejected: unknown[] = [];
    const client = new ControlClient(harness.session, {
      onRejected: (raw) => rejected.push(raw),
    });
    client.start();
    const source = FakeEventSource.instances[0];
    const raw = { cmd: 'future-command', value: 1 };
    source.message({
      type: 'command',
      commands: [{ cmd: 'say', id: 'stream-turn', text: 'あ' }, raw],
    });

    expect(harness.session.queue.map((turn) => turn.id)).toEqual(['stream-turn']);
    expect(rejected).toEqual([raw]);
    client.stop();
  });

  it('keeps an all-unknown frame a healthy no-op for the next frame', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const rejected: unknown[] = [];
    const client = new ControlClient(harness.session, {
      onRejected: (raw) => rejected.push(raw),
    });
    client.start();
    const source = FakeEventSource.instances[0];
    const raw = { cmd: 'future-only' };
    source.message({ type: 'command', commands: [raw] });
    expect(harness.session.queue).toHaveLength(0);
    source.message({
      type: 'command',
      commands: [{ cmd: 'say', id: 'after-unknown', text: 'い' }],
    });

    expect(harness.session.queue.map((turn) => turn.id)).toEqual(['after-unknown']);
    expect(rejected).toEqual([raw]);
    client.stop();
  });

  it('does not let an old EventSource error close its replacement', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    const client = new ControlClient(null, { rendererId: 'renderer-test' });
    client.start();
    const first = FakeEventSource.instances[0];
    first.error();
    expect(first.closeCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1500);
    const second = FakeEventSource.instances[1];
    expect(second).toBeDefined();

    // The old browser object may report its terminal error after the retry has
    // already installed a replacement. It may close only itself and must not
    // clear the replacement or schedule a third source.
    first.error();
    expect(first.closeCalls).toBe(2);
    expect(second.closeCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(FakeEventSource.instances).toHaveLength(2);

    client.stop();
  });

  it('does not create another source while connected or after stop', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const client = new ControlClient(null, { rendererId: 'renderer-test' });
    client.start();
    const connect = (client as unknown as { connect(): void }).connect.bind(client);
    connect();
    expect(FakeEventSource.instances).toHaveLength(1);

    client.stop();
    connect();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('bounds commands received before the first session is ready', () => {
    const client = new ControlClient(null);
    for (let i = 0; i < 205; i++) {
      client.apply({ cmd: 'say', id: `held-${i}`, text: 'あ' });
    }

    const arrived = nextSession();
    client.bind(arrived, 'a');
    expect(arrived.queue.map((turn) => turn.id)).toEqual(
      Array.from({ length: 200 }, (_, i) => `held-${i + 5}`),
    );
  });
});
