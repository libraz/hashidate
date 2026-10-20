import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { scaleTrack, textToVisemes, type VisemeTrack } from '@/engine/face';
import type { Take, TurnRequest } from '@/engine/types';
import { FakeVoice } from './fakes';
import { build, DT, type Harness, settle } from './harness';

/**
 * Speech-driven motion wired through a live session: phrase-final nods, the
 * gaze at the ends of a run of lines, and where a run starts and stops.
 */

/** Every take in this file lasts this long, so a line is long enough to avert and to pin. */
const SECONDS = 4;
/** Two sentences, so the first full stop is a major boundary inside the line. */
const TWO_SENTENCES = 'あいうえおかきくけこ。さしすせそたちつてと。';
const LINE = 'あいうえおかきくけこさしすせそたちつてと。';
const ONE_DEGREE = THREE.MathUtils.degToRad(1);
const TIMEOUT = 30_000;

/** A voice that holds every request after the first `holdAfter` until `release`. */
class LateVoice extends FakeVoice {
  holdAfter = Number.POSITIVE_INFINITY;
  private readonly held: Array<() => void> = [];

  override prepare(text: string, reading?: string, signal?: AbortSignal): Promise<Take | null> {
    const take = super.prepare(text, reading, signal);
    if (this.asked.length <= this.holdAfter) return take;
    return new Promise<Take | null>((resolve) => this.held.push(() => resolve(take)));
  }

  release(): Promise<void> {
    for (const answer of this.held) answer();
    this.held.length = 0;
    return settle();
  }
}

/** A session whose voice answers every line with a `SECONDS` take. */
const session4 = (): Harness => build({ voice: (now) => new FakeVoice(now, { seconds: SECONDS }) });

/** Where the track's last mora ends. */
const spokenEnd = ({ events }: VisemeTrack): number => {
  const last = events[events.length - 1];
  return last.t + last.dur;
};

/** The head's world forward below the horizontal, rad; the synthetic rig faces +z. */
const scratchQ = new THREE.Quaternion();
const scratchFwd = new THREE.Vector3();
function headPitchDown(h: Harness): number {
  const head = h.director.p.bones.head;
  if (!head) throw new Error('synthetic rig lacks a head');
  scratchFwd.set(0, 0, 1).applyQuaternion(head.getWorldQuaternion(scratchQ));
  return Math.asin(THREE.MathUtils.clamp(-scratchFwd.y, -1, 1));
}

/** Play one line with `Math.random` pinned, sampling head pitch against the line's clock. */
async function pitchTrace(
  random: number,
  request: TurnRequest,
): Promise<Array<{ t: number; pitch: number }>> {
  const spy = vi.spyOn(Math, 'random').mockReturnValue(random);
  try {
    const h = session4();
    h.session.say({ id: 'line', ...request });
    await settle();
    h.runUntil(() => h.session.turn?.id === 'line', 2);
    const out: Array<{ t: number; pitch: number }> = [];
    while (h.session.turn) {
      out.push({ t: h.director.mouth.time, pitch: headPitchDown(h) });
      h.step(1);
    }
    return out;
  } finally {
    spy.mockRestore();
  }
}

/** The sample at or just past `t`. */
const at = (trace: Array<{ t: number; pitch: number }>, t: number): number =>
  trace.findIndex((s) => s.t >= t);

describe('phrase-final nods', { timeout: TIMEOUT }, () => {
  it('pitches the head down at a major boundary when the nod is drawn', async () => {
    const brk = scaleTrack(textToVisemes(TWO_SENTENCES), SECONDS).breaks[0];
    expect(brk.kind).toBe('major');
    // 0 passes every roll; 0.95 is above every nod rate, so the control never nods.
    const nod = await pitchTrace(0, { text: TWO_SENTENCES });
    const control = await pitchTrace(0.95, { text: TWO_SENTENCES });
    const i = at(nod, brk.t);
    expect(i).toBeGreaterThan(0);
    expect(control[i].t).toBe(nod[i].t);
    expect(nod[i].pitch - control[i].pitch).toBeGreaterThanOrEqual(ONE_DEGREE);
  });

  it('borrows the text breaks for a reading without punctuation, at the mapped time', async () => {
    const reading = 'あいうえおかきくけこさしすせそたちつてと';
    const written = textToVisemes(TWO_SENTENCES);
    const spoken = scaleTrack(textToVisemes(reading), SECONDS);
    expect(spoken.breaks).toEqual([]);
    const mapped = (written.breaks[0].t * spokenEnd(spoken)) / spokenEnd(written);

    const nod = await pitchTrace(0, { text: TWO_SENTENCES, reading });
    const control = await pitchTrace(0.95, { text: TWO_SENTENCES, reading });
    const i = at(nod, mapped);
    expect(nod[i].pitch - control[i].pitch).toBeGreaterThanOrEqual(ONE_DEGREE);
    // The nod peaks on the mapped boundary, not where a whole-length mapping would put it.
    let best = 0;
    for (let k = 0; k < nod.length && nod[k].t < 3; k++) {
      if (nod[k].pitch - control[k].pitch > nod[best].pitch - control[best].pitch) best = k;
    }
    expect(Math.abs(nod[best].t - mapped)).toBeLessThanOrEqual(0.05);
  });

  it('keeps the kind it borrows: an unpaused comma in the text does not nod', async () => {
    const text = 'あいうえおかきくけこ、さしすせそたちつてと。';
    const reading = 'あいうえおかきくけこさしすせそたちつてと';
    expect(textToVisemes(text).breaks[0].kind).toBe('minor');
    // The fake take's envelope never drops, so the comma is weak and draws nothing.
    const nod = await pitchTrace(0, { text, reading });
    const control = await pitchTrace(0.95, { text, reading });
    for (let k = 0; k < nod.length && nod[k].t < 3; k++) {
      expect(Math.abs(nod[k].pitch - control[k].pitch)).toBeLessThan(ONE_DEGREE / 10);
    }
  });
});

