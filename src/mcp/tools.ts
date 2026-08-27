import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { type ZodError, type ZodType, z } from 'zod';
import {
  cameraFrameSchema,
  emotionVectorSchema,
  type LabelledId,
  lookCommandSchema,
  overlayCommandSchema,
  pointCommandSchema,
  turnSchema,
  type Vocabulary,
} from '../protocol';

/**
 * The tools this adapter advertises, and the schemas it checks a call against.
 *
 * Both come out of the same zod object. The advertised JSON Schema is that
 * object run through `z.toJSONSchema`, so a field the model is told about is a
 * field the parse will accept, and an id it is offered is an id this avatar has.
 * Patching the generated JSON afterwards would keep looking right long after
 * the protocol schema underneath it moved — which is the failure this whole
 * layer exists to remove, not one to reintroduce here.
 *
 * ## The ids are injected, and only when there are any
 *
 * `perform`, `expression`, `gesture` and the two staging fields name things
 * discovered from the loaded avatar, so they cannot be written into a static
 * schema. They are narrowed to an enum here when the vocabulary has them and
 * left as plain strings when it does not — a renderer that has not connected
 * yet must not make the adapter unusable, because the two processes are started
 * in whichever order the operator happens to start them.
 *
 * `emotion` is the one set that is fixed rather than discovered, so it comes
 * through the protocol schema already enumerated and nothing is done to it.
 */

/**
 * How many lines one `speak` may carry.
 *
 * A bound rather than a limit: the point of the tool is that a run of lines
 * travels together, and a model that has more than sixteen queued in one breath
 * has stopped writing dialogue and started writing a script the operator cannot
 * steer.
 */
const MAX_LINES = 16;

export type ToolName = 'speak' | 'status' | 'interrupt' | 'react' | 'stage' | 'revise' | 'deck';

/** How far down the queue `status` may be asked to look. Past this it is a script. */
const MAX_DEPTH = 50;

/**
 * How many pages of a document one `deck` read may return.
 *
 * A bound rather than a limit, on the same reasoning as `MAX_LINES`: a caller
 * reading forty pages in one call is not writing the next line, it is loading a
 * book into the context window it also has to write in. The pages are numbered,
 * so a reader that wants the rest asks for the rest.
 */
export const MAX_PAGES = 20;

// --- what the model is told --------------------------------------------------
//
// Hand-written, and knowingly a second copy of what the protocol comments say.
// JSDoc does not reach a tool description, so the choice is between writing
// these and shipping none. They are kept to what changes a model's default
// behaviour; everything explanatory belongs in `src/protocol`.

const SPEAK_NOTE = [
  "Queue lines to be said. What is passed here comes out of the avatar's mouth.",
  '',
  '- Pass several lines at once. Calling one line at a time puts silence between them',
  '- Write reading. Only the writer knows how numbers, dates, proper nouns and homographs are read',
  '- [performance_id] is where a performance starts, and the brackets are not spoken. It cannot be written in reading',
  '- A document page goes in stage.slide. Write it on the line that talks about that page',
  '- Queue lines carrying pages in order and the document follows the speech. This is the only way to keep script and document together',
].join('\n');

const STATUS_NOTE = [
  'What is happening right now, in one round trip. Only the values to branch on; no vocabulary.',
  'The document being presented, its page and its page count come back too. Read the vocabulary at hashidate://vocabulary.',
].join('\n');

const DECK_NOTE = [
  'Read a document. Reading only — this cannot present one.',
  '',
  '- list is the documents the server can see. It returns ids and page counts',
  '- read is the text on the pages. Read it to write a script about that document',
  `- At most ${MAX_PAGES} pages per call. For the rest, move from along`,
  "- Which document is presented is the operator's decision. All the model moves is the page, and that goes in speak's stage.slide",
].join('\n');

const DECK_ID_NOTE = 'The document id. One of the ones list returns.';
const DECK_FROM_NOTE = 'The page to start reading at. 1-based. Defaults to 1.';
const DECK_TO_NOTE = `The page to stop reading at. Inclusive. Defaults to ${MAX_PAGES} pages from from.`;
const STAGE_DECK_NOTE =
  'The id of the document to present. null takes it down. Normally the operator has already put one up, so there is no need to write this.';
