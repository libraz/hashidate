import { describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { Wardrobe } from '@/engine/scene';
import { Session } from '@/engine/session';
import type { WardrobeTable } from '@/engine/types';
import { same } from '@/i18n/locale';
import {
  commandRequestSchema,
  deckSchema,
  decksResponseSchema,
  deckTextResponseSchema,
  eventsResponseSchema,
  historyEntrySchema,
  placementReportSchema,
  queueRewindSchema,
  reportBodySchema,
  sessionEventSchema,
  sessionStateSchema,
  slideReportSchema,
  snapshotSchema,
  streamMessageSchema,
  vocabularySchema,
} from '@/protocol';
import { buildRig } from '../helpers/scene';

/**
 * The envelopes the control API moves commands and state around in, and the
 * drift check the compile-time guards in the schema file cannot make: a
 * `SessionState` and a `Vocabulary` produced by a **real** session, validated
 * against the schemas the wire carries them under.
 */

const DT = 1 / 60;

const WARDROBE: WardrobeTable = {
  slots: {
    top: {
      label: same('トップス'),
      items: [{ id: 'shirt', label: same('シャツ'), meshes: ['Shirt'] }],
    },
  },
  presets: { default: { label: same('既定'), set: { top: 'shirt' } } },
};

/** What a renderer with a document up says about it. */
const SLIDES = { deck: 'intro', page: 3, pages: 12, ready: true, error: null };

/** And how it is laying the frame out: the character in a corner of one. */
const PLACEMENT = {
  avatar: { anchor: 'bottom-right', width: 0.32, height: 0.6, margin: 0.04 },
  slide: { anchor: 'center', width: 1, height: 1, margin: 0, fit: 'contain' },
};

/** A live session over a synthetic rig, real from the profile up. */
function buildSession() {
  const rig = buildRig({
    groups: [
      ['Face', ['F_DOYA', 'F_JITO']],
      ['FX', ['FX_BLUSH']],
    ],
    garments: ['Shirt'],
  });
  const profile = buildProfile(rig.root, {
    ...rig.descriptor,
    presets: { group: 'Face', emotion: { joy: 'F_DOYA' } },
    overlays: { group: 'FX' },
    wardrobe: WARDROBE,
  });
  const director = new Director(profile);
  const session = new Session(director, { wardrobe: new Wardrobe(rig.root, profile, WARDROBE) });
  const step = (frames: number): void => {
    for (let i = 0; i < frames; i++) {
      session.update(DT);
      director.update(DT);
    }
  };
  return { session, director, step };
}

describe('a real SessionState against sessionStateSchema', () => {
  it('validates while the session is at rest', () => {
    const { session } = buildSession();
    const result = sessionStateSchema.safeParse(session.state());
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('validates mid-turn, with an emotion, an expression, an overlay and a pose up', () => {
    const { session, step } = buildSession();
    session.setOverlay('FX_BLUSH', 0.5);
    session.point({ side: 'R', azimuth: 200, elevation: 140 });
    session.say({
      id: 'turn-1',
      text: 'こんにちは、みなさん',
      emotion: { joy: 0.7, surprise: 0.3 },
      expression: 'F_JITO',
      gesture: 'wave',
    });
    step(20);

    const state = session.state();
    expect(state.turn).toBe('turn-1');
    const result = sessionStateSchema.safeParse(state);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data).toEqual(state);
  });

  it('validates after the turn drains and the wardrobe has been changed', () => {
    const { session, step } = buildSession();
    session.say({ id: 'turn-2', text: 'ありがとう' });
    for (let i = 0; i < 600 && session.busy; i++) step(1);
    session.wear({ slot: 'top', item: null });
    expect(sessionStateSchema.safeParse(session.state()).success).toBe(true);
  });

  it('requires strain for both arms, so a half-reported readout cannot pass', () => {
    const { session } = buildSession();
    const state = session.state();
    expect(sessionStateSchema.safeParse({ ...state, strain: { R: 0 } }).success).toBe(false);
  });

  it('rejects a state missing a field the engine declares', () => {
    const { session } = buildSession();
    const { lookAt: _dropped, ...missing } = session.state();
    expect(sessionStateSchema.safeParse(missing).success).toBe(false);
  });
});

describe('a real Vocabulary against vocabularySchema', () => {
  it('validates for an avatar with expressions, overlays and a wardrobe', () => {
    const { session } = buildSession();
    const vocabulary = session.vocabulary();
    expect(vocabulary.expressions.length).toBeGreaterThan(0);
    expect(vocabulary.overlays.length).toBeGreaterThan(0);
    const result = vocabularySchema.safeParse(vocabulary);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data).toEqual(vocabulary);
  });

  it('validates for an avatar with no wardrobe at all', () => {
    const rig = buildRig();
    const director = new Director(buildProfile(rig.root, rig.descriptor));
    const vocabulary = new Session(director).vocabulary();
    expect(vocabulary.wardrobe).toEqual({});
    const result = vocabularySchema.safeParse(vocabulary);
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it('carries every label in both languages, so the client picks rather than the server', () => {
    const { session } = buildSession();
    const vocabulary = session.vocabulary();
    for (const item of [
      ...vocabulary.emotions,
      ...vocabulary.expressions,
      ...vocabulary.overlays,
      ...vocabulary.performances,
      ...vocabulary.gestures,
      ...vocabulary.hops,
      ...vocabulary.wardrobePresets,
    ]) {
      expect(item.label.en, item.id).not.toBe('');
      expect(item.label.ja, item.id).not.toBe('');
    }
    expect(vocabulary.cue.note.en).not.toBe(vocabulary.cue.note.ja);
    expect(vocabulary.pointing.note.en).not.toBe(vocabulary.pointing.note.ja);
  });

  it('refuses a label given in one language only', () => {
    const { session } = buildSession();
    const vocabulary = session.vocabulary();
    const half = {
      ...vocabulary,
      hops: vocabulary.hops.map((hop) => ({ ...hop, label: { ja: hop.label.ja } })),
    };
    expect(vocabularySchema.safeParse(half).success).toBe(false);
  });
});

describe('a real event stream against sessionEventSchema', () => {
  it('validates every event a full turn produces', () => {
    const { session, step } = buildSession();
    session.say({ id: 'turn-3', text: 'あい' });
    session.say({ id: 'turn-4', text: 'うえ' });
    step(4);
    session.clearQueue();
    for (let i = 0; i < 600 && session.busy; i++) step(1);

    const events = session.takeEvents();
    expect(events.length).toBeGreaterThan(3);
    for (const event of events) {
      const result = sessionEventSchema.safeParse(event);
      expect(result.error?.issues ?? []).toEqual([]);
      expect(result.data).toEqual(event);
    }
  });
});

describe('reportBodySchema', () => {
  it('accepts a real report: state, events and the vocabulary riding along', () => {
    const { session, step } = buildSession();
    session.say({ id: 'turn-5', text: 'あい' });
    step(3);
    const body = {
      state: session.state(),
      events: session.takeEvents(),
      vocabulary: session.vocabulary(),
    };
    const result = reportBodySchema.safeParse(body);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data).toEqual(body);
  });

  it('accepts a heartbeat carrying nothing but state', () => {
    const { session } = buildSession();
    expect(reportBodySchema.safeParse({ state: session.state() }).success).toBe(true);
  });

  it('accepts an empty body, since every field is optional', () => {
    expect(reportBodySchema.safeParse({}).success).toBe(true);
  });

  it('rejects a report whose state is malformed', () => {
    expect(reportBodySchema.safeParse({ state: { speaking: 'yes' } }).success).toBe(false);
  });

  it('rejects an events array holding something that is not an event', () => {
    expect(reportBodySchema.safeParse({ events: [{ type: 'turn.exploded' }] }).success).toBe(false);
  });

  it('carries what the document layer is showing alongside the state', () => {
    const { session } = buildSession();
    const body = { state: session.state(), slides: SLIDES };
    const result = reportBodySchema.safeParse(body);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data).toEqual(body);
  });

  it('leaves slides absent for a renderer that has no document layer at all', () => {
    // Absent is how a panel tells "there is nothing to show a document on" from
    // "nothing is up", which are two different things to draw.
    const { session } = buildSession();
    const parsed = reportBodySchema.safeParse({ state: session.state() });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.slides).toBeUndefined();
  });

  it('rejects a report whose slide report is malformed', () => {
    expect(reportBodySchema.safeParse({ slides: { deck: 'intro' } }).success).toBe(false);
  });

  it('carries how the frame is laid out, which no command need ever have asked for', () => {
    // A browser source opened on `?place=bottom-right:0.32x0.6` is showing a
    // corner nothing on the wire put it in, so the report is the only way a
    // control surface finds out.
    const { session } = buildSession();
    const body = { state: session.state(), placement: PLACEMENT };
    const result = reportBodySchema.safeParse(body);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data).toEqual(body);
  });

  it('leaves the placement absent for a renderer that draws only one way', () => {
    const { session } = buildSession();
    const parsed = reportBodySchema.safeParse({ state: session.state() });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.placement).toBeUndefined();
  });

  it('rejects a placement report that answers with the patch it was sent', () => {
    // Half a rectangle is what the last `place` happened to name, and a surface
    // reading it cannot tell a centred anchor from one nobody has mentioned.
    const { avatar: _dropped, ...half } = PLACEMENT;
    expect(reportBodySchema.safeParse({ placement: half }).success).toBe(false);
    expect(
      reportBodySchema.safeParse({
        placement: { ...PLACEMENT, avatar: { anchor: 'bottom-right', width: 0.32 } },
      }).success,
    ).toBe(false);
  });
});

