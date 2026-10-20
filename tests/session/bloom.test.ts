import { describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import { buildProfile } from '@/engine/profile';
import { Session } from '@/engine/session';
import { BLOOM_DEFAULTS, type Bloom, type BloomPatch, type BloomSettings } from '@/engine/types';
import { buildRig } from '../helpers/scene';

function makeSession() {
  const rig = buildRig({ arkit: false });
  const profile = buildProfile(rig.root, rig.descriptor);
  const current: BloomSettings = { ...BLOOM_DEFAULTS };
  const patches: BloomPatch[] = [];
  const bloom: Bloom = {
    setBloom(patch) {
      patches.push(patch);
      Object.assign(current, patch);
    },
    report: () => ({ ...current }),
  };
  const session = new Session(new Director(profile), { bloom });
  return { session, bloom, current, patches };
}

describe('Session bloom', () => {
  it('passes partial changes through and exposes the renderer report', () => {
    const { session, current, patches } = makeSession();
    session.setBloom({ enabled: true, strength: 0.7 });

    expect(patches).toEqual([{ enabled: true, strength: 0.7 }]);
    expect(session.bloom?.report()).toEqual({ ...current });
  });

  it('applies a staged false value when a turn starts', () => {
    const { session, patches } = makeSession();
    session.setBloom({ enabled: true });
    patches.length = 0;

    session.say({ text: 'あ', stage: { bloom: false } });
    session.update(0.3);

    expect(patches).toEqual([{ enabled: false }]);
  });

  it('makes bloom calls harmless when a renderer has no bloom pass', () => {
    const rig = buildRig({ arkit: false });
    const session = new Session(new Director(buildProfile(rig.root, rig.descriptor)));

    expect(session.bloom).toBeNull();
    expect(() => session.setBloom({ enabled: true })).not.toThrow();
    session.say({ text: 'あ', stage: { bloom: false } });
    expect(() => session.update(0.3)).not.toThrow();
  });
});
