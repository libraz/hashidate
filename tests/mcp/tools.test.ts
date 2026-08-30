import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlError } from '@/control/client';
import { same } from '@/i18n/locale';
import { commandRequestSchema } from '@/protocol';
import {
  closeAll,
  connect,
  entry,
  enumOf,
  type Harness,
  harness,
  historyEntry,
  payloadOf,
  propertyNode,
  snapshot,
  vocabulary,
} from './harness';

/**
 * The two tools that move the avatar without saying anything, the one that edits
 * what is already queued, and the history behind it.
 *
 * `react` and `stage` are the same batch endpoint split by *lifetime* rather
 * than by body part: a face lasts a beat, a backdrop lasts the broadcast. Both
 * take whatever fields were given and send them in one round trip, in an order
 * this layer fixes — a caller writing JSON has no way to express "reset first",
 * and a reset arriving after the emotion it was meant to precede undoes it.
 *
 * `revise` is the only tool that can take a line back. It is also the only place
 * a failure is both an error and an answer: an edit naming an entry that has
 * already been spoken has to come back with the queue as it now stands, or the
 * model's next guess is made from the same stale list.
 *
 * Two commands are deliberately unreachable from here. `voice` and `tune` are
 * the DSP chain and the idle layer — set by ear against a render, by an operator
 * watching one, and there is no readout a model could use to know it had made
 * either worse.
 */

// --- reading the wire --------------------------------------------------------

type Sent = Record<string, unknown>;

/** The commands one call to the control API carried. */
const commandsOf = (call: unknown): Sent[] => {
  const body = call as { batch?: unknown };
  return Array.isArray(body.batch) ? (body.batch as Sent[]) : [call as Sent];
};

const namesOf = (call: unknown): string[] => commandsOf(call).map((sent) => String(sent.cmd));

/** The single command a call carried, and a failure naming the rest when it carried more. */
const only = (call: unknown): Sent => {
  const sent = commandsOf(call);
  expect(sent.map((one) => one.cmd)).toHaveLength(1);
  return sent[0];
};

/**
 * Whether the control server would read the body back.
 *
 * The one check worth making on every command this layer builds. `/api/command`
 * drops what it cannot parse and says nothing — deliberately, so that a newer
 * caller degrades against an older renderer rather than killing the stream — and
 * a model on the other end has no way to notice that its gesture never happened.
 */
const survives = (call: unknown): boolean => commandRequestSchema.safeParse(call).success;

/** The body of a resource read. Text is the only form this adapter serves. */
const resourceText = (contents: { uri: string; text?: string }[]): string => {
  const [first] = contents;
  if (typeof first?.text !== 'string') throw new Error('the resource came back without text');
  return first.text;
};

const schemaOf = async (client: Client, name: string): Promise<unknown> => {
  const { tools } = await client.listTools();
  const tool = tools.find((one) => one.name === name);
  if (!tool) throw new Error(`no ${name} tool among ${tools.map((one) => one.name).join(', ')}`);
  return tool.inputSchema;
};

/** Whether a field is offered at all, for the ones that deliberately are not. */
const offers = (schema: unknown, name: string): boolean => {
  try {
    propertyNode(schema, name);
    return true;
  } catch {
    return false;
  }
};

let h: Harness;

afterEach(async () => {
  await closeAll();
});