const STAGE_SLIDE_NOTE =
  'The page of the document. An absolute 1-based page; there is no relative form. Queued lines get removed and reordered, so a "next" would drift the document out of step with the script.';

const INTERRUPT_NOTE = [
  'Stop what is being said. mode is required and has no default.',
  'now cuts even mid-word. after_line finishes the current line, then throws the rest away.',
].join('\n');

const REACT_NOTE = [
  'An immediate reaction, tied to no line. Nothing is queued; only how it looks right now changes.',
  '',
  '- Only what is named arrives, together, in one round trip. A call that names nothing sends nothing',
  '- perform is an expression and a motion together. expression / gesture replace only one of the two',
  "- Performance timed to a line is written with speak's [performance_id], not with react",
].join('\n');

const STAGE_NOTE = [
  'Settings that stick to the broadcast. They stay until changed again, and do not revert across lines.',
  '',
  "- Changing avatar swaps the whole vocabulary, and from the next call the tools' id lists are replaced",
  '- backdrop is where the figure is seen, room is where the voice resonates. Separate axes; either can be changed alone',
  '- Voice processing and body tuning are not here. Both are decided against the broadcast mix and how the render actually looks',
].join('\n');

const REVISE_NOTE = [
  'Correct queued lines. Only lines still waiting can be corrected; a line that has started being said is no longer in the queue.',
  '',
  '- update replaces only the fields written in line. What was not written stays',
  '- rewind brings back lines already said. from takes that line and everything after it, one takes that line alone',
  '- When the target is not found, the current queue comes back with the error. Call again with an id from it',
].join('\n');

const TEXT_NOTE =
  'The line to say. A [performance_id] placed in it starts that performance at that point. The brackets are reserved and are not spoken.';
const READING_NOTE =
  'The kana reading of text. Numbers, dates, proper nouns and homographs get their reading decided here. Brackets cannot be written.';
const PERFORM_NOTE = 'A named expression and motion. In effect only for the duration of the line.';
const EXPRESSION_NOTE =
  'A drawn expression. With perform given, this replaces the expression alone.';
const GESTURE_NOTE = 'A body motion. With perform given, this replaces the motion alone.';
const BACKDROP_NOTE =
  'Where the figure is seen. null for no backdrop. It stays on past the line that set it.';
const ROOM_NOTE = 'Where the voice resonates. null for no reverb. A separate axis from backdrop.';
const RESET_NOTE =
  'Drop every expression, overlay and emotion and go back to neutral. Applied first.';
const EMOTION_NOTE = 'A sustained blend of emotion. It stays after the line ends.';
const OVERLAY_NOTE =
  'Layer a drawn effect. Each is raised and lowered by name, and any number can be up at once.';
const OVERLAY_ID_NOTE = 'The effect id.';
const HOP_NOTE = 'Hop. It runs separately from arm motion, so it can hop while waving.';
const POINT_NOTE =
  'Point. null lowers the arm. The bearing is continuous; there are no fixed poses.';
const LOOK_NOTE =
  'How strongly the eyes meet the camera. 0 keeps facing forward, 1 is full eye contact.';
const AVATAR_NOTE = 'The id of the avatar to stand up. Changing it swaps the vocabulary.';
const CAMERA_NOTE = 'How much is in frame. face is the face, full is the whole body.';
const WEAR_NOTE = 'Change one slot to an item, or put on a whole preset.';
const WEAR_SLOT_NOTE = 'The part being changed.';
const WEAR_ITEM_NOTE = 'What to put on that part. null takes it off.';
const WEAR_PRESET_NOTE = 'A whole outfit changed at once.';
const IDLE_NOTE =
  'The automatic idle motion. Stopped with false, it stands in the pose it was told to hold.';
const DEPTH_NOTE = `How many queued lines come back. Default 5, at most ${MAX_DEPTH}. It is how the id of a line further down is obtained in order to edit it.`;
const REVISE_ID_NOTE =
  "The id of a queued line. Take it from status's queue or from what speak returns.";
const REVISE_LINE_NOTE =
  'Write only the fields being replaced. What is not written stays as it was.';
const REVISE_TO_NOTE = 'Where to move it to. 0 is the next line to be said.';
const REWIND_MODE_NOTE =
  'from brings back that line and everything after it. one says that line alone again.';
const REWIND_INTERRUPT_NOTE =
  'true cuts the line being said mid-way. false waits until it is finished.';

