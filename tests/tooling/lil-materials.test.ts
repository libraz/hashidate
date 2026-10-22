import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAvatar } from '@/protocol';

const BLENDER = fileURLToPath(new URL('../../tools/blender/', import.meta.url));
const IMPORTER = join(BLENDER, 'lil_materials.py');
const TOON_TEXTURES = join(BLENDER, 'toon_textures.py');
const TEXTURES = join(BLENDER, 'textures.py');

const SHADER = {
  lilToon: 'df12117ecd77c31469c224178886498e',
  outline: 'efa77a80ca0344749b4f19fdd5891cbe',
  transparent: '165365ab7100a044ca85fc8c33548a62',
  fur: '54bc8b41278802d4a81b27fe402994e2',
  unknown: '034460dcdeadbeefdeadbeefdeadbeef',
};

// Writes a unitypackage holding each { guid, path, data } as a guid/pathname + guid/asset pair.
const BUILD = `
import io, json, sys, tarfile
out, entries = sys.argv[1], json.loads(sys.argv[2])
with tarfile.open(out, "w:gz") as tf:
    for entry in entries:
        for name, data in (("pathname", entry["path"].encode()), ("asset", entry["data"].encode())):
            info = tarfile.TarInfo(f"{entry['guid']}/{name}")
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
`;

/** Property lists are written as `_Name=value` words (colours as `r,g,b,a`), as in a dump. */
interface Mat {
  shader: string;
  textures?: string;
  floats?: string;
  colors?: string;
}

const words = (text = ''): string[][] =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.split('='));

/** Unity text YAML in the shape lilToon materials are saved in. */
function matYaml(name: string, mat: Mat): string {
  const textures = words(mat.textures).map(
    ([key, guid]) =>
      `    - ${key}:\n        m_Texture: {fileID: 2800000, guid: ${guid}, type: 3}\n        m_Scale: {x: 1, y: 1}\n        m_Offset: {x: 0, y: 0}`,
  );
  const floats = words(mat.floats).map(([key, value]) => `    - ${key}: ${value}`);
  const colors = words(mat.colors).map(([key, value]) => {
    const [r, g, b, a] = (value ?? '').split(',');
    return `    - ${key}: {r: ${r}, g: ${g}, b: ${b}, a: ${a}}`;
  });
  const list = (key: string, items: string[]) =>
    items.length ? `    ${key}:\n${items.join('\n')}` : `    ${key}: []`;
  return [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    '--- !u!21 &2100000',
    'Material:',
    '  serializedVersion: 8',
    `  m_Name: ${name}`,
    `  m_Shader: {fileID: 4800000, guid: ${mat.shader}, type: 3}`,
    '  m_SavedProperties:',
    '    serializedVersion: 3',
    list('m_TexEnvs', textures),
    list('m_Floats', floats),
    list('m_Colors', colors),
    '  m_BuildTextureStacks: []',
    '',
  ].join('\n');
}

const guidOf = (n: number) => n.toString(16).padStart(32, '0');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hashidate-lil-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Package {
  /** Materials by Unity path. */
  mats: Record<string, Mat>;
  /** Unity paths of textures, by guid. */
  textures?: Record<string, string>;
}

const name = (path: string) =>
  path
    .split('/')
    .pop()
    ?.replace(/\.mat$/, '') ?? '';

function unitypackage({ mats, textures = {} }: Package, raw: Record<string, string> = {}): string {
  const entries = [
    ...Object.entries(mats).map(([path, mat], i) => ({
      guid: guidOf(1000 + i),
      path,
      data: raw[name(path)] ?? matYaml(name(path), mat),
    })),
    ...Object.entries(textures).map(([guid, path]) => ({ guid, path, data: 'png' })),
  ];
  const out = join(dir, 'demo.unitypackage');
  const built = spawnSync('python3', ['-I', '-c', BUILD, out, JSON.stringify(entries)]);
  expect(built.status).toBe(0);
  return out;
}

/** A GLB with a JSON chunk and nothing else, which is all the importer reads. */
async function glb(names: string[]): Promise<string> {
  const json = Buffer.from(
    JSON.stringify({ asset: { version: '2.0' }, materials: names.map((name) => ({ name })) }),
  );
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const path = join(dir, 'demo.glb');
  await writeFile(path, Buffer.concat([header, padded]));
  return path;
}

function run(pkg: string, model: string, ...extra: string[]) {
  return spawnSync(
    'python3',
    ['-I', IMPORTER, pkg, '--folder', '/Materials/', '--glb', model, ...extra],
    { encoding: 'utf8' },
  );
}

