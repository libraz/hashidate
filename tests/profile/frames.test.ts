import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildBodyFrame } from '@/engine/anatomy';
import { BODY_ANCHORS, buildProfile, FACE_ANCHORS } from '@/engine/profile';
import { collectBones, resolveBones } from '@/engine/profile/bones';
import { buildFaceFrame } from '@/engine/profile/frames';
import type { BodyFrame, FaceFrame, Profile } from '@/engine/types';
import { buildRig } from '../helpers/scene';

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`the profile has no ${what}`);
  return value;
}

const world = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3());

/** A frame vector taken back out to world space, for comparing two frames. */
const toWorld = (v: THREE.Vector3, bone: THREE.Object3D): THREE.Vector3 =>
  v.clone().applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion())).normalize();

const expectOrthonormal = (frame: FaceFrame | BodyFrame) => {
  for (const [label, v] of Object.entries(frame)) {
    if (!(v instanceof THREE.Vector3) || label === 'origin') continue;
    expect(v.length(), label).toBeCloseTo(1, 12);
  }
  expect(frame.right.dot(frame.up)).toBeCloseTo(0, 12);
  expect(frame.right.dot(frame.forward)).toBeCloseTo(0, 12);
  expect(frame.up.dot(frame.forward)).toBeCloseTo(0, 12);
};

const faceOf = (profile: Profile): FaceFrame => must(profile.face, 'face frame');

describe('buildFaceFrame', () => {
  it('needs a head and both eyes, and reports the gap without them', () => {
    const profile = buildProfile(buildRig({ eyes: false }).root);

    expect(profile.face).toBeNull();
    expect(profile.missing).toContain('face:no frame (need head + both eyes)');
  });

  it('measures a positive ipd between the two eye bones', () => {
    const rig = buildRig();
    const profile = buildProfile(rig.root, rig.descriptor);
    const face = faceOf(profile);
    const head = must(profile.bones.head, 'head');

    // Head-local, so the anchors it scales stay put when the head moves.
    const inv = new THREE.Matrix4().copy(head.matrixWorld).invert();
    const local = (name: string) => world(must(rig.bones.get(name), name)).applyMatrix4(inv);

    expect(face.ipd).toBeGreaterThan(0);
    expect(face.ipd).toBeCloseTo(local('Eye_L').distanceTo(local('Eye_R')), 12);
    expect(face.origin.distanceTo(local('Eye_L'))).toBeCloseTo(face.ipd / 2, 12);
  });

  it('builds an orthonormal frame', () => {
    const profile = buildProfile(buildRig().root);

    expectOrthonormal(faceOf(profile));
  });

  it('fixes forward by handedness rather than by where the eye bones sit', () => {
    const profile = buildProfile(buildRig().root);
    const face = faceOf(profile);

    expect(face.forward.toArray()).toEqual(
      new THREE.Vector3().crossVectors(face.up, face.right).normalize().toArray(),
    );
    // The eye bone is the eyeball's centre of rotation and sits *behind* the
    // head bone, so deciding the sign from the eye midpoint flips the frame and
    // sends every face-touching gesture round the back of the skull.
    expect(face.origin.dot(face.forward)).toBeLessThan(0);
  });

  it('points right at the character own right', () => {
    const rig = buildRig();
    const profile = buildProfile(rig.root, rig.descriptor);
    const face = faceOf(profile);
    const head = must(profile.bones.head, 'head');
    const inv = new THREE.Matrix4().copy(head.matrixWorld).invert();
    const towards = (name: string) =>
      world(must(profile.bones[name as 'hand.L'], name))
        .applyMatrix4(inv)
        .sub(face.origin)
        .normalize();

    expect(face.right.dot(towards('hand.R'))).toBeGreaterThan(0.9);
    expect(face.right.dot(towards('hand.L'))).toBeLessThan(-0.9);
    // The character's left is the side `sideSign` names, and right is the other.
    expect(Math.sign(face.right.x)).toBe(-profile.sideSign);
  });

  it('agrees with the trunk about which way the character faces', () => {
    const rig = buildRig();
    const profile = buildProfile(rig.root, rig.descriptor);
    const face = faceOf(profile);
    const body = must(profile.body, 'body frame');
    const head = must(profile.bones.head, 'head');
    const chest = must(profile.bones.chest, 'chest');

    expect(toWorld(face.forward, head).dot(toWorld(body.forward, chest))).toBeCloseTo(1, 9);
    expect(toWorld(face.right, head).dot(toWorld(body.right, chest))).toBeCloseTo(1, 9);
    expect(toWorld(face.up, head).dot(toWorld(body.up, chest))).toBeCloseTo(1, 9);
  });

  it('states the frame in head-local space, so turning the avatar leaves it alone', () => {
    const straight = faceOf(buildProfile(buildRig().root));
    const turned = buildRig();
    turned.root.rotateY(Math.PI * 0.5);
    turned.root.updateMatrixWorld(true);
    const profile = buildProfile(turned.root);
    const rotated = faceOf(profile);
    const head = must(profile.bones.head, 'head');

    expect(rotated.right.toArray()).toEqual(straight.right.toArray());
    expect(rotated.forward.toArray()).toEqual(straight.forward.toArray());
    expect(rotated.ipd).toBeCloseTo(straight.ipd, 12);
    // Same frame, and it still lands somewhere else in the world.
    expect(toWorld(rotated.forward, head).x).toBeCloseTo(-1, 9);
  });

  it('falls back to world up when the rig has no neck bone', () => {
    const rig = buildRig();
    const { value: bones } = resolveBones(collectBones(rig.root));
    const withNeck = must(buildFaceFrame(rig.root, bones), 'face frame');
    bones.neck = undefined;

    const frame = must(buildFaceFrame(rig.root, bones), 'face frame');

    expect(frame.up.toArray()).toEqual([0, 1, 0]);
    expect(frame.forward.toArray()).toEqual(withNeck.forward.toArray());
    expectOrthonormal(frame);
  });
});

