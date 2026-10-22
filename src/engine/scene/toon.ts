import * as THREE from 'three';
import type { RgbaTuple, RgbTuple, ToonMatcapMode, ToonSpec } from '../types';

/**
 * lilToon's shading, grafted onto three's own toon material.
 *
 * The author's look is a shade colour, a border and a blur rather than three's
 * grey two-step, so the toon lighting hooks only gather the lights and the
 * lilToon terms are evaluated once afterwards. Every light is fused into one
 * direction and one colour, as lilToon fuses its main light with the ambient:
 * a room has up to four lights, and a term per light would draw a terminator
 * per light.
 *
 * Skinning, morphs, maps, alpha, emission, fog and tone mapping stay three's,
 * which is why this patches four include markers rather than owning a shader.
 * The outline variant is the same material drawn as an inverted hull.
 */

/** Where a spec's auxiliary file comes from, decoded as colour or as data. */
export type TextureSource = (file: string, kind: 'color' | 'data') => THREE.Texture;

/** The source for an avatar loaded without auxiliary textures; any call is a wiring bug. */
export const missingTextureSource: TextureSource = () => {
  throw new Error('toon spec names a texture but no texture source was given');
};

/** The feature switches, in the order `customProgramCacheKey` encodes them. */
const FEATURES = [
  'LIL_RIM',
  'LIL_RIM_MASK',
  'LIL_MATCAP',
  'LIL_MATCAP_MASK',
  'LIL_SHADOW_MASK',
  'LIL_OUTLINE',
  'LIL_OUTLINE_MASK',
] as const;

const MATCAP_MODES: readonly ToonMatcapMode[] = ['normal', 'add', 'screen', 'multiply'];

const PARS_MARKER = '#include <lights_toon_pars_fragment>';
const LIGHTS_END_MARKER = '#include <lights_fragment_end>';
const ALPHA_TEST_MARKER = '#include <alphatest_fragment>';
const SKINNING_MARKER = '#include <skinning_vertex>';

/**
 * Replaces three's toon pars. The varying and the struct are kept because
 * other chunks still read them; the RE_* hooks only accumulate the fused light.
 */
const PARS = /* glsl */ `
varying vec3 vViewPosition;
struct ToonMaterial { vec3 diffuseColor; };
vec3 lilDir = vec3( 0.0 );
vec3 lilCol = vec3( 0.0 );
float lilLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
void RE_Direct_Lil( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
  lilDir += directLight.direction * lilLum( directLight.color );
  lilCol += directLight.color;
}
void RE_IndirectDiffuse_Lil( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {}
#define RE_Direct RE_Direct_Lil
#define RE_IndirectDiffuse RE_IndirectDiffuse_Lil

uniform vec3 lilShadowColor;
uniform float lilShadowBorder;
uniform float lilShadowBlur;
uniform float lilShadowStrength;
uniform float lilShadowNormalStrength;
uniform vec4 lilShadow2Color;
uniform float lilShadow2Border;
uniform float lilShadow2Blur;
uniform float lilAsUnlit;
uniform vec4 lilRimColor;
uniform float lilRimBorder;
uniform float lilRimBlur;
uniform float lilRimFresnel;
uniform vec4 lilMatcapColor;
uniform float lilMatcapBlend;
uniform int lilMatcapMode;
uniform vec4 lilOutlineColor;
#ifdef LIL_SHADOW_MASK
uniform sampler2D lilShadowMask;
#endif
#ifdef LIL_RIM_MASK
uniform sampler2D lilRimMask;
#endif
#ifdef LIL_MATCAP
uniform sampler2D lilMatcap;
#endif
#ifdef LIL_MATCAP_MASK
uniform sampler2D lilMatcapMask;
#endif

// lilToon's anti-aliased step, at an AA strength of 1. The floor on the
// divisor keeps a zero blur on a flat patch from dividing by zero.
float lilTooning( float value, float border, float blur ) {
  float borderMin = saturate( border - blur * 0.5 );
  float borderMax = saturate( border + blur * 0.5 );
  return saturate( ( value - borderMin ) / clamp( borderMax - borderMin + fwidth( value ), 1e-5, 1.0 ) );
}

// 0 normal, 1 add, 2 screen, 3 multiply.
vec3 lilBlend( vec3 dst, vec3 src, float a, int mode ) {
  vec3 o = src;
  if ( mode == 1 ) o = dst + src;
  else if ( mode == 2 ) o = max( dst + src - dst * src, dst );
  else if ( mode == 3 ) o = dst * src;
  return mix( dst, o, a );
}
`;

