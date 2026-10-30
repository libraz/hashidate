/**
 * Record the per-frame hash of the sway solver over every fixture of
 * `tests/helpers/spring-fixtures.ts`.
 *
 *     yarn tsx tools/record-spring-parity.ts [output]
 *
 * `tests/secondary/spring-parity.test.ts` compares `Spring` against the file this writes.
 * Re-record only for a deliberate change of behaviour.
 */

import { buildProfile } from '../src/engine/profile';
import { Spring } from '../src/engine/secondary';
import { withCoreMath } from '../tests/helpers/core-math';
import { applyFrame, SPRING_FIXTURES } from '../tests/helpers/spring-fixtures';
import {
  ByteWriter,
  type HashFile,
  hashBytes,
  writeHashFile,
  writeSpringState,
} from './parity/hash';
import { loadCoreForNode } from './rust-core/node';

const GENERATOR = 'yarn tsx tools/record-spring-parity.ts';
const output = process.argv[2] ?? 'tests/secondary/spring-parity.json';

await loadCoreForNode();

const file: HashFile = { generator: GENERATOR, fixtures: {} };
for (const fixture of SPRING_FIXTURES) {
  const tree = fixture.build();
  const profile = buildProfile(tree.rig.root, tree.descriptor);
  const spring = withCoreMath(() => {
    const built = new Spring(profile, tree.descriptor);
    fixture.setup?.(built);
    return built;
  });
  const hashes: string[] = [];
  try {
    for (const step of fixture.script) {
      applyFrame(tree.rig, spring, step);
      hashes.push(
        withCoreMath(() => {
          spring.update(step.dt);
          return hashBytes(writeSpringState(new ByteWriter(), spring, tree.rig.root).bytes());
        }),
      );
    }
  } finally {
    spring.dispose();
  }
  file.fixtures[fixture.id] = { frames: hashes.length, hashes };
}
await writeHashFile(output, file);
