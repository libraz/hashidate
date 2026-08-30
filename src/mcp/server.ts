import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ControlError, type QueueOutcome } from '../control/client';
import type {
  BgmResponse,
  Command,
  CommandRequest,
  DecksResponse,
  DeckTextResponse,
  HistoryResponse,
  QueueResponse,
  Snapshot,
  TurnRequest,
  Vocabulary,
} from '../protocol';
import { projectQueue, projectStatus, queuedIds } from './project';
import {
  type BgmInput,
  buildTools,
  explain,
  MAX_PAGES,
  type ReactInput,
  type ReviseInput,
  type StageInput,
  type Tools,
} from './tools';

/**
 * The MCP adapter over the control API.
 *
 * Not a second control plane: everything here is `POST /api/queue` and
 * `POST /api/command` said in a way a language model can be handed. What the
 * layer adds is three things, and it would not be worth having for fewer —
 * the avatar's ids are burned into the tool schemas so they cannot be invented,
 * a call that fails validation is answered rather than dropped, and a run of
 * lines travels in one call so there is no silence between them.
 *
 * It holds no judgement of its own. It does not rewrite a line, infer an
 * emotion that was not given, or decide where in the queue something belongs.
 * Anything of that kind is the orchestrator's, on the other side of the wire.
 *
 * ## Transport belongs to the caller
 *
 * `createServer` builds and wires; connecting is done by `main.ts` over stdio,
 * or by a test over an in-memory pair. Nothing here opens a socket, and nothing
 * here subscribes to `/api/stream` — a subscriber is counted as a viewer by the
 * hub, which would make commands report success with no renderer attached and
 * would inflate the connection count the operator is reading.
 */

/**
 * Stamped on every turn this adapter queues, so a line from a model is
 * distinguishable in the panel from a comment and from something typed by hand.
 */
export const SOURCE = 'mcp';

/**
 * The vocabulary, as a resource. This is the object to paste into a prompt.
 *
 * Every label goes out in both languages, exactly as it arrives from the control
 * server. Picking one would be picking on behalf of a reader who is not a person
 * — a model writing a line in Japanese wants the Japanese name for a performance
 * and the English one is what makes the id legible, and both together cost a few
 * dozen tokens.
 */
export const VOCABULARY_URI = 'hashidate://vocabulary';

/**
 * What has already been said, as a resource.
 *
 * Read from the server rather than reconstructed from the model's own memory of
 * what it queued: a line can be cut off mid-word, edited by the operator or
 * rewound, and the only end that knows which of those happened is the one that
 * filed it.
 */
export const HISTORY_URI = 'hashidate://history';

const EMPTY_REACT =
  'Nothing was named in react, so nothing was sent. ' +
  'Name at least one: reset, emotion, perform, expression, gesture, overlay, hop, point, look';

const EMPTY_STAGE =
  'Nothing was named in stage, so nothing was sent. ' +
  'Name at least one: avatar, camera, backdrop, room, wear, idle';

const INSTRUCTIONS = [
  'Drive the broadcast avatar of an AITuber. Queue lines with speak, and read what is happening with status.',
  'The ids that can be used are in the tool schemas. The whole set is at hashidate://vocabulary.',
  "This layer does not inspect what a line says. Guardrails on the subject matter are the caller's responsibility.",
].join('\n');

/**
 * The part of the control API this adapter uses, and no more.
 *
 * Narrow on purpose: a test stands in for it without a server, and the list is
 * also the whole set of things this layer can do to a stream. `ControlClient`
 * satisfies it structurally.
 *
 * The queue edits come back as a `QueueOutcome` rather than a `QueueResponse`
 * because the endpoint answers a missing entry with 404 *and* the current list;
 * dropping the `error` off that would make a refused edit read as a done one.
 */
export interface Control {
  vocabulary(): Promise<Partial<Vocabulary>>;
  state(): Promise<Snapshot>;
  queueAdd(
    turns: TurnRequest[],
    opts?: { at?: 'push' | 'unshift'; source?: string; note?: string },
  ): Promise<QueueResponse>;
  command(command: CommandRequest, wait?: string): Promise<unknown>;
  queueUpdate(id: string, patch: TurnRequest & { note?: string }): Promise<QueueOutcome>;
  queueRemove(id: string): Promise<QueueOutcome>;
  queueMove(id: string, to: number): Promise<QueueOutcome>;
  queueClear(): Promise<QueueOutcome>;
  queueRewind(
    id: string,
    mode: 'from' | 'one',
    opts: { interrupt: boolean },
  ): Promise<QueueOutcome>;
  history(): Promise<HistoryResponse>;
  /** A fresh scan of the configured BGM directory. */
  bgm(): Promise<BgmResponse>;
  /**
   * The two document reads, which are reads and nothing else.
   *
   * They are on the seam rather than derived from the snapshot because the text
   * of a document is not on it and could not be: the roster changes when
   * somebody saves a file, and the words on the pages are read off the disk by
   * the only process that has one. Neither of these can change what is on
   * screen — putting a document up is a `deck` command, and this layer does not
   * send one.
   */
  decks(): Promise<DecksResponse>;
  deckText(id: string, opts?: { from?: number; to?: number }): Promise<DeckTextResponse>;
}