// --- the schemas -------------------------------------------------------------

/**
 * One line, as a caller writes it: a turn without its id, and with the text no
 * longer optional.
 *
 * The id belongs to the server — an entry it files is an entry it names — and a
 * `speak` with no words in it is a call that meant to say something and did not,
 * which is exactly the silent failure this adapter is here to catch.
 */
const speakLine = turnSchema.omit({ id: true }).extend({
  text: turnSchema.shape.text.unwrap().describe(TEXT_NOTE),
  reading: turnSchema.shape.reading.describe(READING_NOTE),
});

/** The three staging axes a line can carry, before any ids are injected. */
const speakStage = turnSchema.shape.stage.unwrap();

/** The run of lines, however narrow the line itself has been made. */
const lineList = <T extends ZodType>(line: T) =>
  z
    .array(line)
    .min(1)
    .max(MAX_LINES)
    .describe(
      `1..${MAX_LINES} lines, in the order they are said. The more that travel together, the tighter the gaps between them.`,
    );

const speakInput = z.object({
  lines: lineList(speakLine),
  at: z
    .enum(['push', 'unshift'])
    .optional()
    .describe('push appends (the default), unshift puts them at the front.'),
  note: z.string().optional().describe('A note for the operator. Neither spoken nor synthesised.'),
});

export type SpeakInput = z.infer<typeof speakInput>;

const statusInput = z.object({
  since: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('The seq that came back last time. Only events newer than it are returned.'),
  /**
   * How much of the queue comes back. Default is the same five lines it has
   * always been — a status is not a script — and asking for more is how a caller
   * gets at the id of a line that is too far down to be shown by default, which
   * is the one thing `revise` cannot be used without.
   */
  depth: z.number().int().min(0).max(MAX_DEPTH).optional().describe(DEPTH_NOTE),
});

export type StatusInput = z.infer<typeof statusInput>;

const interruptInput = z.object({
  mode: z
    .enum(['now', 'after_line'])
    .describe('now cuts even mid-word. after_line waits until the end of the current line.'),
});

export type InterruptInput = z.infer<typeof interruptInput>;

/** The overlay payload, which is the command's own minus the verb. */
const overlaySpec = overlayCommandSchema.omit({ cmd: true });

/**
 * Where to point, with the bearing required.
 *
 * The command treats a missing angle as a release, which is right for a wire
 * where absent and null cannot both be spelled. Here they can, so the release is
 * `point: null` and a bearing given by halves is a mistake rather than a
 * cancellation.
 */
const pointSpec = pointCommandSchema.omit({ cmd: true, id: true }).extend({
  azimuth: pointCommandSchema.shape.azimuth
    .unwrap()
    .describe("Degrees. 0 is straight ahead, positive is the character's own right."),
  elevation: pointCommandSchema.shape.elevation
    .unwrap()
    .describe('Degrees. 0 is shoulder height, positive is up.'),
});

/**
 * Dressing, as the two things it actually is: one slot changed, or a whole
 * preset put on. The command carries both under one flat object because the wire
 * has no unions, and a caller that sends a slot and a preset together has said
 * two things and gets whichever the renderer applies last.
 */
const wearSpec = z.union([
  z.object({
    slot: z.string().describe(WEAR_SLOT_NOTE),
    item: z.string().nullable().describe(WEAR_ITEM_NOTE),
  }),
  z.object({ preset: z.string().describe(WEAR_PRESET_NOTE) }),
]);

const reactInput = z.object({
  reset: z.boolean().optional().describe(RESET_NOTE),
  emotion: emotionVectorSchema.optional().describe(EMOTION_NOTE),
  perform: z.string().nullable().optional().describe(PERFORM_NOTE),
  expression: z.string().nullable().optional().describe(EXPRESSION_NOTE),
  gesture: z.string().nullable().optional().describe(GESTURE_NOTE),
  overlay: overlaySpec.optional().describe(OVERLAY_NOTE),
  hop: z.string().optional().describe(HOP_NOTE),
  point: pointSpec.nullable().optional().describe(POINT_NOTE),
  look: lookCommandSchema.shape.amount.describe(LOOK_NOTE),
});

export type ReactInput = z.infer<typeof reactInput>;

