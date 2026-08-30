import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlError } from '@/control/client';
import { same } from '@/i18n/locale';
import { SOURCE } from '@/mcp/server';
import {
  bgmState,
  bgmTrack,
  closeAll,
  connect,
  deck,
  entry,
  enumOf,
  event,
  type Harness,
  harness,
  otherVocabulary,
  payloadOf,
  propertyNode,
  snapshot,
  textOf,
  vocabulary,
  within,
} from './harness';

/**
 * The three things the MCP adapter adds on top of the control API, and the two
 * ways it is allowed to fail.
 *
 * What it adds: the avatar's own ids burnt into the tool schemas, a refusal the
 * model can read and act on, and several lines queued in one call. Everything
 * else here is a control API call in different clothes, so the tests that matter
 * are about the seams — the enums going stale when the avatar is swapped, a line
 * with broken markup never reaching the queue, and a projection that drops the
 * fields nothing branches on.
 *
 * How it fails: never by dying. The adapter outlives the broadcast and outlives
 * `yarn dev` restarting the control server underneath it, so a refused call is a
 * tool error and the next call still answers.
 *
 * Everything runs over the SDK's in-process transport against a fake `Control`,
 * which is the entire seam to the outside — no socket is opened by this file.
 */

/** The body of a resource read. Text is the only form this adapter serves. */
const resourceText = (contents: { uri: string; text?: string }[]): string => {
  const [first] = contents;
  if (typeof first?.text !== 'string') throw new Error('the resource came back without text');
  return first.text;
};

const speakSchema = async (client: Client): Promise<unknown> => {
  const { tools } = await client.listTools();
  const speak = tools.find((tool) => tool.name === 'speak');
  if (!speak) throw new Error(`no speak tool among ${tools.map((t) => t.name).join(', ')}`);
  return speak.inputSchema;
};

let h: Harness;

afterEach(async () => {
  await closeAll();
});

describe('the tool surface', () => {
  it('offers exactly eight tools', async () => {
    h = harness();
    const client = await connect(h.control);
    const { tools } = await client.listTools();
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

  it('leaves perform an unconstrained string when no avatar has been seen', async () => {
    h = harness();
    h.setVocabulary({});
    const client = await connect(h.control);

    // The renderer may be opened after the model's client, and a tool list that
    // could only be built once a viewer was up would make the two racy.
    expect(enumOf(propertyNode(await speakSchema(client), 'perform'))).toBeNull();
  });

  it('burns the avatar ids into every field discovered from it', async () => {
    h = harness();
    const client = await connect(h.control);
    const schema = await speakSchema(client);

    // The one thing a pasted prompt cannot do: a model handed the list in prose
    // still invents ids, and an invented id is a line delivered with no face.
    expect(enumOf(propertyNode(schema, 'perform'))).toEqual(['hello', 'explain', 'think']);
    expect(enumOf(propertyNode(schema, 'expression'))).toEqual(['F_DOYA', 'F_JITO']);
    expect(enumOf(propertyNode(schema, 'gesture'))).toEqual(['wave', 'point']);
    expect(enumOf(propertyNode(schema, 'backdrop'))).toEqual(['night', 'room']);
    expect(enumOf(propertyNode(schema, 'room'))).toEqual(['studio', 'hall']);
  });

  it('rebuilds the list and says so when the avatar underneath changes', async () => {
    h = harness();
    const client = await connect(h.control);
    const changed = new Promise<void>((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve());
    });
    expect(enumOf(propertyNode(await speakSchema(client), 'perform'))).toEqual([
      'hello',
      'explain',
      'think',
    ]);

    h.setVocabulary(otherVocabulary());
    await client.callTool({ name: 'status', arguments: {} });

    // Noticed on the way past rather than by polling: the swap is rare and a
    // background poll of the control server would be a second liveness story.
    await within(changed, 'notifications/tools/list_changed');
    const schema = await speakSchema(client);
    expect(enumOf(propertyNode(schema, 'perform'))).toEqual(['bow']);
    expect(enumOf(propertyNode(schema, 'expression'))).toEqual(['F_SMILE']);
    expect(enumOf(propertyNode(schema, 'backdrop'))).toEqual(['dusk']);
  });

  it('stays quiet while the avatar is the same one', async () => {
    h = harness();
    const client = await connect(h.control);
    let announcements = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      announcements += 1;
    });

    await client.callTool({ name: 'status', arguments: {} });
    await client.callTool({ name: 'status', arguments: {} });
    // The transport is ordered, so anything the first call announced arrived
    // before this reply did — no sleep is needed to make the absence mean
    // something.
    await client.listTools();

    expect(announcements).toBe(0);
  });
});

