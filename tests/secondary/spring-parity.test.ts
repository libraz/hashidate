import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { core } from '@/core';
import { buildProfile } from '@/engine/profile';
import { Spring } from '@/engine/secondary';
import { CoreSpring } from '@/engine/secondary/spring-core';
import { coreMathCalls, withCoreMath } from '../helpers/core-math';
import { must } from '../helpers/must';
import {
  applyFrame,
  type FixtureRig,
  SPRING_FIXTURES,
  type SpringFixture,
  type SwaySolver,
} from '../helpers/spring-fixtures';

/**
 * The core solver against the TS one it ports, bit for bit.
 *
 * Both run on identical trees under `withCoreMath`, so the transcendentals are the core's on both
 * sides and every other operation has to agree exactly. After each update every node's local
 * transform, every manual `matrix`, the joints' state, the accumulator, `missing`, the anchor
 * diagnostics and the group switches are compared with `Object.is`, then every `matrixWorld` after
 * a world update from the root.
 */

type Field = readonly [string, unknown];

/** Every compared value of one solver over its rig, labelled. */
function state(spring: SwaySolver, root: THREE.Object3D): Field[] {
  const out: Field[] = [];
  const push = (label: string, values: ArrayLike<unknown>) => {
    for (let i = 0; i < values.length; i++) out.push([`${label}[${i}]`, values[i]]);
  };
  root.traverse((o) => {
    push(`${o.name}.position`, o.position.toArray());
    push(`${o.name}.quaternion`, o.quaternion.toArray());
    push(`${o.name}.scale`, o.scale.toArray());
  });
  root.traverse((o) => {
    if (!o.matrixAutoUpdate) push(`${o.name}.matrix`, o.matrix.elements);
  });
  spring.groups.forEach((g, gi) => {
    g.joints.forEach((j, k) => {
      const at = `group ${gi} joint ${k} (${j.bone.name})`;
      push(`${at}.cur`, j.cur.toArray());
      push(`${at}.prev`, j.prev.toArray());
      push(`${at}.solvedQ`, j.solvedQ.toArray());
      push(`${at}.prevSolvedQ`, j.prevSolvedQ.toArray());
      push(`${at}.swing`, j.swing.toArray());
      push(`${at}.limits`, j.limits);
      push(`${at}.spans`, j.spans);
    });
  });
  out.push(['_acc', spring._acc]);
  out.push(['missing.length', spring.missing.length]);
  push('missing', spring.missing);
  for (const [k, d] of spring.anchorDiagnostics.entries()) {
    out.push([`anchorDiagnostics[${k}].groupId`, d.groupId]);
    push(`anchorDiagnostics[${k}].targetWorld`, d.targetWorld);
    push(`anchorDiagnostics[${k}].rootWorld`, d.rootWorld);
    out.push([`anchorDiagnostics[${k}].error`, d.error]);
  }
  out.push(['anchorDiagnostics.length', spring.anchorDiagnostics.length]);
  out.push(['groups.length', spring.groups.length]);
  spring.groups.forEach((g, gi) => {
    out.push([`group ${gi}.enabled`, g.enabled]);
  });
  return out;
}

/** Every node's world matrix, labelled. */
function worlds(root: THREE.Object3D): Field[] {
  const out: Field[] = [];
  root.traverse((o) => {
    o.matrixWorld.elements.forEach((v, i) => {
      out.push([`${o.name}.matrixWorld[${i}]`, v]);
    });
  });
  return out;
}

/** The first field the two disagree on, or null. */
function firstMismatch(expected: readonly Field[], actual: readonly Field[]): string | null {
  if (expected.length !== actual.length) {
    return `${expected.length} fields against ${actual.length}`;
  }
  for (let i = 0; i < expected.length; i++) {
    const [label, a] = expected[i];
    const [other, b] = actual[i];
    if (label !== other) return `field ${i}: ${label} against ${other}`;
    if (!Object.is(a, b)) return `${label}: ${String(a)} against ${String(b)}`;
  }
  return null;
}

interface Pair {
  ts: { tree: FixtureRig; spring: Spring };
  core: { tree: FixtureRig; spring: CoreSpring };
}

/** Two identical trees, one solver on each, both built and set up under the core's math. */
function pair(fixture: SpringFixture): Pair {
  const a = fixture.build();
  const b = fixture.build();
  const pa = buildProfile(a.rig.root, a.descriptor);
  const pb = buildProfile(b.rig.root, b.descriptor);
  return withCoreMath(() => {
    const ts = new Spring(pa, a.descriptor);
    const cs = new CoreSpring(pb, b.descriptor);
    fixture.setup?.(ts);
    fixture.setup?.(cs);
    return { ts: { tree: a, spring: ts }, core: { tree: b, spring: cs } };
  });
}