describe('buildBodyFrame', () => {
  it('needs a shoulder on each side, and reports the gap without one', () => {
    const rig = buildRig();
    // Taking the clavicle takes the whole arm with it, which is what an avatar
    // with one arm rigged and one modelled looks like.
    must(rig.bones.get('Shoulder_L'), 'Shoulder_L').removeFromParent();
    rig.root.updateMatrixWorld(true);

    const profile = buildProfile(rig.root, rig.descriptor);

    expect(profile.body).toBeNull();
    expect(profile.missing).toContain(
      'body:no frame (need a trunk bone, a shoulder per side, and a neck)',
    );
  });

  it('builds an orthonormal trunk frame from the shoulders and the neck', () => {
    const profile = buildProfile(buildRig().root);

    expectOrthonormal(must(profile.body, 'body frame'));
  });

  it('returns null rather than a half frame when the chest has nothing above it', () => {
    const rig = buildRig();
    const { value: bones } = resolveBones(collectBones(rig.root));
    bones.neck = undefined;
    bones.head = undefined;

    expect(buildBodyFrame(rig.root, bones)).toBeNull();
  });
});

describe('body span', () => {
  const spanOf = (armatureScale: number) => {
    const rig = buildRig({ armatureScale });
    const profile = buildProfile(rig.root, rig.descriptor);
    return { rig, profile, span: must(must(profile.body, 'body frame').span, 'span') };
  };

  it('is trunk half-width plus one arm', () => {
    const { profile, span } = spanOf(1);
    const chest = world(must(profile.bones.chest, 'chest'));
    const halfWidth =
      (Math.abs(world(must(profile.bones['upperArm.L'], 'upperArm.L')).x - chest.x) +
        Math.abs(world(must(profile.bones['upperArm.R'], 'upperArm.R')).x - chest.x)) /
      2;
    const arm =
      (profile.limb['upper.L'] +
        profile.limb['lower.L'] +
        profile.limb['upper.R'] +
        profile.limb['lower.R']) /
      2;

    expect(halfWidth).toBeCloseTo(0.16, 9);
    expect(arm).toBeCloseTo(0.32, 9);
    expect(span).toBeCloseTo(halfWidth + arm, 9);
  });

  it('measures the same distance at either armature scale', () => {
    const metres = spanOf(1);
    const centimetres = spanOf(0.01);

    expect(centimetres.span).toBeCloseTo(metres.span, 9);
    // Read from local translations the centimetre rig would report 48.
    expect(centimetres.span).toBeLessThan(1);
  });

  it('is null when the arms are not measurable', () => {
    const rig = buildRig();
    for (const name of ['Hand_L', 'Hand_R']) {
      must(rig.bones.get(name), name).removeFromParent();
    }
    rig.root.updateMatrixWorld(true);

    const profile = buildProfile(rig.root, rig.descriptor);

    expect(profile.body).not.toBeNull();
    expect(must(profile.body, 'body frame').span).toBeNull();
  });
});

describe('anchor tables', () => {
  it('places the face anchors around the eye midpoint in ipd units', () => {
    expect(FACE_ANCHORS.eyes).toEqual([0, 0, 0]);
    // Below the eyes and in front of them, along the frame's own forward.
    expect(FACE_ANCHORS.mouth[1]).toBeLessThan(0);
    expect(FACE_ANCHORS.mouth[2]).toBeGreaterThan(0);
    expect(FACE_ANCHORS.chin[1]).toBeLessThan(FACE_ANCHORS.mouth[1]);
    expect(FACE_ANCHORS.crown[1]).toBeGreaterThan(0);
    // The ear is behind the eyes and further out to the side than the temple.
    expect(FACE_ANCHORS.ear[2]).toBeLessThan(0);
    expect(FACE_ANCHORS.ear[0]).toBeGreaterThan(FACE_ANCHORS.temple[0]);
  });

  it('places the body anchors around the chest in span units', () => {
    expect(BODY_ANCHORS.chest).toEqual([0, 0, 0]);
    expect(BODY_ANCHORS.sternum[2]).toBeGreaterThan(0);
    expect(BODY_ANCHORS.navel[1]).toBeLessThan(0);
    expect(BODY_ANCHORS.shoulder[0]).toBeGreaterThan(0);
    // Every offset is a fraction of the character's own reach.
    for (const [name, a] of Object.entries(BODY_ANCHORS)) {
      for (const v of a) expect(Math.abs(v), name).toBeLessThan(1);
    }
  });
});
