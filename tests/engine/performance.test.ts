import { describe, expect, it } from 'vitest';
import { EMOTIONS } from '@/engine/face';
import { GESTURES, type GestureId, HOPS } from '@/engine/motion';
import {
  holdsUntilReleased,
  PERFORMANCE_GROUPS,
  PERFORMANCE_IDS,
  PERFORMANCE_TABLE,
  PERFORMANCES_BY_GROUP,
  performanceDef,
} from '@/engine/performance';
import type { EmotionName, GestureDef } from '@/engine/types';

/**
 * Table invariants for the performance vocabulary.
 *
 * Nothing here poses a rig. What these check is that a performance cannot be
 * added wrong — naming a gesture that does not exist, an emotion outside the
 * canonical set, a group that is not a group — and the one property that makes
 * the table a *vocabulary* rather than a shortlist: that it covers the whole
 * gesture table.
 */

const GESTURE_TABLE: Record<GestureId, GestureDef> = GESTURES;
const GESTURE_IDS = Object.keys(GESTURE_TABLE) as GestureId[];
const EMOTION_NAMES = Object.keys(EMOTIONS) as EmotionName[];

const each = <T>(rows: T[]) => it.each(rows);

describe('the performance table', () => {
  it('files every entry under its own id and a group that exists', () => {
    expect(PERFORMANCE_IDS.length).toBeGreaterThan(20);
    expect(new Set(PERFORMANCE_IDS).size).toBe(PERFORMANCE_IDS.length);
    for (const id of PERFORMANCE_IDS) {
      expect(Object.keys(PERFORMANCE_GROUPS)).toContain(PERFORMANCE_TABLE[id].group);
    }
  });

  each(PERFORMANCE_IDS)('%s has a label and a usable mood', (id) => {
    const def = PERFORMANCE_TABLE[id];
    expect(def.label.length).toBeGreaterThan(0);
    const weights = Object.entries(def.emotion);
    expect(weights.length).toBeGreaterThan(0);
    for (const [name, weight] of weights) {
      // Outside the canonical set the whole blend is rejected by the wire
      // schema, so a typo here would silently cost the caller the command.
      expect(EMOTION_NAMES).toContain(name as EmotionName);
      expect(weight).toBeGreaterThan(0);
      expect(weight).toBeLessThanOrEqual(1);
    }
  });

  each(PERFORMANCE_IDS)('%s names only motion that exists', (id) => {
    const def = PERFORMANCE_TABLE[id];
    if (def.gesture) expect(GESTURE_IDS).toContain(def.gesture);
    if (def.hop) expect(Object.keys(HOPS)).toContain(def.hop);
    if (def.droop !== undefined) {
      expect(def.droop).toBeGreaterThan(0);
      expect(def.droop).toBeLessThanOrEqual(1);
    }
    if (def.look !== undefined) {
      expect(def.look).toBeGreaterThanOrEqual(0);
      expect(def.look).toBeLessThanOrEqual(1);
    }
  });

  /**
   * The property that makes this a vocabulary.
   *
   * A gesture with no performance naming it is one the autopilot will
   * eventually play deadpan — the arms do something and the face is whatever it
   * happened to be. That is the exact failure the layer exists to remove, so a
   * gesture added to the table without a face to go with it fails here rather
   * than showing up on a stream weeks later.
   */
  it('covers every gesture in the gesture table', () => {
    const used = new Set(PERFORMANCE_IDS.map((id) => PERFORMANCE_TABLE[id].gesture));
    const orphans = GESTURE_IDS.filter((id) => !used.has(id));
    expect(orphans).toEqual([]);
  });

  it('has a face-only entry in every group that an idle can rest on', () => {
    // The `mood` rows are what stop the autopilot gesturing continuously; if
    // they all grew a gesture the idle would have nowhere to stand still.
    const still = PERFORMANCE_IDS.filter((id) => !PERFORMANCE_TABLE[id].gesture);
    expect(still.length).toBeGreaterThan(3);
  });

  it('makes each hop pattern reachable by name', () => {
    const used = new Set(PERFORMANCE_IDS.map((id) => PERFORMANCE_TABLE[id].hop).filter(Boolean));
    // Not every pattern needs a performance — `leap` leaves a bust framing and
    // is there for the tuning panel — but the bounce is the one the whole hop
    // run exists for, and something has to ask for it.
    expect(used.has('bounce')).toBe(true);
  });
});

