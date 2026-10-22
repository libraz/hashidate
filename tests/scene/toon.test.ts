import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { setupMaterials } from '@/engine/scene/materials';
import { LilToonMaterial, type TextureSource } from '@/engine/scene/toon';
import type { AvatarDescriptor, ToonSpec } from '@/engine/types';

const PARS = '#include <lights_toon_pars_fragment>';
const LIGHTS_END = '#include <lights_fragment_end>';
const ALPHA_TEST = '#include <alphatest_fragment>';
const SKINNING = '#include <skinning_vertex>';

const FEATURES = [
  'LIL_RIM',
  'LIL_RIM_MASK',
  'LIL_MATCAP',
  'LIL_MATCAP_MASK',
  'LIL_SHADOW_MASK',
  'LIL_OUTLINE',
  'LIL_OUTLINE_MASK',
] as const;

const shadowOnly = (): ToonSpec => ({
  shadow: { color: [0.5, 0.5, 0.5], border: 0.39, blur: 0.26, strength: 1, normalStrength: 0.8 },
});

/** A texture source that hands out one named texture per file and kind, and records the asks. */
function recordingSource(): { source: TextureSource; asks: Array<[string, string]> } {
  const made = new Map<string, THREE.Texture>();
  const asks: Array<[string, string]> = [];
  const source: TextureSource = (file, kind) => {
    asks.push([file, kind]);
    const key = `${kind}:${file}`;
    let texture = made.get(key);
    if (!texture) {
      texture = new THREE.Texture();
      texture.name = key;
      made.set(key, texture);
    }
    return texture;
  };
  return { source, asks };
}

