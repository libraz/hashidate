import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const IMPORTER = fileURLToPath(new URL('../../tools/blender/import_pack.py', import.meta.url));
const ID = 'demo';

// Writes a zip of the given members; a member named *.unitypackage is built as
// one, holding each listed Unity path as a guid/pathname + guid/asset pair.
const BUILD = `
import io, json, sys, tarfile, zipfile
out, members = sys.argv[1], json.loads(sys.argv[2])
def unitypackage(paths):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for i, path in enumerate(paths):
            for name, data in (("pathname", path.encode()), ("asset", b"asset " + path.encode())):
                info = tarfile.TarInfo(f"guid{i}/{name}")
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()
with zipfile.ZipFile(out, "w") as z:
    for name, content in members.items():
        z.writestr(name, unitypackage(content) if name.endswith(".unitypackage") else content)
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hashidate-import-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Pack {
  extract?: unknown[];
  sha256?: string;
  profile?: Record<string, unknown>;
}

async function zip(members: Record<string, string | string[]>): Promise<string> {
  const path = join(dir, 'package.zip');
  const built = spawnSync('python3', ['-I', '-c', BUILD, path, JSON.stringify(members)]);
  expect(built.status).toBe(0);
  return path;
}

async function hash(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function pack({ extract = [], sha256 = '0'.repeat(64), profile }: Pack): Promise<void> {
  const root = join(dir, 'packs', ID);
  await mkdir(root, { recursive: true });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(
    join(root, 'pack.json'),
    json({
      store: 'https://example.com/demo',
      packages: [{ file: 'package.zip', sha256 }],
      extract,
    }),
  );
  await writeFile(join(root, 'avatar.json'), json({ label: { en: 'Demo', ja: 'デモ' } }));
  await writeFile(
    join(root, 'export.json'),
    json(
      profile ?? {
        source: `unpacked/${ID}/Demo/demo.fbx`,
        textures: `unpacked/${ID}/tex_web`,
        textures_src: `unpacked/${ID}/Demo/PNG`,
        separator: '^_+(.+?)_+$',
        keep_groups: [],
      },
    ),
  );
}

function run(...args: string[]) {
  return spawnSync('python3', ['-I', IMPORTER, 'packs', ...args], { cwd: dir, encoding: 'utf8' });
}

const avatar = () => join(dir, 'avatars', `${ID}.json`);
const profile = () => join(dir, 'avatars', 'export', `${ID}.json`);

describe('import_pack.py', () => {
  it('unpacks a verified package and puts the descriptor and profile in place', async () => {
    const path = await zip({ 'Demo/demo.fbx': 'fbx', 'Demo/PNG/body.png': 'png' });
    await pack({ sha256: await hash(path) });

    const result = run(ID, path, 'avatars');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verified package package.zip');
    expect(result.stderr).toBe('');
    expect(existsSync(join(dir, 'unpacked', ID, 'Demo/demo.fbx'))).toBe(true);
    expect(await readFile(avatar(), 'utf8')).toBe(
      await readFile(join(dir, 'packs', ID, 'avatar.json'), 'utf8'),
    );
    expect(existsSync(profile())).toBe(true);
  });

  it('pulls FBX and textures out of a unitypackage by path substring', async () => {
    const path = await zip({
      'Demo/Demo.unitypackage': [
        'Assets/Demo/FBX/demo.fbx',
        'Assets/Demo/Texture/body.png',
        'Assets/Demo/Other/skip.fbx',
      ],
    });
    await pack({
      extract: [{ from: 'Demo/Demo.unitypackage', match: '/FBX/', into: 'fbx' }],
      profile: {
        source: `unpacked/${ID}/fbx/demo.fbx`,
        textures: `unpacked/${ID}/tex_web`,
        separator: '^_+(.+?)_+$',
        keep_groups: [],
      },
    });

    const result = run(ID, path, 'avatars');

    expect(result.status).toBe(0);
    const fbx = join(dir, 'unpacked', ID, 'fbx');
    expect(await readFile(join(fbx, 'demo.fbx'), 'utf8')).toBe('asset Assets/Demo/FBX/demo.fbx');
    expect(existsSync(join(fbx, 'skip.fbx'))).toBe(false);
  });

  it('warns about a package it was not verified with and imports it anyway', async () => {
    const path = await zip({ 'Demo/demo.fbx': 'fbx', 'Demo/PNG/body.png': 'png' });
    await pack({});

    const result = run(ID, path, 'avatars');

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('not a package this pack was verified with');
    expect(existsSync(avatar())).toBe(true);
  });

  it('refuses a package that lacks a file the export profile names', async () => {
    const path = await zip({ 'Other/other.fbx': 'fbx' });
    await pack({});

    const result = run(ID, path, 'avatars');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not contain');
    expect(existsSync(avatar())).toBe(false);
  });

  it('refuses to unpack over an earlier unpacking', async () => {
    // Left in place, the earlier files would let a wrong package pass the check
    // that the export profile's files came out of it.
    const right = await zip({ 'Demo/demo.fbx': 'fbx', 'Demo/PNG/body.png': 'png' });
    await pack({});
    expect(run(ID, right, 'avatars').status).toBe(0);
    const wrong = await zip({ 'Other/other.fbx': 'fbx' });

    const result = run(ID, wrong, 'avatars');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`unpacked/${ID} already exists`);
  });

  it('never overwrites a descriptor that differs from the pack', async () => {
    const path = await zip({ 'Demo/demo.fbx': 'fbx', 'Demo/PNG/body.png': 'png' });
    await pack({});
    await mkdir(join(dir, 'avatars'), { recursive: true });
    await writeFile(avatar(), '{"label":{"en":"Mine","ja":"自分の"}}');

    const result = run(ID, path, 'avatars');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('move it aside');
    expect(await readFile(avatar(), 'utf8')).toBe('{"label":{"en":"Mine","ja":"自分の"}}');
  });

  it.each([
    [{ from: '../x.unitypackage', match: '/FBX/', into: 'fbx' }, "may not contain '..'"],
    [{ from: 'x.unitypackage', match: '/FBX/', into: '/tmp/fbx' }, 'must be a relative path'],
    [{ from: 'x.unitypackage', match: '', into: 'fbx' }, 'match must be a non-empty string'],
    [{ from: 'x.unitypackage', match: '/FBX/', into: 'fbx', run: 'sh' }, 'needs exactly'],
  ])('refuses an extract step %j', async (step, message) => {
    const path = await zip({ 'Demo/demo.fbx': 'fbx' });
    await pack({ extract: [step] });

    const result = run(ID, path, 'avatars');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it('refuses an export profile that reads from outside the pack', async () => {
    const path = await zip({ 'Demo/demo.fbx': 'fbx' });
    await pack({
      profile: { source: 'unpacked/other/demo.fbx', separator: 'x', keep_groups: [] },
    });

    const result = run(ID, path, 'avatars');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`must be under unpacked/${ID}/`);
  });

  it('refuses a pack id that is not a directory name', async () => {
    const result = run('../demo', join(dir, 'package.zip'), 'avatars');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no pack named');
  });

  it('lists the packs with where to buy each model', async () => {
    await pack({});

    const result = spawnSync('python3', ['-I', IMPORTER, 'packs'], { cwd: dir, encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('demo');
    expect(result.stdout).toContain('https://example.com/demo');
  });
});