describe('holdsUntilReleased', () => {
  it('is true exactly when there is something to put back', () => {
    for (const id of PERFORMANCE_IDS) {
      const def = PERFORMANCE_TABLE[id];
      const outstanding =
        (!!def.gesture && !!GESTURE_TABLE[def.gesture].sustain) ||
        !!def.overlay?.length ||
        def.droop !== undefined ||
        def.look !== undefined;
      expect(holdsUntilReleased(def)).toBe(outstanding);
    }
  });

  it('follows the gesture table rather than a flag of its own', () => {
    // `bored` rests a cheek on a hand and holds; `agree` nods and is over. The
    // difference is stated once, in the gesture table.
    expect(GESTURE_TABLE[PERFORMANCE_TABLE.bored.gesture as GestureId].sustain).toBe(true);
    expect(holdsUntilReleased(PERFORMANCE_TABLE.bored)).toBe(true);
    expect(holdsUntilReleased(PERFORMANCE_TABLE.agree)).toBe(false);
  });

  it('holds a face-only entry that closes the eyes', () => {
    // Nothing about `doze` is a pose in the gesture-table sense on the face
    // side, and it still cannot be left to expire: lids do not reopen on a
    // timer.
    expect(PERFORMANCE_TABLE.doze.droop).toBeGreaterThan(0.5);
    expect(holdsUntilReleased(PERFORMANCE_TABLE.doze)).toBe(true);
  });
});

describe('performanceDef', () => {
  it('answers for a real id and null for anything else', () => {
    expect(performanceDef('happy')).toBe(PERFORMANCE_TABLE.happy);
    // `toString` and friends are here because a plain `in` or a truthy lookup
    // would answer yes for every one of them.
    for (const junk of ['', 'Happy', 'teleport', 'toString', 'constructor', '__proto__']) {
      expect(performanceDef(junk)).toBeNull();
    }
  });
});

describe('PERFORMANCES_BY_GROUP', () => {
  it('lists the groups in the order the group table declares them', () => {
    expect(PERFORMANCES_BY_GROUP.map((g) => g.key)).toEqual(Object.keys(PERFORMANCE_GROUPS));
    for (const entry of PERFORMANCES_BY_GROUP) {
      expect(entry.label).toBe(PERFORMANCE_GROUPS[entry.key]);
      expect(entry.ids.length).toBeGreaterThan(0);
    }
  });

  it('covers every performance exactly once, under its own group', () => {
    const listed = PERFORMANCES_BY_GROUP.flatMap((g) => g.ids);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...PERFORMANCE_IDS].sort());
    for (const entry of PERFORMANCES_BY_GROUP) {
      for (const id of entry.ids) expect(PERFORMANCE_TABLE[id].group).toBe(entry.key);
    }
  });
});

describe('the entries the brief named', () => {
  it('makes being pleased three small hops rather than one big one', () => {
    const happy = PERFORMANCE_TABLE.happy;
    expect(happy.emotion.joy).toBeGreaterThan(0.8);
    expect(happy.hop).toBe('bounce');
    expect(HOPS.bounce.count).toBe(3);
    expect(HOPS.bounce.height).toBeLessThan(HOPS.hop.height);
  });

  it('builds falling asleep out of a held pose, a soft mood and closed eyes', () => {
    const doze = PERFORMANCE_TABLE.doze;
    expect(doze.gesture).toBe('doze');
    expect(GESTURE_TABLE.doze.sustain).toBe(true);
    expect(doze.emotion.relaxed).toBeGreaterThan(0.5);
    expect(doze.droop).toBeGreaterThan(0.5);
    // The gaze has to let go too, or the head keeps being pulled back up to
    // the camera and the pose visibly fights the tracking.
    expect(doze.look).toBe(0);
  });

  it('keeps a mid-stream yawn awake, and distinct from falling asleep', () => {
    const sleepy = PERFORMANCE_TABLE.sleepy;
    expect(sleepy.gesture).toBe('yawn');
    expect(sleepy.droop).toBeLessThan(0.5);
    expect(sleepy.look).toBeUndefined();
  });
});
