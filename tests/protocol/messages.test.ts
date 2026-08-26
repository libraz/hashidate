import { describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { Wardrobe } from '@/engine/scene';
import { Session } from '@/engine/session';
import type { WardrobeTable } from '@/engine/types';
import {
  commandRequestSchema,
  eventsResponseSchema,
  reportBodySchema,
  sessionEventSchema,
  sessionStateSchema,
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
    top: { label: 'トップス', items: [{ id: 'shirt', label: 'シャツ', meshes: ['Shirt'] }] },
  },
  presets: { default: { label: '既定', set: { top: 'shirt' } } },
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
    });
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it('accepts a partial state, since a stale server withholds fields rather than lying', () => {
    expect(
      snapshotSchema.safeParse({
        connected: false,
        viewers: 1,
        seq: 3,
        state: { speaking: false },
        vocabulary: { cameras: ['face'] },
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
