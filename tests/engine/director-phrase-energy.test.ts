import { describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { buildRig } from '../helpers/scene';

const DT = 1 / 60;

describe('Director / phrase-scale speech energy', () => {
  it('moves far less between frames than the per-mora form it replaces', () => {
    const rig = buildRig();
    const director = new Director(buildProfile(rig.root, rig.descriptor), undefined, {
      random: () => 0.5,
    });
    director.speak('あいあいあいあいあいあいあいあいあいあいあいあい');
    const end = director.mouth.track?.duration ?? 0;
    let prevNew = 0;
    let prevOld = 0;
    let maxNew = 0;
    let maxOld = 0;
    let first = true;
    for (let t = 0; t < end; t += DT) {
      director.update(DT);
      const mouth = director.mouth;
      const old = mouth.busy * (0.6 + 0.4 * mouth.openness);
      const now = director.body.speechEnergy;
      if (!first && t > 0.5 && t < end - 0.3) {
        maxNew = Math.max(maxNew, Math.abs(now - prevNew));
        maxOld = Math.max(maxOld, Math.abs(old - prevOld));
      }
      first = false;
      prevNew = now;
      prevOld = old;
    }
    expect(maxOld).toBeGreaterThan(0);
    expect(maxNew).toBeLessThan(maxOld / 4);
  });
});
