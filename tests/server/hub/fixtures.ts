import { same } from '@/i18n/locale';
import type {
  BgmReport,
  Deck,
  PlacementReport,
  SessionEvent,
  SessionState,
  SlideReport,
  StreamMessage,
  Vocabulary,
} from '@/protocol';

/**
 * The shapes a renderer reports and a hub fans out.
 *
 * Every suite here builds the same handful of objects, so they are built in one
 * place: a difference between two files in what a "state" or a "vocabulary" is
 * would be a difference nobody chose, and the hub's own behaviour is what is
 * being looked at.
 *
 * The clock is faked in every file for the same reason it was faked in one:
 * freshness and `waitFor` are wall-clock bound, the hub reads `Date.now()` for
 * the `at` stamp and for the staleness cut-off, and a real clock makes those
 * tests either slow or flaky.
 */

/** A fixed point to run the clock from, so `at` stamps are exact. */
export const EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

export const frame = (id: string): StreamMessage => ({
  type: 'command',
  commands: [{ cmd: 'gesture', id }],
});

export const event = (turn: string, type: SessionEvent['type'] = 'turn.end'): SessionEvent => ({
  type,
  turn,
});

/** A minimal but complete state, so the freshness tests carry something real. */
export const state = (over: Partial<SessionState> = {}): SessionState => ({
  speaking: false,
  turn: null,
  queued: 0,
  busy: false,
  idle: false,
  idleEnabled: true,
  emotion: { neutral: 1 },
  expression: null,
  pickedExpression: null,
  overlays: {},
  performance: null,
  gesture: null,
  hopping: false,
  strain: { L: 0, R: 0 },
  lookAt: 1,
  wardrobe: null,
  ...over,
});

/** A complete vocabulary, since a report carries the whole thing or none of it. */
export const vocabulary = (): Vocabulary => ({
  avatar: { id: 'synthetic', label: same('合成リグ') },
  emotions: [{ id: 'joy', label: same('喜') }],
  expressions: [{ id: 'F_DOYA', label: same('F_DOYA') }],
  overlays: [],
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
  ],
  gestures: [{ id: 'wave', label: same('手を振る'), group: 'greeting', sustain: false }],
  hops: [{ id: 'hop', label: same('ぴょん') }],
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
  wardrobe: {},
  wardrobePresets: [],
  rooms: [],
  backdrops: [],
  voicePresets: [],
});

/** One document, as a store would have found it on disk. */
export const deck = (id: string): Deck => ({
  id,
  label: same(`${id}.pdf`),
  pages: 12,
  bytes: 4096,
  at: 1,
});

/** What a renderer with a document layer says about it. */
export const slides = (over: Partial<SlideReport> = {}): SlideReport => ({
  deck: 'intro',
  page: 3,
  pages: 12,
  ready: true,
  error: null,
  ...over,
});

/** And how it is laying the frame out: both rectangles, resolved. */
export const placement = (over: Partial<PlacementReport> = {}): PlacementReport => ({
  avatar: { anchor: 'bottom-right', width: 0.32, height: 0.6, margin: 0.04 },
  slide: { anchor: 'center', width: 1, height: 1, margin: 0, fit: 'contain' },
  ...over,
});

/** A renderer heartbeat, with the mute bit explicit for authority tests. */
export const bgm = (over: Partial<BgmReport> = {}): BgmReport => ({
  revision: 0,
  track: null,
  transport: 'stopped',
  position: 0,
  duration: null,
  muted: false,
  blocked: false,
  error: null,
  dspDegraded: false,
  ...over,
});

/** One inline BGM request as emitted by a session at its mouth-clock cue. */
export const bgmCue = (
  cueId: string,
  action: 'play' | 'pause' | 'stop' = 'play',
  track?: string,
): SessionEvent => ({
  type: 'cue.fire',
  turn: 'turn-1',
  cueId,
  cue:
    action === 'play'
      ? { kind: 'bgm', action, ...(track === undefined ? {} : { track }) }
      : { kind: 'bgm', action },
});
