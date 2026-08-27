import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Mock } from 'vitest';
import { vi } from 'vitest';
import { same } from '@/i18n/locale';
import type { Control } from '@/mcp/server';
import { createServer } from '@/mcp/server';
import type {
  Command,
  Deck,
  DecksResponse,
  DeckTextResponse,
  HistoryEntry,
  HistoryResponse,
  QueueEntry,
  QueueResponse,
  SessionEvent,
  Snapshot,
  TurnRequest,
  Vocabulary,
} from '@/protocol';

/**
 * The stand-in control server, the wiring to talk to the adapter, and the two
 * readers the schema assertions need.
 *
 * No HTTP anywhere: `Control` is the whole seam between the adapter and the rest
 * of the process, so a fake of it is a complete substitute for the control API
 * and the tests stay about the adapter rather than about fetch.
 */

// --- fixtures ---------------------------------------------------------------

/**
 * An avatar with something in every list the adapter injects an enum from.
 * Two entries per list, so a test can tell an injected enum from a coincidence.
 */
export const vocabulary = (over: Partial<Vocabulary> = {}): Vocabulary => ({
  avatar: { id: 'synthetic', label: same('合成リグ') },
  emotions: [{ id: 'joy', label: same('喜') }],
  expressions: [
    { id: 'F_DOYA', label: same('ドヤ') },
    { id: 'F_JITO', label: same('ジト') },
  ],
  overlays: [
    { id: 'blush', label: same('赤面') },
    { id: 'tears', label: same('涙') },
  ],
  performances: [
    {
      id: 'hello',
      label: same('あいさつ'),
      group: 'greeting',
      emotion: { joy: 0.85 },
      gesture: 'wave',
      hop: null,
      sustain: false,
    },
    {
      id: 'explain',
      label: same('説明'),
      group: 'explain',
      emotion: { thinking: 0.4 },
      gesture: 'point',
      hop: null,
      sustain: false,
    },
    {
      id: 'think',
      label: same('考える'),
      group: 'mood',
      emotion: { thinking: 0.9 },
      gesture: null,
      hop: null,
      sustain: true,
    },
  ],
  gestures: [
    { id: 'wave', label: same('手を振る'), group: 'greeting', sustain: false },
    { id: 'point', label: same('指す'), group: 'explain', sustain: false },
  ],
  hops: [
    { id: 'hop', label: same('ぴょん') },
    { id: 'double', label: same('二連') },
  ],
  cue: { syntax: '[performance]', note: same('') },
  cameras: ['bust', 'upper', 'face', 'full'],
  pointing: {
    side: ['L', 'R'],
    azimuth: [-120, 120],
    elevation: [-70, 110],
    extent: [0.1, 1],
    finger: ['thumb', 'index', 'middle', 'ring', 'little'],
    note: same(''),
  },
  wardrobe: {
    top: { label: same('上'), items: [{ id: 'coat', label: same('コート') }] },
    bottom: { label: same('下'), items: [{ id: 'skirt', label: same('スカート') }] },
  },
  wardrobePresets: [
    { id: 'casual', label: same('私服') },
    { id: 'stage', label: same('衣装') },
  ],
  rooms: [
    { id: 'studio', label: same('スタジオ') },
    { id: 'hall', label: same('ホール') },
  ],
  backdrops: [
    { id: 'night', label: same('夜') },
    { id: 'room', label: same('部屋') },
  ],
  voicePresets: [{ id: 'plain', label: same('素') }],
  ...over,
});

/** A second avatar, for the swap that has to reach the tool definitions. */
export const otherVocabulary = (): Vocabulary =>
  vocabulary({
    avatar: { id: 'other', label: same('べつのリグ') },
    performances: [
      {
        id: 'bow',
        label: same('おじぎ'),
        group: 'greeting',
        emotion: {},
        gesture: null,
        hop: null,
        sustain: false,
      },
    ],
    expressions: [{ id: 'F_SMILE', label: same('笑') }],
    gestures: [{ id: 'nod', label: same('うなずく'), group: 'reaction', sustain: false }],
    backdrops: [{ id: 'dusk', label: same('夕') }],
    rooms: [{ id: 'booth', label: same('ブース') }],
  });

export const entry = (over: Partial<QueueEntry> & { id: string }): QueueEntry => ({
  text: 'あ',
  at: 0,
  ...over,
});

/** A line already said: the entry it was, plus when it stopped. */
export const historyEntry = (over: Partial<HistoryEntry> & { id: string }): HistoryEntry => ({
  text: 'あ',
  at: 0,
  saidAt: 1,
  ...over,
});