describe('placementReportSchema', () => {
  it('accepts both layers, resolved', () => {
    const result = placementReportSchema.safeParse(PLACEMENT);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data).toEqual(PLACEMENT);
  });

  it('rejects a rectangle missing any field a control would be drawn at', () => {
    for (const key of ['anchor', 'width', 'height', 'margin'] as const) {
      const { [key]: _dropped, ...missing } = PLACEMENT.avatar;
      const result = placementReportSchema.safeParse({ ...PLACEMENT, avatar: missing });
      expect(result.success, key).toBe(false);
    }
    // The document's rectangle answers one question more than the character's.
    const { fit: _fit, ...noFit } = PLACEMENT.slide;
    expect(placementReportSchema.safeParse({ ...PLACEMENT, slide: noFit }).success).toBe(false);
  });

  it('holds the report to the limits the command is held to', () => {
    // Both come off `placementSchema`, so a fraction the wire would refuse
    // cannot come back through the report either — below a tenth of the frame
    // the character is a smudge, and a report saying so is a renderer to fix.
    const under = { ...PLACEMENT, avatar: { ...PLACEMENT.avatar, width: 0.02 } };
    expect(placementReportSchema.safeParse(under).success).toBe(false);
    const over = { ...PLACEMENT, avatar: { ...PLACEMENT.avatar, height: 1.5 } };
    expect(placementReportSchema.safeParse(over).success).toBe(false);
  });

  it('rejects an anchor that is not one of the nine', () => {
    const nowhere = { ...PLACEMENT, avatar: { ...PLACEMENT.avatar, anchor: 'nowhere' } };
    expect(placementReportSchema.safeParse(nowhere).success).toBe(false);
  });
});

