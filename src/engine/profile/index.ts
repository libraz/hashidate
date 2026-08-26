/**
 * Avatar profile.
 *
 * The runtime never names a bone or a blendshape directly. It asks the profile
 * for a canonical slot ("upperArm.L", viseme "a") and the profile resolves it to
 * whatever this particular avatar happens to call it. Swapping avatars means
 * swapping this object, not touching the runtime.
 *
 * buildProfile() is the auto-detection pass described in the engine design doc:
 * it scans the loaded scene and produces a draft profile. Anything it cannot
 * resolve is reported in `missing` so it can be corrected by hand.
 */

import type * as THREE from 'three';
import { buildBodyFrame } from '../anatomy';
import type { AvatarDescriptor, BlinkShapes, Profile, VisemeName, VrmEmotionName } from '../types';
import {
  buildRestDirections,
  collectBones,
  deriveSideSign,
  measureLimbs,
  measureSpan,
  resolveBones,
  resolveFingers,
} from './bones';
import {
  ARKIT_52,
  BLINK_CANDIDATES,
  DEFAULT_GAZE_LIMITS,
  DEFAULT_SEPARATOR,
  VISEME_CANDIDATES,
  VRM_EMOTION_CANDIDATES,
} from './candidates';
import { buildFaceFrame } from './frames';
import { readGroups, routeMorphs } from './morphs';

const first = (dict: Record<string, number>, names: string[]): string | null =>
  names.find((n) => n in dict) ?? null;

/**
 * @param root    the loaded GLB scene
 * @param avatar  the avatar descriptor (see `avatars/index.ts`). Omitting it
 *                runs pure auto-detection, which is what a brand-new avatar
 *                gets before anyone has written its profile.
 */
export function buildProfile(
  root: THREE.Object3D,
  avatar: Partial<AvatarDescriptor> = {},
): Profile {
  const bonesByName = collectBones(root);

  const missing: string[] = [];
  const { value: bones, missing: boneGaps } = resolveBones(bonesByName);
  missing.push(...boneGaps);

  const { value: fingerBones, missing: fingerGaps } = resolveFingers(bonesByName);
  missing.push(...fingerGaps);

  const { morphTargets, faceMeshes, dict } = routeMorphs(root);

  // An avatar may name a slot in a way no generic candidate list would guess.
  // Its own names are tried first, then the generic ones — so stating a name
  // overrides detection without disabling it.
  const own = avatar.shapes ?? {};
  const candidates = (generic: string[], stated?: string[]) =>
    stated ? [...stated, ...generic] : generic;

  const viseme: Partial<Record<VisemeName, string>> = {};
  for (const k of Object.keys(VISEME_CANDIDATES) as VisemeName[]) {
    const hit = first(dict, candidates(VISEME_CANDIDATES[k], own.viseme?.[k]));
    if (hit) viseme[k] = hit;
    else if (k !== 'n' && k !== 'sil') missing.push(`viseme:${k}`);
  }

  const vrmEmotion: Partial<Record<VrmEmotionName, string>> = {};
  for (const k of Object.keys(VRM_EMOTION_CANDIDATES) as VrmEmotionName[]) {
    const hit = first(dict, VRM_EMOTION_CANDIDATES[k]);
    if (hit) vrmEmotion[k] = hit;
  }

  const blink: BlinkShapes = {
    both: first(dict, candidates(BLINK_CANDIDATES.both, own.blink?.both)),
    L: first(dict, candidates(BLINK_CANDIDATES.L, own.blink?.L)),
    R: first(dict, candidates(BLINK_CANDIDATES.R, own.blink?.R)),
  };
  if (!(blink.both || blink.L)) missing.push('blink');

  // ARKit support is the primary expression channel. 52 minus tongueOut is
  // normal for Japanese avatars, so anything above 45 counts as supported.
  const arkitNames = Object.keys(dict).filter((n) => ARKIT_52.has(n));
  const arkit = {
    supported: arkitNames.length >= 45,
    count: arkitNames.length,
    names: new Set(arkitNames),
  };
  // Not a gap when the avatar brings its own emotion vocabulary. An avatar that
  // implements none of ARKit and says so is fully specified; one that is simply
  // silent is the case worth surfacing.
  if (!(arkit.supported || avatar.emotionShapes)) missing.push(`arkit(${arkitNames.length}/52)`);

  const sideSign = deriveSideSign(root, bones);
  const restDir = buildRestDirections(bones, fingerBones);

  const groups = readGroups(root, avatar.separator ?? DEFAULT_SEPARATOR);
  const face = buildFaceFrame(root, bones);
  if (!face) missing.push('face:no frame (need head + both eyes)');
  const body = buildBodyFrame(root, bones);
  // Stated as what is actually required rather than as the canonical slots: the
  // frame falls back down the spine and takes the upper arm where a clavicle is
  // absent, so a rig missing `chest` outright still resolves.
  if (!body) missing.push('body:no frame (need a trunk bone, a shoulder per side, and a neck)');

  const limb = measureLimbs(root, bones, fingerBones);

  // Needs the limb lengths, so it cannot go with the frame it belongs to.
  if (body) body.span = measureSpan(bones, body, limb);

  return {
    // The scene itself, kept so the anatomy layer can measure the body's actual
    // shape rather than approximate it from bone positions.
    root,
    // `Profile.avatar` is a full descriptor, but auto-detection has to run for a
    // model nobody has written one for. The identity fields are filled with
    // empty strings rather than loosening the type every consumer reads.
    avatar: { id: '', label: '', url: '', ...avatar },
    bones,
    fingerBones,
    morphTargets,
    faceMeshes,
    dict,
    viseme,
    vrmEmotion,
    blink,
    arkit,
    sideSign,
    restDir,
    groups,
    face,
    body,
    limb,
    missing,
    gaze: { ...DEFAULT_GAZE_LIMITS, ...(avatar.gaze ?? {}) },
  };
}

export { ARKIT_52, DEFAULT_GAZE_LIMITS, isSeparator } from './candidates';
export { BODY_ANCHORS, FACE_ANCHORS } from './frames';