describe('the tool surface once everything is on it', () => {
  it('bundles twenty-one commands into eight tools', async () => {
    h = harness();
    const client = await connect(h.control);

    const { tools } = await client.listTools();

    // Eight: BGM is an independent surface because its live roster and
    // transport have no avatar vocabulary to share with the other tools.
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'bgm',
      'deck',
      'interrupt',
      'react',
      'revise',
      'speak',
      'stage',
      'status',
    ]);
  });

  it('offers no way to touch the voice chain or the tuning layer', async () => {
    h = harness();
    const client = await connect(h.control);

    const { tools } = await client.listTools();

    // Both are set by ear against a render. A model can neither hear the result
    // nor read one, so every value it sent would be a guess it could not check.
    expect(tools.map((tool) => tool.name)).not.toContain('voice');
    expect(tools.map((tool) => tool.name)).not.toContain('tune');
    for (const tool of tools.filter((one) => one.name !== 'bgm')) {
      expect(offers(tool.inputSchema, 'dsp')).toBe(false);
      expect(offers(tool.inputSchema, 'sway')).toBe(false);
    }
    const bgm = tools.find((tool) => tool.name === 'bgm');
    expect(bgm).toBeDefined();
    expect(offers(bgm?.inputSchema, 'dsp')).toBe(true);
  });
});

describe('react', () => {
  it('sends what it was given as one batch', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({
      name: 'react',
      arguments: { perform: 'hello', emotion: { joy: 0.8 } },
    });

    // One round trip, and the parts land together: a face and the mood under it
    // arriving in two requests is two frames apart on screen.
    expect(h.control.command).toHaveBeenCalledTimes(1);
    const [body, wait] = h.control.command.mock.calls[0];
    expect(body).toHaveProperty('batch');
    expect(namesOf(body)).toEqual(['emotion', 'perform']);
    // Never blocking, like `interrupt`: a tool call that waited would hit the
    // client's own timeout while the thing it asked for was happening.
    expect(wait).toBeUndefined();
  });

  it('orders the batch itself rather than taking the order it was written in', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({
      name: 'react',
      arguments: {
        look: 0.4,
        point: { azimuth: -35, elevation: 12 },
        hop: 'double',
        gesture: 'wave',
        expression: 'F_DOYA',
        perform: 'hello',
        emotion: { joy: 0.8 },
        reset: true,
      },
    });

    // Written in the reverse of the order they have to be applied in, because
    // JSON has no order to promise and a model will write them in any of them.
    // The one that has to lead is `reset`, which otherwise wipes the rest.
    expect(namesOf(h.control.command.mock.calls[0][0])).toEqual([
      'reset',
      'emotion',
      'perform',
      'expression',
      'gesture',
      'hop',
      'point',
      'look',
    ]);
  });

  it('builds commands the control server can read back', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({
      name: 'react',
      arguments: {
        reset: true,
        emotion: { joy: 0.8 },
        perform: 'hello',
        expression: 'F_DOYA',
        gesture: 'wave',
        overlay: { id: 'blush', weight: 0.5 },
        hop: 'double',
        point: { azimuth: 20, elevation: 5 },
        look: 1,
      },
    });

    // Anything this layer got wrong is dropped in silence at the other end, so
    // the whole body is put back through the schema that would drop it.
    expect(survives(h.control.command.mock.calls[0][0])).toBe(true);
  });

  it('releases a gesture without saying null', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({ name: 'react', arguments: { gesture: null } });

    const sent = only(h.control.command.mock.calls[0][0]);
    // `gestureCommandSchema` has no null in it: absence is the release. A null
    // sent here fails the whole batch, and a failed batch is dropped unmentioned.
    expect(sent.cmd).toBe('gesture');
    expect(sent.id).toBeUndefined();
    expect(survives(h.control.command.mock.calls[0][0])).toBe(true);
  });

  it('releases a performance and an expression by naming null', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({ name: 'react', arguments: { perform: null, expression: null } });

    const sent = commandsOf(h.control.command.mock.calls[0][0]);
    // These two do take a null, and it means something a missing key does not:
    // the face goes back to whatever the emotion vector was saying.
    expect(sent).toEqual([
      { cmd: 'perform', id: null },
      { cmd: 'expression', id: null },
    ]);
  });

  it('sends the pointing angles in degrees, as the wire states them', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({
      name: 'react',
      arguments: {
        point: { azimuth: -35, elevation: 12, extent: 0.8, side: 'R', finger: 'index' },
      },
    });

    // Degrees on the wire and radians in the engine, converted at the boundary
    // that applies the command. A layer converting early aims at 35 radians.
    expect(only(h.control.command.mock.calls[0][0])).toMatchObject({
      cmd: 'point',
      azimuth: -35,
      elevation: 12,
      extent: 0.8,
      side: 'R',
      finger: 'index',
    });
  });

  it('takes the arm down when point is null', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({ name: 'react', arguments: { point: null } });

    const sent = only(h.control.command.mock.calls[0][0]);
    // A `point` with no bearing is the release, on the same rule as `gesture`.
    expect(sent.cmd).toBe('point');
    expect(sent.azimuth).toBeUndefined();
    expect(sent.elevation).toBeUndefined();
  });

  it('raises an overlay part of the way and takes one back down', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({
      name: 'react',
      arguments: { overlay: { id: 'blush', weight: 0.4 } },
    });
    await client.callTool({ name: 'react', arguments: { overlay: { id: 'tears', on: false } } });

    expect(only(h.control.command.mock.calls[0][0])).toMatchObject({
      cmd: 'overlay',
      id: 'blush',
      weight: 0.4,
    });
    expect(only(h.control.command.mock.calls[1][0])).toMatchObject({
      cmd: 'overlay',
      id: 'tears',
      on: false,
    });
  });

  it('answers with what it sent', async () => {
    h = harness();
    const client = await connect(h.control);

    const payload = payloadOf(
      await client.callTool({ name: 'react', arguments: { emotion: { joy: 0.8 }, look: 1 } }),
    );

    // The list is the point of the reply: it is the only way a caller can tell
    // which of the fields it wrote were understood as commands.
    expect(payload).toMatchObject({ ok: true, viewers: 2 });
    expect(payload.sent).toEqual(['emotion', 'look']);
  });

  it('refuses a call that asks for nothing', async () => {
    h = harness();
    const client = await connect(h.control);

    const result = await client.callTool({ name: 'react', arguments: {} });

    // An empty batch would be answered `ok` and change nothing, which is the
    // silent success this layer exists to stop being possible.
    expect(result.isError).toBe(true);
    expect(h.control.command).not.toHaveBeenCalled();
  });
});