/** Run a fixture to the end, returning the first disagreement and how many frames agreed. */
function run(
  fixture: SpringFixture,
  tamper?: (spring: CoreSpring, frame: number) => void,
): { frames: number; mismatch: string | null } {
  const { ts, core: cs } = pair(fixture);
  try {
    const built = firstMismatch(
      state(ts.spring, ts.tree.rig.root),
      state(cs.spring, cs.tree.rig.root),
    );
    if (built) return { frames: 0, mismatch: `${fixture.id} after construction: ${built}` };
    for (const [frame, step] of fixture.script.entries()) {
      applyFrame(ts.tree.rig, ts.spring, step);
      applyFrame(cs.tree.rig, cs.spring, step);
      withCoreMath(() => {
        ts.spring.update(step.dt);
        cs.spring.update(step.dt);
      });
      tamper?.(cs.spring, frame);
      const expected = state(ts.spring, ts.tree.rig.root);
      const actual = state(cs.spring, cs.tree.rig.root);
      withCoreMath(() => {
        ts.tree.rig.root.updateMatrixWorld(true);
        cs.tree.rig.root.updateMatrixWorld(true);
      });
      expected.push(...worlds(ts.tree.rig.root));
      actual.push(...worlds(cs.tree.rig.root));
      const mismatch = firstMismatch(expected, actual);
      if (mismatch) return { frames: frame, mismatch: `${fixture.id} frame ${frame}: ${mismatch}` };
    }
    return { frames: fixture.script.length, mismatch: null };
  } finally {
    cs.spring.dispose();
  }
}

describe('CoreSpring against Spring', () => {
  for (const fixture of SPRING_FIXTURES) {
    it(`matches bit for bit: ${fixture.id}`, () => {
      const calls = coreMathCalls();
      const result = run(fixture);
      expect(result.mismatch).toBeNull();
      expect(result.frames).toBe(600);
      if (fixture === SPRING_FIXTURES[0]) expect(coreMathCalls()).toBeGreaterThan(calls);
    });
  }

  it('reports both anchor failures of F7 and switches their groups off', () => {
    const fixture = must(SPRING_FIXTURES[7], 'F7');
    const { core: cs } = pair(fixture);
    for (const step of fixture.script) {
      applyFrame(cs.tree.rig, cs.spring, step);
      withCoreMath(() => cs.spring.update(step.dt));
    }
    const failed = cs.spring.groups.filter((g) => g.id.startsWith('charm'));
    cs.spring.dispose();
    expect(cs.spring.missing).toEqual([
      'sway:charm anchor: anchor:ProducerA_1 scale changed after resolution',
      'sway:charmB anchor: anchor:CharmB_1 has a manual matrixWorld override',
    ]);
    expect(failed.map((g) => [g.enabled, g.anchor])).toEqual([
      [false, null],
      [false, null],
    ]);
  });

  it('fails when one bit of a core output is flipped', () => {
    const bits = new Float64Array(1);
    const word = new BigUint64Array(bits.buffer);
    const result = run(must(SPRING_FIXTURES[0], 'F1'), (spring, frame) => {
      if (frame !== 300) return;
      const joint = must(spring.groups[0]?.joints[0], 'joint');
      bits[0] = joint.cur.x;
      word[0] ^= 1n;
      joint.cur.x = bits[0];
    });
    expect(result.mismatch).toMatch(/frame 300: group 0 joint 0 \(ProducerA\)\.cur\[0\]/);
  });

  it('does not grow memory over 1,000 frames, and frees it on dispose', () => {
    const fixture = must(SPRING_FIXTURES[1], 'F2');
    const tree = fixture.build();
    const profile = buildProfile(tree.rig.root, tree.descriptor);
    const spring = new CoreSpring(profile, tree.descriptor);
    spring.update(0);
    const before = core().memory.buffer.byteLength;
    for (let frame = 0; frame < 1000; frame++) {
      applyFrame(tree.rig, spring, must(fixture.script[frame % 600], 'frame'));
      spring.update(frame % 7 === 0 ? 0.05 : 1 / 60);
    }
    const after = core().memory.buffer.byteLength;
    spring.dispose();
    for (let k = 0; k < 3; k++) {
      const again = fixture.build();
      new CoreSpring(buildProfile(again.rig.root, again.descriptor), again.descriptor).dispose();
    }
    const rebuilt = core().memory.buffer.byteLength;
    expect(after).toBe(before);
    expect(rebuilt).toBe(before);
  });
});
