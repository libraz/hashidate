import { describe, expect, it } from 'vitest';
import { BLOOM_DEFAULTS, type BloomSettings } from '@/engine/types';
import { type StreamMessage, snapshotSchema } from '@/protocol';
import { Hub } from '@/server/hub';

describe('reported bloom settings', () => {
  it('starts unknown, retains the latest complete report, and tolerates omitted reports', () => {
    const hub = new Hub();
    expect(hub.snapshot().bloom).toBeNull();
    expect(snapshotSchema.safeParse(hub.snapshot()).success).toBe(true);

    const settings: BloomSettings = { ...BLOOM_DEFAULTS, enabled: true, strength: 0.8 };
    hub.report({ bloom: settings });
    expect(hub.snapshot().bloom).toEqual(settings);
    const legacy = { ...hub.snapshot() };
    delete (legacy as Partial<typeof legacy>).bloom;
    expect(snapshotSchema.safeParse(legacy).success).toBe(true);

    hub.report({});
    expect(hub.snapshot().bloom).toEqual(settings);
  });

  it('replays folded bloom settings, including an explicit off, to a late renderer', () => {
    const hub = new Hub();
    hub.send({
      type: 'command',
      commands: [
        { cmd: 'bloom', enabled: true, strength: 1.3 },
        { cmd: 'bloom', radius: 0.7 },
        { cmd: 'bloom', enabled: false },
      ],
    });
    const messages: StreamMessage[] = [];
    hub.subscribe((message) => messages.push(message));

    expect(messages[0]?.commands).toEqual([
      { cmd: 'bloom', enabled: false, strength: 1.3, radius: 0.7 },
      { cmd: 'queue', turns: [] },
    ]);
  });
});