describe('slideReportSchema', () => {
  it('accepts a document that is up and drawn', () => {
    const result = slideReportSchema.safeParse(SLIDES);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data).toEqual(SLIDES);
  });

  it('accepts the state of a renderer with nothing up', () => {
    const empty = { deck: null, page: 0, pages: 0, ready: true, error: null };
    expect(slideReportSchema.safeParse(empty).data).toEqual(empty);
  });

  it('carries the page that is still being drawn, which the command cannot say', () => {
    // `ready` is the difference between the page asked for and the page on
    // screen, and it is the only thing an operator holding an arrow key needs.
    const drawing = { ...SLIDES, page: 4, ready: false };
    expect(slideReportSchema.safeParse(drawing).data).toEqual(drawing);
  });

  it('carries why a document is not up, for whoever can put the file back', () => {
    const failed = { deck: 'intro', page: 0, pages: 0, ready: true, error: 'ファイルがありません' };
    expect(slideReportSchema.safeParse(failed).data).toEqual(failed);
  });

  it('rejects a report missing a field a control surface would draw', () => {
    for (const key of ['deck', 'page', 'pages', 'ready', 'error'] as const) {
      const { [key]: _dropped, ...missing } = SLIDES;
      expect(slideReportSchema.safeParse(missing).success, key).toBe(false);
    }
  });
});