/** Evaluated once, after three has run every light through the RE_* hooks above. */
const COMPOSE = /* glsl */ `
vec3 lilAmbUp = ambientLightColor;
vec3 lilAmbDown = ambientLightColor;
#if NUM_HEMI_LIGHTS > 0
  // Every hemisphere light is taken as pointing up, which both the default
  // rig and the rooms leave it doing.
  for ( int lilI = 0; lilI < NUM_HEMI_LIGHTS; lilI ++ ) {
    lilAmbUp += hemisphereLights[ lilI ].skyColor;
    lilAmbDown += hemisphereLights[ lilI ].groundColor;
  }
#endif
// Divided by pi so the lit side sits where three's Lambert toon put it.
vec3 lilLight = clamp( ( lilCol + max( lilAmbUp, lilAmbDown ) ) * RECIPROCAL_PI, 0.05, 1.0 );
#ifdef LIL_OUTLINE
  reflectedLight.directDiffuse = diffuseColor.rgb * lilOutlineColor.rgb * lilLight;
  reflectedLight.indirectDiffuse = vec3( 0.0 );
#else
  vec3 lilUpView = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  vec3 lilL = normalize( lilDir + lilUpView * ( max( 0.0, lilLum( lilAmbUp ) - lilLum( lilAmbDown ) ) + 1e-4 ) );
  lilLight = mix( lilLight, vec3( 1.0 ), lilAsUnlit );

  vec3 lilAlbedo = diffuseColor.rgb;
  vec3 lilN1 = normalize( mix( nonPerturbedNormal, normal, lilShadowNormalStrength ) );
  float lilLn = saturate( dot( lilL, lilN1 ) * 0.5 + 0.5 );
  float lilT1 = lilTooning( lilLn, lilShadowBorder, lilShadowBlur );
  float lilT2 = lilTooning( lilLn, lilShadow2Border, lilShadow2Blur );
  float lilShadowAmount = 1.0;
  #ifdef LIL_SHADOW_MASK
    lilShadowAmount = texture2D( lilShadowMask, vUv ).r;
  #endif
  lilT1 = mix( 1.0, lilT1, lilShadowStrength * lilShadowAmount );

  vec3 lilShade = lilAlbedo * lilShadowColor;
  vec3 lilShade2 = lilAlbedo * lilShadow2Color.rgb;
  float lilW2 = lilShadow2Color.a - lilT2 * lilShadow2Color.a;
  lilShade = mix( lilShade, lilShade2, lilW2 );
  vec3 lilDirect = lilAlbedo * lilLight;
  lilShade = min( lilShade * lilLight, lilDirect );
  vec3 lilOut = mix( lilShade, lilDirect, lilT1 );

  #ifdef LIL_RIM
    float lilRim = pow( saturate( 1.0 - abs( dot( normal, geometryViewDir ) ) ), lilRimFresnel );
    lilRim = lilTooning( lilRim, lilRimBorder, lilRimBlur );
    // No rim on back faces, so a double-sided hair card does not glow from behind.
    lilRim *= step( 0.0, faceDirection );
    lilRim = mix( lilRim, lilRim * lilT1, 0.5 );
    float lilRimAmount = 1.0;
    #ifdef LIL_RIM_MASK
      lilRimAmount = texture2D( lilRimMask, vUv ).r;
    #endif
    lilOut += lilRimColor.rgb * lilLight * lilRim * lilRimColor.a * lilRimAmount;
  #endif

  #ifdef LIL_MATCAP
    // three's own matcap frame; at a front bust it agrees with lilToon's.
    vec3 lilMx = normalize( vec3( geometryViewDir.z, 0.0, - geometryViewDir.x ) );
    vec3 lilMy = cross( geometryViewDir, lilMx );
    vec2 lilMatcapUv = vec2( dot( lilMx, normal ), dot( lilMy, normal ) ) * 0.495 + 0.5;
    vec4 lilM = lilMatcapColor * texture2D( lilMatcap, lilMatcapUv );
    lilM.rgb *= lilLight;
    float lilMatcapAmount = 1.0;
    #ifdef LIL_MATCAP_MASK
      lilMatcapAmount = texture2D( lilMatcapMask, vUv ).r;
    #endif
    lilOut = lilBlend( lilOut, lilM.rgb, lilMatcapBlend * lilM.a * lilMatcapAmount, lilMatcapMode );
  #endif

  reflectedLight.directDiffuse = lilOut;
  reflectedLight.indirectDiffuse = vec3( 0.0 );
#endif
`;