describe('stage', () => {
  it('maps each standing field onto its command, in its own order', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({
      name: 'stage',
      arguments: {
        idle: false,
        wear: { slot: 'top', item: 'coat' },
        room: 'hall',
        backdrop: 'night',
        camera: 'bust',
        avatar: 'synthetic',
      },
    });

    expect(h.control.command).toHaveBeenCalledTimes(1);
    const body = h.control.command.mock.calls[0][0];
    // The avatar leads because it replaces the thing the rest are talking to:
    // a swap builds a new scene, and what follows is applied to the new one.
    expect(namesOf(body)).toEqual(['avatar', 'camera', 'backdrop', 'room', 'wear', 'idle']);
    expect(commandsOf(body)).toEqual([
      { cmd: 'avatar', id: 'synthetic' },
      { cmd: 'camera', frame: 'bust' },
      { cmd: 'backdrop', id: 'night' },
      { cmd: 'room', id: 'hall' },
      { cmd: 'wear', slot: 'top', item: 'coat' },
      { cmd: 'idle', on: false },
    ]);
    expect(survives(body)).toBe(true);
  });

  it('dresses one slot or the whole outfit at once', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({ name: 'stage', arguments: { wear: { preset: 'casual' } } });
    await client.callTool({ name: 'stage', arguments: { wear: { slot: 'top', item: null } } });

    // Two shapes of the same command: a whole outfit by name, and one garment
    // taken off — `item: null` is the undress, which is why it is not a string.
    expect(only(h.control.command.mock.calls[0][0])).toEqual({ cmd: 'wear', preset: 'casual' });
    expect(only(h.control.command.mock.calls[1][0])).toEqual({
      cmd: 'wear',
      slot: 'top',
      item: null,
    });
  });

  it('takes the backdrop and the room away when told null', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({ name: 'stage', arguments: { backdrop: null, room: null } });

    // Absent and null are different everywhere on this wire: no key leaves the
    // room alone, null takes the character out of one.
    expect(commandsOf(h.control.command.mock.calls[0][0])).toEqual([
      { cmd: 'backdrop', id: null },
      { cmd: 'room', id: null },
    ]);
  });

  it('answers with what it sent', async () => {
    h = harness();
    const client = await connect(h.control);

    const payload = payloadOf(
      await client.callTool({ name: 'stage', arguments: { camera: 'face', idle: true } }),
    );

    expect(payload).toMatchObject({ ok: true, viewers: 2 });
    expect(payload.sent).toEqual(['camera', 'idle']);
  });

  it('refuses a call that asks for nothing', async () => {
    h = harness();
    const client = await connect(h.control);

    const result = await client.callTool({ name: 'stage', arguments: {} });

    expect(result.isError).toBe(true);
    expect(h.control.command).not.toHaveBeenCalled();
  });

  it('has no field for the voice chain, so asking for one changes nothing', async () => {
    h = harness();
    const client = await connect(h.control);

    const schema = await schemaOf(client, 'stage');
    const result = await client.callTool({ name: 'stage', arguments: { voice: 'plain' } });

    // Not merely undocumented: a field stripped by the parse would leave the
    // call empty, and an empty call is refused rather than answered `ok`.
    expect(offers(schema, 'voice')).toBe(false);
    expect(result.isError).toBe(true);
    expect(h.control.command).not.toHaveBeenCalled();
  });
});

