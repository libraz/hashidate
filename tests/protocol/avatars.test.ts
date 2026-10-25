import { describe, expect, it } from 'vitest';
import { avatarsResponseSchema, parseAvatar } from '@/protocol';

const label = { en: 'Example', ja: '例' };
const minimal = { label };

function reject(value: unknown): string {
  const result = parseAvatar('example', value);
  if (result.ok) throw new Error('expected the avatar to be rejected');
  return result.error;
}

function accept(value: unknown) {
  const result = parseAvatar('example', value);
  if (!result.ok) throw new Error(result.error);
  return result.avatar;
}

describe('parseAvatar', () => {
  it('fills id and the default url', () => {
    expect(accept(minimal)).toEqual({ id: 'example', label, url: '/models/example.glb' });
  });

  it('accepts an empty file object only with a label', () => {
    expect(reject({})).toContain('label');
  });

  it.each([[[]], [null], [3], ['x']])('rejects a non-object top level %j', (value) => {
    expect(reject(value)).toContain('avatar:');
  });

  it('rejects an unknown key, including id', () => {
    expect(reject({ ...minimal, id: 'example' })).toContain('"id"');
    expect(reject({ ...minimal, extra: 1 })).toContain('"extra"');
    expect(reject({ ...minimal, sway: { groups: [], extra: 1 } })).toContain('"extra"');
  });

  it('accepts any tool data under extras', () => {
    const extras = { mimesis: { wardrobe: { slots: ['outfit'], presets: [] } }, other: [1] };
    expect(accept({ ...minimal, extras }).extras).toEqual(extras);
    expect(reject({ ...minimal, extras: [] })).toContain('extras');
  });

  it('checks a wardrobe item pose', () => {
    const item = (pose: unknown) => ({
      ...minimal,
      wardrobe: { slots: { shoes: { label, items: [{ id: 'heels', label, meshes: [], pose }] } } },
    });
    const pose = { Foot_L: { rotation: [0.26, 0, 0, 0.97] }, Root: { translation: [0, 0.02, 0] } };
    expect(accept(item(pose)).wardrobe?.slots.shoes.items[0].pose).toEqual(pose);
    expect(reject(item({ Foot_L: {} }))).toContain('Foot_L');
    expect(reject(item({ Foot_L: { rotation: [0, 0, 0, 0] } }))).toContain('zero');
    expect(reject(item({ Foot_L: { rotation: [0, 0, 1] } }))).toContain('rotation');
    expect(reject(item({ Foot_L: { scale: [1, 1, 1] } }))).toContain('"scale"');
  });

  it('wants the source language on a label and fills the rest from it', () => {
    expect(reject({ label: { ja: 'x' } })).toContain('label.en');
    expect(accept({ label: { en: 'x' } }).label).toEqual({ en: 'x', ja: 'x' });
  });

  it('accepts -0 and rejects non-finite numbers', () => {
    const gaze = (eyeYaw: number) => ({ ...minimal, gaze: { eyeYaw } });
    expect(Object.is(accept(gaze(-0)).gaze?.eyeYaw, -0)).toBe(true);
    expect(reject(gaze(Number.NaN))).toContain('gaze.eyeYaw');
    expect(reject(gaze(Number.POSITIVE_INFINITY))).toContain('gaze.eyeYaw');
  });

  it('rejects the wrong kind with a path', () => {
    expect(reject({ label: { en: 1, ja: 'x' } })).toContain('label.en');
    expect(reject({ ...minimal, gaze: { eyeYaw: true } })).toContain('gaze.eyeYaw');
  });

  it('accepts null exactly where the engine allows it', () => {
    const avatar = accept({
      ...minimal,
      gaze: null,
      presets: null,
      emotionShapes: null,
      overlays: null,
      mouthShapePattern: null,
      wardrobe: {
        slots: {},
        presets: { p: { label, set: { top: null } } },
      },
    });
    expect(avatar.gaze).toBeNull();
    expect(avatar.mouthShapePattern).toBeNull();
    expect(avatar.wardrobe?.presets?.p.set.top).toBeNull();
  });

  it('rejects null elsewhere', () => {
    for (const key of ['author', 'url', 'separator', 'shapes', 'materials', 'wardrobe', 'sway']) {
      expect(reject({ ...minimal, [key]: null }), key).toContain(key);
    }
    expect(reject({ ...minimal, sway: { groups: [{ id: null }] } })).toContain('sway.groups.0.id');
  });

  it('accepts empty arrays', () => {
    const avatar = accept({
      ...minimal,
      script: [],
      sway: { groups: [], colliders: { c: [] } },
    });
    expect(avatar.script).toEqual([]);
    expect(avatar.sway?.groups).toEqual([]);
  });

  it('reuses the turn schema for script lines', () => {
    expect(accept({ ...minimal, script: [{ text: 'hello' }] }).script).toEqual([{ text: 'hello' }]);
    expect(reject({ ...minimal, script: [{ text: 'a [broken' }] })).toContain('script.0.text');
  });

  it('flattens the shoulder of an anatomy table', () => {
    const dof = { label, free: [0, 1], max: [0, 2] };
    const joint = { label, dofs: { x: dof } };
    const anatomy = {
      shoulder: { ...joint, elevation: [[0, 1, 2]] },
      elbow: joint,
      wrist: joint,
      finger: joint,
      thumb: joint,
      neck: joint,
      spine: joint,
    };
    expect(accept({ ...minimal, anatomy }).anatomy?.shoulder.elevation).toEqual([[0, 1, 2]]);
    const { elevation: _, ...flat } = anatomy.shoulder;
    expect(reject({ ...minimal, anatomy: { ...anatomy, shoulder: flat } })).toContain(
      'anatomy.shoulder.elevation',
    );
  });
});

