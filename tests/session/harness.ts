import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { Wardrobe } from '@/engine/scene';
import { Session } from '@/engine/session';
import type {
  Composition,
  LabelledId,
  SessionEvent,
  SessionEventType,
  Shot,
  Slides,
  Voice,
  WardrobeTable,
} from '@/engine/types';
import { same } from '@/i18n/locale';
import { buildRig } from '../helpers/scene';

/**
 * The turn queue, driven the way the real loop drives it: `session.update(dt)`
 * first, then `director.update(dt)`, at a fixed step. Everything below the
 * session is real — a synthetic rig, a resolved profile and a live director —
 * because the session's contract is with a director and not with a stub of one.
 *
 * One harness, shared by every file in this directory. The suites are split by
 * what they are about — the queue, one turn's aftermath, the idle, the cues,
 * the voice, the staging — and every one of them builds its session the same
 * way, because a difference in how the session was built would be a difference
 * nobody chose.
 */

/** The fixed step the viewer's loop runs at. */
export const DT = 1 / 60;

/** `TURN_GAP` in `session/turns.ts`. */
export const TURN_GAP = 0.28;

/** `IDLE_AFTER` in `session/index.ts`. */
export const IDLE_AFTER = 1.6;

/** `VOICE_WAIT` in `session/turns.ts`. */
export const VOICE_WAIT = 5;

export const FACES = ['F_DOYA', 'F_JITO', 'F_SUYASUYA'];
export const EFFECTS = ['FX_BLUSH', 'FX_TEARS'];

export const WARDROBE: WardrobeTable = {
  slots: {
    top: {
      label: same('トップス'),
      items: [{ id: 'shirt', label: same('シャツ'), meshes: ['Shirt'] }],
    },
  },
  presets: { bare: { label: same('素'), set: { top: null } } },
};

export interface Harness {
  session: Session;
  director: Director;
  /** Simulated seconds since the harness was built. */
  now: () => number;
  /** Advance the loop by `frames` steps of `DT`. */
  step: (frames: number) => void;
  /** Advance until `done()` holds, or fail after `limit` seconds. */
  runUntil: (done: () => boolean, limit?: number) => void;
}

export function build({
  wardrobe = false,
  idle = false,
  voice,
  camera,
  scenery,
  slides,
  composition,
}: {
  wardrobe?: boolean;
  idle?: boolean;
  /** Handed the harness's own clock, so a fake take can run on simulated time. */
  voice?: (now: () => number) => Voice;
  /** The staging hooks a renderer supplies, for the turns that carry a shot. */
  camera?: (shot: Shot) => void;
  scenery?: { backdrops: LabelledId[]; setBackdrop: (id: string | null) => void };
  /** The document layer, absent on every renderer that has none. */
  slides?: Slides;
  composition?: Composition;
} = {}) {
  const rig = buildRig({
    groups: [
      ['Face', FACES],
      ['FX', EFFECTS],
    ],
    garments: ['Shirt'],
  });
  const profile = buildProfile(rig.root, {
    ...rig.descriptor,
    presets: { group: 'Face', emotion: { joy: 'F_DOYA' } },
    overlays: { group: 'FX' },
    ...(wardrobe ? { wardrobe: WARDROBE } : {}),
  });
  const director = new Director(profile);
  let clock = 0;
  const session = new Session(director, {
    wardrobe: wardrobe ? new Wardrobe(rig.root, profile, WARDROBE) : null,
    idle,
    voice: voice?.(() => clock),
    camera,
    scenery,
    slides,
    composition,
  });

  const step = (frames: number): void => {
    for (let i = 0; i < frames; i++) {
      session.update(DT);
      director.update(DT);
      clock += DT;
    }
  };
  const runUntil = (done: () => boolean, limit = 20): void => {
    const cap = Math.ceil(limit / DT);
    for (let i = 0; i < cap; i++) {
      if (done()) return;
      step(1);
    }
    throw new Error('condition never held within the frame budget');
  };

  const harness: Harness = { session, director, now: () => clock, step, runUntil };
  return harness;
}

/** Event types, in emission order. */
export const types = (events: SessionEvent[]): SessionEventType[] => events.map((e) => e.type);

/** One macrotask, for the frame a synthesised take settles on. */
export const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