describe('the gaze over a run of lines', { timeout: TIMEOUT }, () => {
  it('averts on the first line of a run only, and pins the last to the camera', async () => {
    // 0.6 passes the onset roll (0.731), lands on a side aversion and picks +x.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.6);
    try {
      const h = session4();
      const { session, director } = h;
      session.say({ id: 'l1', text: LINE });
      session.say({ id: 'l2', text: LINE });
      session.say({ id: 'l3', text: LINE });
      await settle();

      const started: Record<string, number> = {};
      let frame = 0;
      let firstPeak = 0;
      let secondPeak = 0;
      let pinnedFrames = 0;
      const cap = Math.ceil(25 / DT);
      while (frame < cap && (session.turn || session.queue.length)) {
        h.step(1);
        frame++;
        const id = session.turn?.id;
        if (!id) continue;
        started[id] ??= frame;
        const since = (frame - started[id]) * DT;
        const g = director.body.gaze;
        if (id === 'l1' && since <= 0.15) firstPeak = Math.max(firstPeak, g.length());
        if (id === 'l2' && since <= 0.5) secondPeak = Math.max(secondPeak, g.length());
        if (id === 'l3' && director.body.speaking && director.body.speechRemaining < 2.26) {
          expect(g.x).toBe(0);
          expect(g.y).toBe(0);
          pinnedFrames++;
        }
      }
      expect(Object.keys(started)).toEqual(['l1', 'l2', 'l3']);
      expect(firstPeak).toBeGreaterThanOrEqual(0.1);
      // The aversion fixations sit at 0.11 and 0.21; the wander at this draw stays well inside.
      expect(secondPeak).toBeLessThan(0.1);
      expect(pinnedFrames).toBeGreaterThan(100);
    } finally {
      spy.mockRestore();
    }
  });

  it('releases the end pin when a line streams in behind, and continues the run', async () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.6);
    try {
      const h = session4();
      const { session, director } = h;
      session.say({ id: 'l1', text: LINE });
      await settle();
      h.runUntil(() => session.turn?.id === 'l1', 2);
      expect(director.speechOpens).toBe(true);
      // Inside the last END_RETURN seconds, before the wander's next draw.
      h.runUntil(() => director.mouth.time >= 1.7, 5);
      expect(director.body.speechCloses).toBe(true);
      expect(director.body.gaze.x).toBe(0);
      expect(director.body.gaze.y).toBe(0);

      session.say({ id: 'l2', text: LINE });
      await settle();
      h.step(1);
      expect(director.speechCloses).toBe(false);
      expect(director.body.speechCloses).toBe(false);
      let away = 0;
      while (session.turn?.id === 'l1') {
        h.step(1);
        away = Math.max(away, director.body.gaze.length());
      }
      expect(away).toBeGreaterThan(0.03);

      h.runUntil(() => session.turn?.id === 'l2', 2);
      expect(director.speechOpens).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('where a run of speech starts', { timeout: TIMEOUT }, () => {
  it('opens a new run for the line said after an interrupt', async () => {
    const h = session4();
    const { session, director } = h;
    session.say({ id: 'l0', text: LINE });
    await settle();
    h.runUntil(() => session.turn?.id === 'l0', 2);
    h.runUntil(() => session.turn === null, 10);
    // Straight after a line ends: the same run.
    session.say({ id: 'l1', text: LINE });
    await settle();
    h.runUntil(() => session.turn?.id === 'l1', 2);
    expect(director.speechOpens).toBe(false);

    h.step(Math.round(1 / DT));
    session.interrupt();
    session.say({ id: 'l2', text: LINE });
    await settle();
    h.runUntil(() => session.turn?.id === 'l2', 2);
    expect(director.speechOpens).toBe(true);
  });

  it('counts from when a line was queued, so a slow synthesis does not open a run', async () => {
    const voices: LateVoice[] = [];
    const h = build({
      voice: (now) => {
        const voice = new LateVoice(now, { seconds: SECONDS });
        voice.holdAfter = 1;
        voices.push(voice);
        return voice;
      },
    });
    const { session, director } = h;
    session.say({ id: 'l1', text: LINE });
    await settle();
    h.runUntil(() => session.turn?.id === 'l1', 2);
    h.runUntil(() => session.turn === null, 10);

    h.step(Math.round(0.5 / DT));
    session.say({ id: 'l2', text: LINE });
    await settle();
    h.step(Math.round(0.7 / DT));
    expect(session.turn).toBeNull();
    await voices[0].release();
    h.runUntil(() => session.turn?.id === 'l2', 2);
    expect(director.speechOpens).toBe(false);
  });

  it('opens a new run for a line queued a second or more after the last one ended', async () => {
    const h = session4();
    const { session, director } = h;
    session.say({ id: 'l1', text: LINE });
    await settle();
    h.runUntil(() => session.turn?.id === 'l1', 2);
    h.runUntil(() => session.turn === null, 10);

    h.step(Math.round(1.2 / DT));
    session.say({ id: 'l2', text: LINE });
    await settle();
    h.runUntil(() => session.turn?.id === 'l2', 2);
    expect(director.speechOpens).toBe(true);
  });
});
