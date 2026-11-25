import { describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { buildRig } from '../helpers/scene';

const DT = 1 / 60;

/** Count the frames on which the body is told a phrase began. */
function onsets(text: string, reading?: string): number {
  const rig = buildRig();
  const director = new Director(buildProfile(rig.root, rig.descriptor), undefined, {
    random: () => 0.99,
  });
  director.speak(text, reading);
  const end = director.mouth.track?.duration ?? 0;
  let count = 0;
  for (let t = 0; t < end + 0.5; t += DT) {
    director.update(DT);
    if (director.body.speechOnset) count++;
  }
  return count;
}

describe('Director / phrase onsets for the arm beat', () => {
  it('signals once per phrase head, the line start included', () => {
    expect(onsets('あいうえおあいう。あいうえお')).toBe(2);
  });

  it('signals once for an unpunctuated line', () => {
    expect(onsets('あいうえおあいうえお')).toBe(1);
  });

  it('counts a minor break as inside its phrase', () => {
    expect(onsets('あいうえお、あいうえお')).toBe(1);
  });

  it('borrows the written text breaks for a reading', () => {
    expect(onsets('あいうえおあいう。あいうえお', 'あいうえおあいうあいうえお')).toBe(2);
  });

  it('never signals with nothing spoken', () => {
    const rig = buildRig();
    const director = new Director(buildProfile(rig.root, rig.descriptor));
    for (let i = 0; i < 30; i++) {
      director.update(DT);
      expect(director.body.speechOnset).toBe(false);
    }
  });
});