describe('speak', () => {
  it('puts the lines on the server queue and sends no command', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({ name: 'speak', arguments: { lines: [{ text: 'こんばんは。' }] } });

    expect(h.control.queueAdd).toHaveBeenCalledTimes(1);
    // A `say` would reach the renderer directly: gone on reload, invisible to
    // the panel, and unattributed in a queue three producers are writing to.
    expect(h.control.command).not.toHaveBeenCalled();
  });

  it('stamps every line with the adapter as its producer', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({
      name: 'speak',
      arguments: { lines: [{ text: 'あ' }], note: 'コメント返し' },
    });

    expect(SOURCE).toBe('mcp');
    const [, opts] = h.control.queueAdd.mock.calls[0];
    expect(opts).toMatchObject({ source: SOURCE, note: 'コメント返し' });
  });

  it('queues a whole run in one call and answers with the ids it made', async () => {
    h = harness();
    h.seed([entry({ id: 'old-1' }), entry({ id: 'old-2' })]);
    const client = await connect(h.control);

    const result = await client.callTool({
      name: 'speak',
      arguments: {
        lines: [
          { text: 'こんばんは。', reading: 'こんばんは' },
          { text: '[explain]今日はこの話をします。' },
        ],
      },
    });

    const [turns] = h.control.queueAdd.mock.calls[0];
    // One call and not two: a line at a time leaves the renderer with nothing to
    // prepare during, and about a second of silence between every pair.
    expect(turns).toHaveLength(2);
    const payload = payloadOf(result);
    expect(payload).toMatchObject({ ok: true, ids: ['new-1', 'new-2'], viewers: 2 });
    expect(payload.queued).toBe(4);
  });

  it('reads the ids off the front when the lines were put in front', async () => {
    h = harness();
    h.seed([entry({ id: 'old-1' }), entry({ id: 'old-2' })]);
    const client = await connect(h.control);

    const result = await client.callTool({
      name: 'speak',
      arguments: { lines: [{ text: 'あ' }, { text: 'い' }], at: 'unshift' },
    });

    // The reply carries the whole queue, so which end the new entries are at is
    // the only way to name them — and it is the opposite end for an insertion.
    expect(payloadOf(result).ids).toEqual(['new-1', 'new-2']);
  });

  it('carries a page on the line that talks about it', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({
      name: 'speak',
      arguments: {
        lines: [
          { text: 'まずは全体像から。', stage: { deck: 'intro', slide: 1 } },
          { text: 'ここが今日の本題です。', stage: { slide: 7 } },
        ],
      },
    });

    // The whole point of the page being on the line rather than in a command of
    // its own: queued together, the document follows the script by itself, and
    // it keeps following it when the operator reorders the run.
    const [turns] = h.control.queueAdd.mock.calls[0];
    expect(turns[0].stage).toMatchObject({ deck: 'intro', slide: 1 });
    expect(turns[1].stage).toMatchObject({ slide: 7 });
    expect(h.control.command).not.toHaveBeenCalled();
  });

  it('refuses a relative page written as a page number', async () => {
    h = harness();
    const client = await connect(h.control);

    const result = await client.callTool({
      name: 'speak',
      arguments: { lines: [{ text: 'つぎ。', stage: { slide: 0 } }] },
    });

    // Pages are 1 based and absolute. A queued line can be dropped or moved, so
    // "one more than wherever we are" would mean a different page every time the
    // script was touched.
    expect(result.isError).toBe(true);
    expect(h.control.queueAdd).not.toHaveBeenCalled();
  });

  it('refuses a broken cue and tells the model the ids it could have used', async () => {
    h = harness();
    const client = await connect(h.control);

    const result = await client.callTool({
      name: 'speak',
      arguments: { lines: [{ text: '[hello こんばんは' }] },
    });

    expect(result.isError).toBe(true);
    // Dropped silently, the model would carry on as though it had spoken. Caught
    // here with the list attached, it is one round trip from being right.
    expect(h.control.queueAdd).not.toHaveBeenCalled();
    const message = textOf(result);
    expect(message).toContain('hello');
    expect(message).toContain('explain');
    expect(message).toContain('think');
  });

  it('refuses a line with no text at all', async () => {
    h = harness();
    const client = await connect(h.control);

    const result = await client.callTool({
      name: 'speak',
      arguments: { lines: [{ reading: 'こんばんは' }] },
    });

    // A reading is how a line sounds, not what it is; queued alone it is a turn
    // with nothing to say that still takes its place in the script.
    expect(result.isError).toBe(true);
    expect(h.control.queueAdd).not.toHaveBeenCalled();
  });

  it('refuses cue markup written into a reading', async () => {
    h = harness();
    const client = await connect(h.control);

    const result = await client.callTool({
      name: 'speak',
      arguments: { lines: [{ text: 'こんばんは。', reading: '[hello]こんばんは' }] },
    });

    expect(result.isError).toBe(true);
    expect(h.control.queueAdd).not.toHaveBeenCalled();
  });
});