/**
 * A document as the control server found it on disk. Not avatar data — it is a
 * directory listing, which is why it is a fixture of its own and not part of the
 * vocabulary above.
 */
export const deck = (over: Partial<Deck> & { id: string }): Deck => ({
  label: same(over.id),
  pages: 12,
  bytes: 4096,
  at: 1_700_000_000,
  ...over,
});

/** The pages of the fixture document, so a read has something to come back with. */
const PAGE_TEXT = (id: string, page: number): string => `${id} の ${page} ページ目`;

export const event = (seq: number, over: Partial<SessionEvent> = {}): SessionEvent => ({
  type: 'turn.end',
  turn: `t${seq}`,
  seq,
  at: 1_700_000_000 + seq,
  ...over,
});

/** A whole snapshot: the projection tests are about what is *dropped* from it. */
export const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  connected: true,
  viewers: 2,
  seq: 3,
  state: {
    speaking: true,
    turn: 'turn-1',
    queued: 2,
    busy: true,
    idle: false,
    idleEnabled: true,
    emotion: { joy: 0.6 },
    expression: 'F_DOYA',
    pickedExpression: null,
    overlays: { blush: 0.5 },
    performance: 'hello',
    gesture: 'wave',
    hopping: false,
    strain: { L: 0.2, R: 0.1 },
    lookAt: 1,
    wardrobe: { top: 'coat' },
  },
  vocabulary: vocabulary(),
  events: [event(1), event(2), event(3)],
  voice: {
    preset: 'plain',
    dsp: { gain: 1 },
    room: 'studio',
    lufs: -18,
    truePeakDb: -1.2,
    blocked: false,
  },
  tuning: {
    idle: {
      breathDepth: 1,
      breathPeriod: 4,
      idleAmount: 1,
      weightShift: 1,
      gazeAmount: 1,
      eyeLimit: 1,
      blink: true,
    },
    sway: { enabled: true, stiffness: 1, inertia: 1, gravity: 1 },
    hop: { height: 0.1, gravity: 9.8 },
    tail: { amount: 1 },
    render: { toon: true, arkit: false },
    has: { sway: true, tail: false, arkit: false },
  },
  avatars: [{ id: 'synthetic', label: same('合成リグ') }],
  // The roster is on the snapshot and the adapter reads it from the endpoint
  // instead, so this stays empty: a document a model may read is one the server
  // can see now, not one that was in the last poll.
  decks: [],
  // A document up, part way through, with the page drawn. `ready` and `error`
  // are here because the report carries them and are what the projection is
  // expected to drop.
  slides: { deck: 'intro', page: 4, pages: 24, ready: true, error: null },
  // The frame's layout, which the projection drops for the same reason: a model
  // writing a script has nothing to do with where the rectangles are.
  placement: null,
  // Answering, and dropped by the projection as well — a voice that is up is
  // one more thing a model writing lines cannot act on.
  speech: 'ready',
  queue: [],
  ...over,
});

// --- the fake control server ------------------------------------------------

/**
 * The reply to an edit: the queue as it now stands, and what went wrong when
 * something did. The control server answers an id it does not have with the
 * queue in the body as well as the complaint, which is what lets a caller learn
 * that the edit failed and what there was to edit instead in one round trip.
 */
export type QueueOutcome = QueueResponse & { error?: string };

/**
 * The editing half of the seam, declared here rather than imported so that these
 * tests state the contract they are testing against instead of following it.
 */
interface ControlQueue {
  decks(): Promise<DecksResponse>;
  deckText(id: string, opts?: { from?: number; to?: number }): Promise<DeckTextResponse>;
  queueUpdate(id: string, patch: TurnRequest): Promise<QueueOutcome>;
  queueRemove(id: string): Promise<QueueOutcome>;
  queueMove(id: string, to: number): Promise<QueueOutcome>;
  queueClear(): Promise<QueueOutcome>;
  queueRewind(
    id: string,
    mode: 'from' | 'one',
    opts: { interrupt: boolean },
  ): Promise<QueueOutcome>;
  history(): Promise<HistoryResponse>;
}

/** `Control`, with each method still readable as the spy it is. */
export type FakeControl = { [K in keyof Control]: Control[K] & Mock } & {
  [K in keyof ControlQueue]: ControlQueue[K] & Mock;
};