const TEX = {
  main: guidOf(1),
  other: guidOf(2),
  mask: guidOf(3),
  normal: guidOf(4),
  matcap: guidOf(5),
  glow: guidOf(6),
};
const TEX_PATHS = {
  [TEX.main]: 'Assets/Demo/Tex/body_main.png',
  [TEX.other]: 'Assets/Demo/Tex/other.png',
  [TEX.mask]: 'Assets/Demo/PNG/Mask/rim_mask.png',
  [TEX.normal]: 'Assets/Demo/PNG/Normal/body_n.tga',
  [TEX.matcap]: 'Assets/Demo/Tex/shine.png',
  [TEX.glow]: 'Assets/Demo/Tex/glow.png',
};

const body: Mat = {
  shader: SHADER.outline,
  textures: `_MainTex=${TEX.main} _OutlineTex=${TEX.main} _RimColorTex=${TEX.mask} _BumpMap=${TEX.normal} _MatCapTex=${TEX.matcap} _EmissionMap=${TEX.glow}`,
  floats:
    '_UseShadow=1 _ShadowBorder=0.39 _ShadowBlur=0.26 _ShadowStrength=1 _ShadowNormalStrength=0 ' +
    '_Shadow2ndBorder=0.214 _Shadow2ndBlur=0.073 _UseRim=1 _RimBorder=0.6685 _RimBlur=0.663 ' +
    '_RimFresnelPower=2.8402147 _UseMatCap=1 _MatCapBlend=0.5 _MatCapBlendMode=2 _UseEmission=1 ' +
    '_UseBumpMap=1 _BumpScale=0.57 _AsUnlit=0.2 _OutlineWidth=0.060000002 _OutlineFixWidth=0.5',
  colors:
    '_ShadowColor=0.992,0.925,0.901,1 _Shadow2ndColor=0.5,0.4,0.3,0.6 _RimColor=0.764,0.546,0.526,1 ' +
    '_MatCapColor=1,1,1,1 _EmissionColor=2,1.5,1,1 _OutlineColor=0.83,0.684,0.665,1',
};

const eye: Mat = {
  shader: SHADER.transparent,
  floats: '_UseShadow=0 _ShadowBorder=0.5 _ShadowBlur=0.1',
};

const tail: Mat = {
  shader: SHADER.fur,
  floats: '_UseShadow=1 _UseRim=0 _OutlineWidth=0.08',
};

function toon(stdout: string) {
  return JSON.parse(stdout).toon as Record<string, Record<string, unknown>>;
}