interface Compiled {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

/** Run the material's hook over three's real toon program, as the renderer would. */
function compile(
  material: THREE.Material,
  vertexShader = THREE.ShaderLib.toon.vertexShader,
  fragmentShader = THREE.ShaderLib.toon.fragmentShader,
): Compiled {
  const shader: Compiled = { uniforms: {}, vertexShader, fragmentShader };
  material.onBeforeCompile(shader as never, {} as never);
  return shader;
}

/** The `lil*` uniform names a source declares. */
const declared = (source: string): string[] =>
  [...source.matchAll(/uniform\s+\w+\s+(lil\w+)\s*;/g)].map((m) => m[1]);

const definesOf = (material: THREE.Material): string[] =>
  FEATURES.filter((name) => Object.hasOwn(material.defines ?? {}, name));

describe('LilToonMaterial shader patch', () => {
  it('replaces the toon pars and keeps the declarations other chunks read', () => {
    const { fragmentShader } = compile(
      new LilToonMaterial({}, shadowOnly(), recordingSource().source),
    );
    expect(fragmentShader).not.toContain(PARS);
    expect(fragmentShader).not.toContain('RE_Direct_Toon');
    expect(fragmentShader).toContain('varying vec3 vViewPosition;');
    expect(fragmentShader).toContain('struct ToonMaterial { vec3 diffuseColor; };');
    expect(fragmentShader).toContain('vec3 lilDir = vec3( 0.0 );');
    expect(fragmentShader).toContain('void RE_Direct_Lil(');
    expect(fragmentShader).toContain('#define RE_Direct RE_Direct_Lil');
    expect(fragmentShader).toContain('#define RE_IndirectDiffuse RE_IndirectDiffuse_Lil');
  });

  it('keeps three’s RE_* signatures verbatim', () => {
    const { fragmentShader } = compile(
      new LilToonMaterial({}, shadowOnly(), recordingSource().source),
    );
    const chunk = THREE.ShaderChunk.lights_toon_pars_fragment;
    const params = (source: string, name: string): string => {
      const start = source.indexOf(`${name}(`);
      expect(start).toBeGreaterThanOrEqual(0);
      return source.slice(start + name.length, source.indexOf(')', start) + 1);
    };
    expect(params(fragmentShader, 'RE_Direct_Lil')).toBe(params(chunk, 'RE_Direct_Toon'));
    expect(params(fragmentShader, 'RE_IndirectDiffuse_Lil')).toBe(
      params(chunk, 'RE_IndirectDiffuse_Toon'),
    );
  });

  it('composes after the lights, thins the outline before the alpha test and pushes after skinning', () => {
    const { fragmentShader, vertexShader } = compile(
      new LilToonMaterial({}, shadowOnly(), recordingSource().source),
    );
    const end = fragmentShader.indexOf(LIGHTS_END);
    expect(end).toBeGreaterThanOrEqual(0);
    expect(fragmentShader.indexOf('reflectedLight.directDiffuse = lilOut;')).toBeGreaterThan(end);
    const alpha = fragmentShader.indexOf(ALPHA_TEST);
    const thin = fragmentShader.indexOf('diffuseColor.a *= lilOutlineColor.a;');
    expect(thin).toBeGreaterThanOrEqual(0);
    expect(thin).toBeLessThan(alpha);
    const skin = vertexShader.indexOf(SKINNING);
    expect(skin).toBeGreaterThanOrEqual(0);
    expect(vertexShader.indexOf('transformed += lilN * ( lilW / lilS );')).toBeGreaterThan(skin);
  });

  it('supplies a uniform for every lil uniform either stage declares', () => {
    const { source } = recordingSource();
    const full: ToonSpec = {
      ...shadowOnly(),
      shadow: { ...shadowOnly().shadow, mask: 's.png' },
      rim: { color: [1, 1, 1, 1], border: 0.5, blur: 0.6, fresnelPower: 3, mask: 'r.png' },
      matcap: { file: 'm.png', color: [1, 1, 1, 1], blend: 1, mode: 'add', mask: 'mm.png' },
      outline: { width: 0.08, color: [0.6, 0.5, 0.7, 1], fixWidth: 0.5, mask: 'o.png' },
    };
    for (const outline of [false, true]) {
      const shader = compile(new LilToonMaterial({}, full, source, outline));
      const names = [...declared(shader.fragmentShader), ...declared(shader.vertexShader)];
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(shader.uniforms).toHaveProperty(name);
    }
  });

  it.each([
    ['fragment', PARS],
    ['fragment', LIGHTS_END],
    ['fragment', ALPHA_TEST],
    ['vertex', SKINNING],
  ])('throws when the %s shader lost %s', (stage, marker) => {
    const material = new LilToonMaterial({}, shadowOnly(), recordingSource().source);
    const vertex = THREE.ShaderLib.toon.vertexShader;
    const fragment = THREE.ShaderLib.toon.fragmentShader;
    expect(() =>
      compile(
        material,
        stage === 'vertex' ? vertex.replace(marker, '') : vertex,
        stage === 'fragment' ? fragment.replace(marker, '') : fragment,
      ),
    ).toThrow(/Toon material .* lost its .* include/);
  });
});

describe('three r186 symbols the patch relies on', () => {
  it('has every marker in the toon program, in the order the patch reads them', () => {
    const fragment = THREE.ShaderLib.toon.fragmentShader;
    const vertex = THREE.ShaderLib.toon.vertexShader;
    const at = (source: string, marker: string): number => {
      const index = source.indexOf(marker);
      expect(index, marker).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at(fragment, '#include <lights_pars_begin>')).toBeLessThan(at(fragment, PARS));
    expect(at(fragment, '#include <map_fragment>')).toBeLessThan(at(fragment, ALPHA_TEST));
    expect(at(fragment, '#include <normal_fragment_maps>')).toBeLessThan(
      at(fragment, '#include <lights_fragment_begin>'),
    );
    expect(at(fragment, '#include <normal_fragment_begin>')).toBeLessThan(
      at(fragment, '#include <normal_fragment_maps>'),
    );
    expect(at(fragment, '#include <lights_fragment_begin>')).toBeLessThan(at(fragment, LIGHTS_END));
    expect(at(vertex, '#include <skinnormal_vertex>')).toBeLessThan(at(vertex, SKINNING));
    expect(at(vertex, '#include <begin_vertex>')).toBeLessThan(at(vertex, SKINNING));
  });

  it('declares every symbol the composition reads, in the chunk the patch expects', () => {
    const chunk = THREE.ShaderChunk;
    expect(chunk.normal_fragment_begin).toContain('float faceDirection =');
    expect(chunk.normal_fragment_begin).toContain('vec3 nonPerturbedNormal = normal;');
    expect(chunk.lights_fragment_begin).toContain('vec3 geometryViewDir =');
    expect(chunk.lights_fragment_begin).toContain('vec3 geometryNormal =');
    expect(chunk.lights_fragment_begin).toContain('RE_Direct(');
    expect(chunk.lights_fragment_end).toContain('RE_IndirectDiffuse(');
    expect(chunk.lights_pars_begin).toContain('uniform vec3 ambientLightColor;');
    expect(chunk.lights_pars_begin).toContain('#if NUM_HEMI_LIGHTS > 0');
    expect(chunk.lights_pars_begin).toContain(
      'uniform HemisphereLight hemisphereLights[ NUM_HEMI_LIGHTS ];',
    );
    expect(chunk.lights_pars_begin).toMatch(
      /struct HemisphereLight \{[^}]*vec3 skyColor;[^}]*vec3 groundColor;/,
    );
    expect(chunk.common).toContain('#define RECIPROCAL_PI ');
    expect(chunk.common).toContain('#define saturate(');
    expect(chunk.beginnormal_vertex).toContain('vec3 objectNormal =');
    expect(chunk.begin_vertex).toContain('vec3 transformed =');
    expect(chunk.uv_pars_fragment).toMatch(/defined\( USE_UV \)[\s\S]*varying vec2 vUv;/);
    expect(chunk.uv_vertex).toMatch(/defined\( USE_UV \)[\s\S]*vUv = /);
  });

  it('gets the view matrix, camera position, model matrix and uv from the program prefix', () => {
    const programSource = readFileSync(
      createRequire(import.meta.url).resolve('three/src/renderers/webgl/WebGLProgram.js'),
      'utf8',
    );
    expect(programSource).toContain("'uniform mat4 modelMatrix;'");
    expect(programSource).toContain("'uniform mat4 viewMatrix;'");
    expect(programSource).toContain("'uniform vec3 cameraPosition;'");
    expect(programSource).toContain("'attribute vec2 uv;'");
  });
});

