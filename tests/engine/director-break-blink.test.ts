import { describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { buildRig } from '../helpers/scene';

const DT = 1 / 60;
const HIT = 0.3;
const MISS = 0.99;

/** Eight morae (1.08 s), a major break, then five more: well clear of the 2.5 s first blink. */
const PUNCTUATED = 'あいうえおあいう。あいうえお';
const BREAK_AT = 8 * 0.135;
/** No punctuation: the only blink opportunity is the end of the line, 1.35 s in. */
const UNPUNCTUATED = 'あいうえおあいうえお';
const END_AT = 10 * 0.135;

function setup(value: number) {
  const rig = buildRig();
  let draws = 0;
  const director = new Director(buildProfile(rig.root, rig.descriptor), undefined, {
    random: () => {
      draws++;
      return value;
    },
  });
  return { director, draws: () => draws };
}

/** Blink weight per frame until `seconds` of speech, with the frame the mouth clock first reached `at`. */
function run(director: Director, at: number, seconds: number) {
  const weights: number[] = [];
  let crossing = -1;
  for (let i = 0; weights.length < seconds / DT; i++) {
    director.update(DT);
    weights.push(director.blink);
    if (crossing < 0 && director.mouth.time >= at) crossing = i;
  }
  return { weights, crossing };
}

describe('Director / blink at a phrase end', () => {
  it('starts a blink as the mouth clock crosses a major break when the draw hits', () => {
    const { director } = setup(HIT);
    director.speak(PUNCTUATED);
    const { weights, crossing } = run(director, BREAK_AT, 1.5);
    expect(crossing).toBeGreaterThan(0);
    expect(weights.slice(0, crossing).every((w) => w === 0)).toBe(true);
    expect(weights[crossing] > 0 || weights[crossing + 1] > 0).toBe(true);
  });

  it('starts one at the end of an unpunctuated line', () => {
    const { director } = setup(HIT);
    director.speak(UNPUNCTUATED);
    const { weights, crossing } = run(director, END_AT, 1.6);
    expect(weights.slice(0, crossing).every((w) => w === 0)).toBe(true);
    expect(weights[crossing] > 0 || weights[crossing + 1] > 0).toBe(true);
  });

  it('does not blink at a break when the draw misses', () => {
    const { director } = setup(MISS);
    director.speak(PUNCTUATED);
    const { weights } = run(director, BREAK_AT, 2.3);
    expect(weights.every((w) => w === 0)).toBe(true);
  });

  it('draws nothing for breaks once the track is gone', () => {
    const idle = setup(HIT);
    const stopped = setup(HIT);
    stopped.director.speak(PUNCTUATED);
    stopped.director.mouth.stop();
    const before = stopped.draws();
    for (let i = 0; i < 120; i++) {
      idle.director.update(DT);
      stopped.director.update(DT);
    }
    expect(stopped.draws() - before).toBe(idle.draws());
  });
});