export interface Harness {
  control: FakeControl;
  /** What the next `vocabulary()` answers, as an avatar swap changes it. */
  setVocabulary(next: Partial<Vocabulary>): void;
  /** What the next `state()` answers. */
  setSnapshot(next: Snapshot): void;
  /** Make the next call of one method fail the way a stopped server does. */
  failNext(method: keyof FakeControl, error: Error): void;
  /** Put entries on the queue that were already there before the adapter asked. */
  seed(entries: QueueEntry[]): void;
  /** What the document directory holds. Empty by default: most tests have no document. */
  setDecks(found: Deck[]): void;
  /** Lines already spoken, which is what a rewind reaches into. */
  setHistory(entries: HistoryEntry[]): void;
  /** The queue as the fake holds it, after whatever the adapter did to it. */
  queue(): QueueEntry[];
  /** The history as the fake holds it, which a rewind takes lines out of. */
  history(): HistoryEntry[];
}

export function harness(): Harness {
  let vocab: Partial<Vocabulary> = vocabulary();
  let snap: Snapshot = snapshot();
  let queue: QueueEntry[] = [];
  let said: HistoryEntry[] = [];
  let found: Deck[] = [];
  let minted = 0;
  const failures = new Map<string, Error>();

  /** Throw once if this method was armed to fail, exactly as one refused connection would. */
  const gate = (method: string): void => {
    const error = failures.get(method);
    if (!error) return;
    failures.delete(method);
    throw error;
  };

  const settled = (): QueueOutcome => ({ queue: [...queue], viewers: 2 });

  /**
   * What the control server answers an edit that names an entry it does not
   * have: the complaint and the queue together, on the same body.
   */
  const missing = (): QueueOutcome => ({ ...settled(), error: 'no such entry' });

  /**
   * A rewound line comes back as a new entry rather than the one it was. The old
   * id has already had its `turn.end`, and a second one under it would leave
   * anything correlating against the event log unable to tell them apart.
   */
  const requeue = (line: HistoryEntry): QueueEntry => {
    minted += 1;
    return entry({
      id: `again-${minted}`,
      text: line.text,
      reading: line.reading,
      source: line.source,
      at: 200 + minted,
    });
  };

  const control: FakeControl = {
    vocabulary: vi.fn(async (): Promise<Partial<Vocabulary>> => {
      gate('vocabulary');
      return vocab;
    }),
    state: vi.fn(async (): Promise<Snapshot> => {
      gate('state');
      return snap;
    }),
    queueAdd: vi.fn(
      async (
        turns: TurnRequest[],
        opts: { at?: 'push' | 'unshift'; source?: string; note?: string } = {},
      ): Promise<QueueResponse> => {
        gate('queueAdd');
        const added = turns.map((turn) => {
          minted += 1;
          return entry({
            ...turn,
            id: `new-${minted}`,
            source: opts.source,
            note: opts.note,
            at: 100 + minted,
          });
        });
        queue = opts.at === 'unshift' ? [...added, ...queue] : [...queue, ...added];
        return { queue: [...queue], viewers: 2 };
      },
    ),
    command: vi.fn(async (_command: Command, _wait?: string): Promise<unknown> => {
      gate('command');
      return { ok: true, viewers: 2, ids: ['c1'] };
    }),
    queueUpdate: vi.fn(async (id: string, patch: TurnRequest): Promise<QueueOutcome> => {
      gate('queueUpdate');
      if (!queue.some((queued) => queued.id === id)) return missing();
      queue = queue.map((queued) => (queued.id === id ? { ...queued, ...patch } : queued));
      return settled();
    }),
    queueRemove: vi.fn(async (id: string): Promise<QueueOutcome> => {
      gate('queueRemove');
      if (!queue.some((queued) => queued.id === id)) return missing();
      queue = queue.filter((queued) => queued.id !== id);
      return settled();
    }),
    queueMove: vi.fn(async (id: string, to: number): Promise<QueueOutcome> => {
      gate('queueMove');
      const from = queue.findIndex((queued) => queued.id === id);
      if (from < 0) return missing();
      const rest = queue.filter((_queued, index) => index !== from);
      queue = [...rest.slice(0, to), queue[from], ...rest.slice(to)];
      return settled();
    }),
    queueClear: vi.fn(async (): Promise<QueueOutcome> => {
      gate('queueClear');
      queue = [];
      return settled();
    }),
    queueRewind: vi.fn(
      async (
        id: string,
        mode: 'from' | 'one',
        _opts: { interrupt: boolean },
      ): Promise<QueueOutcome> => {
        gate('queueRewind');
        const index = said.findIndex((line) => line.id === id);
        if (index < 0) return missing();
        // `from` resumes the show at that line and takes what followed with it;
        // `one` is that line again with nothing else moved.
        const taken = mode === 'from' ? said.slice(index) : [said[index]];
        if (mode === 'from') said = said.slice(0, index);
        queue = [...taken.map(requeue), ...queue];
        return settled();
      },
    ),
    history: vi.fn(async (): Promise<HistoryResponse> => {
      gate('history');
      return { history: [...said] };
    }),
    decks: vi.fn(async (): Promise<DecksResponse> => {
      gate('decks');
      return { decks: [...found] };
    }),
    deckText: vi.fn(
      async (id: string, opts: { from?: number; to?: number } = {}): Promise<DeckTextResponse> => {
        gate('deckText');
        const document = found.find((item) => item.id === id);
        // The real server answers an id it cannot open with a failure rather
        // than an empty document, so that a mistyped name is not indistinguish-
        // able from a deck of blank pages.
        if (!document) throw new Error(`no such deck: ${id}`);
        const from = Math.max(1, opts.from ?? 1);
        const to = Math.min(document.pages, opts.to ?? document.pages);
        const text = [];
        for (let page = from; page <= to; page += 1) text.push(PAGE_TEXT(id, page));
        return { id, pages: document.pages, from, text };
      },
    ),
  };

  return {
    control,
    setVocabulary: (next) => {
      vocab = next;
    },
    setSnapshot: (next) => {
      snap = next;
    },
    failNext: (method, error) => {
      failures.set(method, error);
    },
    seed: (entries) => {
      queue = [...entries];
    },
    setDecks: (documents) => {
      found = [...documents];
    },
    setHistory: (entries) => {
      said = [...entries];
    },
    queue: () => [...queue],
    history: () => [...said],
  };
}