describe('revise', () => {
  const seeded = (): Harness => {
    const made = harness();
    made.seed([entry({ id: 'q1' }), entry({ id: 'q2' }), entry({ id: 'q3' })]);
    return made;
  };

  it('edits one entry without resending the rest of it', async () => {
    h = seeded();
    const client = await connect(h.control);

    await client.callTool({
      name: 'revise',
      arguments: {
        action: 'update',
        id: 'q2',
        line: { text: 'いいなおす。', reading: 'いいなおす' },
      },
    });

    expect(h.control.queueUpdate).toHaveBeenCalledTimes(1);
    const [id, patch] = h.control.queueUpdate.mock.calls[0];
    // A patch and not a replacement: an edit that resent every field would
    // clobber whatever the panel changed about the same line meanwhile.
    expect(id).toBe('q2');
    expect(patch).toMatchObject({ text: 'いいなおす。', reading: 'いいなおす' });
    expect(h.queue().map((queued) => queued.text)).toEqual(['あ', 'いいなおす。', 'あ']);
  });

  it('refuses an edit that would put broken markup on a queued line', async () => {
    h = seeded();
    const client = await connect(h.control);

    const result = await client.callTool({
      name: 'revise',
      arguments: { action: 'update', id: 'q1', line: { text: '[hello こんばんは' } },
    });

    // The same refusal `speak` makes, for the same reason: an unclosed bracket
    // reaches the mouth, and the queue is the copy that gets spoken.
    expect(result.isError).toBe(true);
    expect(h.control.queueUpdate).not.toHaveBeenCalled();
  });

  it('drops one entry and answers with the queue that is left', async () => {
    h = seeded();
    const client = await connect(h.control);

    const payload = payloadOf(
      await client.callTool({ name: 'revise', arguments: { action: 'remove', id: 'q2' } }),
    );

    expect(h.control.queueRemove).toHaveBeenCalledWith('q2');
    expect(payload).toMatchObject({ ok: true, queued: 2 });
    expect((payload.queue as { id: string }[]).map((queued) => queued.id)).toEqual(['q1', 'q3']);
  });

  it('moves an entry to a position rather than past one', async () => {
    h = seeded();
    const client = await connect(h.control);

    await client.callTool({ name: 'revise', arguments: { action: 'move', id: 'q3', to: 0 } });

    expect(h.control.queueMove).toHaveBeenCalledWith('q3', 0);
    expect(h.queue().map((queued) => queued.id)).toEqual(['q3', 'q1', 'q2']);
  });

  it('empties the queue and leaves the line on air alone', async () => {
    h = seeded();
    const client = await connect(h.control);

    const payload = payloadOf(
      await client.callTool({ name: 'revise', arguments: { action: 'clear' } }),
    );

    // Clearing is not interrupting: what is being said now has already left the
    // queue, and stopping it is the other tool.
    expect(h.control.queueClear).toHaveBeenCalledTimes(1);
    expect(h.control.command).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ ok: true, queued: 0, queue: [] });
  });

  it('sends a spoken line round again with both choices stated', async () => {
    h = seeded();
    h.setHistory([historyEntry({ id: 'h1', text: 'さっき' }), historyEntry({ id: 'h2' })]);
    const client = await connect(h.control);

    await client.callTool({
      name: 'revise',
      arguments: { action: 'rewind', id: 'h1', mode: 'from', interrupt: true },
    });

    expect(h.control.queueRewind).toHaveBeenCalledTimes(1);
    const [id, mode, opts] = h.control.queueRewind.mock.calls[0];
    expect([id, mode]).toEqual(['h1', 'from']);
    expect(opts).toMatchObject({ interrupt: true });
    // `from` resumes the show at that line: it and everything after it come back
    // as new entries, ahead of what was already queued.
    expect(h.queue().map((queued) => queued.text)).toEqual(['さっき', 'あ', 'あ', 'あ', 'あ']);
  });

  it('copies one line back without moving the rest', async () => {
    h = seeded();
    h.setHistory([historyEntry({ id: 'h1', text: 'さっき' }), historyEntry({ id: 'h2' })]);
    const client = await connect(h.control);

    await client.callTool({
      name: 'revise',
      arguments: { action: 'rewind', id: 'h1', mode: 'one', interrupt: false },
    });

    const [, mode, opts] = h.control.queueRewind.mock.calls[0];
    expect(mode).toBe('one');
    expect(opts).toMatchObject({ interrupt: false });
    // The history keeps it: `one` is a line that was fluffed being said again,
    // not the script being wound back to it.
    expect(h.history()).toHaveLength(2);
  });

  it('refuses a rewind that did not say which kind', async () => {
    h = seeded();
    h.setHistory([historyEntry({ id: 'h1' })]);
    const client = await connect(h.control);

    const result = await client.callTool({
      name: 'revise',
      arguments: { action: 'rewind', id: 'h1', interrupt: false },
    });

    // No default, because the two modes differ in what happens to every line
    // said after the named one, and guessing wrong silently drops the script.
    expect(result.isError).toBe(true);
    expect(h.control.queueRewind).not.toHaveBeenCalled();
  });

  it('refuses a rewind that did not say what to do with the line on air', async () => {
    h = seeded();
    h.setHistory([historyEntry({ id: 'h1' })]);
    const client = await connect(h.control);

    const result = await client.callTool({
      name: 'revise',
      arguments: { action: 'rewind', id: 'h1', mode: 'from' },
    });

    // Cutting a character off mid-word is sometimes exactly right and is never
    // a thing to do because a field was left out.
    expect(result.isError).toBe(true);
    expect(h.control.queueRewind).not.toHaveBeenCalled();
  });

  it('refuses an action it does not have', async () => {
    h = seeded();
    const client = await connect(h.control);

    const result = await client.callTool({ name: 'revise', arguments: { action: 'shuffle' } });

    expect(result.isError).toBe(true);
    expect(h.control.queueClear).not.toHaveBeenCalled();
  });

  it('answers a refused edit with the queue it should have been reading', async () => {
    h = seeded();
    const client = await connect(h.control);

    const result = await client.callTool({
      name: 'revise',
      arguments: { action: 'remove', id: 'said-already' },
    });

    // Both at once. The failure has to be an error or the model goes on as
    // though the line were gone; the queue has to come with it or the model's
    // next guess is made from the same list that was already wrong.
    expect(result.isError).toBe(true);
    const shown = JSON.stringify(result);
    expect(shown).toContain('q1');
    expect(shown).toContain('q3');
    expect(h.queue()).toHaveLength(3);
  });
});

