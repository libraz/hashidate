import { writeFile } from 'node:fs/promises';
import { TRIANGLE_FIXTURES, triangleFrameHashes } from '../tests/helpers/triangle-fixtures';
import { loadCoreForNode } from './rust-core/node';

/** Record the controller's per-frame shell-index hashes for every triangle fixture. */
const output = process.argv[2] ?? 'tests/scene/triangle-sort-parity.json';

await loadCoreForNode();
const fixtures: Record<string, { frames: number; hashes: string[] }> = {};
for (const fixture of TRIANGLE_FIXTURES) {
  const hashes = triangleFrameHashes(fixture);
  fixtures[fixture.id] = { frames: hashes.length, hashes };
}
const file = { generator: 'yarn tsx tools/record-triangle-parity.ts', fixtures };
await writeFile(output, `${JSON.stringify(file)}\n`);