// --- talking to the adapter -------------------------------------------------

const opened: Client[] = [];

/** A client joined to a fresh adapter over the SDK's own in-process transport. */
export async function connect(control: Control): Promise<Client> {
  const server = createServer(control);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hashidate-tests', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  opened.push(client);
  return client;
}

export async function closeAll(): Promise<void> {
  await Promise.all(opened.splice(0).map((client) => client.close()));
}

/**
 * Fail with what was being waited for rather than letting the suite hang.
 * Real timers, because the transport is real and only the escape hatch is timed.
 */
export async function within<T>(promise: Promise<T>, what: string, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not arrive within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

// --- reading a tool result --------------------------------------------------

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
}

/** The prose a tool answered with, which for a failure is the message to the model. */
export function textOf(result: unknown): string {
  const { content = [] } = result as ToolResult;
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

/**
 * The object a tool answered with. Structured content when the adapter declares
 * an output schema and the JSON text when it does not — which of the two it uses
 * is its choice, and neither changes what the fields have to say.
 */
export function payloadOf(result: unknown): Record<string, unknown> {
  const { structuredContent } = result as ToolResult;
  if (structuredContent && typeof structuredContent === 'object') {
    return structuredContent as Record<string, unknown>;
  }
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

// --- reading a generated JSON Schema ----------------------------------------

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The schema node a named property resolves to, wherever it sits.
 *
 * A search rather than a path on purpose. Whether a nullable field comes out as
 * an `anyOf`, and whether a reused object is hoisted into `$defs`, are decisions
 * the generator makes; what the adapter promises is that the property is there
 * and is constrained. Pinning the encoding would make these tests fail on a zod
 * upgrade that changed nothing about the contract.
 */
export function propertyNode(schema: unknown, name: string): Node {
  const found = search(schema, name);
  if (!found) throw new Error(`no "${name}" property anywhere in ${JSON.stringify(schema)}`);
  return found;
}

function search(value: unknown, name: string): Node | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = search(item, name);
      if (hit) return hit;
    }
    return null;
  }
  if (!isNode(value)) return null;
  const { properties } = value;
  if (isNode(properties) && isNode(properties[name])) return properties[name];
  for (const child of Object.values(value)) {
    const hit = search(child, name);
    if (hit) return hit;
  }
  return null;
}

/** The values a node admits, or null when it admits any string at all. */
export function enumOf(node: Node): string[] | null {
  if (Array.isArray(node.enum)) return node.enum as string[];
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!isNode(branch)) continue;
      const found = enumOf(branch);
      if (found) return found;
    }
  }
  return null;
}