describe('how much of the queue status shows', () => {
  const queued = (count: number): Harness => {
    const made = harness();
    made.setSnapshot(
      snapshot({
        queue: Array.from({ length: count }, (_unused, index) =>
          entry({ id: `q${index}`, text: `行${index}` }),
        ),
      }),
    );
    return made;
  };

  it('shows five without being asked', async () => {
    h = queued(7);
    const client = await connect(h.control);

    const payload = payloadOf(await client.callTool({ name: 'status', arguments: {} }));

    // Enough to see what is coming, few enough that a status call stays cheap
    // enough to make every turn.
    expect(payload.queue).toHaveLength(5);
  });

  it('shows as many as it was asked for', async () => {
    h = queued(7);
    const client = await connect(h.control);

    const payload = payloadOf(await client.callTool({ name: 'status', arguments: { depth: 2 } }));

    expect((payload.queue as { id: string }[]).map((one) => one.id)).toEqual(['q0', 'q1']);
  });

  it('shows none when asked for none, and everything when asked for more than there is', async () => {
    h = queued(7);
    const client = await connect(h.control);

    const none = payloadOf(await client.callTool({ name: 'status', arguments: { depth: 0 } }));
    const all = payloadOf(await client.callTool({ name: 'status', arguments: { depth: 50 } }));

    // Zero is a real answer: a caller that only wants the flags should be able
    // to stop paying for the queue by the token.
    expect(none.queue).toEqual([]);
    expect(all.queue).toHaveLength(7);
  });

  it('refuses a depth past the end of the range', async () => {
    h = queued(7);
    const client = await connect(h.control);

    const tooMany = await client.callTool({ name: 'status', arguments: { depth: 51 } });
    const fractional = await client.callTool({ name: 'status', arguments: { depth: 2.5 } });
    const negative = await client.callTool({ name: 'status', arguments: { depth: -1 } });

    expect(tooMany.isError).toBe(true);
    expect(fractional.isError).toBe(true);
    expect(negative.isError).toBe(true);
  });
});