describe('patterns', () => {
  const material = (pattern: unknown) => ({ ...minimal, materials: { doubleSided: pattern } });

  it('compiles with and without ignoreCase', () => {
    const plain = accept(material({ pattern: '^hair' })).materials?.doubleSided;
    const folded = accept(material({ pattern: '^hair', ignoreCase: true })).materials?.doubleSided;
    expect(plain).toEqual(/^hair/);
    expect(plain?.test('Hair')).toBe(false);
    expect(folded?.test('Hair')).toBe(true);
    expect(folded?.flags).toBe('i');
  });

  it('keeps mouthShapePattern a compiled pattern', () => {
    const avatar = accept({ ...minimal, mouthShapePattern: { pattern: 'mouth' } });
    expect(avatar.mouthShapePattern).toEqual(/mouth/);
  });

  it('rejects empty, oversized and non-compiling patterns', () => {
    expect(reject(material({ pattern: '' }))).toContain('materials.doubleSided.pattern');
    expect(reject(material({ pattern: 'a'.repeat(1025) }))).toContain('1024');
    expect(accept(material({ pattern: 'a'.repeat(1024) }))).toBeTruthy();
    expect(reject(material({ pattern: '(' }))).toContain('regular expression');
  });

  it('rejects a bare string, a non-boolean ignoreCase and unknown keys', () => {
    expect(reject(material('hair'))).toContain('materials.doubleSided');
    expect(reject(material({ pattern: 'a', ignoreCase: 'yes' }))).toContain('ignoreCase');
    expect(reject(material({ pattern: 'a', flags: 'g' }))).toContain('"flags"');
  });

  it('requires exactly one capture group in a separator', () => {
    const separator = (pattern: string) => ({ ...minimal, separator: { pattern } });
    expect(accept(separator('^=+([^=]+)=+$')).separator?.exec('==Face==')?.[1]).toBe('Face');
    expect(reject(separator('^=+$'))).toContain('found 0');
    expect(reject(separator('^(a)(b)$'))).toContain('found 2');
    expect(accept(separator('^(?:a)(b)$')).separator).toBeInstanceOf(RegExp);
    expect(accept(separator('^\\((a)$')).separator).toBeInstanceOf(RegExp);
  });
});

