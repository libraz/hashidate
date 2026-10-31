import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { core } from '@/core';
import { SceneGraph } from '@/core/scene';
import { buildProfile } from '@/engine/profile';
import { Spring } from '@/engine/secondary';
import { ByteWriter, type HashFile, hashBytes, writeSpringState } from '../../tools/parity/hash';
import { withCoreMath } from '../helpers/core-math';
import { must } from '../helpers/must';
import { applyFrame, SPRING_FIXTURES, type SpringFixture } from '../helpers/spring-fixtures';

/**
 * The solver against the per-frame hashes recorded from its reference implementation.
 *
 * Each fixture runs under `withCoreMath`, so the transcendentals are the core's, and after every
 * update the state of the tree and the solver is hashed (see `tools/parity/hash.ts`). The hashes
 * must equal `spring-parity.json` exactly.
 *
 * Regenerate with `yarn tsx tools/record-spring-parity.ts`, and only for a deliberate change of
 * behaviour: the file is the definition of what the solver produces.
 */

const recorded = JSON.parse(
  readFileSync(new URL('./spring-parity.json', import.meta.url), 'utf8'),
) as HashFile;

/** The hash of each frame of a fixture, or the hashes up to a `tamper` call's effect. */
function run(
  fixture: SpringFixture,
  tamper?: (spring: Spring, frame: number) => void,
): { hashes: string[]; spring: Spring } {
  const tree = fixture.build();
  const profile = buildProfile(tree.rig.root, tree.descriptor);
  const spring = withCoreMath(() => {
    const built = new Spring(profile, tree.descriptor);
    fixture.setup?.(built);
    return built;
  });
  const hashes: string[] = [];
  try {
    for (const [frame, step] of fixture.script.entries()) {
      applyFrame(tree.rig, spring, step);
      withCoreMath(() => spring.update(step.dt));
      tamper?.(spring, frame);
      hashes.push(
        withCoreMath(() =>
          hashBytes(writeSpringState(new ByteWriter(), spring, tree.rig.root).bytes()),
        ),
      );
    }
  } finally {
    spring.dispose();
  }
  return { hashes, spring };
}

/** The index of the first frame whose hash differs from the recording, or -1. */
function firstDifference(fixture: SpringFixture, hashes: readonly string[]): number {
  const expected = must(recorded.fixtures[fixture.id], fixture.id);
  return hashes.findIndex((hash, frame) => hash !== expected.hashes[frame]);
}

describe('Spring against the recorded hashes', () => {
  it('records every fixture', () => {
    expect(Object.keys(recorded.fixtures)).toEqual(SPRING_FIXTURES.map((f) => f.id));
  });

  for (const fixture of SPRING_FIXTURES) {
    it(`matches frame for frame: ${fixture.id}`, () => {
      // No JS transcendental runs here; the hash comparison guards against a vacuous pass.
      const { hashes } = run(fixture);
      const expected = must(recorded.fixtures[fixture.id], fixture.id);
      expect(hashes).toHaveLength(expected.frames);
      expect(expected.frames).toBe(600);
      expect(firstDifference(fixture, hashes)).toBe(-1);
    });
  }

  it('reports the scale failure of F7 and switches its group off', () => {
    const fixture = must(SPRING_FIXTURES[7], 'F7');
    const tree = fixture.build();
    const spring = withCoreMath(
      () => new Spring(buildProfile(tree.rig.root, tree.descriptor), tree.descriptor),
    );
    for (const step of fixture.script) {
      applyFrame(tree.rig, spring, step);
      withCoreMath(() => spring.update(step.dt));
    }
    const groups = spring.groups.filter((g) => g.id.startsWith('charm'));
    // The anchor is core-backed now, so its world override can no longer be switched on.
    const anchor = must(tree.rig.bones.get('CharmB_1'), 'CharmB_1');
    expect(() => {
      anchor.matrixWorldAutoUpdate = false;
    }).toThrow(TypeError);
    spring.dispose();
    expect(spring.missing).toEqual([
      'sway:charm anchor: anchor:ProducerA_1 scale changed after resolution',
    ]);
    expect(groups.map((g) => [g.id, g.enabled, g.anchor === null])).toEqual([
      ['charm', false, true],
      ['charmB', true, false],
    ]);
  });

  it('fails when one bit of an output is flipped', () => {
    const fixture = must(SPRING_FIXTURES[0], 'F1');
    const bits = new Float64Array(1);
    const word = new BigUint64Array(bits.buffer);
    const { hashes } = run(fixture, (spring, frame) => {
      if (frame !== 300) return;
      const joint = must(spring.groups[0]?.joints[0], 'joint');
      bits[0] = joint.cur.x;
      word[0] ^= 1n;
      joint.cur.x = bits[0];
    });
    expect(firstDifference(fixture, hashes)).toBe(300);
  });

  it('does not grow memory over 1,000 frames, and frees it on dispose', () => {
    const fixture = must(SPRING_FIXTURES[1], 'F2');
    const tree = fixture.build();
    const profile = buildProfile(tree.rig.root, tree.descriptor);
    const spring = new Spring(profile, tree.descriptor);
    spring.update(0);
    const before = core().memory.buffer.byteLength;
    for (let frame = 0; frame < 1000; frame++) {
      applyFrame(tree.rig, spring, must(fixture.script[frame % 600], 'frame'));
      spring.update(frame % 7 === 0 ? 0.05 : 1 / 60);
    }
    const after = core().memory.buffer.byteLength;
    spring.dispose();
    SceneGraph.of(tree.rig.root).dispose();
    for (let k = 0; k < 3; k++) {
      const again = fixture.build();
      new Spring(buildProfile(again.rig.root, again.descriptor), again.descriptor).dispose();
      SceneGraph.of(again.rig.root).dispose();
    }
    const rebuilt = core().memory.buffer.byteLength;
    expect(after).toBe(before);
    expect(rebuilt).toBe(before);
  });
});