describe('LilToonMaterial values', () => {
  it('converts authored sRGB colours to linear and carries alpha and scalars over', () => {
    const spec: ToonSpec = {
      ...shadowOnly(),
      shadow2: { color: [0.5, 0.5, 0.5, 0.4], border: 0.15, blur: 0.1 },
      asUnlit: 0.2,
      rim: { color: [0.5, 1, 0, 0.7], border: 0.5, blur: 0.65, fresnelPower: 3.5 },
      matcap: { file: 'm.png', color: [1, 1, 1, 0.9], blend: 0.6, mode: 'screen' },
    };
    const { uniforms } = compile(new LilToonMaterial({}, spec, recordingSource().source));
    const shade = uniforms.lilShadowColor.value as THREE.Color;
    expect(Math.abs(shade.r - 0.214)).toBeLessThanOrEqual(1e-4);
    const shade2 = uniforms.lilShadow2Color.value as THREE.Vector4;
    expect(Math.abs(shade2.x - 0.214)).toBeLessThanOrEqual(1e-4);
    expect(shade2.w).toBe(0.4);
    const rim = uniforms.lilRimColor.value as THREE.Vector4;
    expect(rim.y).toBe(1);
    expect(rim.w).toBe(0.7);
    expect(uniforms.lilShadowBorder.value).toBe(0.39);
    expect(uniforms.lilShadowBlur.value).toBe(0.26);
    expect(uniforms.lilShadowNormalStrength.value).toBe(0.8);
    expect(uniforms.lilAsUnlit.value).toBe(0.2);
    expect(uniforms.lilRimFresnel.value).toBe(3.5);
    expect(uniforms.lilMatcapBlend.value).toBe(0.6);
    expect(uniforms.lilMatcapMode.value).toBe(2);
  });

  it('leaves the second shade invisible and lighting fully toon when they are absent', () => {
    const { uniforms } = compile(new LilToonMaterial({}, shadowOnly(), recordingSource().source));
    expect((uniforms.lilShadow2Color.value as THREE.Vector4).w).toBe(0);
    expect(uniforms.lilAsUnlit.value).toBe(0);
  });

  it('keeps spec textures as own enumerable properties that the uniforms point at', () => {
    const spec: ToonSpec = {
      ...shadowOnly(),
      shadow: { ...shadowOnly().shadow, mask: 's.png' },
      rim: { color: [1, 1, 1, 1], border: 0.5, blur: 0.6, fresnelPower: 3, mask: 'r.png' },
      matcap: { file: 'm.png', color: [1, 1, 1, 1], blend: 1, mode: 'add', mask: 'mm.png' },
      outline: { width: 0.08, color: [0.6, 0.5, 0.7, 1], fixWidth: 0.5, mask: 'o.png' },
    };
    const { source } = recordingSource();
    const body = new LilToonMaterial({}, spec, source);
    const hull = new LilToonMaterial({}, spec, source, true);
    for (const [material, names] of [
      [body, ['lilShadowMask', 'lilRimMask', 'lilMatcap', 'lilMatcapMask']],
      [hull, ['lilOutlineMask']],
    ] as const) {
      const { uniforms } = compile(material);
      for (const name of names) {
        expect(Object.getOwnPropertyDescriptor(material, name)?.enumerable).toBe(true);
        const texture = (material as unknown as Record<string, THREE.Texture>)[name];
        expect(texture).toBeInstanceOf(THREE.Texture);
        expect(Object.values(material)).toContain(texture);
        expect(uniforms[name].value).toBe(texture);
      }
    }
  });

  it('refuses an outline variant without an outline spec', () => {
    expect(() => new LilToonMaterial({}, shadowOnly(), recordingSource().source, true)).toThrow(
      /outline spec/,
    );
  });
});