/**
 * The persistent axes.
 *
 * `voice` and `tune` are deliberately not among them, and their absence is the
 * point rather than an omission. How the voice is processed is a decision about
 * the broadcast's mix, made against what the stream sounds like; the numbers in
 * `src/engine` were arrived at by watching two real avatars render, and
 * `CLAUDE.md` is explicit that moving one is an act that needs a look at the
 * render. Neither is a surface to hand to something that cannot hear or see the
 * result of what it sent.
 */
const stageInput = z.object({
  avatar: z.string().optional().describe(AVATAR_NOTE),
  camera: cameraFrameSchema.optional().describe(CAMERA_NOTE),
  backdrop: z.string().nullable().optional().describe(BACKDROP_NOTE),
  room: z.string().nullable().optional().describe(ROOM_NOTE),
  wear: wearSpec.optional().describe(WEAR_NOTE),
  idle: z.boolean().optional().describe(IDLE_NOTE),
});

export type StageInput = z.infer<typeof stageInput>;

/** One line as an edit writes it: everything optional, including the words. */
const reviseLine = turnSchema.omit({ id: true }).extend({
  text: turnSchema.shape.text.describe(TEXT_NOTE),
  reading: turnSchema.shape.reading.describe(READING_NOTE),
});

const entryId = z.string().describe(REVISE_ID_NOTE);

/**
 * The five edits, discriminated so that a caller cannot half-name one.
 *
 * A flat object with an optional `to` and an optional `line` would accept a
 * `move` with nothing to move to and a `rewind` with no mode, and would have to
 * refuse them itself; here the shape of the call says which edit it is and the
 * parse carries the rest.
 *
 * `rewind` gets no defaults on either field. Which of the two things "again"
 * means changes where the script resumes, and cutting the character off
 * mid-word is sometimes right and never something to do because a field was
 * left out — the same judgement `queueRewindSchema` and `interrupt` make.
 */
const reviseUnion = <T extends ZodType>(line: T) =>
  z.discriminatedUnion('action', [
    z.object({
      action: z.literal('update'),
      id: entryId,
      line: line.describe(REVISE_LINE_NOTE),
    }),
    z.object({ action: z.literal('remove'), id: entryId }),
    z.object({
      action: z.literal('move'),
      id: entryId,
      to: z.number().int().min(0).describe(REVISE_TO_NOTE),
    }),
    z.object({ action: z.literal('clear') }),
    z.object({
      action: z.literal('rewind'),
      id: entryId,
      mode: z.enum(['from', 'one']).describe(REWIND_MODE_NOTE),
      interrupt: z.boolean().describe(REWIND_INTERRUPT_NOTE),
    }),
  ]);

const reviseInput = reviseUnion(reviseLine);

export type ReviseInput = z.infer<typeof reviseInput>;

/**
 * Reading a document, and only reading it.
 *
 * There is no branch here that puts one up, and the omission is the design. A
 * document is a file an operator dropped in a directory and chose to present
 * from; which one is on screen is part of the set, decided by the person who can
 * see the stream. What a model does with it is narrate it — which needs the
 * words on the pages, and moves the page by writing a number on the line that
 * talks about it, where the page turn is part of the script rather than a
 * separate act of stagecraft.
 *
 * Discriminated for the reason `revise` is: `read` cannot be half-named, and a
 * `list` cannot arrive carrying a page range that nothing will use.
 */
const deckInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({
    action: z.literal('read'),
    id: z.string().describe(DECK_ID_NOTE),
    from: z.number().int().min(1).optional().describe(DECK_FROM_NOTE),
    to: z.number().int().min(1).optional().describe(DECK_TO_NOTE),
  }),
]);

export type DeckInput = z.infer<typeof deckInput>;

/** The set of tools built for one avatar, with the vocabulary they were built from. */
export interface Tools {
  /** What `tools/list` answers with. */
  readonly definitions: Tool[];
  readonly speak: ZodType<SpeakInput>;
  readonly status: ZodType<StatusInput>;
  readonly interrupt: ZodType<InterruptInput>;
  readonly react: ZodType<ReactInput>;
  readonly stage: ZodType<StageInput>;
  readonly revise: ZodType<ReviseInput>;
  readonly deck: ZodType<DeckInput>;
  /**
   * The vocabulary these were narrowed against. Kept so that a rejection can
   * quote back the list the caller should have been working from, rather than
   * whatever has been fetched since.
   */
  readonly vocabulary: Partial<Vocabulary>;
}

