import { beforeEach, describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { Session } from '@/engine/session';
import type { Command } from '@/protocol';
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
  /** What the renderer is showing, so a redundant swap can answer false. */
  let standing = 'a';
  const renderer: RendererControls = {
    avatars: [
      { id: 'a', label: 'あ' },
      { id: 'b', label: 'い' },
    ],
    load: (id) => {
      if (!renderer.avatars.some((avatar) => avatar.id === id)) return false;
      if (id === standing) return false;
      standing = id;
      loads.push(id);
      return true;
    },
  };

  const client = new ControlClient(session, { renderer });
  return { client, session, renderer, loads };
}

/** A second session, standing in for the one a swap would build. */
function nextSession(): Session {
  const rig = buildRig({ arkit: false });
  return new Session(new Director(buildProfile(rig.root, rig.descriptor)));
}

let harness: ReturnType<typeof build>;

beforeEach(() => {
  harness = build();
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

  it('ignores a verb it has no case for rather than throwing', () => {
    // A newer caller talking to an older renderer should degrade, not crash the
    // stream. The cast is the point: this is a command from the future.
    expect(() => harness.client.apply({ cmd: 'teleport' } as unknown as Command)).not.toThrow();
  });
});

describe('an avatar swap', () => {
  it('asks the renderer to load rather than touching the session', () => {
    harness.client.apply({ cmd: 'avatar', id: 'b' });
    expect(harness.loads).toEqual(['b']);
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
