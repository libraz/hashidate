import { describe, expect, it, vi } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { buildRig } from '../helpers/scene';

const DT = 1 / 60;

/** A director whose body reports the given gesture lids and gaze lid every frame. */
function make(lids: number, gazeLid: number) {
  const rig = buildRig();
  const director = new Director(buildProfile(rig.root, rig.descriptor), undefined, {
    random: () => 0.99,
  });
  vi.spyOn(director.body, 'lids', 'get').mockReturnValue(lids);
  const update = director.body.update.bind(director.body);
  vi.spyOn(director.body, 'update').mockImplementation((...args) => {
    update(...args);
    director.body.gazeLid = gazeLid;
  });
  return director;
}

/** The lid floor after a settle shorter than the first scheduled blink. */
function floor(director: Director): number {
  for (let i = 0; i < 120; i++) director.update(DT);
  return director.blink;
}

describe('Director / gaze lid', () => {
  it('adds the gaze lid to the gesture lids', () => {
    expect(floor(make(0.3, 0.2))).toBeCloseTo(0.5, 2);
  });

  it('raises the floor with no gesture lids at all', () => {
    expect(floor(make(0, 0.2))).toBeCloseTo(0.2, 2);
  });

  it('clips the sum at one', () => {
    expect(floor(make(0.9, 0.5))).toBeCloseTo(1, 3);
  });

  it('adds nothing while surprise holds the eyes open', () => {
    const director = make(0.3, 0.2);
    director.setEmotion({ surprise: 1 });
    expect(floor(director)).toBeCloseTo(0.3, 2);
  });
});