export function createServer(control: Control): Server {
  const server = new Server(
    { name: 'hashidate', version: '0.1.0' },
    {
      capabilities: { tools: { listChanged: true }, resources: {} },
      instructions: INSTRUCTIONS,
    },
  );

  // Null until the first successful read, which is not the same as an empty
  // vocabulary: an empty one is a real answer from a server with no renderer.
  let vocabulary: Partial<Vocabulary> | null = null;
  let tools: Tools = buildTools({});
  // Whether a tool list has gone out. Nothing needs correcting until one has.
  let advertised = false;

  /**
   * Re-read the vocabulary, and rebuild the tools if the avatar moved.
   *
   * Done at the top of a request rather than on a timer. An avatar is swapped a
   * handful of times in a stream and this process outlives several of them, so
   * polling would spend a request every couple of seconds to be early for
   * something that has already happened by the time anyone asks. Being late
   * costs one call validated against the previous avatar's ids — which fails
   * with the right list attached, and the model corrects on the next turn.
   *
   * A vocabulary that cannot be fetched is not an error here. The control
   * server restarts all through a development session, and the last known ids
   * remain the best guess about what is loaded; the call that follows will fail
   * on its own and say why.
   */
  async function refresh(): Promise<void> {
    let next: Partial<Vocabulary>;
    try {
      next = await control.vocabulary();
    } catch {
      return;
    }
    const previous = vocabulary;
    vocabulary = next;
    if (previous !== null && previous.avatar?.id === next.avatar?.id) return;
    tools = buildTools(next);
    // A list that has already gone out has to be corrected, and the first
    // *successful* read is a correction whenever the read before it failed.
    // That is the ordinary case rather than a corner: the adapter is started by
    // the MCP client, the control server is started by the operator, and a list
    // served in between carries no ids at all.
    if (advertised) await announce();
  }

  /**
   * Say that the tools moved, and swallow the failure of saying it. A client
   * that has gone away, or a transport not yet connected, must not take down
   * the call that triggered the notification.
   */
  async function announce(): Promise<void> {
    try {
      await server.sendToolListChanged();
      await server.sendResourceUpdated({ uri: VOCABULARY_URI });
    } catch {
      // Nothing to do about it and nowhere to say it: stdout is the wire.
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await refresh();
    advertised = true;
    return { tools: tools.definitions };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    await refresh();
    const { name, arguments: args } = request.params;
    switch (name) {
      case 'speak':
        return speak(args);
      case 'status':
        return status(args);
      case 'interrupt':
        return interrupt(args);
      case 'react':
        return react(args);
      case 'stage':
        return stage(args);
      case 'revise':
        return revise(args);
      case 'deck':
        return deck(args);
      case 'bgm':
        return bgm(args);
      default:
        return refuse(`Unknown tool: ${name}`);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      {
        uri: VOCABULARY_URI,
        name: 'vocabulary',
        title: 'The avatar vocabulary',
        description:
          'Everything the currently loaded avatar can do: the ids of its expressions, performances, gestures, backdrops, rooms and outfits, and how the cue notation is written.',
        mimeType: 'application/json',
      },
      {
        uri: HISTORY_URI,
        name: 'history',
        title: 'Lines already said',
        description:
          "The lines already spoken, oldest first. A line that was cut off mid-way stays as it was, so the rest of the conversation can be read from the server rather than from the model's own memory.",
        mimeType: 'application/json',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === HISTORY_URI) return read(uri, await spoken());
    if (uri !== VOCABULARY_URI) throw new McpError(ErrorCode.InvalidParams, `Unknown URI: ${uri}`);
    await refresh();
    return read(uri, vocabulary ?? {});
  });

  /**
   * The history, or the reason there is none.
   *
   * A resource read has no `isError` to answer with, so a control server that is
   * down becomes an `McpError` here rather than a thrown `ControlError` — which
   * the transport would report as an internal fault of this process and which
   * says nothing about what to do next.
   */
  async function spoken(): Promise<HistoryResponse> {
    try {
      return await control.history();
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, message(error));
    }
  }

  /**
   * Lines go on the server's queue, never out as a `say`.
   *
   * A `say` reaches the renderer directly, which is right for one line typed by
   * hand and wrong for everything a model produces: it does not survive a
   * viewer reload, it never appears in the panel, so it cannot be reordered or
   * rewritten, and it carries no `source` for the operator to tell it apart
   * from a comment. The queue is the copy that counts — see `src/server/queue.ts`.
   */
  async function speak(args: unknown): Promise<CallToolResult> {
    const parsed = tools.speak.safeParse(args);
    if (!parsed.success) return refuse(explain('speak', parsed.error, tools));
    const { lines, at, note } = parsed.data;
    try {
      const response = await control.queueAdd(lines, { at, source: SOURCE, note });
      return report({
        ok: true,
        ids: queuedIds(response, lines.length, at ?? 'push'),
        queued: response.queue.length,
        // Zero viewers is not a failure. The queue is held by the server and is
        // delivered whole to whichever renderer connects next.
        viewers: response.viewers,
      });
    } catch (error) {
      return unreachable(error);
    }
  }

  /** What is happening, including what is on the document layer. */
  async function status(args: unknown): Promise<CallToolResult> {
    const parsed = tools.status.safeParse(args);
    if (!parsed.success) return refuse(explain('status', parsed.error, tools));
    try {
      const { since, depth } = parsed.data;
      return report(projectStatus(await control.state(), since, depth));
    } catch (error) {
      return unreachable(error);
    }
  }

  /**
   * Read a document, or list the ones there are.
   *
   * Deliberately the whole of what this layer can do with a document. Nothing
   * here sends a command, so a model that has decided the audience should be
   * looking at page 12 says so on the line that talks about page 12 — see
   * `deckInput`.
   */
  async function deck(args: unknown): Promise<CallToolResult> {
    const parsed = tools.deck.safeParse(args);
    if (!parsed.success) return refuse(explain('deck', parsed.error, tools));
    const call = parsed.data;
    try {
      if (call.action === 'list') return report(await control.decks());
      const from = call.from ?? 1;
      // Clamped rather than refused: a caller that asked for the whole document
      // wanted to read it, and the pages come back numbered so the rest is one
      // more call. Refusing would spend a round trip saying no.
      const to = Math.min(call.to ?? from + MAX_PAGES - 1, from + MAX_PAGES - 1);
      return report(await control.deckText(call.id, { from, to }));
    } catch (error) {
      return unreachable(error);
    }
  }

  /**
   * List or control the server-owned background music transport.
   *
   * `list` reads the directory directly. Mutations travel as one canonical
   * `bgm` command, and then read the server snapshot so the response includes
   * the resolved DSP and degradation marker when that read is available.
   */
  async function bgm(args: unknown): Promise<CallToolResult> {
    const parsed = tools.bgm.safeParse(args);
    if (!parsed.success) return refuse(explain('bgm', parsed.error, tools));
    const call = parsed.data;
    if (call.action === 'list') {
      try {
        return report(await control.bgm());
      } catch (error) {
        return unreachable(error);
      }
    }

    const command: Extract<Command, { cmd: 'bgm' }> = bgmCommand(call);
    try {
      const response = await control.command(command);
      const payload = commandResponse(response);
      // A command delivery response and the canonical server state are two
      // useful answers to one request. A restarted/older control endpoint may
      // deliver the command but fail the follow-up read, so keep the delivery
      // answer in that case rather than turning a successful mutation into an
      // error.
      try {
        const snapshot = await control.state();
        if (snapshot.bgm !== undefined) payload.bgm = snapshot.bgm;
      } catch {
        // The delivery result remains actionable even when the state read races
        // a control-server restart.
      }
      return report(payload);
    } catch (error) {
      return unreachable(error);
    }
  }

  /**
   * Two verbs under one tool, because the choice between them is the whole
   * decision: `interrupt` cuts the current line off where it is, `clear` lets it
   * finish and drops what is behind it.
   */
  async function interrupt(args: unknown): Promise<CallToolResult> {
    const parsed = tools.interrupt.safeParse(args);
    if (!parsed.success) return refuse(explain('interrupt', parsed.error, tools));
    const command: Command = parsed.data.mode === 'now' ? { cmd: 'interrupt' } : { cmd: 'clear' };
    try {
      const response = await control.command(command);
      return report({ ok: ok(response), viewers: viewers(response) });
    } catch (error) {
      return unreachable(error);
    }
  }

  /** The immediate reactions, as one batch. Nothing here touches the queue. */
  async function react(args: unknown): Promise<CallToolResult> {
    const parsed = tools.react.safeParse(args);
    if (!parsed.success) return refuse(explain('react', parsed.error, tools));
    const batch = reactCommands(parsed.data);
    if (batch.length === 0) return refuse(EMPTY_REACT);
    return deliver(batch);
  }

  /** The persistent settings, as one batch. See `stageInput` for what is not here. */
  async function stage(args: unknown): Promise<CallToolResult> {
    const parsed = tools.stage.safeParse(args);
    if (!parsed.success) return refuse(explain('stage', parsed.error, tools));
    const batch = stageCommands(parsed.data);
    if (batch.length === 0) return refuse(EMPTY_STAGE);
    return deliver(batch);
  }

  /**
   * One round trip for however many commands were asked for.
   *
   * A batch is not a transaction — the server delivers them in order and that is
   * all it promises — but it is one message on the wire, which is what keeps a
   * face and the gesture under it from arriving a frame apart.
   */
  async function deliver(batch: Command[]): Promise<CallToolResult> {
    try {
      const response = await control.command({ batch });
      return report({
        ok: ok(response),
        viewers: viewers(response),
        // What actually went, in the order it went in: the caller wrote fields
        // and this is the translation of them, which is the part it cannot see.
        sent: batch.map((command) => command.cmd),
      });
    } catch (error) {
      return unreachable(error);
    }
  }

  /**
   * Edit the pending list.
   *
   * A refused edit answers with the queue rather than with the complaint alone.
   * Naming an entry that is no longer pending is the ordinary outcome of editing
   * a row that started playing while the caller was deciding to edit it — the
   * same judgement `queue()` in `src/server/routes.ts` makes when it attaches
   * the list to its 404 — and what the caller needs back is the list it should
   * have been working from, because with it the next call is right.
   */
  async function revise(args: unknown): Promise<CallToolResult> {
    const parsed = tools.revise.safeParse(args);
    if (!parsed.success) return refuse(explain('revise', parsed.error, tools));
    const call = parsed.data;
    let outcome: QueueOutcome;
    try {
      outcome = await edit(call);
    } catch (error) {
      return unreachable(error);
    }
    const payload = {
      ok: outcome.error === undefined,
      queued: outcome.queue.length,
      queue: projectQueue(outcome.queue),
    };
    if (outcome.error === undefined) return report(payload);
    return refuse(
      `revise (${call.action}) could not be applied: ${outcome.error}. ` +
        'That line has either started being said or been removed. This is the queue as it stands:\n' +
        JSON.stringify(payload),
    );
  }

  function edit(call: ReviseInput): Promise<QueueOutcome> {
    switch (call.action) {
      case 'update':
        return control.queueUpdate(call.id, call.line);
      case 'remove':
        return control.queueRemove(call.id);
      case 'move':
        return control.queueMove(call.id, call.to);
      case 'clear':
        return control.queueClear();
      case 'rewind':
        return control.queueRewind(call.id, call.mode, { interrupt: call.interrupt });
    }
  }

  function bgmCommand(
    call: Exclude<BgmInput, { action: 'list' }>,
  ): Extract<Command, { cmd: 'bgm' }> {
    switch (call.action) {
      case 'play':
        return {
          cmd: 'bgm',
          action: 'play',
          track: call.track,
          ...(call.volume === undefined ? {} : { volume: call.volume }),
          ...(call.loop === undefined ? {} : { loop: call.loop }),
          ...(call.dsp === undefined ? {} : { dsp: call.dsp }),
          ...(call.fade === undefined ? {} : { fade: call.fade }),
        };
      case 'pause':
        return { cmd: 'bgm', action: 'pause' };
      case 'resume':
        // Resume is intentionally a play with no track. The coordinator keeps
        // the current selection and position when no track is supplied.
        return { cmd: 'bgm', action: 'play' };
      case 'stop':
        return { cmd: 'bgm', action: 'stop' };
      case 'settings':
        return {
          cmd: 'bgm',
          ...(call.volume === undefined ? {} : { volume: call.volume }),
          ...(call.loop === undefined ? {} : { loop: call.loop }),
          ...(call.dsp === undefined ? {} : { dsp: call.dsp }),
          ...(call.fade === undefined ? {} : { fade: call.fade }),
        };
    }
  }

  return server;
}