describe('deckSchema', () => {
  const DECK = {
    id: 'intro',
    label: same('イントロ'),
    pages: 12,
    bytes: 240_000,
    at: 1_800_000_000,
  };

  it('accepts one document as the server found it on disk', () => {
    const result = deckSchema.safeParse(DECK);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data).toEqual(DECK);
  });

  it('rejects one that does not say how many pages it has', () => {
    // Counted without rasterising anything, so it is known before the document
    // has ever been shown — a listing without it cannot be offered as a choice.
    const { pages: _dropped, ...missing } = DECK;
    expect(deckSchema.safeParse(missing).success).toBe(false);
  });

  it('rejects one with no label to put in front of an operator', () => {
    const { label: _dropped, ...missing } = DECK;
    expect(deckSchema.safeParse(missing).success).toBe(false);
  });
});

describe('decksResponseSchema', () => {
  it('accepts the listing, newest first', () => {
    const response = {
      decks: [
        { id: 'today', label: same('今日'), pages: 4, bytes: 90_000, at: 1_800_000_100 },
        { id: 'intro', label: same('イントロ'), pages: 12, bytes: 240_000, at: 1_800_000_000 },
      ],
    };
    const result = decksResponseSchema.safeParse(response);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data).toEqual(response);
  });

  it('accepts an empty directory', () => {
    expect(decksResponseSchema.safeParse({ decks: [] }).success).toBe(true);
  });

  it('rejects a reply with no list in it', () => {
    expect(decksResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('deckTextResponseSchema', () => {
  it('accepts what a document says, page by page', () => {
    const response = { id: 'intro', pages: 3, from: 1, text: ['こんばんは', '本日の話', 'まとめ'] };
    const result = deckTextResponseSchema.safeParse(response);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data).toEqual(response);
  });

  it('accepts an empty string for a page that is all picture', () => {
    // A gap in the list would be indistinguishable from a page nobody asked
    // for, so a wordless page is present and empty rather than missing.
    const response = { id: 'intro', pages: 3, from: 2, text: ['', 'まとめ'] };
    expect(deckTextResponseSchema.safeParse(response).data).toEqual(response);
  });

  it('rejects a reply that does not say which page the text starts at', () => {
    expect(deckTextResponseSchema.safeParse({ id: 'intro', pages: 3, text: ['あ'] }).success).toBe(
      false,
    );
  });
});

describe('queueRewindSchema', () => {
  it('takes a bare id and rewinds from there, which is what the word means', () => {
    expect(queueRewindSchema.safeParse({ id: 'q1' }).data).toEqual({ id: 'q1', mode: 'from' });
  });

  it('carries the other mode, and the choice about the line on air', () => {
    const body = { id: 'q1', mode: 'one', interrupt: true };
    expect(queueRewindSchema.safeParse(body).data).toEqual(body);
  });

  it('leaves interrupt absent rather than defaulting it', () => {
    // Cutting a character off mid-word is never something to do by accident, so
    // the schema must not decide it on the caller's behalf.
    expect(queueRewindSchema.safeParse({ id: 'q1' }).data?.interrupt).toBeUndefined();
  });

  it('rejects a mode it does not have and a body with no id', () => {
    expect(queueRewindSchema.safeParse({ id: 'q1', mode: 'backwards' }).success).toBe(false);
    expect(queueRewindSchema.safeParse({ mode: 'one' }).success).toBe(false);
  });
});

describe('historyEntrySchema', () => {
  it('accepts a spoken line: the entry it was, plus how it ended', () => {
    const entry = {
      id: 'q1',
      text: 'あい',
      source: 'panel',
      at: 1_800_000_000,
      saidAt: 1_800_000_009,
      interrupted: true,
    };
    const result = historyEntrySchema.safeParse(entry);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data).toEqual(entry);
  });

  it('leaves interrupted absent for a line that was said to the end', () => {
    const parsed = historyEntrySchema.safeParse({ id: 'q1', text: 'あ', at: 1, saidAt: 2 });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.interrupted).toBeUndefined();
  });

  it('rejects one that never says when it was said', () => {
    expect(historyEntrySchema.safeParse({ id: 'q1', text: 'あ', at: 1 }).success).toBe(false);
  });
});

describe('commandRequestSchema', () => {
  it('accepts a single bare command', () => {
    expect(commandRequestSchema.safeParse({ cmd: 'say', text: 'あ' }).data).toEqual({
      cmd: 'say',
      text: 'あ',
    });
  });

  it('accepts several commands under batch, delivered as one round trip', () => {
    const batch = {
      batch: [
        { cmd: 'idle', on: true },
        { cmd: 'emotion', vec: { joy: 1 } },
        { cmd: 'say', id: 'turn-6', text: 'あ' },
      ],
    };
    const result = commandRequestSchema.safeParse(batch);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data).toEqual(batch);
  });

  it('accepts an empty batch', () => {
    expect(commandRequestSchema.safeParse({ batch: [] }).success).toBe(true);
  });

  it('rejects a batch containing one command it does not know', () => {
    expect(
      commandRequestSchema.safeParse({ batch: [{ cmd: 'say' }, { cmd: 'teleport' }] }).success,
    ).toBe(false);
  });

  it('rejects a body that is neither a command nor a batch', () => {
    expect(commandRequestSchema.safeParse({ commands: [{ cmd: 'say' }] }).success).toBe(false);
  });
});