/** The outline's own alpha, applied before the cutout test so it can thin the line. */
const OUTLINE_ALPHA = /* glsl */ `
#ifdef LIL_OUTLINE
  diffuseColor.a *= lilOutlineColor.a;
#endif
`;

const VERTEX_PARS = /* glsl */ `
#ifdef LIL_OUTLINE
uniform float lilOutlineWidth;
uniform float lilOutlineFixWidth;
#ifdef LIL_OUTLINE_MASK
uniform sampler2D lilOutlineMask;
#endif
#endif
`;

/**
 * The inverted hull. Width is lilToon's object-space unit; dividing by the
 * model matrix's stretch along the normal undoes an export scale, and
 * `fixWidth` thins the line only inside a metre of the camera.
 */
const OUTLINE_PUSH = /* glsl */ `
#ifdef LIL_OUTLINE
  vec3 lilN = normalize( objectNormal );
  float lilS = max( length( mat3( modelMatrix ) * lilN ), 1e-6 );
  float lilW = lilOutlineWidth * 0.01;
  #ifdef LIL_OUTLINE_MASK
    lilW *= texture2D( lilOutlineMask, uv ).r;
  #endif
  vec3 lilWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  lilW *= mix( 1.0, clamp( distance( cameraPosition, lilWorld ), 0.0, 1.0 ), lilOutlineFixWidth );
  transformed += lilN * ( lilW / lilS );
#endif
`;

/** An authored sRGB colour in three's linear working space. */
const linear = ([r, g, b]: RgbTuple): THREE.Color =>
  new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

/** As {@link linear}, alpha carried over unconverted. */
const linearRgba = ([r, g, b, a]: RgbaTuple): THREE.Vector4 => {
  const c = linear([r, g, b]);
  return new THREE.Vector4(c.r, c.g, c.b, a);
};

/**
 * A `MeshToonMaterial` shaded by an imported lilToon spec.
 *
 * Spec textures are own enumerable properties, so the material set's dispose
 * walk frees them with every other slot. The normal map and emission use
 * three's own slots; without a spec value for them, whatever `base` carried
 * from the imported material stays.
 */
export class LilToonMaterial extends THREE.MeshToonMaterial {
  lilShadowMask: THREE.Texture | null = null;
  lilRimMask: THREE.Texture | null = null;
  lilMatcap: THREE.Texture | null = null;
  lilMatcapMask: THREE.Texture | null = null;
  lilOutlineMask: THREE.Texture | null = null;
  /** What `onBeforeCompile` hands the program; values are fixed at construction. */
  readonly lilUniforms: Record<string, THREE.IUniform>;
  private readonly programKey: string;

