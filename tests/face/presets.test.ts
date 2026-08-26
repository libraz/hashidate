import { describe, expect, it } from 'vitest';
import { buildOverlays, buildPresets } from '@/engine/face';
import { buildProfile } from '@/engine/profile';
import type { AvatarDescriptor, Profile } from '@/engine/types';
import { buildRig } from '../helpers/scene';

/**
 * The lid measurement is a projection of one morph's deltas onto another's, so
 * the rig has to carry real morph attributes for it to have anything to read.
 * The synthetic rig writes a distinct constant delta per shape index, which
 * makes the expected closure a ratio of the two indices' deltas and therefore
 * checkable by hand.
 */
const FACE_GROUP = 'Face';
const LID_GROUP = 'Lids';

/** The face ids the preset group carries, in authored order. */
const FACE_IDS = ['F_SUYASUYA', 'F_DOYA', 'F_JITO', 'F_NIKO'];

interface RigSetup {
  profile: Profile;
  descriptor: AvatarDescriptor;
}

/**
 * A rig whose blink shapes are ones the avatar names itself, sitting at morph
 * indices whose deltas are larger than the preset shapes' — without that, every
 * preset projects past full closure and clamps to 1, which measures nothing.
 */
function setup(overrides: Partial<AvatarDescriptor> = {}): RigSetup {
  const rig = buildRig({
    arkit: false,
    groups: [
      [LID_GROUP, ['MyLidL', 'MyLidR']],
      [FACE_GROUP, FACE_IDS],
    ],
  });
  const descriptor: AvatarDescriptor = {
    ...rig.descriptor,
    shapes: { blink: { L: ['MyLidL'], R: ['MyLidR'] } },
    ...overrides,
  };
  return { profile: buildProfile(rig.root, descriptor), descriptor };
}

describe('buildPresets', () => {
  it('returns nothing when the avatar declares no preset group', () => {
    const { profile, descriptor } = setup();
    expect(buildPresets(profile, descriptor)).toEqual([]);
  });

  it('returns nothing when no descriptor is supplied at all', () => {
    const { profile } = setup();
    expect(buildPresets(profile)).toEqual([]);
  });

  it('returns nothing when the avatar states it has none', () => {
    const { profile, descriptor } = setup({ presets: null });
    expect(buildPresets(profile, descriptor)).toEqual([]);
  });

  it('returns nothing when the declared group is not on this model', () => {
    const { profile, descriptor } = setup({ presets: { group: 'NoSuchGroup' } });
    expect(buildPresets(profile, descriptor)).toEqual([]);
  });

  it('lists the group in authored order', () => {
    const { profile, descriptor } = setup({ presets: { group: FACE_GROUP } });
    expect(buildPresets(profile, descriptor).map((p) => p.id)).toEqual(FACE_IDS);
  });

  it('drops an excluded id and keeps the rest', () => {
    const { profile, descriptor } = setup({
      presets: { group: FACE_GROUP, exclude: ['F_DOYA'] },
    });
    const ids = buildPresets(profile, descriptor).map((p) => p.id);
    expect(ids).not.toContain('F_DOYA');
    expect(ids).toEqual(FACE_IDS.filter((id) => id !== 'F_DOYA'));
  });

  it('ignores an exclusion for an id the group never had', () => {
    const { profile, descriptor } = setup({
      presets: { group: FACE_GROUP, exclude: ['F_NOT_HERE'] },
    });
    expect(buildPresets(profile, descriptor).map((p) => p.id)).toEqual(FACE_IDS);
  });

  it('falls back to the raw id when the avatar supplies no label', () => {
    const { profile, descriptor } = setup({ presets: { group: FACE_GROUP } });
    for (const preset of buildPresets(profile, descriptor)) expect(preset.label).toBe(preset.id);
  });

  it('applies the avatar label function to every id', () => {
    const { profile, descriptor } = setup({
      presets: { group: FACE_GROUP, label: (id) => id.replace(/^F_/, '').toLowerCase() },
    });
    expect(buildPresets(profile, descriptor).map((p) => p.label)).toEqual([
      'suyasuya',
      'doya',
      'jito',
      'niko',
    ]);
  });

  it('drops an id listed in the group but absent from the mesh', () => {
    const { profile, descriptor } = setup({ presets: { group: FACE_GROUP } });
    // A stale group listing: the id is declared but nothing on the GLB answers
    // to it.
    profile.groups.get(FACE_GROUP)?.push('F_GHOST');
    expect(profile.groups.get(FACE_GROUP)).toContain('F_GHOST');
    expect(buildPresets(profile, descriptor).map((p) => p.id)).toEqual(FACE_IDS);
  });
});