describe('snapshotSchema', () => {
  it('accepts a snapshot carrying a real state and vocabulary', () => {
    const { session, step } = buildSession();
    session.say({ id: 'turn-7', text: 'あい' });
    step(3);
    const snapshot = {
      connected: true,
      viewers: 1,
      seq: 12,
      state: session.state(),
      vocabulary: session.vocabulary(),
      events: session.takeEvents(),
      voice: null,
      tuning: session.tuning(),
      placement: PLACEMENT,
      avatars: [{ id: 'sample', label: same('サンプル') }],
      decks: [
        { id: 'intro', label: same('イントロ'), pages: 12, bytes: 240_000, at: 1_800_000_000 },
      ],
      slides: SLIDES,
      speech: 'ready',
      queue: [],
      paused: false,
      recording: null,
    };
    const result = snapshotSchema.safeParse(snapshot);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data).toEqual(snapshot);
  });

  it('accepts empty state and vocabulary, which is what a server with no viewer has', () => {
    const result = snapshotSchema.safeParse({
      connected: false,
      viewers: 0,
      seq: 0,
      state: {},
      vocabulary: {},
      events: [],
      voice: null,
      tuning: null,
      placement: null,
      avatars: [],
      decks: [],
      slides: null,
      speech: 'absent',
      queue: [],
      paused: false,
      recording: null,
    });
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it('carries the documents on disk, which are a listing rather than vocabulary', () => {
    // They change when somebody saves a file, so they ride on the snapshot the
    // panel already polls and come from the only process that can see the disk.
    const decks = [{ id: 'intro', label: same('イントロ'), pages: 12, bytes: 240_000, at: 1 }];
    const result = snapshotSchema.safeParse({
      connected: true,
      viewers: 1,
      seq: 1,
      state: {},
      vocabulary: {},
      events: [],
      voice: null,
      tuning: null,
      placement: null,
      avatars: [],
      decks,
      slides: null,
      speech: 'absent',
      queue: [],
      paused: false,
      recording: null,
    });
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data?.decks).toEqual(decks);
    // Null until a viewer with a document layer has reported, which is not the
    // same as a viewer reporting that nothing is up.
    expect(result.data?.slides).toBeNull();
  });

  it('rejects a snapshot that says nothing about the documents, the frame or the voice', () => {
    const base = {
      connected: false,
      viewers: 0,
      seq: 0,
      state: {},
      vocabulary: {},
      events: [],
      voice: null,
      tuning: null,
      placement: null,
      avatars: [],
      decks: [],
      slides: null,
      speech: 'absent',
      queue: [],
      paused: false,
      recording: null,
    };
    expect(snapshotSchema.safeParse(base).success).toBe(true);
    for (const key of ['decks', 'slides', 'placement', 'speech'] as const) {
      const { [key]: _dropped, ...missing } = base;
      expect(snapshotSchema.safeParse(missing).success, key).toBe(false);
    }
  });

  it('carries the layout the frame is in, null until a viewer has reported one', () => {
    // Nullable like `tuning` beside it and for the reason it is: the value
    // belongs to whatever is applying it, and a panel drawing its composition
    // controls from its own command history is wrong from the moment it opens.
    const base = {
      connected: true,
      viewers: 1,
      seq: 1,
      state: {},
      vocabulary: {},
      events: [],
      voice: null,
      tuning: null,
      placement: null,
      avatars: [],
      decks: [],
      slides: null,
      speech: 'absent',
      queue: [],
      paused: false,
      recording: null,
    };
    expect(snapshotSchema.safeParse(base).data?.placement).toBeNull();
    const reported = snapshotSchema.safeParse({ ...base, placement: PLACEMENT });
    expect(reported.error?.issues ?? []).toEqual([]);
    expect(reported.data?.placement).toEqual(PLACEMENT);
  });

  it('accepts a partial state, since a stale server withholds fields rather than lying', () => {
    expect(
      snapshotSchema.safeParse({
        connected: false,
        viewers: 1,
        seq: 3,
        state: { speaking: false },
        vocabulary: { cameras: ['face'] },
        voice: null,
        tuning: null,
        placement: null,
        avatars: [],
        decks: [],
        slides: null,
        speech: 'absent',
        queue: [],
        paused: false,
        recording: null,
        events: [],
      }).success,
    ).toBe(true);
  });

  it('rejects a snapshot with no connected flag to branch on', () => {
    expect(
      snapshotSchema.safeParse({ viewers: 0, seq: 0, state: {}, vocabulary: {}, events: [] })
        .success,
    ).toBe(false);
  });
});

