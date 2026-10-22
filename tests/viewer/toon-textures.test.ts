import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { AVATAR_ANISOTROPY } from '@/engine/scene/materials';
import type { AvatarDescriptor, ToonSpec } from '@/engine/types';
import { loadToonTextures } from '@/viewer/scene/runtime/toon-textures';

const shadow: ToonSpec['shadow'] = {
  color: [0.9, 0.8, 0.8],
  border: 0.4,
  blur: 0.2,
  strength: 1,
  normalStrength: 1,
};

/** The matcap keys these tests do not vary. */
const matcapRest = {
  shadowMask: 0,
  enableLighting: 1,
  mainStrength: 0,
  normalStrength: 1,
  backfaceMask: 0,
};

const avatar = (toon?: Record<string, ToonSpec>): AvatarDescriptor => ({
  id: 'yoka',
  label: { en: 'Yoka', ja: 'ヨカ' },
  url: '/models/yoka.glb',
  ...(toon ? { materials: { toon } } : {}),
});

/** A loader that answers every URL with a fresh texture, except those listed as missing. */
function fakeLoader(missing: string[] = []) {
  const urls: string[] = [];
  const made: THREE.Texture<HTMLImageElement>[] = [];
  const loader = {
    loadAsync: vi.fn(async (url: string) => {
      urls.push(url);
      if (missing.some((file) => url.endsWith(`/${file}`))) throw new Error(`404 ${url}`);
      const texture = new THREE.Texture<HTMLImageElement>();
      texture.name = url;
      made.push(texture);
      return texture;
    }),
  };
  return { loader, urls, made };
}

describe('loadToonTextures', () => {
  it('loads nothing for a descriptor without toon specs', async () => {
    const { loader } = fakeLoader();
    const loaded = await loadToonTextures(avatar(), loader);
    expect(loader.loadAsync).not.toHaveBeenCalled();
    expect(loaded.failed).toEqual([]);
    loaded.dispose();
  });

  it('fetches every named file once from beside the GLB', async () => {
    const { loader, urls } = fakeLoader();
    await loadToonTextures(
      avatar({
        Skin: {
          shadow: { ...shadow, mask: 'shade.png' },
          normalMap: { file: 'normal.png', scale: 1 },
          rim: {
            color: [1, 1, 1, 1],
            border: 0.5,
            blur: 0.6,
            fresnelPower: 3,
            normalStrength: 1,
            backfaceMask: 1,
            shadowMask: 0.5,
            mainStrength: 0,
            enableLighting: 1,
            mode: 'add',
            dirStrength: 0,
            dirRange: 0,
            indirRange: 0,
            indirColor: [1, 1, 1, 1],
            indirBorder: 0.5,
            indirBlur: 0.1,
            colorTex: 'rim.png',
          },
          matcap: {
            file: 'cap.png',
            color: [1, 1, 1, 1],
            blend: 1,
            mode: 'add',
            mask: 'capm.png',
            shadowMask: 0,
            enableLighting: 1,
            mainStrength: 0,
            normalStrength: 1,
            backfaceMask: 0,
          },
          emission: { color: [1, 1, 1], map: 'glow.png' },
          outline: { width: 0.08, color: [0, 0, 0, 1], fixWidth: 0.5, mask: 'line.png' },
        },
        Hair: { shadow: { ...shadow, mask: 'shade.png' } },
      }),
      loader,
    );
    expect(urls.sort()).toEqual(
      [
        '/models/yoka/cap.png',
        '/models/yoka/capm.png',
        '/models/yoka/glow.png',
        '/models/yoka/line.png',
        '/models/yoka/normal.png',
        '/models/yoka/rim.png',
        '/models/yoka/shade.png',
      ].sort(),
    );
  });

  it('decodes colour as sRGB and data as raw, unflipped and anisotropic', async () => {
    const { loader } = fakeLoader();
    const loaded = await loadToonTextures(
      avatar({
        Skin: {
          shadow: { ...shadow, mask: 'shade.png' },
          matcap: { file: 'cap.png', color: [1, 1, 1, 1], blend: 1, mode: 'add', ...matcapRest },
        },
      }),
      loader,
    );
    const color = loaded.textures('cap.png', 'color');
    const data = loaded.textures('shade.png', 'data');
    expect(color.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(data.colorSpace).toBe(THREE.NoColorSpace);
    for (const texture of [color, data]) {
      expect(texture.flipY).toBe(false);
      expect(texture.anisotropy).toBe(AVATAR_ANISOTROPY);
      expect(texture.version).toBeGreaterThan(0);
    }
    expect(loaded.textures('cap.png', 'color')).toBe(color);
  });

  it('makes one texture per decoding when a file is asked for both ways', async () => {
    const { loader, urls } = fakeLoader();
    const loaded = await loadToonTextures(
      avatar({
        Skin: {
          shadow: { ...shadow, mask: 'both.png' },
          matcap: { file: 'both.png', color: [1, 1, 1, 1], blend: 1, mode: 'add', ...matcapRest },
        },
      }),
      loader,
    );
    expect(urls).toEqual(['/models/yoka/both.png']);
    const color = loaded.textures('both.png', 'color');
    const data = loaded.textures('both.png', 'data');
    expect(color).not.toBe(data);
    expect(color.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(data.colorSpace).toBe(THREE.NoColorSpace);
  });

  it('reports a failed file and stands a neutral white texture in for it', async () => {
    const { loader } = fakeLoader(['gone.png']);
    const loaded = await loadToonTextures(
      avatar({
        Skin: {
          shadow: { ...shadow, mask: 'gone.png' },
          matcap: { file: 'cap.png', color: [1, 1, 1, 1], blend: 1, mode: 'add', ...matcapRest },
        },
      }),
      loader,
    );
    expect(loaded.failed).toEqual(['gone.png']);
    const neutral = loaded.textures('gone.png', 'data');
    expect(neutral).toBeInstanceOf(THREE.DataTexture);
    expect([...(neutral.image as { data: Uint8Array }).data]).toEqual([255, 255, 255, 255]);
    expect(neutral.image).toMatchObject({ width: 1, height: 1 });
    expect(neutral.colorSpace).toBe(THREE.NoColorSpace);
    expect(neutral.flipY).toBe(false);
  });

  it('refuses a file the descriptor never named', async () => {
    const { loader } = fakeLoader();
    const loaded = await loadToonTextures(avatar({ Skin: { shadow } }), loader);
    expect(() => loaded.textures('stray.png', 'color')).toThrow(/stray\.png/);
  });

  it('releases the loaded and the neutral textures on dispose', async () => {
    const { loader, made } = fakeLoader(['gone.png']);
    const loaded = await loadToonTextures(
      avatar({
        Skin: {
          shadow: { ...shadow, mask: 'gone.png' },
          matcap: { file: 'cap.png', color: [1, 1, 1, 1], blend: 1, mode: 'add', ...matcapRest },
        },
      }),
      loader,
    );
    const neutral = loaded.textures('gone.png', 'data');
    const spies = [...made, neutral].map((texture) => vi.spyOn(texture, 'dispose'));
    loaded.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledOnce();
  });
});