describe('status', () => {
  it('answers with the projection and nothing else', async () => {
    h = harness();
    const client = await connect(h.control);

    const payload = payloadOf(await client.callTool({ name: 'status', arguments: {} }));

    expect(Object.keys(payload).sort()).toEqual(
      [
        'bgm',
        'avatar',
        'connected',
        'emotion',
        'events',
        'idle',
        'queue',
        'queued',
        'seq',
        'slides',
        'speaking',
        'turn',
        'viewers',
      ].sort(),
    );
    expect(payload).toMatchObject({
      connected: true,
      viewers: 2,
      speaking: true,
      turn: 'turn-1',
      queued: 2,
      idle: false,
      emotion: { joy: 0.6 },
      seq: 3,
      bgm: expect.objectContaining({
        dsp: expect.objectContaining({ toneDb: 0, width: 1 }),
        dspDegraded: false,
      }),
    });
    // Which of the two shapes the avatar is named by is the adapter's choice;
    // that it is named at all is not, since the enums depend on which one it is.
    expect(JSON.stringify(payload.avatar)).toContain('synthetic');
  });

  it('leaves out the fields nothing branches on', async () => {
    h = harness();
    const client = await connect(h.control);

    const payload = payloadOf(await client.callTool({ name: 'status', arguments: {} }));

    // The reader pays for every one of these by the token and cannot act on any
    // of them: a DSP chain, a fader position and a joint load are for the panel.
    expect(payload).not.toHaveProperty('voice');
    expect(payload).not.toHaveProperty('tuning');
    expect(payload).not.toHaveProperty('strain');
    expect(payload).not.toHaveProperty('wardrobe');
    expect(payload).not.toHaveProperty('overlays');
    expect(payload).not.toHaveProperty('vocabulary');
    expect(JSON.stringify(payload)).not.toContain('truePeakDb');
  });

  it('says which document is up and how far through it is', async () => {
    h = harness();
    const client = await connect(h.control);

    const payload = payloadOf(await client.callTool({ name: 'status', arguments: {} }));

    // The one part of the staging a *line* branches on: a run of lines with page
    // numbers on them cannot be written without knowing the document and its
    // length, and neither is knowable from what this adapter queued — the
    // operator mounts the document and turns pages too.
    expect(payload.slides).toEqual({ deck: 'intro', page: 4, pages: 24 });
  });

  it('leaves out the parts of the document report nothing can act on', async () => {
    h = harness();
    const client = await connect(h.control);

    const payload = payloadOf(await client.callTool({ name: 'status', arguments: {} }));

    // A page part way through being drawn is a frame, and a missing file is
    // fixed by whoever can put it back. Both are the panel's.
    expect(payload.slides).not.toHaveProperty('ready');
    expect(payload.slides).not.toHaveProperty('error');
  });

  it('says there is no document layer rather than inventing an empty one', async () => {
    h = harness();
    h.setSnapshot(snapshot({ slides: null }));
    const client = await connect(h.control);

    const payload = payloadOf(await client.callTool({ name: 'status', arguments: {} }));

    // A renderer with no document layer is not the same answer as a renderer
    // with no document up, and a caller deciding whether to write page numbers
    // has to be able to tell them apart.
    expect(payload.slides).toBeNull();
  });

  it('returns only the events past the sequence number it was given', async () => {
    h = harness();
    const client = await connect(h.control);

    const payload = payloadOf(await client.callTool({ name: 'status', arguments: { since: 2 } }));

    expect((payload.events as { seq: number }[]).map((e) => e.seq)).toEqual([3]);
  });

  it('returns the whole log when asked without a since', async () => {
    h = harness();
    const client = await connect(h.control);

    const payload = payloadOf(await client.callTool({ name: 'status', arguments: {} }));

    expect((payload.events as { seq: number }[]).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('returns nothing when the caller is already current', async () => {
    h = harness();
    const client = await connect(h.control);

    const payload = payloadOf(await client.callTool({ name: 'status', arguments: { since: 3 } }));

    expect(payload.events).toEqual([]);
  });

  it('shows the head of the queue and no more of it', async () => {
    h = harness();
    h.setSnapshot(
      snapshot({
        queue: Array.from({ length: 7 }, (_, i) =>
          entry({ id: `q${i}`, text: `行${i}`, source: 'panel', note: 'メモ' }),
        ),
      }),
    );
    const client = await connect(h.control);

    const payload = payloadOf(await client.callTool({ name: 'status', arguments: {} }));

    const queue = payload.queue as Record<string, unknown>[];
    expect(queue).toHaveLength(5);
    expect(queue[0]).toEqual({ id: 'q0', text: '行0', source: 'panel' });
    expect(queue.at(-1)?.id).toBe('q4');
  });

  it('cuts a long line down and leaves a short one alone', async () => {
    const long = 'あ'.repeat(100);
    const exact = 'い'.repeat(60);
    h = harness();
    h.setSnapshot(
      snapshot({ queue: [entry({ id: 'a', text: long }), entry({ id: 'b', text: exact })] }),
    );
    const client = await connect(h.control);

    const payload = payloadOf(await client.callTool({ name: 'status', arguments: {} }));

    const queue = payload.queue as { text: string }[];
    // Prefix rather than an exact slice, because whether the last character is
    // spent on an ellipsis is presentation; that the head survives is not.
    expect(queue[0].text.startsWith('あ'.repeat(59))).toBe(true);
    // Sixty is the budget, so a mark meaning "there is more" comes out of it
    // rather than being added on top of it.
    expect(queue[0].text.length).toBeLessThanOrEqual(60);
    expect(queue[1].text).toBe(exact);
  });

  it('answers with an empty vocabulary and no state before a viewer connects', async () => {
    h = harness();
    h.setVocabulary({});
    h.setSnapshot(
      snapshot({ connected: false, viewers: 0, seq: 0, state: {}, vocabulary: {}, events: [] }),
    );
    const client = await connect(h.control);

    const result = await client.callTool({ name: 'status', arguments: {} });

    // Nothing reported yet is a normal answer, not a failure: the model has to
    // be able to find out that the renderer is not up.
    expect(result.isError).toBeFalsy();
    expect(payloadOf(result)).toMatchObject({ connected: false, viewers: 0 });
  });
});

describe('bgm', () => {
  it('lists the live MP3/FLAC roster through the independent tool', async () => {
    h = harness();
    h.setBgmTracks([bgmTrack({ id: 'opening.mp3' }), bgmTrack({ id: 'room.flac' })]);
    const client = await connect(h.control);

    const payload = payloadOf(
      await client.callTool({ name: 'bgm', arguments: { action: 'list' } }),
    );

    expect(h.control.bgm).toHaveBeenCalledTimes(1);
    expect(payload.tracks).toEqual([
      expect.objectContaining({ id: 'opening.mp3', mime: 'audio/mpeg' }),
      expect.objectContaining({ id: 'room.flac', mime: 'audio/flac' }),
    ]);
    expect(h.control.command).not.toHaveBeenCalled();
  });

  it('plays an exact track with mix settings and returns canonical BGM state', async () => {
    h = harness();
    h.setSnapshot(
      snapshot({
        bgm: bgmState({
          track: 'opening.mp3',
          volume: 0.35,
          transport: 'playing',
          dspDegraded: true,
        }),
      }),
    );
    const client = await connect(h.control);

    const result = await client.callTool({
      name: 'bgm',
      arguments: {
        action: 'play',
        track: 'opening.mp3',
        volume: 0.35,
        loop: false,
        dsp: { toneDb: 2, compression: 0.4, width: 1.2, reverb: { mix: 0.2 } },
      },
    });

    expect(h.control.command).toHaveBeenCalledWith({
      cmd: 'bgm',
      action: 'play',
      track: 'opening.mp3',
      volume: 0.35,
      loop: false,
      dsp: { toneDb: 2, compression: 0.4, width: 1.2, reverb: { mix: 0.2 } },
    });
    expect(payloadOf(result)).toMatchObject({
      ok: true,
      bgm: { track: 'opening.mp3', transport: 'playing', dspDegraded: true },
    });
  });

  it('maps resume to play without replacing the selected track', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({ name: 'bgm', arguments: { action: 'resume' } });

    expect(h.control.command).toHaveBeenCalledWith({ cmd: 'bgm', action: 'play' });
  });

  it('requires a setting for settings and rejects out-of-range DSP values', async () => {
    h = harness();
    const client = await connect(h.control);

    const empty = await client.callTool({ name: 'bgm', arguments: { action: 'settings' } });
    const invalid = await client.callTool({
      name: 'bgm',
      arguments: { action: 'settings', dsp: { reverb: { mix: 0.6 } } },
    });

    expect(empty.isError).toBe(true);
    expect(invalid.isError).toBe(true);
    expect(h.control.command).not.toHaveBeenCalled();
  });
});

describe('interrupt', () => {
  it('cuts the line being said when asked for now', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({ name: 'interrupt', arguments: { mode: 'now' } });

    expect(h.control.command).toHaveBeenCalledTimes(1);
    const [command, wait] = h.control.command.mock.calls[0];
    expect(command).toMatchObject({ cmd: 'interrupt' });
    // Never blocking: a tool call that waited would hit the client's own timeout
    // and report a failure for a line that is being said.
    expect(wait).toBeUndefined();
  });

  it('drops what is pending and lets the line finish when asked to wait', async () => {
    h = harness();
    const client = await connect(h.control);

    await client.callTool({ name: 'interrupt', arguments: { mode: 'after_line' } });

    expect(h.control.command.mock.calls[0][0]).toMatchObject({ cmd: 'clear' });
  });

  it('refuses to choose for a caller that did not say which', async () => {
    h = harness();
    const client = await connect(h.control);

    const result = await client.callTool({ name: 'interrupt', arguments: {} });

    // Cutting a character off mid-word is sometimes right and is never a thing
    // to do because a field was left out.
    expect(result.isError).toBe(true);
    expect(h.control.command).not.toHaveBeenCalled();
  });

  it('refuses a mode it does not have', async () => {
    h = harness();
    const client = await connect(h.control);

    const result = await client.callTool({ name: 'interrupt', arguments: { mode: 'later' } });

    expect(result.isError).toBe(true);
    expect(h.control.command).not.toHaveBeenCalled();
  });
});

describe('deck', () => {
  it('lists what the server can see right now', async () => {
    h = harness();
    h.setDecks([
      deck({ id: 'intro', label: same('導入'), pages: 24 }),
      deck({ id: '資料', pages: 3 }),
    ]);
    const client = await connect(h.control);

    const payload = payloadOf(
      await client.callTool({ name: 'deck', arguments: { action: 'list' } }),
    );

    // Read from the endpoint rather than off the snapshot: a document is a file
    // somebody saved into a directory, possibly a moment ago.
    expect(h.control.decks).toHaveBeenCalledTimes(1);
    expect(payload.decks).toEqual([
      expect.objectContaining({ id: 'intro', pages: 24 }),
      expect.objectContaining({ id: '資料', pages: 3 }),
    ]);
  });

  it('reads the pages so a script can be written about them', async () => {
    h = harness();
    h.setDecks([deck({ id: 'intro', pages: 24 })]);
    const client = await connect(h.control);

    const payload = payloadOf(
      await client.callTool({
        name: 'deck',
        arguments: { action: 'read', id: 'intro', from: 2, to: 3 },
      }),
    );

    expect(h.control.deckText).toHaveBeenCalledWith('intro', { from: 2, to: 3 });
    expect(payload).toMatchObject({ id: 'intro', pages: 24, from: 2 });
    expect(payload.text).toHaveLength(2);
  });

  it('caps how much of a document comes back in one call', async () => {
    h = harness();
    h.setDecks([deck({ id: 'long', pages: 400 })]);
    const client = await connect(h.control);

    await client.callTool({ name: 'deck', arguments: { action: 'read', id: 'long' } });

    // Clamped rather than refused: the caller wanted to read the document, and
    // the pages come back numbered so the rest is one more call. Four hundred
    // pages would be the context window it also has to write in.
    const [, opts] = h.control.deckText.mock.calls[0];
    expect(opts.from).toBe(1);
    expect(opts.to).toBe(20);
  });

  it('answers a document it cannot open with the failure', async () => {
    h = harness();
    h.setDecks([deck({ id: 'intro' })]);
    const client = await connect(h.control);

    const result = await client.callTool({
      name: 'deck',
      arguments: { action: 'read', id: 'gone' },
    });

    // A name a minute out of date is the ordinary case here — the directory is
    // written to by hand during a broadcast — so it is a readable refusal.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('gone');
  });

  it('refuses a read that does not say what to read', async () => {
    h = harness();
    const client = await connect(h.control);

    const result = await client.callTool({ name: 'deck', arguments: { action: 'read' } });

    expect(result.isError).toBe(true);
    expect(h.control.deckText).not.toHaveBeenCalled();
  });

  it('cannot put a document up', async () => {
    h = harness();
    h.setDecks([deck({ id: 'intro' })]);
    const client = await connect(h.control);

    const result = await client.callTool({
      name: 'deck',
      arguments: { action: 'show', id: 'intro' },
    });

    // Deliberate: which document is on screen is part of the set, decided by
    // whoever can see the stream. The model moves pages by writing them onto the
    // lines it speaks.
    expect(result.isError).toBe(true);
    expect(h.control.command).not.toHaveBeenCalled();
  });
});

describe('a control server that is not there', () => {
  it('answers the tool with the failure instead of dying of it', async () => {
    h = harness();
    const client = await connect(h.control);
    h.failNext('state', new ControlError('制御サーバに接続できない'));

    const result = await client.callTool({ name: 'status', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('制御サーバに接続できない');
  });

  it('is still answering after the control server comes back', async () => {
    h = harness();
    const client = await connect(h.control);
    h.failNext('queueAdd', new ControlError('制御サーバに接続できない'));

    const failed = await client.callTool({ name: 'speak', arguments: { lines: [{ text: 'あ' }] } });
    const recovered = await client.callTool({
      name: 'speak',
      arguments: { lines: [{ text: 'い' }] },
    });

    // `yarn dev` restarts the control server all day and the adapter is started
    // by the model's client, which will not notice that it needs starting again.
    expect(failed.isError).toBe(true);
    expect(recovered.isError).toBeFalsy();
    expect(h.control.queueAdd).toHaveBeenCalledTimes(2);
    expect(h.queue().map((queued) => queued.text)).toEqual(['い']);
    expect(payloadOf(recovered).ids).toHaveLength(1);
  });

  it('serves a tool list built from no vocabulary when the first read fails', async () => {
    h = harness();
    h.failNext('vocabulary', new ControlError('制御サーバに接続できない'));
    const client = await connect(h.control);

    const { tools } = await client.listTools();

    // Started before the control server, which is the ordinary case when the
    // client launches it: the list has to exist so the model can call it later.
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
});

describe('the vocabulary resource', () => {
  it('is offered beside the history and nothing else', async () => {
    h = harness();
    const client = await connect(h.control);

    const { resources } = await client.listResources();

    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      'hashidate://history',
      'hashidate://vocabulary',
    ]);
  });

  it('reads back the whole vocabulary, which is what a prompt is pasted from', async () => {
    h = harness();
    const client = await connect(h.control);

    const { contents } = await client.readResource({ uri: 'hashidate://vocabulary' });

    expect(contents).toHaveLength(1);
    expect(JSON.parse(resourceText(contents))).toEqual(vocabulary());
  });

  it('follows the avatar that is standing', async () => {
    h = harness();
    const client = await connect(h.control);
    h.setVocabulary(otherVocabulary());

    const { contents } = await client.readResource({ uri: 'hashidate://vocabulary' });

    expect(JSON.parse(resourceText(contents))).toEqual(otherVocabulary());
  });
});

describe('the event tail', () => {
  it('carries each event whole, so a caller can correlate its own turns', async () => {
    h = harness();
    h.setSnapshot(snapshot({ events: [event(1, { type: 'turn.start', turn: 'new-1' })], seq: 1 }));
    const client = await connect(h.control);

    const payload = payloadOf(await client.callTool({ name: 'status', arguments: {} }));

    expect(payload.events).toEqual([
      expect.objectContaining({ type: 'turn.start', turn: 'new-1', seq: 1 }),
    ]);
  });
});