describe('lil_materials.py', () => {
  it('converts each lilToon variant and names textures by stem as PNG', async () => {
    const pkg = unitypackage({
      mats: {
        'Assets/Demo/Materials/Body.mat': body,
        'Assets/Demo/Materials/Eye.mat': eye,
        'Assets/Demo/Materials/Tail.mat': tail,
      },
      textures: TEX_PATHS,
    });

    const result = run(pkg, await glb(['Body', 'Eye', 'Tail']));

    expect(result.status).toBe(0);
    const specs = toon(result.stdout);
    expect(specs.Body).toEqual({
      shadow: {
        color: [0.992, 0.925, 0.901],
        border: 0.39,
        blur: 0.26,
        strength: 1,
        normalStrength: 0,
      },
      shadow2: { color: [0.5, 0.4, 0.3, 0.6], border: 0.214, blur: 0.073 },
      asUnlit: 0.2,
      normalMap: { file: 'body_n.png', scale: 0.57 },
      rim: {
        color: [0.764, 0.546, 0.526, 1],
        border: 0.6685,
        blur: 0.663,
        fresnelPower: 2.840215,
        mask: 'rim_mask.png',
      },
      matcap: { file: 'shine.png', color: [1, 1, 1, 1], blend: 0.5, mode: 'screen' },
      emission: { color: [2, 1.5, 1], map: 'glow.png' },
      outline: { width: 0.06, color: [0.83, 0.684, 0.665, 1], fixWidth: 0.5 },
    });
    // _UseShadow=0 keeps the block and turns it off; no outline off an outline-less shader.
    expect(specs.Eye?.shadow).toMatchObject({ strength: 0 });
    expect(specs.Eye).not.toHaveProperty('outline');
    expect(specs.Tail).not.toHaveProperty('outline');
  });

  it('writes a toon record that parseAvatar accepts inside a descriptor', async () => {
    const pkg = unitypackage({
      mats: { 'Assets/Demo/Materials/Body.mat': body, 'Assets/Demo/Materials/Eye.mat': eye },
      textures: TEX_PATHS,
    });
    const result = run(pkg, await glb(['Body', 'Eye']));
    expect(result.status).toBe(0);

    const parsed = parseAvatar('demo', {
      label: { en: 'Demo', ja: 'デモ' },
      materials: { toon: toon(result.stdout) },
    });

    expect(parsed.ok).toBe(true);
  });

  it('pairs a GLB material with a .mat by name, without mt_, or by --map', async () => {
    const pkg = unitypackage({
      mats: {
        'Assets/Demo/Materials/Body.mat': eye,
        'Assets/Demo/Materials/Hair.mat': eye,
        'Assets/Demo/Materials/Outer_double.mat': eye,
      },
    });

    const result = run(
      pkg,
      await glb(['Body', 'mt_Hair', 'mt_Outer_doubleS']),
      '--map',
      'mt_Outer_doubleS=Outer_double',
    );

    expect(result.status).toBe(0);
    expect(Object.keys(toon(result.stdout)).sort()).toEqual([
      'Body',
      'mt_Hair',
      'mt_Outer_doubleS',
    ]);
    expect(result.stderr).not.toContain('unmatched');
  });

  it('lists the unmatched materials of both sides on stderr and still writes the rest', async () => {
    const pkg = unitypackage({
      mats: { 'Assets/Demo/Materials/Body.mat': eye, 'Assets/Demo/Materials/Spare.mat': eye },
    });

    const result = run(pkg, await glb(['Body', 'Orphan']));

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("unmatched: GLB material 'Orphan' has no .mat");
    expect(result.stderr).toContain('unmatched: Spare.mat has no GLB material');
    expect(Object.keys(toon(result.stdout))).toEqual(['Body']);
  });

  it('refuses when nothing pairs, and a --map that names nothing', async () => {
    const pkg = unitypackage({ mats: { 'Assets/Demo/Materials/Body.mat': eye } });

    const none = run(pkg, await glb(['Other']));
    const stray = run(pkg, await glb(['Body']), '--map', 'Body=Missing');

    expect(none.status).not.toBe(0);
    expect(none.stdout).toBe('');
    expect(stray.status).not.toBe(0);
    expect(stray.stderr).toContain("no .mat named 'Missing'");
  });

  it('stops on a shader guid that is not a lilToon variant, naming the material', async () => {
    const pkg = unitypackage({
      mats: {
        'Assets/Demo/Materials/Body.mat': eye,
        'Assets/Demo/Materials/Odd.mat': { shader: SHADER.unknown },
      },
    });

    const result = run(pkg, await glb(['Body']));

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Odd.mat');
    expect(result.stderr).toContain(SHADER.unknown);
  });

  it('reads the Material document when another document comes first', async () => {
    const monoBehaviour = [
      '%YAML 1.1',
      '%TAG !u! tag:unity3d.com,2011:',
      '--- !u!114 &-4362346949540656949',
      'MonoBehaviour:',
      '  m_Name: ',
      '  m_Shader: {fileID: 0}',
      '  m_Floats: []',
      '',
    ].join('\n');
    const text = matYaml('Body', eye).replace(
      '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n',
      monoBehaviour,
    );
    const pkg = unitypackage({ mats: { 'Assets/Demo/Materials/Body.mat': eye } }, { Body: text });

    const result = run(pkg, await glb(['Body']));

    expect(result.status).toBe(0);
    expect(toon(result.stdout).Body?.shadow).toMatchObject({ strength: 0 });
  });

  it('refuses a .mat with no Material document', async () => {
    const text = '%YAML 1.1\n--- !u!114 &1\nMonoBehaviour:\n  m_Name: x\n';
    const pkg = unitypackage({ mats: { 'Assets/Demo/Materials/Body.mat': eye } }, { Body: text });

    const result = run(pkg, await glb(['Body']));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Body.mat');
  });

  it('reads only the .mat files under --folder', async () => {
    const pkg = unitypackage({
      mats: {
        'Assets/Demo/Materials/Body.mat': eye,
        'Assets/Demo/Poiyomi/Odd.mat': { shader: SHADER.unknown },
      },
    });

    expect(run(pkg, await glb(['Body'])).status).toBe(0);
  });

  it('refuses two .mat files of the same name under --folder', async () => {
    const pkg = unitypackage({
      mats: {
        'Assets/Demo/Materials/Body.mat': eye,
        'Assets/Demo/Materials/Old/Body.mat': eye,
      },
    });

    const result = run(pkg, await glb(['Body']));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('share a name');
  });

  it('warns, with the material and the value, about what the runtime does not draw', async () => {
    const pkg = unitypackage({
      mats: {
        'Assets/Demo/Materials/Body.mat': {
          shader: SHADER.outline,
          textures: `_MainTex=${TEX.main} _OutlineTex=${TEX.other}`,
          floats: '_UseShadow=1 _ShadowBorderRange=0.08 _UseBacklight=1 _ShadowEnvStrength=0.5',
        },
        'Assets/Demo/Materials/Eye.mat': {
          ...eye,
          floats: '_UseGlitter=1 _RimShadowMask=0.5',
        },
      },
      textures: TEX_PATHS,
    });

    const result = run(pkg, await glb(['Body', 'Eye']));

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('warning: Body (Body.mat): _ShadowBorderRange = 0.08');
    expect(result.stderr).toContain(
      'warning: Body (Body.mat): _OutlineTex = differs from _MainTex',
    );
    expect(result.stderr).toContain('warning: Body (Body.mat): _UseBacklight = 1');
    expect(result.stderr).toContain('warning: Body (Body.mat): _ShadowEnvStrength = 0.5');
    expect(result.stderr).toContain('warning: Eye (Eye.mat): _UseGlitter = 1');
    expect(result.stderr).not.toContain('_RimShadowMask');
  });
});