/**
 * A field narrowed to the ids this avatar actually has.
 *
 * An empty list means the renderer has not reported yet, and an empty enum
 * would reject every value including the ones that are about to exist. A plain
 * string is refused nowhere and dropped by the renderer if it is wrong, which
 * is the same thing the control API does with an id it does not know.
 */
function idField(items: readonly LabelledId[] | undefined, note: string) {
  return idEnum(items).nullable().optional().describe(note);
}

/**
 * The same narrowing without the nullable wrapper, for the places where an id is
 * required or where absence already means something: `gesture` with no id is a
 * stop, and an overlay has to name the effect it is raising.
 */
function idEnum(items: readonly LabelledId[] | undefined) {
  const ids = [...new Set(items?.map((item) => item.id) ?? [])];
  return ids.length > 0 ? z.enum(ids) : z.string();
}

/**
 * The fields of a line that name something discovered from the avatar.
 *
 * Shared by `speak` and by the `update` a `revise` carries, which are the same
 * line said twice — one with the words required and one with everything
 * optional. Injecting the ids in one place is what keeps an id a caller may
 * write in a new line the same set it may write when correcting one.
 */
const lineIds = (vocabulary: Partial<Vocabulary>) => ({
  expression: idField(vocabulary.expressions, EXPRESSION_NOTE),
  gesture: idField(vocabulary.gestures, GESTURE_NOTE),
  perform: idField(vocabulary.performances, PERFORM_NOTE),
  stage: speakStage
    .extend({
      backdrop: idField(vocabulary.backdrops, BACKDROP_NOTE),
      room: idField(vocabulary.rooms, ROOM_NOTE),
      // Not narrowed to an enum, unlike the two above. What documents exist is a
      // directory listing rather than avatar data, so it is not in the
      // vocabulary these are built from — a caller that wants the list asks the
      // `deck` tool, which reads it from the process that can see the disk.
      deck: speakStage.shape.deck.describe(STAGE_DECK_NOTE),
      slide: speakStage.shape.slide.describe(STAGE_SLIDE_NOTE),
    })
    .optional(),
});

export function buildTools(vocabulary: Partial<Vocabulary>): Tools {
  const ids = lineIds(vocabulary);
  const speak = speakInput.extend({ lines: lineList(speakLine.extend(ids)) });
  const react = reactInput.extend({
    expression: idField(vocabulary.expressions, EXPRESSION_NOTE),
    gesture: idField(vocabulary.gestures, GESTURE_NOTE),
    perform: idField(vocabulary.performances, PERFORM_NOTE),
    overlay: overlaySpec
      .extend({ id: idEnum(vocabulary.overlays).describe(OVERLAY_ID_NOTE) })
      .optional()
      .describe(OVERLAY_NOTE),
    hop: idEnum(vocabulary.hops).optional().describe(HOP_NOTE),
  });
  const stage = stageInput.extend({
    backdrop: idField(vocabulary.backdrops, BACKDROP_NOTE),
    room: idField(vocabulary.rooms, ROOM_NOTE),
    wear: wearField(vocabulary).optional().describe(WEAR_NOTE),
  });
  const revise = reviseUnion(reviseLine.extend(ids));

  return {
    definitions: [
      define('speak', SPEAK_NOTE, speak),
      define('status', STATUS_NOTE, statusInput),
      define('interrupt', INTERRUPT_NOTE, interruptInput),
      define('react', REACT_NOTE, react),
      define('stage', STAGE_NOTE, stage),
      define('revise', REVISE_NOTE, revise),
      define('deck', DECK_NOTE, deckInput),
    ],
    speak,
    status: statusInput,
    interrupt: interruptInput,
    react,
    stage,
    revise,
    deck: deckInput,
    vocabulary,
  };
}

/**
 * The wardrobe, narrowed.
 *
 * The slots come from the avatar's own meshes and the items from the slots, so
 * both are injected — but the items are injected as one flat list rather than
 * per slot. A union of one branch per slot would be exact and would also grow
 * the schema by the size of the wardrobe on every call; an item sent to a slot
 * it does not belong to is dropped by the renderer, which is the same outcome
 * the control API gives every other id it does not recognise.
 *
 * `avatar` is not narrowed at all. The roster is on the snapshot rather than in
 * the vocabulary (`Snapshot.avatars`), and reading it would mean a second
 * request against the control server on every tool call to enumerate something
 * that is fixed for the life of the renderer. An id it does not have is ignored
 * rather than blanking the stream — see `avatarCommandSchema`.
 */
