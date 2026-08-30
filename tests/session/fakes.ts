import type {
  Composition,
  Placement,
  PlacementReport,
  SlidePlacement,
  SlideReport,
  Slides,
  Take,
  Voice,
  VoiceChainRequest,
  VoiceReport,
} from '@/engine/types';
import { same } from '@/i18n/locale';
import { settle } from './harness';

/**
 * The renderer, as these tests supply it.
 *
 * Every port the session takes is optional and absent on a machine that has no
 * voice, no document layer and no frame layout — which is most of them. These
 * are the stand-ins for the case where one is present, and each keeps a record
 * of what it was handed rather than only the state it ended in: the order
 * calls arrive in is what several of these suites are actually about.
 */
/**
 * A line that has been spoken, on the harness's simulated clock.
 *
 * The rate is a multiplier on how fast that clock runs for *this* take, and it
 * is the only way from out here to tell a mouth driven by the audio from one
 * driven by the frame: in the harness both advance together at 1.0, so a take
 * that runs at half speed is the whole experiment.
 */
export class FakeTake implements Take {
  playedAt: number | null = null;
  stopped = false;
  amplitude = 1;

  constructor(
    readonly seconds: number,
    private readonly now: () => number,
    private readonly rate = 1,
  ) {}

  play(): void {
    this.playedAt = this.now();
  }

  stop(): void {
    this.stopped = true;
  }

  get elapsed(): number {
    if (this.playedAt === null) return 0;
    // Past the end, like a real one: the mouth needs a clock that keeps going
    // to notice that the line is over.
    return (this.now() - this.playedAt) * this.rate;
  }
}

/** A voice that answers immediately with a take of a stated length. */
export class FakeVoice implements Voice {
  readonly asked: string[] = [];
  readonly takes: FakeTake[] = [];
  /** Resolvers for every outstanding request, when `defer` is on. */
  private readonly pending: Array<(take: Take | null) => void> = [];

  constructor(
    private readonly now: () => number,
    private readonly opts: {
      seconds?: number;
      rate?: number;
      defer?: boolean;
      fail?: boolean;
      /** Answer null from this request onward — a sidecar that went away. */
      nullAfter?: number;
    } = {},
  ) {}

  prepare(text: string): Promise<Take | null> {
    this.asked.push(text);
    if (this.opts.fail) return Promise.reject(new Error('no voice'));
    if (this.opts.nullAfter !== undefined && this.asked.length > this.opts.nullAfter) {
      return Promise.resolve(null);
    }
    const take = new FakeTake(this.opts.seconds ?? 1, this.now, this.opts.rate);
    this.takes.push(take);
    if (!this.opts.defer) return Promise.resolve(take);
    return new Promise((resolve) => this.pending.push(resolve));
  }

  /** Answer everything outstanding. */
  answer(): Promise<void> {
    for (const [i, resolve] of this.pending.entries()) resolve(this.takes[i]);
    this.pending.length = 0;
    return settle();
  }

  readonly rooms = [
    { id: 'booth', label: same('ブース') },
    { id: 'hall', label: same('ホール') },
  ];

  /** Every room this was put in, so a test can see what the session forwarded. */
  readonly roomsSet: Array<string | null> = [];

  setRoom(id: string | null): void {
    this.roomsSet.push(id);
  }

  readonly presets = [{ id: 'neutral-monitor', label: same('素のまま') }];

  /** Every chain this was set to, on the same footing as `roomsSet`. */
  readonly chainsSet: VoiceChainRequest[] = [];

  setChain(request: VoiceChainRequest): void {
    this.chainsSet.push(request);
  }

  report(): VoiceReport {
    return {
      preset: this.chainsSet.at(-1)?.preset ?? 'neutral-monitor',
      dsp: null,
      room: this.roomsSet.at(-1) ?? null,
      lufs: null,
      truePeakDb: null,
      blocked: false,
    };
  }
}

/** Let the microtask chain in `synthesise` run to the end. */
/**
 * A document layer that keeps every call it was handed, in order.
 *
 * The order is the thing being tested and a stub that only kept the resulting
 * state could not show it: a line naming a document *and* a page in it has to
 * open the document first, and doing it the other way round turns to a page of
 * the one being replaced before opening the new one at its first.
 *
 * It never opens anything, so `pages` stays 0 — that is what the report says
 * for a document that has not been read, and nothing here depends on the count.
 */
export class FakeSlides implements Slides {
  readonly calls: Array<
    | { call: 'setDeck'; id: string | null; page?: number }
    | { call: 'setSlide'; page: number }
    | { call: 'turnSlide'; by: number }
  > = [];

  private deck: string | null = null;
  private page = 0;

  setDeck(id: string | null, page?: number): void {
    this.calls.push({ call: 'setDeck', id, page });
    this.deck = id;
    this.page = id === null ? 0 : (page ?? 1);
  }

  setSlide(page: number): void {
    this.calls.push({ call: 'setSlide', page });
    this.page = page;
  }

  turnSlide(by: number): void {
    this.calls.push({ call: 'turnSlide', by });
    this.page += by;
  }

  report(): SlideReport {
    return { deck: this.deck, page: this.page, pages: 0, ready: true, error: null };
  }
}

/** A frame layout that keeps every patch it was handed, on the same footing. */
export class FakeComposition implements Composition {
  readonly placements: Array<{ avatar?: Placement; slide?: SlidePlacement }> = [];
  /** Where both layers are, merged as a renderer would merge them. */
  private readonly current: PlacementReport = {
    avatar: { anchor: 'center', width: 1, height: 1, margin: 0 },
    slide: { anchor: 'center', width: 1, height: 1, margin: 0, fit: 'contain' },
  };

  setPlacement(placement: { avatar?: Placement; slide?: SlidePlacement }): void {
    this.placements.push(placement);
    Object.assign(this.current.avatar, placement.avatar);
    Object.assign(this.current.slide, placement.slide);
  }

  report(): PlacementReport {
    return { avatar: { ...this.current.avatar }, slide: { ...this.current.slide } };
  }
}
