import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASE_POSE } from '@/engine/motion/gestures';
import { heldTime } from '@/engine/motion/timing';
import type { GestureDef, GesturePhase, Side } from '@/engine/types';
import { DT, harness } from './harness';

type Interruption = 'none' | 'stop' | 'handoff';

interface Scenario {
  authoredLead: 0.2 | 1.5;
  random: 0 | 1;
  side: Side;
  interruption: Interruption;
}

interface BuildSample {
  t: number;
  phase: GesturePhase | undefined;
  movement: number;
}

const DWELL = 0.2;
const SUBMOVEMENT = 0.68;

/** Pairwise across lead, playback speed, pinned side and interruption. */
const SCENARIOS: Scenario[] = [
  { authoredLead: 0.2, random: 0, side: 'L', interruption: 'none' },
  { authoredLead: 0.2, random: 1, side: 'R', interruption: 'stop' },
  { authoredLead: 1.5, random: 0, side: 'R', interruption: 'handoff' },
  { authoredLead: 1.5, random: 1, side: 'L', interruption: 'none' },
  { authoredLead: 0.2, random: 0, side: 'R', interruption: 'handoff' },
  { authoredLead: 1.5, random: 1, side: 'R', interruption: 'stop' },
  { authoredLead: 0.2, random: 1, side: 'L', interruption: 'handoff' },
  { authoredLead: 1.5, random: 0, side: 'L', interruption: 'stop' },
  { authoredLead: 0.2, random: 1, side: 'R', interruption: 'none' },
];

const ease = (t: number, duration: number): number => {
  const x = Math.min(1, Math.max(0, t / duration));
  return x * x * (3 - 2 * x);
};

const farPose = (movement: number) => {
  const arm = () => ({
    upperArm: BASE_POSE.upperArm.clone().negate(),
    lowerArm: BASE_POSE.lowerArm.clone().negate(),
    hand: BASE_POSE.hand.clone().negate(),
  });
  return {
    arms: { L: arm(), R: arm() },
    spine: { chest: [0.1 * movement, 0, 0] as [number, number, number] },
  };
};

const delayedFarGesture = (authoredLead: number, samples: BuildSample[]): GestureDef => ({
  label: { en: 'Delayed far pose', ja: '遠い遅延ポーズ' },
  group: 'pose',
  lead: authoredLead,
  hold: 2,
  sustain: true,
  build(t, _v, phase?: GesturePhase) {
    const held = heldTime(t, authoredLead, phase);
    const movement = ease(held - DWELL, SUBMOVEMENT);
    samples.push({ t, phase: phase ? { ...phase } : undefined, movement });
    return farPose(movement);
  },
});

const step = (h: ReturnType<typeof harness>): void => {
  h.rig.reset();
  h.body.update(DT);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gesture slot phase clock', () => {
  it.each(SCENARIOS)(
    'waits for the actual entrance and dwell with $authoredLead lead, speed draw $random, side $side, then $interruption',
    ({ authoredLead, random, side, interruption }) => {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      const h = harness();
      step(h);

      const samples: BuildSample[] = [];
      const def = delayedFarGesture(authoredLead, samples);
      h.body.playDef(def, 'delayed-far', side);
      const slot = h.body.gesture;
      if (!slot) throw new Error('gesture did not start');
      const { lead, speed } = slot;
      expect(lead).toBeGreaterThan(0.68);
      expect(speed).toBeCloseTo(random === 0 ? 0.93 : 1.07, 12);
      expect(slot.v.side).toBe(side === 'R' ? 1 : -1);
      samples.length = 0; // Ignore the distance probe at build time zero.

      let frames = 0;
      const advance = () => {
        step(h);
        frames++;
      };
      const interruptionAt = lead + (DWELL * 0.5) / speed;
      while (frames * DT < interruptionAt) advance();

      const beforeInterruption = samples.at(-1);
      const heldBeforeInterruption = beforeInterruption?.phase?.held ?? 0;
      expect(beforeInterruption?.phase).toBeDefined();
      expect(heldBeforeInterruption).toBeLessThan(DWELL);
      const samplesAtInterruption = samples.length;
      const incomingSamples: BuildSample[] = [];

      if (interruption === 'stop') {
        h.body.stopGesture();
      } else if (interruption === 'handoff') {
        const incoming: GestureDef = {
          label: { en: 'Incoming', ja: '次のポーズ' },
          group: 'pose',
          lead: 0.1,
          hold: 1,
          build(t, _v, phase?: GesturePhase) {
            incomingSamples.push({ t, phase: phase ? { ...phase } : undefined, movement: 0 });
            return {};
          },
        };
        h.body.playDef(incoming, 'incoming', side);
        incomingSamples.length = 0; // Ignore its distance probe.
      }

      const afterDwell = lead + (DWELL + 0.12) / speed;
      while (frames * DT < afterDwell) advance();

      const missingPhase = samples.filter((sample) => sample.phase === undefined);
      expect(missingPhase).toEqual([]);
      for (const sample of samples) {
        const phase = sample.phase;
        if (!phase) continue;
        const elapsed = sample.t / speed;
        expect(phase.entrance).toBeCloseTo(Math.min(1, elapsed / lead), 10);
        expect(phase.held).toBeCloseTo(Math.max(0, elapsed - lead) * speed, 10);
        if (phase.held <= DWELL) expect(sample.movement).toBe(0);
      }

      const earlyDeparture = samples.find(
        (sample) => sample.movement > 0 && sample.t / speed < lead + DWELL / speed,
      );
      expect(earlyDeparture).toBeUndefined();
      expect(samples.some((sample) => sample.movement > 0)).toBe(true);

      const oldBefore = heldBeforeInterruption;
      const oldAfter = samples
        .slice(samplesAtInterruption)
        .find((sample) => sample.phase && sample.phase.held > oldBefore);
      expect(oldAfter).toBeDefined();
      if (interruption === 'handoff') {
        expect(incomingSamples[0]?.phase?.entrance).toBeCloseTo(DT / 0.1, 10);
        expect(incomingSamples[0]?.phase?.held).toBe(0);
      }
    },
  );
});