function wearField(vocabulary: Partial<Vocabulary>) {
  const wardrobe = vocabulary.wardrobe ?? {};
  const slots = Object.keys(wardrobe);
  const items = Object.values(wardrobe).flatMap((slot) => slot.items);
  return z.union([
    z.object({
      slot: (slots.length > 0 ? z.enum(slots) : z.string()).describe(WEAR_SLOT_NOTE),
      item: idEnum(items).nullable().describe(WEAR_ITEM_NOTE),
    }),
    z.object({ preset: idEnum(vocabulary.wardrobePresets).describe(WEAR_PRESET_NOTE) }),
  ]);
}

/**
 * The cast is on the root type only: `toJSONSchema` returns the whole JSON
 * Schema union because it has to, and MCP requires an object at the root, which
 * every schema here is.
 */
function define(name: ToolName, description: string, schema: ZodType): Tool {
  return {
    name,
    description,
    inputSchema: z.toJSONSchema(schema, {
      io: 'input',
      override: objectAtTheRoot,
    }) as Tool['inputSchema'],
  };
}

/**
 * MCP requires every tool's arguments to be a JSON Schema object at the root,
 * and a discriminated union does not say so on its own: `revise` comes out as a
 * bare `oneOf`, which is a valid schema and an invalid tool. A client that
 * validates the tool list rejects **the whole list** over it, so the cost of
 * getting this wrong is all six tools rather than the one.
 *
 * Stating it here rather than writing the branch out by hand. What is added is
 * not content — no field, no id, nothing that could fall out of step with the
 * protocol schema underneath — only the one thing that is true of every set of
 * arguments this file will ever describe.
 */
function objectAtTheRoot(ctx: {
  path: readonly (string | number)[];
  jsonSchema: JsonSchema;
}): void {
  if (ctx.path.length === 0) ctx.jsonSchema.type ??= 'object';
}

interface JsonSchema {
  type?: unknown;
}

// --- rejections --------------------------------------------------------------

/**
 * Turn a failed parse into something the caller can act on.
 *
 * The caller is a model, so the answer goes in with the complaint: an id it
 * invented is answered with the list it should have picked from, and broken cue
 * markup is answered with how the markup is written. One round trip, not a
 * conversation.
 */
export function explain(tool: ToolName, error: ZodError, tools: Tools): string {
  const lines = error.issues.map((issue) => `  ${where(issue.path)}: ${advise(issue, tools)}`);
  return [
    `The arguments to ${tool} were invalid, so nothing was sent. Fix them and call again:`,
    ...lines,
  ].join('\n');
}

/** `['lines', 0, 'text']` -> `lines[0].text`. */
function where(path: readonly PropertyKey[]): string {
  const rendered = path.reduce<string>((acc, key) => {
    if (typeof key === 'number') return `${acc}[${key}]`;
    return acc === '' ? String(key) : `${acc}.${String(key)}`;
  }, '');
  return rendered === '' ? 'arguments' : rendered;
}

/**
 * What to say about one issue.
 *
 * The two hand-written checks in the protocol are recognised by where they
 * landed rather than by their message: which field a custom check sits on is
 * structural, and the wording of the message is not something this file should
 * be pinned to.
 */
function advise(issue: ZodError['issues'][number], tools: Tools): string {
  const field = issue.path.at(-1);
  if (issue.code === 'custom' && field === 'text') {
    const ids = tools.vocabulary.performances?.map((item) => item.id) ?? [];
    const known = ids.length > 0 ? `\n    performance ids this avatar has: ${ids.join(', ')}` : '';
    return `The brackets do not match up. Written as: [performance_id]the line — the brackets are not spoken.${known}`;
  }
  if (issue.code === 'custom' && field === 'reading') {
    return 'Brackets cannot be written in a reading. A cue is a position inside the line, so it goes on the text side.';
  }
  if (issue.code === 'invalid_value') {
    return `That value cannot be used. The ones that can: ${issue.values.map(String).join(', ')}`;
  }
  return issue.message;
}