describe('label rules', () => {
  const overlays = (rule: unknown) => ({ ...minimal, overlays: { group: 'g', label: rule } });
  const run = (rule: unknown, id: string) => accept(overlays(rule)).overlays?.label?.(id);

  it('strips the prefix once, at the start only', () => {
    expect(run({ stripPrefix: 'F_' }, 'F_SMILE')).toBe('SMILE');
    expect(run({ stripPrefix: 'F_' }, 'X_F_Y')).toBe('X_F_Y');
    expect(run({ stripPrefix: 'F_' }, 'F_F_Y')).toBe('F_Y');
    expect(run({ stripPrefix: 'option_' }, 'plain')).toBe('plain');
  });

  it('replaces every underscore when asked', () => {
    expect(run({ underscoresToSpaces: true }, 'a__b')).toBe('a  b');
    expect(run({ stripPrefix: 'F_', underscoresToSpaces: true }, 'F_A_B')).toBe('A B');
    expect(run({ underscoresToSpaces: false }, 'a_b')).toBe('a_b');
    expect(run({}, 'a_b')).toBe('a_b');
  });

  it('rejects an unknown key and a non-string prefix', () => {
    expect(reject(overlays({ strip: 'F_' }))).toContain('"strip"');
    expect(reject(overlays({ stripPrefix: 3 }))).toContain('overlays.label.stripPrefix');
    expect(reject(overlays('F_'))).toContain('overlays.label');
  });

  it('applies to presets too', () => {
    const avatar = accept({ ...minimal, presets: { group: 'g', label: { stripPrefix: 'p_' } } });
    expect(avatar.presets?.label?.('p_x')).toBe('x');
  });
});

describe('url', () => {
  const withUrl = (url: unknown) => ({ ...minimal, url });

  it('keeps a root-relative path', () => {
    expect(accept(withUrl('/models/a b.glb')).url).toBe('/models/a b.glb');
  });

  it.each(['//x', 'http://x', '../x', 'models/x', '/a/../b', '/a?b', '/a#b', '/a\\b', ''])(
    'rejects %j',
    (url) => {
      expect(reject(withUrl(url))).toContain('url');
    },
  );

  it('accepts a dotted name that is not a parent segment', () => {
    expect(accept(withUrl('/models/..x.glb')).url).toBe('/models/..x.glb');
  });

  it('percent-encoding is left to the browser for a non-ASCII id', () => {
    expect(parseAvatar('夜', minimal)).toMatchObject({
      ok: true,
      avatar: { url: '/models/夜.glb' },
    });
  });
});

describe('avatarsResponseSchema', () => {
  it('keeps good entries beside a bad one and carries server errors through', () => {
    const parsed = avatarsResponseSchema.parse({
      avatars: [
        { id: 'a', label },
        { id: 'bad', label, separator: { pattern: '(' } },
        { id: 'b', label, url: '/models/custom.glb' },
        { label },
        null,
      ],
      errors: [{ id: 'broken', error: 'parse failed' }],
    });
    expect(parsed.avatars.map((avatar) => avatar.id)).toEqual(['a', 'b']);
    expect(parsed.avatars[0].url).toBe('/models/a.glb');
    expect(parsed.avatars[1].url).toBe('/models/custom.glb');
    expect(parsed.errors.map((error) => error.id)).toEqual(['broken', 'bad', '(no id)', '(no id)']);
    expect(parsed.errors[1].error).toContain('separator.pattern');
  });

  it('answers empty for an empty roster', () => {
    expect(avatarsResponseSchema.parse({ avatars: [], errors: [] })).toEqual({
      avatars: [],
      errors: [],
    });
  });

  it('reports a bad entry under its own id', () => {
    const parsed = avatarsResponseSchema.parse({
      avatars: [{ id: 'a', label, extra: true }],
      errors: [],
    });
    expect(parsed.avatars).toEqual([]);
    expect(parsed.errors[0]).toMatchObject({ id: 'a' });
  });
});

describe('avatar bone names and PBR ranges', () => {
  const pbr = (override: unknown) => ({
    ...minimal,
    materials: { preservedPbrOverrides: { Metal: override } },
  });

  it('accepts the unit range, and reflection of any size above zero', () => {
    expect(() => accept(pbr({ metalness: 0, roughness: 1, reflection: 3 }))).not.toThrow();
  });

  it.each([
    [{ metalness: 1.2, roughness: 0.5 }, 'metalness'],
    [{ metalness: 0.5, roughness: -0.1 }, 'roughness'],
    [{ metalness: 0.5, roughness: 0.5, reflection: -1 }, 'reflection'],
  ])('rejects %j', (override, field) => {
    expect(reject(pbr(override))).toContain(field);
  });

  it('accepts bone and finger overrides', () => {
    const avatar = accept({
      ...minimal,
      bones: { 'upperArm.L': ['Arm_L'], hips: ['Root'] },
      fingers: { 'index.R': ['I1', 'I2', 'I3'] },
    });
    expect(avatar.bones?.['upperArm.L']).toEqual(['Arm_L']);
    expect(avatar.fingers?.['index.R']).toEqual(['I1', 'I2', 'I3']);
  });

  it('rejects an unknown slot or finger', () => {
    expect(reject({ ...minimal, bones: { tail: ['T'] } })).toContain('tail');
    expect(reject({ ...minimal, fingers: { 'index.X': ['I'] } })).toContain('index.X');
  });
});

