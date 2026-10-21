import * as THREE from 'three';
import type { ArmTwistBinding, Profile, Side } from '../types';
import { positiveConformalScale } from './arm-driver';

// 80° straight-roll body-mesh helper-blend samples: minimum radial ratio .941094→.962435
// and .936620→.978843 at half the parent-to-child axial residual.
// Provisional split; needs a render check.
const RESIDUAL_SHARE = 0.5;

interface CalibratedTwist {
  source: ArmTwistBinding;
  primary: THREE.Bone;
  next: THREE.Bone;
  helper: THREE.Bone;
  side: Side;
  rest: THREE.Quaternion;
  inverseRelativeRest: THREE.Quaternion;
  axis: THREE.Vector3;
  committed: number;
}

/** Leaf-only skin deformation; trial poses never advance the accepted angular branch. */
export class ArmTwists {
  private readonly bindings: CalibratedTwist[] = [];
  private readonly rotation = new THREE.Matrix4();
  private readonly primaryQ = new THREE.Quaternion();
  private readonly nextQ = new THREE.Quaternion();
  private readonly relative = new THREE.Quaternion();
  private readonly turn = new THREE.Quaternion();

  static create(profile: Profile): ArmTwists | null {
    const entries = Object.entries(profile.armTwists ?? {});
    if (!entries.length) return null;
    const canonical = new Set([
      ...Object.values(profile.bones),
      ...Object.values(profile.fingerBones).flat(),
    ]);
    const controller = new ArmTwists();
    for (const [slot, source] of entries) {
      if (canonical.has(source.helper)) continue;
      const axis = profile.restDir[slot as keyof typeof profile.restDir]?.clone();
      if (!(axis?.toArray().every(Number.isFinite) && axis.lengthSq() > 0)) continue;
      const binding: CalibratedTwist = {
        source,
        primary: source.primary,
        next: source.next,
        helper: source.helper,
        side: slot.endsWith('.L') ? 'L' : 'R',
        rest: source.helper.quaternion.clone(),
        inverseRelativeRest: new THREE.Quaternion(),
        axis: axis.normalize(),
        committed: 0,
      };
      if (!(controller.safeTopology(binding) && controller.readRelative(binding))) continue;
      binding.inverseRelativeRest.copy(controller.relative).invert();
      controller.bindings.push(binding);
    }
    return controller.bindings.length ? controller : null;
  }

  private safeTopology(binding: CalibratedTwist): boolean {
    const { source, primary, next, helper } = binding;
    return (
      source.primary === primary &&
      source.next === next &&
      source.helper === helper &&
      helper !== primary &&
      helper !== next &&
      helper.parent === primary &&
      next.parent === primary &&
      helper.children.length === 0
    );
  }

  private readRelative(binding: CalibratedTwist): boolean {
    const { primary, next, helper } = binding;
    primary.updateWorldMatrix(true, false);
    next.updateWorldMatrix(false, false);
    helper.updateWorldMatrix(false, false);
    if (
      positiveConformalScale(primary.matrixWorld) === null ||
      positiveConformalScale(next.matrixWorld) === null ||
      positiveConformalScale(helper.matrixWorld) === null
    )
      return false;
    this.primaryQ.setFromRotationMatrix(this.rotation.extractRotation(primary.matrixWorld));
    this.nextQ.setFromRotationMatrix(this.rotation.extractRotation(next.matrixWorld));
    this.relative.copy(this.primaryQ).invert().multiply(this.nextQ).normalize();
    return true;
  }

  private restore(binding: CalibratedTwist): void {
    binding.helper.quaternion.copy(binding.rest);
    binding.helper.updateWorldMatrix(false, false);
  }

  reset(): void {
    for (const binding of this.bindings) if (this.safeTopology(binding)) this.restore(binding);
  }

  stage(side: Side): void {
    this.apply(side, false);
  }
  accept(side: Side): void {
    this.apply(side, true);
  }

  private apply(side: Side, accept: boolean): void {
    for (const binding of this.bindings) {
      if (binding.side !== side || !this.safeTopology(binding)) continue;
      if (!this.readRelative(binding)) {
        this.restore(binding);
        continue;
      }
      this.relative.multiply(binding.inverseRelativeRest).normalize();
      const { x, y, z, w } = this.relative;
      const axial = x * binding.axis.x + y * binding.axis.y + z * binding.axis.z;
      let angle = binding.committed;
      if (axial * axial + w * w > Number.EPSILON) {
        const raw = 2 * Math.atan2(axial, w);
        angle = raw + 2 * Math.PI * Math.round((binding.committed - raw) / (2 * Math.PI));
        if (accept) binding.committed = angle;
      }
      binding.helper.quaternion
        .copy(this.turn.setFromAxisAngle(binding.axis, RESIDUAL_SHARE * angle))
        .multiply(binding.rest);
      binding.helper.updateWorldMatrix(false, false);
    }
  }
}