/**
 * The pairwise model: normalMap, shadowMask, rim, matcap, emission, outline,
 * alpha — with an outline never on a decal.
 */
const PAIRWISE = `
aux,F,off,mask,color,off,decal
none,T,on,mask,off,mask,opaque
glb,T,mask,off,color,on,cutout
none,T,on,off,map,off,decal
glb,F,mask,on,map,mask,opaque
aux,T,off,mask,map,on,cutout
none,F,mask,mask,off,on,cutout
aux,F,on,off,color,mask,opaque
none,T,off,on,color,mask,cutout
glb,T,on,on,off,mask,cutout
glb,T,off,off,off,off,opaque
none,T,on,off,off,on,opaque
none,T,mask,on,map,off,cutout
aux,F,mask,on,color,on,opaque
aux,F,on,on,off,off,cutout
none,F,on,on,off,off,decal
glb,F,on,mask,map,off,decal
glb,F,mask,off,color,off,decal
`
  .trim()
  .split('\n')
  .map((line) => line.split(','));

describe('LilToonMaterial variants (pairwise)', () => {
  const avatar = (toon: Record<string, ToonSpec>): AvatarDescriptor => ({
    id: 'toon-test',
    label: { en: 'Toon test', ja: 'トゥーン検査' },
    url: '/toon-test.glb',
    materials: { faceDecal: /^decal-/, toon },
  });

  const keys = new Map<string, string>();

  it.each(PAIRWISE.map((row, i) => [i + 1, ...row]))(
    'row %i: normal %s, shadow mask %s, rim %s, matcap %s, emission %s, outline %s, %s',
    (_row, normal, shadowMask, rim, matcap, emission, outline, alpha) => {
      const name = `${alpha === 'decal' ? 'decal-' : ''}row`;
      const glbNormal = new THREE.Texture();
      const map = new THREE.Texture();
      const source = new THREE.MeshStandardMaterial({
        map,
        ...(normal === 'glb' ? { normalMap: glbNormal } : {}),
        ...(alpha === 'opaque' ? {} : { transparent: true }),
      });
      source.name = name;

      const spec: ToonSpec = {
        shadow: {
          color: [0.9, 0.8, 0.8],
          border: 0.4,
          blur: 0.2,
          strength: 0.9,
          normalStrength: 1,
          ...(shadowMask === 'T' ? { mask: 'shadow.png' } : {}),
        },
        ...(normal === 'aux' ? { normalMap: { file: 'normal.png', scale: 0.7 } } : {}),
        ...(rim === 'off'
          ? {}
          : {
              rim: {
                color: [1, 0.9, 0.8, 0.6],
                border: 0.5,
                blur: 0.6,
                fresnelPower: 3,
                ...(rim === 'mask' ? { mask: 'rim.png' } : {}),
              },
            }),
        ...(matcap === 'off'
          ? {}
          : {
              matcap: {
                file: 'matcap.png',
                color: [1, 1, 1, 1],
                blend: 0.5,
                mode: 'add',
                ...(matcap === 'mask' ? { mask: 'matcap-mask.png' } : {}),
              },
            }),
        ...(emission === 'off'
          ? {}
          : {
              emission: {
                color: [0.5, 0.25, 1.5],
                ...(emission === 'map' ? { map: 'emission.png' } : {}),
              },
            }),
        ...(outline === 'off'
          ? {}
          : {
              outline: {
                width: 0.08,
                color: [0.6, 0.56, 0.73, 1],
                fixWidth: 0.5,
                ...(outline === 'mask' ? { mask: 'outline.png' } : {}),
              },
            }),
      };

      const { source: textures } = recordingSource();
      const root = new THREE.Group().add(new THREE.Mesh(new THREE.BufferGeometry(), source));
      const set = setupMaterials(root, avatar({ [name]: spec }), () => null, textures);
      set.apply(true);
      const body = (root.children[0] as THREE.Mesh).material as LilToonMaterial;
      expect(body).toBeInstanceOf(LilToonMaterial);

      const expected = [
        ...(rim !== 'off' ? ['LIL_RIM'] : []),
        ...(rim === 'mask' ? ['LIL_RIM_MASK'] : []),
        ...(matcap !== 'off' ? ['LIL_MATCAP'] : []),
        ...(matcap === 'mask' ? ['LIL_MATCAP_MASK'] : []),
        ...(shadowMask === 'T' ? ['LIL_SHADOW_MASK'] : []),
      ];
      expect(definesOf(body)).toEqual(expected);
      expect(body.defines).toMatchObject({ TOON: '', USE_UV: '' });
      expect(body.customProgramCacheKey()).toBe(
        `lil:${FEATURES.map((f) => (expected.includes(f) ? '1' : '0')).join('')}`,
      );

      // Normal map: the spec's own wins, otherwise the imported one is kept.
      if (normal === 'aux') {
        expect(body.normalMap?.name).toBe('data:normal.png');
        expect(body.normalScale.toArray()).toEqual([0.7, -0.7]);
      } else {
        expect(body.normalMap).toBe(normal === 'glb' ? glbNormal : null);
      }

      // Emission through three's own slots, authored colour converted.
      if (emission === 'off') {
        expect(body.emissive.getHex()).toBe(0);
      } else {
        expect(body.emissive.r).toBeCloseTo(
          new THREE.Color().setRGB(0.5, 0, 0, THREE.SRGBColorSpace).r,
          6,
        );
        expect(body.emissiveMap?.name).toBe(emission === 'map' ? 'color:emission.png' : undefined);
      }

      // The alpha rules are the plain variant's, untouched by the spec.
      if (alpha === 'decal') {
        expect(body.transparent).toBe(true);
        expect(body.alphaTest).toBe(0.35);
      } else if (alpha === 'cutout') {
        expect(body.transparent).toBe(false);
        expect(body.alphaTest).toBe(0.25);
        expect(body.alphaToCoverage).toBe(true);
      } else {
        expect(body.transparent).toBe(false);
        expect(body.alphaTest).toBe(0);
      }

      const { uniforms } = compile(body);
      expect(uniforms.lilShadowStrength.value).toBe(0.9);
      expect(uniforms.lilShadowMask.value).toBe(body.lilShadowMask);
      expect(uniforms.lilMatcap.value).toBe(body.lilMatcap);
      expect(uniforms.lilMatcapBlend.value).toBe(matcap === 'off' ? 0 : 0.5);

      const variants: THREE.Material[] = [body];
      if (outline !== 'off') {
        const hull = new LilToonMaterial({ map }, spec, textures, true);
        const lines = ['LIL_OUTLINE', ...(outline === 'mask' ? ['LIL_OUTLINE_MASK'] : [])];
        expect(definesOf(hull)).toEqual(lines);
        expect(compile(hull).uniforms.lilOutlineWidth.value).toBe(0.08);
        variants.push(hull);
      }

      // One program per feature set, across every row.
      for (const material of variants) {
        const key = material.customProgramCacheKey();
        const features = definesOf(material).join('+');
        expect(keys.get(key) ?? features).toBe(features);
        keys.set(key, features);
      }
      set.dispose();
    },
  );
});
