import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProfile } from '@/engine/profile';
import { Wardrobe } from '@/engine/scene/wardrobe';
import type { Profile, WardrobeTable } from '@/engine/types';
import { same } from '@/i18n/locale';
import { buildRig, type SyntheticRig } from '../helpers/scene';

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the rig has no ${what}`);
  return value;
}

/**
 * A rig whose garments carry every name shape the exporter produces, and whose
 * face carries the hide shapes alongside its expression shapes.
 */
function dressedRig(): SyntheticRig {
  return buildRig({
    // "Tops__Cotton" is a multi-material split, "Pillow_1" a glTF name clash
    // with the bone of the same name, "Skirt_Long" a different garment whose
    // name merely starts the same way.
    garments: ['Tops__Cotton', 'Cardigan', 'Skirt', 'Skirt_Long', 'Pillow_1'],
    groups: [['HIDE', ['NeckHide', 'BustHide']]],
  });
}

const TABLE: WardrobeTable = {
  slots: {
    top: {
      label: same('Tops'),
      items: [
        { id: 'camisole', label: same('Camisole'), meshes: ['Tops'], hide: ['NeckHide'] },
        { id: 'blouse', label: same('Blouse'), meshes: ['Cardigan'], hide: ['BustHide'] },
      ],
    },
    bottom: {
      label: same('Bottoms'),
      items: [{ id: 'skirt', label: same('Skirt'), meshes: ['Skirt'] }],
    },
    prop: {
      label: same('Prop'),
      items: [{ id: 'pillow', label: same('Pillow'), meshes: ['Pillow'] }],
    },
  },
  presets: {
    default: { label: same('Default'), set: { top: 'camisole', bottom: 'skirt' } },
    bare: { label: same('Bare'), set: { top: null, bottom: null, prop: null } },
    lounging: { label: same('Lounging'), set: { top: 'blouse', bottom: null, prop: 'pillow' } },
  },
  note: same('synthetic'),
};

interface Fixture {
  rig: SyntheticRig;
  profile: Profile;
  wardrobe: Wardrobe;
  mesh: (name: string) => THREE.Mesh;
  influence: (meshName: string, shape: string) => number;
}

function dress(table: WardrobeTable = TABLE): Fixture {
  const rig = dressedRig();
  const profile = buildProfile(rig.root, rig.descriptor);
  const wardrobe = new Wardrobe(rig.root, profile, table);
  const mesh = (name: string) => must(rig.meshes.get(name), name) as THREE.Mesh;
  const influence = (meshName: string, shape: string) => {
    const m = mesh(meshName);
    const index = must(m.morphTargetDictionary, `${meshName} dict`)[shape];
    return must(m.morphTargetInfluences, `${meshName} influences`)[index];
  };
  return { rig, profile, wardrobe, mesh, influence };
}

const CUFFS = ['Cuff_L1', 'Cuff_L2', 'Cuff_R1', 'Cuff_R2'];

/** An outfit table whose main item wears `extras` beside its dress, over a rig that has every mesh. */
function outfits(extras: string[]) {
  const table: WardrobeTable = {
    slots: {
      outfit: {
        label: same('Outfit'),
        items: [
          { id: 'main', label: same('Main'), meshes: ['Main_Dress', ...extras] },
          { id: 'separates', label: same('Separates'), meshes: ['Separates_Top'] },
          { id: 'layered', label: same('Layered'), meshes: ['Separates_Top', 'Cape_Shell'] },
        ],
      },
    },
    presets: { default: { label: same('Default'), set: { outfit: 'main' } } },
  };
  const garments = [
    ...new Set(Object.values(table.slots).flatMap((slot) => slot.items.flatMap((i) => i.meshes))),
  ];
  const rig = buildRig({ garments });
  const profile = buildProfile(rig.root, rig.descriptor);
  return { rig, table, wardrobe: new Wardrobe(rig.root, profile, table) };
}

describe('wardrobe visibility', () => {
  it('shows the cuffs only with the main outfit', () => {
    const { rig, wardrobe } = outfits(CUFFS);
    const visible = (name: string) => rig.meshes.get(name)?.visible;

    expect(wardrobe.missing).toEqual([]);
    expect(wardrobe.state.outfit).toBe('main');
    for (const name of CUFFS) expect(visible(name), name).toBe(true);
    expect(visible('Separates_Top')).toBe(false);
    expect(visible('Cape_Shell')).toBe(false);

    wardrobe.set('outfit', 'separates');
    for (const name of CUFFS) expect(visible(name), name).toBe(false);
    expect(visible('Separates_Top')).toBe(true);
    expect(visible('Cape_Shell')).toBe(false);

    wardrobe.set('outfit', 'main');
    for (const name of CUFFS) expect(visible(name), name).toBe(true);

    wardrobe.set('outfit', 'layered');
    for (const name of CUFFS) expect(visible(name), name).toBe(false);
    expect(visible('Separates_Top')).toBe(true);
    expect(visible('Cape_Shell')).toBe(true);
  });

  it('resolves a connector mesh exactly once and keeps it with the main outfit', () => {
    const connector = 'Back_Connector';
    const { rig, table, wardrobe } = outfits([connector]);
    const main = table.slots.outfit.items.find((item) => item.id === 'main');
    const visible = (name: string) => rig.meshes.get(name)?.visible;

    expect(main?.meshes.filter((mesh) => mesh === connector)).toEqual([connector]);
    expect(wardrobe.missing).toEqual([]);
    expect(visible(connector)).toBe(true);
    expect(visible('Separates_Top')).toBe(false);
    expect(visible('Cape_Shell')).toBe(false);

    wardrobe.set('outfit', 'separates');
    expect(visible(connector)).toBe(false);
    expect(visible('Separates_Top')).toBe(true);
    expect(visible('Cape_Shell')).toBe(false);

    wardrobe.set('outfit', 'layered');
    expect(visible(connector)).toBe(false);
    expect(visible('Separates_Top')).toBe(true);
    expect(visible('Cape_Shell')).toBe(true);
  });

  it('applies the default preset at construction when the table has one', () => {
    const { wardrobe, mesh } = dress();

    expect(wardrobe.state).toEqual({ top: 'camisole', bottom: 'skirt', prop: null });
    expect(mesh('Tops__Cotton').visible).toBe(true);
    expect(mesh('Skirt').visible).toBe(true);
    expect(mesh('Cardigan').visible).toBe(false);
    expect(mesh('Pillow_1').visible).toBe(false);
  });

  it('starts every slot bare when the table has no default preset', () => {
    const { wardrobe, mesh } = dress({ slots: TABLE.slots });

    expect(wardrobe.state).toEqual({ top: null, bottom: null, prop: null });
    for (const name of ['Tops__Cotton', 'Cardigan', 'Skirt', 'Pillow_1']) {
      expect(mesh(name).visible, name).toBe(false);
    }
  });

  it('swaps which meshes are shown when a slot is set', () => {
    const { wardrobe, mesh } = dress();

    wardrobe.set('top', 'blouse');

    expect(wardrobe.state.top).toBe('blouse');
    expect(mesh('Cardigan').visible).toBe(true);
    expect(mesh('Tops__Cotton').visible).toBe(false);
    // Untouched slots keep what they were wearing.
    expect(mesh('Skirt').visible).toBe(true);
  });

  it('bares a slot when it is set to null', () => {
    const { wardrobe, mesh } = dress();

    wardrobe.set('top', null);

    expect(wardrobe.state.top).toBeNull();
    expect(mesh('Tops__Cotton').visible).toBe(false);
    expect(mesh('Cardigan').visible).toBe(false);
    expect(mesh('Skirt').visible).toBe(true);
  });

  it('ignores a slot the table does not declare', () => {
    const { wardrobe, mesh } = dress();

    wardrobe.set('hat', 'beret');

    expect(wardrobe.state).toEqual({ top: 'camisole', bottom: 'skirt', prop: null });
    expect(mesh('Tops__Cotton').visible).toBe(true);
  });

  it('bares a slot asked for an item the slot does not have', () => {
    const { wardrobe, mesh } = dress();

    wardrobe.set('top', 'kimono');

    expect(mesh('Tops__Cotton').visible).toBe(false);
    expect(mesh('Cardigan').visible).toBe(false);
  });

  it('sets several slots at once from a preset', () => {
    const { wardrobe, mesh } = dress();

    wardrobe.applyPreset('lounging');

    expect(wardrobe.state).toEqual({ top: 'blouse', bottom: null, prop: 'pillow' });
    expect(mesh('Cardigan').visible).toBe(true);
    expect(mesh('Pillow_1').visible).toBe(true);
    expect(mesh('Skirt').visible).toBe(false);
    expect(mesh('Tops__Cotton').visible).toBe(false);
  });

  it('ignores a preset the table does not declare', () => {
    const { wardrobe, mesh } = dress();

    wardrobe.applyPreset('swimwear');

    expect(wardrobe.state).toEqual({ top: 'camisole', bottom: 'skirt', prop: null });
    expect(mesh('Tops__Cotton').visible).toBe(true);
  });

  it('leaves meshes no item claims alone', () => {
    const { wardrobe, mesh } = dress();

    wardrobe.applyPreset('bare');

    // The body and the face are not garments, and neither is a mesh whose name
    // merely starts like one.
    expect(mesh('Body').visible).toBe(true);
    expect(mesh('Face').visible).toBe(true);
    expect(mesh('Skirt_Long').visible).toBe(true);
  });
});

describe('wardrobe name mangling', () => {
  it('matches a table entry against the plain, split and clash-suffixed names', () => {
    const { wardrobe, mesh } = dress();

    wardrobe.applyPreset('lounging');

    // "Skirt" exactly, "Tops" through "Tops__Cotton", "Pillow" through "Pillow_1".
    expect(wardrobe.missing).toEqual([]);
    expect(mesh('Pillow_1').visible).toBe(true);
    wardrobe.set('top', 'camisole');
    expect(mesh('Tops__Cotton').visible).toBe(true);
    wardrobe.set('bottom', 'skirt');
    expect(mesh('Skirt').visible).toBe(true);
  });

  it('does not sweep up a mesh whose name only starts like the entry', () => {
    const { wardrobe, mesh } = dress();

    // `Skirt_\d+` is the clash suffix; `Skirt_Long` is another garment.
    wardrobe.set('bottom', 'skirt');
    expect(mesh('Skirt_Long').visible).toBe(true);
    wardrobe.set('bottom', null);
    expect(mesh('Skirt_Long').visible).toBe(true);
    expect(mesh('Skirt').visible).toBe(false);
  });

  it('reports a declared mesh this GLB does not have instead of throwing', () => {
    const table: WardrobeTable = {
      slots: {
        top: {
          label: same('Tops'),
          items: [
            { id: 'camisole', label: same('Camisole'), meshes: ['Tops', 'Apron'] },
            { id: 'blouse', label: same('Blouse'), meshes: ['Cardigan'] },
          ],
        },
      },
      presets: { default: { label: same('Default'), set: { top: 'camisole' } } },
    };

    const { wardrobe, mesh } = dress(table);

    expect(wardrobe.missing).toEqual(['top/camisole: Apron']);
    // The rest of the item still goes on.
    expect(mesh('Tops__Cotton').visible).toBe(true);
  });

  it('takes an empty table without complaint', () => {
    const rig = dressedRig();
    const profile = buildProfile(rig.root, rig.descriptor);

    const wardrobe = new Wardrobe(rig.root, profile);

    expect(wardrobe.state).toEqual({});
    expect(wardrobe.missing).toEqual([]);
    expect(wardrobe.activeHides).toEqual([]);
    expect(wardrobe.all.length).toBeGreaterThan(0);
  });
});

describe('wardrobe hide shapes', () => {
  it('raises the worn item hide shapes on every mesh that carries them', () => {
    const { wardrobe, influence } = dress();

    expect(wardrobe.activeHides).toEqual(['NeckHide']);
    expect(influence('Face', 'NeckHide')).toBe(1);
    expect(influence('Body', 'NeckHide')).toBe(1);
    expect(influence('Face', 'BustHide')).toBe(0);
    expect(influence('Body', 'BustHide')).toBe(0);
  });

  it('clears exactly what it raised and leaves the expression shapes alone', () => {
    const { wardrobe, mesh, influence } = dress();
    const face = mesh('Face');
    const dict = must(face.morphTargetDictionary, 'face dict');
    const influences = must(face.morphTargetInfluences, 'face influences');
    // The director owns this one, and it is on the same mesh as the hides.
    influences[dict.jawOpen] = 0.8;

    wardrobe.set('top', 'blouse');

    expect(wardrobe.activeHides).toEqual(['BustHide']);
    expect(influence('Face', 'NeckHide')).toBe(0);
    expect(influence('Body', 'NeckHide')).toBe(0);
    expect(influence('Face', 'BustHide')).toBe(1);
    expect(influence('Body', 'BustHide')).toBe(1);
    expect(influence('Face', 'jawOpen')).toBe(0.8);
  });

  it('drops every hide shape when the slot is bared', () => {
    const { wardrobe, influence } = dress();

    wardrobe.set('top', null);

    expect(wardrobe.activeHides).toEqual([]);
    expect(influence('Face', 'NeckHide')).toBe(0);
    expect(influence('Body', 'NeckHide')).toBe(0);
  });

  it('keeps a hide shape a second worn item still needs', () => {
    const table: WardrobeTable = {
      slots: {
        top: TABLE.slots.top,
        prop: {
          label: same('Prop'),
          items: [{ id: 'pillow', label: same('Pillow'), meshes: ['Pillow'], hide: ['NeckHide'] }],
        },
      },
      presets: { default: { label: same('Default'), set: { top: 'camisole', prop: 'pillow' } } },
    };
    const { wardrobe, influence } = dress(table);

    expect(influence('Body', 'NeckHide')).toBe(1);
    wardrobe.set('top', 'blouse');

    expect(wardrobe.activeHides.sort()).toEqual(['BustHide', 'NeckHide']);
    expect(influence('Body', 'NeckHide')).toBe(1);
    expect(influence('Body', 'BustHide')).toBe(1);
  });

  it('ignores a hide shape this avatar does not carry', () => {
    const table: WardrobeTable = {
      slots: {
        top: {
          label: same('Tops'),
          items: [
            { id: 'camisole', label: same('Camisole'), meshes: ['Tops'], hide: ['ThighHide'] },
          ],
        },
      },
      presets: { default: { label: same('Default'), set: { top: 'camisole' } } },
    };

    const { wardrobe, influence, profile } = dress(table);

    expect(profile.morphTargets.has('ThighHide')).toBe(false);
    expect(wardrobe.activeHides).toEqual(['ThighHide']);
    expect(influence('Body', 'NeckHide')).toBe(0);
    expect(influence('Body', 'BustHide')).toBe(0);
  });
});

describe('wardrobe mesh names', () => {
  const tableFor = (meshes: string[]): WardrobeTable => ({
    slots: {
      outfit: {
        label: same('Outfit'),
        items: [{ id: 'on', label: same('On'), meshes }],
      },
    },
  });

  it('matches a name that is not a valid pattern', () => {
    const rig = buildRig({ garments: ['Skirt(long)', 'Skirt(long)_2', 'Skirt(long)_x'] });
    const wardrobe = new Wardrobe(
      rig.root,
      buildProfile(rig.root, rig.descriptor),
      tableFor(['Skirt(long)']),
    );

    expect(wardrobe.missing).toEqual([]);
    // Nothing is worn at the start, so a mesh the item claims is hidden and one
    // it does not claim is left as it was.
    expect(rig.meshes.get('Skirt(long)')?.visible).toBe(false);
    expect(rig.meshes.get('Skirt(long)_2')?.visible).toBe(false);
    expect(rig.meshes.get('Skirt(long)_x')?.visible).toBe(true);
  });

  it('takes a numbered clash only with a non-empty digit suffix', () => {
    const rig = buildRig({ garments: ['Skirt', 'Skirt_', 'Skirt_12', 'Skirt_1a'] });
    const wardrobe = new Wardrobe(
      rig.root,
      buildProfile(rig.root, rig.descriptor),
      tableFor(['Skirt']),
    );
    expect(wardrobe.missing).toEqual([]);

    expect(rig.meshes.get('Skirt')?.visible).toBe(false);
    expect(rig.meshes.get('Skirt_12')?.visible).toBe(false);
    expect(rig.meshes.get('Skirt_')?.visible).toBe(true);
    expect(rig.meshes.get('Skirt_1a')?.visible).toBe(true);
  });

  it('finds a mesh the loader renamed', () => {
    const rig = buildRig({ garments: ['Lace_Trim', 'Body001'] });
    const wardrobe = new Wardrobe(
      rig.root,
      buildProfile(rig.root, rig.descriptor),
      tableFor(['Lace Trim', 'Body.001']),
    );

    expect(wardrobe.missing).toEqual([]);
  });
});
