import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Body } from '@/engine/motion/body';
import { HOPS, planJump, sampleJump } from '@/engine/motion/jump';
import { buildProfile } from '@/engine/profile';
import { Rig } from '@/engine/rig';
import type { BoneSlot, Profile, Side } from '@/engine/types';
import { buildRig } from '../../helpers/scene';

const SIDES: Side[] = ['L', 'R'];
const CUTE = [
  'cheekPoke',
  'catPaw',
  'beg',
  'heartHands',
  'bunnyEars',
  'pawBounce',
  'tinyDance',
  'cheekPeace',
];

function boneOf(p: Profile, slot: BoneSlot): THREE.Bone {
  const bone = p.bones[slot];
  if (!bone) throw new Error(`synthetic rig lacks ${slot}`);
  return bone;
}

function position(p: Profile, slot: BoneSlot): THREE.Vector3 {
  const bone = boneOf(p, slot);
  bone.updateWorldMatrix(true, false);
  return bone.getWorldPosition(new THREE.Vector3());
}

function kneeBend(p: Profile, side: Side): number {
  const hip = position(p, `upperLeg.${side}`);
  const knee = position(p, `lowerLeg.${side}`);
  const ankle = position(p, `foot.${side}`);
  return knee.clone().sub(hip).angleTo(ankle.sub(knee));
}

function standing() {
  const built = buildRig({ legs: true });
  const profile = buildProfile(built.root, built.descriptor);
  const rig = new Rig(profile);
  const body = new Body(rig, profile);
  body.idleAmount = 0;
  body.gazeAmount = 0;
  const anchors = SIDES.map((s) => position(profile, `foot.${s}`));
  const locals = SIDES.flatMap((s) =>
    (['upperLeg', 'lowerLeg', 'foot', 'toe'] as const).map((part) => {
      const bone = boneOf(profile, `${part}.${s}`);
      return { bone, position: bone.position.clone(), scale: bone.scale.clone() };
    }),
  );
  function frame(dt: number) {
    rig.reset();
    body.update(dt);
    for (const saved of locals) {
      expect(saved.bone.position.distanceTo(saved.position)).toBeLessThan(1e-12);
      expect(saved.bone.scale.distanceTo(saved.scale)).toBeLessThan(1e-12);
      expect(saved.bone.quaternion.toArray().every(Number.isFinite)).toBe(true);
    }
  }
  return { profile, rig, body, anchors, frame };
}

describe('standing legs in the body pipeline', () => {
  it.each([30, 60])('keeps cute motions grounded while the torso moves at %i fps', (fps) => {
    for (const id of CUTE) {
      const h = standing();
      const dt = 1 / fps;
      const hipsRest = position(h.profile, 'hips');
      const chestRest = boneOf(h.profile, 'chest').quaternion.clone();
      h.body.breathDepth = 1;
      h.body.weightShift = 1;
      h.body.play(id, 'L');
      let ankleError = 0;
      let pelvisMovement = 0;
      let chestMovement = 0;
      let kneeMovement = 0;
      const bendRest = kneeBend(h.profile, 'L');
      for (let i = 0; i < fps * 3; i++) {
        h.frame(dt);
        for (const [j, side] of SIDES.entries()) {
          ankleError = Math.max(
            ankleError,
            position(h.profile, `foot.${side}`).distanceTo(h.anchors[j]),
          );
        }
        pelvisMovement = Math.max(pelvisMovement, position(h.profile, 'hips').distanceTo(hipsRest));
        chestMovement = Math.max(
          chestMovement,
          boneOf(h.profile, 'chest').quaternion.angleTo(chestRest),
        );
        kneeMovement = Math.max(kneeMovement, Math.abs(kneeBend(h.profile, 'L') - bendRest));
      }
      expect(ankleError).toBeLessThan(1e-7);
      // Positive controls: fixed feet must coexist with actual torso and knee
      // movement, rather than passing because the whole avatar stopped moving.
      expect(pelvisMovement).toBeGreaterThan(0.001);
      expect(chestMovement).toBeGreaterThan(0.01);
      expect(kneeMovement).toBeGreaterThan(0.01);
    }
  });

  it.each([30, 60])('flexes on loading and landing, lifts in flight at %i fps', (fps) => {
    for (const spec of Object.values(HOPS)) {
      const h = standing();
      h.body.breathDepth = 0;
      h.body.weightShift = 0;
      const dt = 1 / fps;
      // Pose the idle once before measuring a performance transition. The
      // fixture initially holds its import T-pose, which is not a played frame.
      h.frame(dt);
      h.body.play('catPaw', 'L');
      h.body.hop(spec);
      const arc = planJump(spec.height, h.body.gravity, spec.count);
      const restBend = kneeBend(h.profile, 'L');
      let elapsed = 0;
      let lifted = 0;
      let loaded = 0;
      let landed = 0;
      let wasAirborne = false;
      let wristSpeed = 0;
      let previousWrist = position(h.profile, 'hand.L');
      for (let i = 0; i < fps * 4; i++) {
        elapsed += dt;
        const sample = sampleJump(arc, elapsed);
        h.frame(dt);
        const wrist = position(h.profile, 'hand.L');
        wristSpeed = Math.max(wristSpeed, wrist.distanceTo(previousWrist) / dt);
        previousWrist = wrist;
        const rise = Math.max(0, sample.rise);
        for (const [j, side] of SIDES.entries()) {
          const expected = h.anchors[j].clone().add(new THREE.Vector3(0, rise, 0));
          expect(position(h.profile, `foot.${side}`).distanceTo(expected)).toBeLessThan(1e-7);
        }
        if (sample.rise > 0) {
          wasAirborne = true;
          lifted = Math.max(lifted, sample.rise);
        }
        if (sample.rise < -arc.dip * 0.5) {
          const flexion = kneeBend(h.profile, 'L') - restBend;
          if (wasAirborne) landed = Math.max(landed, flexion);
          else loaded = Math.max(loaded, flexion);
        }
        if (sample.done) break;
      }
      expect(lifted).toBeGreaterThan(spec.height * 0.8);
      expect(loaded).toBeGreaterThan(0.1);
      expect(landed).toBeGreaterThan(0.1);
      expect(wristSpeed).toBeLessThan(8);
      expect(h.body.jumping).toBe(false);
      expect(Math.abs(kneeBend(h.profile, 'L') - restBend)).toBeLessThan(1e-7);
    }
  });
});