// --- what a call becomes -----------------------------------------------------

/**
 * The commands one `react` turns into, in the order they are applied.
 *
 * Fixed rather than following the order the fields happen to be written in. A
 * performance names a face and a movement together, so the three fields that
 * replace part of one have to land after it or the override is overwritten by
 * the thing it was overriding — which is the same order `say` resolves a line
 * in, and the reason `perform` sits above `expression` and `gesture` here.
 */
function reactCommands(input: ReactInput): Command[] {
  const batch: Command[] = [];
  if (input.reset === true) batch.push({ cmd: 'reset' });
  if (input.emotion !== undefined) batch.push({ cmd: 'emotion', vec: input.emotion });
  if (input.perform !== undefined) batch.push({ cmd: 'perform', id: input.perform });
  if (input.expression !== undefined) batch.push({ cmd: 'expression', id: input.expression });
  // A gesture is stopped by a command with no id at all — `gestureCommandSchema`
  // has no null to send — so the release drops the field rather than emptying it.
  if (input.gesture !== undefined) {
    batch.push(input.gesture === null ? { cmd: 'gesture' } : { cmd: 'gesture', id: input.gesture });
  }
  if (input.overlay !== undefined) batch.push({ cmd: 'overlay', ...input.overlay });
  if (input.hop !== undefined) batch.push({ cmd: 'hop', hop: input.hop });
  // Degrees on the wire, and degrees here: the conversion to the engine's
  // radians belongs at the boundary that applies the command, not at this one.
  if (input.point !== undefined) {
    batch.push(input.point === null ? { cmd: 'point' } : { cmd: 'point', ...input.point });
  }
  if (input.look !== undefined) batch.push({ cmd: 'look', amount: input.look });
  return batch;
}