describe('buildPresets / lid closure', () => {
  it('reports a fraction per eye rather than a declared flag', () => {
    const { profile, descriptor } = setup({ presets: { group: FACE_GROUP } });
    const presets = buildPresets(profile, descriptor);
    for (const preset of presets) {
      for (const eye of [preset.lid.L, preset.lid.R]) {
        expect(eye).toBeGreaterThanOrEqual(0);
        expect(eye).toBeLessThanOrEqual(1);
      }
    }
    // Measured, not tabulated: the values differ per preset and at least one
    // sits strictly between wide open and shut.
    const partial = presets.filter((p) => p.lid.L > 0 && p.lid.L < 1);
    expect(partial.length).toBeGreaterThan(0);
    expect(new Set(presets.map((p) => p.lid.L)).size).toBeGreaterThan(1);
  });

  it('measures each eye separately, so an asymmetric face comes out asymmetric', () => {
    const { profile, descriptor } = setup({ presets: { group: FACE_GROUP } });
    const presets = buildPresets(profile, descriptor);
    expect(presets.some((p) => p.lid.L !== p.lid.R)).toBe(true);
  });

  it('projects the preset onto the blink shape, so the ratio of deltas is the closure', () => {
    const { profile, descriptor } = setup({ presets: { group: FACE_GROUP } });
    const face = buildRig({
      arkit: false,
      groups: [
        [LID_GROUP, ['MyLidL', 'MyLidR']],
        [FACE_GROUP, FACE_IDS],
      ],
    }).meshes.get('Face');
    const attrs = face?.geometry.morphAttributes.position;
    const dict = face?.morphTargetDictionary;
    if (!(attrs && dict)) throw new Error('the synthetic face carries no morph attributes');
    const delta = (name: string): number => attrs[dict[name]].getY(0);

    for (const preset of buildPresets(profile, descriptor)) {
      expect(preset.lid.L).toBeCloseTo(Math.min(1, delta(preset.id) / delta('MyLidL')), 6);
      expect(preset.lid.R).toBeCloseTo(Math.min(1, delta(preset.id) / delta('MyLidR')), 6);
    }
  });

  it('reports no closure when the preset lives on a different mesh from the lids', () => {
    // The deltas are only comparable within one mesh, so a face shape the body
    // carries cannot claim the lids.
    const rig = buildRig({
      arkit: false,
      groups: [[LID_GROUP, ['MyLidL', 'MyLidR']]],
      ungrouped: ['___Body___', 'B_HAZUKASHII'],
    });
    const descriptor: AvatarDescriptor = {
      ...rig.descriptor,
      shapes: { blink: { L: ['MyLidL'], R: ['MyLidR'] } },
      presets: { group: 'Body' },
    };
    const profile = buildProfile(rig.root, descriptor);
    expect(buildPresets(profile, descriptor)).toEqual([
      { id: 'B_HAZUKASHII', label: 'B_HAZUKASHII', lid: { L: 0, R: 0 } },
    ]);
  });

  it('reports no closure when the avatar has no blink shapes to measure against', () => {
    const { profile, descriptor } = setup({ presets: { group: FACE_GROUP } });
    profile.blink.L = null;
    profile.blink.R = null;
    for (const preset of buildPresets(profile, descriptor)) {
      expect(preset.lid).toEqual({ L: 0, R: 0 });
    }
  });
});

describe('buildOverlays', () => {
  it('returns nothing when the avatar declares no overlay group', () => {
    const { profile, descriptor } = setup();
    expect(buildOverlays(profile, descriptor)).toEqual([]);
    expect(buildOverlays(profile)).toEqual([]);
  });

  it('returns nothing when the avatar states it has none', () => {
    const { profile, descriptor } = setup({ overlays: null });
    expect(buildOverlays(profile, descriptor)).toEqual([]);
  });

  it('lists the declared group with labels and without lid measurement', () => {
    const { profile, descriptor } = setup({
      overlays: { group: FACE_GROUP, label: (id) => `overlay:${id}` },
    });
    expect(buildOverlays(profile, descriptor)).toEqual(
      FACE_IDS.map((id) => ({ id, label: `overlay:${id}` })),
    );
  });

  it('honours exclude and the id fallback label', () => {
    const { profile, descriptor } = setup({
      overlays: { group: FACE_GROUP, exclude: ['F_SUYASUYA', 'F_NIKO'] },
    });
    expect(buildOverlays(profile, descriptor)).toEqual([
      { id: 'F_DOYA', label: 'F_DOYA' },
      { id: 'F_JITO', label: 'F_JITO' },
    ]);
  });

  it('shares the discovery with presets: the same group yields the same ids', () => {
    const { profile, descriptor } = setup({
      presets: { group: FACE_GROUP },
      overlays: { group: FACE_GROUP },
    });
    expect(buildOverlays(profile, descriptor).map((o) => o.id)).toEqual(
      buildPresets(profile, descriptor).map((p) => p.id),
    );
  });
});
