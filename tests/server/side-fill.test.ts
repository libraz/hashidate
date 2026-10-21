import { describe, expect, it } from 'vitest';
import type { Command, StreamMessage } from '@/protocol';
import { Hub } from '@/server/hub';
import { TurnQueue } from '@/server/queue';
import { withSide } from '@/server/side';

/** Alternates: first draw lands on 'L', second on 'R'. */
const alternating = () => {
  let n = 0;
  return () => (n++ % 2 === 0 ? 0.1 : 0.9);
};

describe('withSide', () => {
  it('fills a gesture, and a performance that names a gesture', () => {
    expect(withSide({ cmd: 'gesture', id: 'wave' }, () => 0.1)).toEqual({
      cmd: 'gesture',
      id: 'wave',
      side: 'L',
    });
    expect(withSide({ cmd: 'perform', id: 'doze' }, () => 0.9)).toMatchObject({ side: 'R' });
  });

  it('leaves an explicit side, a release, a gestureless performance and other commands alone', () => {
    const never = () => {
      throw new Error('drew');
    };
    const kept = { cmd: 'gesture', id: 'wave', side: 'R' } as const;
    expect(withSide(kept, never)).toBe(kept);
    const release = { cmd: 'gesture' } as const;
    expect(withSide(release, never)).toBe(release);
    const calm = { cmd: 'perform', id: 'calm' } as const;
    expect(withSide(calm, never)).toBe(calm);
    const point = { cmd: 'point', azimuth: 10 } as const;
    expect(withSide(point, never)).toBe(point);
  });

  it('fills a turn only when it names a movement', () => {
    expect(withSide({ text: 'a', gesture: 'wave' }, () => 0.1)).toMatchObject({ side: 'L' });
    expect(withSide({ text: 'a', perform: 'doze' }, () => 0.1)).toMatchObject({ side: 'L' });
    expect(withSide({ text: 'a' }, () => 0.1)).not.toHaveProperty('side');
    expect(withSide({ text: 'a', perform: 'calm' }, () => 0.1)).not.toHaveProperty('side');
  });
});

describe('the server draws the side once', () => {
  it('hands every renderer the same side for one command', () => {
    const hub = new Hub(null, null, null, null, null, undefined, alternating());
    const heard: Command[][] = [[], [], []];
    heard.forEach((log, i) => {
      hub.subscribe((m: StreamMessage) => log.push(...m.commands), `r${i}`);
    });
    hub.command([{ cmd: 'gesture', id: 'wave' }]);
    const sides = heard.map((log) => log.find((c) => c.cmd === 'gesture'));
    expect(sides.map((c) => (c as { side?: string }).side)).toEqual(['L', 'L', 'L']);
  });

  it('fills the turns a queue holds and the list it publishes', () => {
    const queue = new TurnQueue(alternating());
    queue.say({ text: 'a', gesture: 'wave' });
    queue.add([{ text: 'b', perform: 'doze' }, { text: 'c' }]);
    expect(queue.list().map((e) => e.side)).toEqual(['L', 'R', undefined]);
    const [first] = queue.list();
    queue.replace([{ id: first.id, text: 'a', gesture: 'wave' }]);
    expect(queue.list()[0].side).toBe('L');
    expect(queue.command()).toMatchObject({ turns: [{ side: 'L' }] });
  });
});