/** Runs the body against textures.py loaded as a module, which never reaches sips. */
function collect(src: string) {
  const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("textures", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.collect_sources(sys.argv[2])))
`;
  return spawnSync('python3', ['-I', '-c', code, TEXTURES, src], { encoding: 'utf8' });
}

describe('textures.py collect_sources', () => {
  it('walks subdirectories and keeps only texture files, as relative paths', async () => {
    await mkdir(join(dir, 'src', 'Mask'), { recursive: true });
    await writeFile(join(dir, 'src', 'body.png'), '');
    await writeFile(join(dir, 'src', 'Mask', 'rim.TGA'), '');
    await writeFile(join(dir, 'src', 'notes.txt'), '');

    const result = collect(join(dir, 'src'));

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['Mask/rim.TGA', 'body.png']);
  });

  it('refuses a stem shared across directories', async () => {
    await mkdir(join(dir, 'src', 'Mask'), { recursive: true });
    await writeFile(join(dir, 'src', 'rim.png'), '');
    await writeFile(join(dir, 'src', 'Mask', 'RIM.tga'), '');

    const result = collect(join(dir, 'src'));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('share a stem');
  });
});

describe('toon_textures.py', () => {
  const toonSpec = {
    Body: {
      shadow: { mask: 'shade.png' },
      rim: { mask: 'rim_mask.png' },
      matcap: { file: 'shine.png' },
    },
    Eye: { shadow: {}, emission: { map: 'glow.png' }, outline: { mask: 'line.png' } },
  };

  async function setup(files: string[], descriptor?: unknown) {
    await mkdir(join(dir, 'tex'), { recursive: true });
    for (const name of files) await writeFile(join(dir, 'tex', name), name);
    await writeFile(join(dir, 'export.json'), JSON.stringify({ textures: join(dir, 'tex') }));
    if (descriptor !== undefined) {
      await writeFile(join(dir, 'avatar.json'), JSON.stringify(descriptor));
    }
  }

  const copy = () =>
    spawnSync(
      'python3',
      ['-I', TOON_TEXTURES, join(dir, 'export.json'), join(dir, 'avatar.json'), join(dir, 'out')],
      { encoding: 'utf8' },
    );

  it.each([
    ['there is no descriptor', undefined],
    ['the descriptor has no materials.toon', { label: {} }],
    ['materials.toon names no file', { materials: { toon: { Body: { shadow: {} } } } }],
  ])('has nothing to copy when %s', async (_, descriptor) => {
    await setup([], descriptor);

    const result = copy();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('toon textures: nothing to copy');
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });

  it('lists every named file that is missing and exits 1', async () => {
    await setup(['shade.png'], { materials: { toon: toonSpec } });

    const result = copy();

    expect(result.status).toBe(1);
    for (const name of ['rim_mask.png', 'shine.png', 'glow.png', 'line.png']) {
      expect(result.stderr).toContain(name);
    }
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });

  it('copies each named file into the output directory and nothing else', async () => {
    await setup(['shade.png', 'rim_mask.png', 'shine.png', 'glow.png', 'line.png', 'spare.png'], {
      materials: { toon: toonSpec },
    });

    const result = copy();

    expect(result.status).toBe(0);
    expect(await readFile(join(dir, 'out', 'glow.png'), 'utf8')).toBe('glow.png');
    expect(existsSync(join(dir, 'out', 'shade.png'))).toBe(true);
    expect(existsSync(join(dir, 'out', 'spare.png'))).toBe(false);
  });
});