/**
 * The commands one `stage` turns into.
 *
 * `avatar` goes first because it replaces the thing every command after it talks
 * to: the swap builds a new scene, and the control server holds what follows
 * until the new avatar is standing and then applies it to that one. Dressing an
 * avatar in the same call that loads it does what it reads like.
 */
function stageCommands(input: StageInput): Command[] {
  const batch: Command[] = [];
  if (input.avatar !== undefined) batch.push({ cmd: 'avatar', id: input.avatar });
  if (input.camera !== undefined) batch.push({ cmd: 'camera', frame: input.camera });
  if (input.backdrop !== undefined) batch.push({ cmd: 'backdrop', id: input.backdrop });
  if (input.room !== undefined) batch.push({ cmd: 'room', id: input.room });
  if (input.wear !== undefined) batch.push({ cmd: 'wear', ...input.wear });
  if (input.idle !== undefined) batch.push({ cmd: 'idle', on: input.idle });
  return batch;
}

// --- answers -----------------------------------------------------------------

function report(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** A resource body. Text is the only form this adapter serves, and it is JSON. */
function read(uri: string, value: unknown) {
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
  };
}

/**
 * A failure the caller can read, rather than a JSON-RPC error.
 *
 * The distinction matters because of who is calling. A protocol error is
 * handled by the client and may never reach the model, which then goes on as
 * though the line had been said — the exact silent failure this adapter exists
 * to prevent. An `isError` result is content: it lands in the conversation and
 * gets corrected.
 */
function refuse(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/**
 * The control server did not answer. Reported the same way a rejected argument
 * is, and the process stays up: this adapter outlives the stream it drives, and
 * a restarted control server is a normal event rather than a fatal one.
 */
function unreachable(error: unknown): CallToolResult {
  return refuse(message(error));
}

/** What to say about a failed call. A `ControlError` already says it. */
function message(error: unknown): string {
  if (error instanceof ControlError) return error.message;
  return `The call to the control API failed: ${error instanceof Error ? error.message : error}`;
}

/** The command reply is passed through unread by the transport; read the two fields here. */
function ok(response: unknown): boolean {
  return field(response, 'ok') === true;
}

function viewers(response: unknown): number {
  const value = field(response, 'viewers');
  return typeof value === 'number' ? value : 0;
}

function field(response: unknown, key: string): unknown {
  return typeof response === 'object' && response !== null
    ? (response as Record<string, unknown>)[key]
    : undefined;
}

/** Preserve a delivery response's fields while making room for canonical state. */
function commandResponse(response: unknown): Record<string, unknown> {
  if (typeof response === 'object' && response !== null && !Array.isArray(response)) {
    return { ...(response as Record<string, unknown>) };
  }
  return { response };
}