  /**
   * @param base The toon parameters the plain variant would have been built with.
   * @param spec The material's imported lilToon look.
   * @param textures Resolves the spec's auxiliary files.
   * @param outline Build the inverted-hull variant; `spec.outline` must be present.
   */
  constructor(
    base: THREE.MeshToonMaterialParameters,
    spec: ToonSpec,
    textures: TextureSource,
    outline = false,
  ) {
    super(base);
    const { shadow, shadow2, rim, matcap, emission, normalMap } = spec;
    const line = spec.outline;
    if (outline && !line) throw new Error('An outline material needs an outline spec');

    // The hull paints albedo times the outline colour and nothing else, so it
    // carries none of the body's features or their textures.
    if (outline && line) {
      this.lilOutlineMask = line.mask ? textures(line.mask, 'data') : null;
    } else {
      this.lilShadowMask = shadow.mask ? textures(shadow.mask, 'data') : null;
      this.lilRimMask = rim?.mask ? textures(rim.mask, 'data') : null;
      this.lilMatcap = matcap ? textures(matcap.file, 'color') : null;
      this.lilMatcapMask = matcap?.mask ? textures(matcap.mask, 'data') : null;
      if (normalMap) {
        this.normalMap = textures(normalMap.file, 'data');
        // The exporter writes no tangents, so three derives the frame from
        // glTF-convention UVs and the loader flips y for that; so do we.
        this.normalScale.set(normalMap.scale, -normalMap.scale);
      }
      if (emission) {
        const [r, g, b] = emission.color;
        this.emissive.setRGB(r, g, b, THREE.SRGBColorSpace);
        // The authored colour is HDR and carries its own strength.
        this.emissiveIntensity = 1;
        this.emissiveMap = emission.map ? textures(emission.map, 'color') : null;
      }
    }

    const on: Record<(typeof FEATURES)[number], boolean> = {
      LIL_RIM: !outline && !!rim,
      LIL_RIM_MASK: this.lilRimMask !== null,
      LIL_MATCAP: this.lilMatcap !== null,
      LIL_MATCAP_MASK: this.lilMatcapMask !== null,
      LIL_SHADOW_MASK: this.lilShadowMask !== null,
      LIL_OUTLINE: outline,
      LIL_OUTLINE_MASK: this.lilOutlineMask !== null,
    };
    const defines: Record<string, unknown> = { ...this.defines, USE_UV: '' };
    for (const name of FEATURES) if (on[name]) defines[name] = '';
    this.defines = defines;
    this.programKey = `lil:${FEATURES.map((name) => (on[name] ? '1' : '0')).join('')}`;

    this.lilUniforms = {
      lilShadowColor: { value: linear(shadow.color) },
      lilShadowBorder: { value: shadow.border },
      lilShadowBlur: { value: shadow.blur },
      lilShadowStrength: { value: shadow.strength },
      lilShadowNormalStrength: { value: shadow.normalStrength },
      lilShadow2Color: {
        value: shadow2 ? linearRgba(shadow2.color) : new THREE.Vector4(0, 0, 0, 0),
      },
      lilShadow2Border: { value: shadow2?.border ?? 0 },
      lilShadow2Blur: { value: shadow2?.blur ?? 0 },
      lilAsUnlit: { value: spec.asUnlit ?? 0 },
      lilRimColor: { value: rim ? linearRgba(rim.color) : new THREE.Vector4() },
      lilRimBorder: { value: rim?.border ?? 0 },
      lilRimBlur: { value: rim?.blur ?? 0 },
      lilRimFresnel: { value: rim?.fresnelPower ?? 1 },
      lilMatcapColor: { value: matcap ? linearRgba(matcap.color) : new THREE.Vector4() },
      lilMatcapBlend: { value: matcap?.blend ?? 0 },
      lilMatcapMode: { value: matcap ? MATCAP_MODES.indexOf(matcap.mode) : 0 },
      lilOutlineColor: { value: line ? linearRgba(line.color) : new THREE.Vector4(1, 1, 1, 1) },
      lilOutlineWidth: { value: line?.width ?? 0 },
      lilOutlineFixWidth: { value: line?.fixWidth ?? 0 },
      lilShadowMask: { value: this.lilShadowMask },
      lilRimMask: { value: this.lilRimMask },
      lilMatcap: { value: this.lilMatcap },
      lilMatcapMask: { value: this.lilMatcapMask },
      lilOutlineMask: { value: this.lilOutlineMask },
    };
  }

  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms): void {
    Object.assign(shader.uniforms, this.lilUniforms);
    const patch = (source: string, marker: string, label: string, to: string): string => {
      if (!source.includes(marker)) {
        throw new Error(`Toon material ${this.type} lost its ${label} include`);
      }
      return source.replace(marker, to);
    };
    let fragment = shader.fragmentShader;
    fragment = patch(fragment, PARS_MARKER, 'toon lights pars', PARS);
    fragment = patch(fragment, LIGHTS_END_MARKER, 'lights end', `${LIGHTS_END_MARKER}\n${COMPOSE}`);
    fragment = patch(
      fragment,
      ALPHA_TEST_MARKER,
      'alpha test',
      `${OUTLINE_ALPHA}\n${ALPHA_TEST_MARKER}`,
    );
    const vertex = patch(
      shader.vertexShader,
      SKINNING_MARKER,
      'skinning',
      `${SKINNING_MARKER}\n${OUTLINE_PUSH}`,
    );
    shader.fragmentShader = fragment;
    shader.vertexShader = `${VERTEX_PARS}\n${vertex}`;
  }

  override customProgramCacheKey(): string {
    return this.programKey;
  }
}