describe('eventsResponseSchema', () => {
  it('accepts the snapshot event tail on its own', () => {
    const response = {
      seq: 4,
      events: [
        { type: 'turn.start', turn: 'a', seconds: 1.2, seq: 3, at: 1_700_000_000 },
        { type: 'turn.end', turn: 'a', seq: 4, at: 1_700_000_001 },
      ],
    };
    const result = eventsResponseSchema.safeParse(response);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data).toEqual(response);
  });

  it('accepts an empty tail', () => {
    expect(eventsResponseSchema.safeParse({ seq: 0, events: [] }).success).toBe(true);
  });

  it('rejects a tail with no sequence number to feed back as since', () => {
    expect(eventsResponseSchema.safeParse({ events: [] }).success).toBe(false);
  });
});

describe('streamMessageSchema', () => {
  it('accepts one command frame', () => {
    const frame = { type: 'command', commands: [{ cmd: 'gesture', id: 'wave' }] };
    expect(streamMessageSchema.safeParse(frame).data).toEqual(frame);
  });

  it('accepts a frame carrying no commands', () => {
    expect(streamMessageSchema.safeParse({ type: 'command', commands: [] }).success).toBe(true);
  });

  it('rejects a frame whose type is not the discriminant it declares', () => {
    expect(streamMessageSchema.safeParse({ type: 'state', commands: [] }).success).toBe(false);
  });

  it('rejects a frame carrying a command the renderer does not know', () => {
    expect(
      streamMessageSchema.safeParse({ type: 'command', commands: [{ cmd: 'teleport' }] }).success,
    ).toBe(false);
  });
});
