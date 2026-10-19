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

  it('rejects a label missing a language', () => {
    expect(reject({ label: { en: 'x' } })).toContain('label.ja');
    expect(reject({ label: { ja: 'x' } })).toContain('label.en');
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