describe('the history resource', () => {
  it('stands beside the vocabulary as the second thing to read', async () => {
    h = harness();
    const client = await connect(h.control);

    const { resources } = await client.listResources();

    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      'hashidate://history',
      'hashidate://vocabulary',
    ]);
  });

  it('reads back what has already been said', async () => {
    h = harness();
    h.setHistory([
      historyEntry({ id: 'h1', text: 'ひとつめ' }),
      historyEntry({ id: 'h2', text: 'ふたつめ', interrupted: true }),
    ]);
    const client = await connect(h.control);

    const { contents } = await client.readResource({ uri: 'hashidate://history' });

    expect(h.control.history).toHaveBeenCalled();
    const body = JSON.parse(resourceText(contents)) as unknown;
    const lines = (Array.isArray(body) ? body : (body as { history: unknown[] }).history) as {
      id: string;
      text: string;
    }[];
    // The continuity of the conversation without the model having to have
    // remembered it — including the line that was cut off, which is the one
    // most likely to be wanted back.
    expect(lines.map((line) => line.id)).toEqual(['h1', 'h2']);
    expect(lines.map((line) => line.text)).toEqual(['ひとつめ', 'ふたつめ']);
  });

  it('outlives a read that could not be answered', async () => {
    h = harness();
    const client = await connect(h.control);
    h.failNext('history', new ControlError('制御サーバに接続できない'));

    await client.readResource({ uri: 'hashidate://history' }).catch(() => undefined);
    const after = await client.callTool({ name: 'status', arguments: {} });

    // The adapter is started by the model's client and the control server is
    // restarted by `yarn dev` all day; the second is not allowed to end the first.
    expect(after.isError).toBeFalsy();
  });
});