describe('toon materials', () => {
  const shadow = { color: [0.9, 0.8, 0.7], border: 0.5, blur: 0.1, strength: 1, normalStrength: 1 };
  const full = {
    shadow: { ...shadow, mask: 'shadow_mask.png' },
    shadow2: { color: [0.5, 0.5, 0.6, 0.4], border: 0.3, blur: 0.2 },
    asUnlit: 0.2,
    normalMap: { file: 'normal.png', scale: 1 },
    rim: {
      color: [1, 1, 1, 0.5],
      border: 0.6,
      blur: 0.2,
      fresnelPower: 3,
      normalStrength: 0,
      backfaceMask: 0,
      shadowMask: 1,
      mainStrength: 0,
      enableLighting: 1,
      mode: 'normal',
      dirStrength: 1,
      dirRange: 0,
      indirRange: 0,
      indirColor: [0.99, 0.99, 0.99, 0.69],
      indirBorder: 0.5,
      indirBlur: 0.18,
      colorTex: 'rim.png',
    },
    rimShade: {
      color: [0.82, 0.84, 0.92, 1],
      border: 0.5,
      blur: 1,
      fresnelPower: 1,
      normalStrength: 1,
      mask: 'rim_shade_mask.png',
    },
    matcap: {
      file: 'matcap.png',
      color: [1, 1, 1, 1],
      blend: 0.5,
      mode: 'add',
      mask: 'matcap_mask.png',
      shadowMask: 0.095,
      enableLighting: 0,
      mainStrength: 0.28,
      normalStrength: 0.325,
      backfaceMask: 0,
      lod: 0,
    },
    emission: { color: [2, 1, 0], map: 'glow.png' },
    outline: { width: 0.07, color: [0.1, 0.1, 0.1, 1], fixWidth: 0.5, mask: 'width.png' },
  };
  const withToon = (toon: unknown, extra: object = {}) => ({
    ...minimal,
    materials: { toon, ...extra },
  });
  const withSpec = (spec: unknown) => withToon({ Skin: spec });
  const withShadow = (patch: object) => withSpec({ shadow: { ...shadow, ...patch } });
  const withOutline = (patch: object) =>
    withSpec({ shadow, outline: { ...full.outline, ...patch } });

  it('round-trips a full spec unchanged', () => {
    expect(accept(withSpec(full)).materials?.toon).toEqual({ Skin: full });
  });

  it('accepts the smallest spec, and an empty toon record', () => {
    expect(accept(withSpec({ shadow })).materials?.toon?.Skin?.asUnlit).toBeUndefined();
    expect(accept(withToon({})).materials?.toon).toEqual({});
  });

  it('accepts a file without the toon key', () => {
    expect(accept({ ...minimal, materials: {} }).materials?.toon).toBeUndefined();
  });

  it('accepts 0 and -0', () => {
    expect(() => accept(withShadow({ border: 0, blur: -0 }))).not.toThrow();
    expect(() => accept(withOutline({ width: -0 }))).not.toThrow();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects %s as a value',
    (value) => {
      expect(reject(withShadow({ border: value }))).toContain('materials.toon.Skin.shadow.border');
      expect(reject(withSpec({ shadow, normalMap: { file: 'n.png', scale: value } }))).toContain(
        'normalMap.scale',
      );
    },
  );

  it('rejects null for toon, a block and a value', () => {
    expect(reject(withToon(null))).toContain('materials.toon');
    expect(reject(withSpec({ shadow, rim: null }))).toContain('materials.toon.Skin.rim');
    expect(reject(withShadow({ blur: null }))).toContain('shadow.blur');
    expect(reject(withSpec(null))).toContain('materials.toon.Skin');
  });

  it('accepts any optional block being absent', () => {
    for (const key of Object.keys(full).filter((k) => k !== 'shadow')) {
      const { [key as keyof typeof full]: _, ...rest } = full;
      expect(() => accept(withSpec(rest))).not.toThrow();
    }
  });

  it('rejects a missing shadow block and a missing required key', () => {
    const { shadow: _, ...noShadow } = full;
    expect(reject(withSpec(noShadow))).toContain('materials.toon.Skin.shadow');
    for (const key of Object.keys(shadow)) {
      const { [key as keyof typeof shadow]: __, ...rest } = shadow;
      expect(reject(withSpec({ shadow: rest }))).toContain(`shadow.${key}`);
    }
    expect(reject(withSpec({ shadow, rim: { ...full.rim, fresnelPower: undefined } }))).toContain(
      'rim.fresnelPower',
    );
    expect(reject(withSpec({ shadow, matcap: { ...full.matcap, mode: undefined } }))).toContain(
      'matcap.mode',
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['rim', full.rim],
    ['rimShade', full.rimShade],
    ['matcap', full.matcap],
  ])('rejects a %s block missing any required key', (block, value) => {
    const optional = new Set(['colorTex', 'mask']);
    for (const key of Object.keys(value).filter((k) => !optional.has(k))) {
      const { [key]: _, ...rest } = value;
      expect(reject(withSpec({ shadow, [block]: rest }))).toContain(`${block}.${key}`);
    }
  });

  it('keeps the rim ranges closed at -1 and 1', () => {
    for (const key of ['dirRange', 'indirRange']) {
      for (const value of [-1, 1]) {
        expect(() =>
          accept(withSpec({ shadow, rim: { ...full.rim, [key]: value } })),
        ).not.toThrow();
      }
      for (const value of [-1.0001, 1.0001]) {
        expect(reject(withSpec({ shadow, rim: { ...full.rim, [key]: value } }))).toContain(
          `rim.${key}`,
        );
      }
    }
  });

  it('takes a matcap lod of 0 or more and rejects a negative one', () => {
    for (const lod of [0, 6.6, 2 ** 32]) {
      expect(() => accept(withSpec({ shadow, matcap: { ...full.matcap, lod } }))).not.toThrow();
    }
    expect(reject(withSpec({ shadow, matcap: { ...full.matcap, lod: -0.0001 } }))).toContain(
      'matcap.lod',
    );
  });

  it('allows a matcap colour channel above 1 but not its alpha', () => {
    const withMatcapColor = (color: number[]) =>
      withSpec({ shadow, matcap: { ...full.matcap, color } });
    expect(() => accept(withMatcapColor([2.1, 2.1, 2.1, 1]))).not.toThrow();
    expect(reject(withMatcapColor([1, 1, 1, 1.0001]))).toContain('matcap.color');
    expect(reject(withMatcapColor([-0.1, 1, 1, 1]))).toContain('matcap.color');
    expect(reject(withMatcapColor([1, 1, 1]))).toContain('matcap.color');
  });

  it.each([[[0.5, 0.5]], [[0.5, 0.5, 0.5, 0.5]], [[]]])(
    'rejects an RGB colour %j of the wrong length',
    (color) => {
      expect(reject(withShadow({ color }))).toContain('shadow.color');
    },
  );

  it.each([[[0.5, 0.5, 0.5]], [[0.5, 0.5, 0.5, 0.5, 0.5]], [[]]])(
    'rejects an RGBA colour %j of the wrong length',
    (color) => {
      expect(reject(withSpec({ shadow, shadow2: { color, border: 0, blur: 0 } }))).toContain(
        'shadow2.color',
      );
    },
  );

  it('rejects a null or missing element in a colour', () => {
    expect(reject(withShadow({ color: [0.5, null, 0.5] }))).toContain('shadow.color');
    expect(reject(withShadow({ color: [0.5, undefined, 0.5] }))).toContain('shadow.color');
  });

  it('keeps the unit range closed at 0 and 1', () => {
    expect(() => accept(withShadow({ border: 0 }))).not.toThrow();
    expect(() => accept(withShadow({ border: 1 }))).not.toThrow();
    expect(() => accept(withShadow({ color: [0, 1, 1] }))).not.toThrow();
    expect(reject(withShadow({ border: -0.0001 }))).toContain('shadow.border');
    expect(reject(withShadow({ border: 1.0001 }))).toContain('shadow.border');
    expect(reject(withShadow({ color: [1.0001, 0, 0] }))).toContain('shadow.color');
  });

  it('allows an emission colour above 1 but not below 0', () => {
    expect(() => accept(withSpec({ shadow, emission: { color: [5, 0, 0] } }))).not.toThrow();
    expect(reject(withSpec({ shadow, emission: { color: [-0.1, 0, 0] } }))).toContain(
      'emission.color',
    );
  });

  it('takes 0 and rejects a negative for width and fresnelPower', () => {
    expect(() => accept(withOutline({ width: 0 }))).not.toThrow();
    expect(reject(withOutline({ width: -0.01 }))).toContain('outline.width');
    expect(() => accept(withSpec({ shadow, rim: { ...full.rim, fresnelPower: 0 } }))).not.toThrow();
    expect(reject(withSpec({ shadow, rim: { ...full.rim, fresnelPower: -1 } }))).toContain(
      'rim.fresnelPower',
    );
  });

  it('accepts 2^31 and 2^32 for width, fresnelPower and scale', () => {
    for (const big of [2 ** 31, 2 ** 32]) {
      expect(() => accept(withOutline({ width: big }))).not.toThrow();
      expect(() =>
        accept(withSpec({ shadow, rim: { ...full.rim, fresnelPower: big } })),
      ).not.toThrow();
      expect(() =>
        accept(withSpec({ shadow, normalMap: { file: 'n.png', scale: big } })),
      ).not.toThrow();
    }
  });

  it('accepts a negative normal scale', () => {
    expect(() =>
      accept(withSpec({ shadow, normalMap: { file: 'n.png', scale: -1 } })),
    ).not.toThrow();
  });

  it.each([true, '0.5'])('rejects %j where a number is expected', (value) => {
    expect(reject(withShadow({ border: value }))).toContain('shadow.border');
    expect(reject(withShadow({ color: [value, 0, 0] }))).toContain('shadow.color');
    expect(reject(withOutline({ width: value }))).toContain('outline.width');
  });

  it('rejects an unknown matcap or rim mode', () => {
    expect(reject(withSpec({ shadow, matcap: { ...full.matcap, mode: 'overlay' } }))).toContain(
      'matcap.mode',
    );
    expect(reject(withSpec({ shadow, rim: { ...full.rim, mode: 'overlay' } }))).toContain(
      'rim.mode',
    );
    for (const mode of ['normal', 'add', 'screen', 'multiply']) {
      expect(() => accept(withSpec({ shadow, matcap: { ...full.matcap, mode } }))).not.toThrow();
      expect(() => accept(withSpec({ shadow, rim: { ...full.rim, mode } }))).not.toThrow();
    }
  });

  it('rejects an unknown key on a spec and on a block', () => {
    expect(reject(withSpec({ shadow, glitter: {} }))).toContain('"glitter"');
    expect(reject(withShadow({ borderColor: [0, 0, 0] }))).toContain('"borderColor"');
    expect(reject(withSpec({ shadow, outline: { ...full.outline, extra: 1 } }))).toContain(
      '"extra"',
    );
    // A rim takes a colour texture, not a mask.
    expect(reject(withSpec({ shadow, rim: { ...full.rim, mask: 'rim.png' } }))).toContain('"mask"');
  });

  it.each(['', 'a/b.png', '..', 'x?.png', 'x#.png', 'a\\b.png'])('rejects the file %j', (file) => {
    expect(reject(withSpec({ shadow, normalMap: { file, scale: 1 } }))).toContain('normalMap.file');
    expect(reject(withShadow({ mask: file }))).toContain('shadow.mask');
    expect(reject(withSpec({ shadow, emission: { color: [0, 0, 0], map: file } }))).toContain(
      'emission.map',
    );
    expect(reject(withSpec({ shadow, rim: { ...full.rim, colorTex: file } }))).toContain(
      'rim.colorTex',
    );
    expect(reject(withSpec({ shadow, rimShade: { ...full.rimShade, mask: file } }))).toContain(
      'rimShade.mask',
    );
  });

  it('accepts a non-ASCII or surrogate file and material name', () => {
    const name = '肌_\u{1F600}';
    const file = '影_\u{1F600}.png';
    const avatar = accept(withToon({ [name]: { shadow: { ...shadow, mask: file } } }));
    expect(avatar.materials?.toon?.[name]?.shadow.mask).toBe(file);
  });

  it('rejects a name that is also preserved, and accepts one that is not', () => {
    const rejected = reject(
      withToon({ Metal: { shadow } }, { preserveImported: { pattern: '^Metal' } }),
    );
    expect(rejected).toContain('materials.toon.Metal');
    expect(rejected).toContain('preserveImported');
    expect(() =>
      accept(withToon({ Skin: { shadow } }, { preserveImported: { pattern: '^Metal' } })),
    ).not.toThrow();
  });
});
