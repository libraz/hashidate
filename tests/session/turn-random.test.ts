import { describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import type { ActiveGesture } from '@/engine/motion';
import { buildProfile } from '@/engine/profile';
import { Session } from '@/engine/session';
import type { TurnRequest } from '@/engine/types';
import { splitmix64 } from '../helpers/director-fixtures';
import { buildRig } from '../helpers/scene';

/** A turn gesture at the start and a cued one mid-line, so the stream is drawn twice in order. */
const LINE: TurnRequest = { text: 'あいうえおかき[@gesture peace]くけこさしす', gesture: 'wave' };

/** Every gesture the turn starts, by its variation draws, run at a fixed `dt` for three seconds. */
function play(random: () => number, dt: number, request: TurnRequest) {
  const rig = buildRig();
  const director = new Director(buildProfile(rig.root, rig.descriptor), undefined, { random });
  const session = new Session(director);
  session.say(request);
  const seen: Pick<ActiveGesture, 'id' | 'v' | 'speed'>[] = [];
  let last: ActiveGesture | null = null;
  for (let t = 0; t < 3; t += dt) {
    session.update(dt);
    director.update(dt);
    const g = director.body.gesture;
    if (g && g !== last) seen.push({ id: g.id, v: { ...g.v }, speed: g.speed });
    last = g;
  }
  return seen;
}

describe('Session / turn draws', () => {
  it('plays a turn with an id the same way on every renderer', () => {
    const a = play(splitmix64(1n), 1 / 60, { id: 'q-1', ...LINE });
    const b = play(splitmix64(2n), 1 / 72, { id: 'q-1', ...LINE });
    expect(a.map((g) => g.id)).toEqual(['wave', 'peace']);
    expect(b).toEqual(a);
  });

  it('draws a turn without an id from the global random', () => {
    const seen = play(() => 0.25, 1 / 60, LINE);
    expect(seen[0]).toEqual({
      id: 'wave',
      v: { rate: 0.92 + 0.25 * 0.16, scale: 0.9 + 0.25 * 0.2, side: -1 },
      speed: 0.93 + 0.25 * 0.14,
    });
  });
});