describe('the ids the later tools were built from', () => {
  it('burns the loaded avatar ids into every field discovered from one', async () => {
    h = harness();
    const client = await connect(h.control);
    const react = await schemaOf(client, 'react');
    const stage = await schemaOf(client, 'stage');

    expect(enumOf(propertyNode(react, 'perform'))).toEqual(['hello', 'explain', 'think']);
    expect(enumOf(propertyNode(react, 'expression'))).toEqual(['F_DOYA', 'F_JITO']);
    expect(enumOf(propertyNode(react, 'gesture'))).toEqual(['wave', 'point']);
    expect(enumOf(propertyNode(react, 'hop'))).toEqual(['hop', 'double']);
    // Nested, because an overlay is an id and a level together — and it is the
    // id that cannot be written into a static schema.
    expect(enumOf(propertyNode(propertyNode(react, 'overlay'), 'id'))).toEqual(['blush', 'tears']);

    expect(enumOf(propertyNode(stage, 'backdrop'))).toEqual(['night', 'room']);
    expect(enumOf(propertyNode(stage, 'room'))).toEqual(['studio', 'hall']);
    expect(enumOf(propertyNode(propertyNode(stage, 'wear'), 'slot'))).toEqual(['top', 'bottom']);
    expect(enumOf(propertyNode(propertyNode(stage, 'wear'), 'item'))).toEqual(['coat', 'skirt']);
    expect(enumOf(propertyNode(propertyNode(stage, 'wear'), 'preset'))).toEqual([
      'casual',
      'stage',
    ]);
  });

  it('enumerates the framings, which the protocol fixes rather than the avatar', async () => {
    h = harness();
    const client = await connect(h.control);

    const framings = enumOf(propertyNode(await schemaOf(client, 'stage'), 'camera'));

    // Four fixed names, so nothing is injected here — but the field is still an
    // enum, and a model asking for a framing that does not exist is still wrong.
    expect(framings?.slice().sort()).toEqual(['bust', 'face', 'full', 'upper']);
  });

  it('leaves the discovered fields as plain strings before a viewer connects', async () => {
    h = harness();
    h.setVocabulary({});
    const client = await connect(h.control);
    const react = await schemaOf(client, 'react');
    const stage = await schemaOf(client, 'stage');

    // An empty enum would refuse every value including the ones about to exist,
    // and the two processes are started in whichever order the operator likes.
    expect(enumOf(propertyNode(react, 'perform'))).toBeNull();
    expect(enumOf(propertyNode(react, 'hop'))).toBeNull();
    expect(enumOf(propertyNode(propertyNode(react, 'overlay'), 'id'))).toBeNull();
    expect(enumOf(propertyNode(stage, 'backdrop'))).toBeNull();
    expect(enumOf(propertyNode(propertyNode(stage, 'wear'), 'slot'))).toBeNull();
  });

  it('follows the avatar that is standing', async () => {
    h = harness();
    const client = await connect(h.control);
    expect(enumOf(propertyNode(await schemaOf(client, 'react'), 'gesture'))).toEqual([
      'wave',
      'point',
    ]);

    h.setVocabulary(
      vocabulary({
        avatar: { id: 'other', label: same('べつのリグ') },
        gestures: [{ id: 'nod', label: same('うなずく'), group: 'reaction', sustain: false }],
      }),
    );
    await client.callTool({ name: 'status', arguments: {} });

    expect(enumOf(propertyNode(await schemaOf(client, 'react'), 'gesture'))).toEqual(['nod']);
  });
});
