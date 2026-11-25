import { describe, expect, it } from 'vitest';
import { Mouth, textToVisemes } from '@/engine/face';

const DT = 1 / 60;
const LONG = 0.2;

function mouth(): Mouth {
  const m = new Mouth();
  m.schedule(textToVisemes('あいうえおかきくけこ'));
  return m;
}

describe('Mouth / elapsed', () => {
  it('advances an unsynced track clock by elapsed', () => {
    const m = mouth();
    m.update(DT, LONG);
    expect(m.time).toBeCloseTo(LONG, 12);
    m.update(DT);
    expect(m.time).toBeCloseTo(LONG + DT, 12);
  });

  it('adds only dt on top of a sync, and only for the update right after it', () => {
    const m = mouth();
    m.sync(0.3);
    m.update(DT, LONG);
    expect(m.time).toBeCloseTo(0.3 + DT, 12);
    m.update(DT, LONG);
    expect(m.time).toBeCloseTo(0.3 + DT + LONG, 12);
  });

  it('smooths the shapes on dt whatever clock moved the track', () => {
    const byElapsed = mouth();
    byElapsed.update(DT, LONG);
    const bySync = mouth();
    bySync.sync(LONG - DT);
    bySync.update(DT);
    expect(byElapsed.weights).toEqual(bySync.weights);
    const byLongStep = mouth();
    byLongStep.update(LONG);
    expect(byLongStep.weights).not.toEqual(byElapsed.weights);
  });
});
