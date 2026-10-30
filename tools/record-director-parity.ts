/**
 * Record the director's golden: the per-frame hashes and the folded boundary calls of every
 * fixture in `tests/helpers/director-fixtures.ts`.
 *
 *     yarn tsx tools/record-director-parity.ts [--check] [output]
 *
 * `--check` records everything twice and refuses to write unless the two recordings are
 * identical, which is the condition for a golden worth keeping. `tests/engine/director-parity.test.ts`
 * compares the engine against the file this writes. Re-record only for a deliberate change of
 * behaviour.
 */

import { parseArgs } from 'node:util';
import { DIRECTOR_FIXTURES, runDirectorFixture } from '../tests/helpers/director-fixtures';
import { type DirectorHashFile, writeHashFile } from './parity/hash';
import { loadCoreForNode } from './rust-core/node';

const GENERATOR = 'yarn tsx tools/record-director-parity.ts --check';

function record(): DirectorHashFile {
  const file: DirectorHashFile = { generator: GENERATOR, fixtures: {} };
  const started = Date.now();
  for (const [i, fixture] of DIRECTOR_FIXTURES.entries()) {
    const run = runDirectorFixture(fixture, { calls: true });
    if (run.calls === null) throw new Error(`${fixture.id}: the calls were not watched`);
    file.fixtures[fixture.id] = { frames: run.frames.length, frame: run.frames, calls: run.calls };
    if ((i + 1) % 10 === 0 || i + 1 === DIRECTOR_FIXTURES.length) {
      const seconds = Math.round((Date.now() - started) / 1000);
      console.log(`${i + 1}/${DIRECTOR_FIXTURES.length} fixtures (${seconds}s)`);
    }
  }
  return file;
}

/** The first fixture and frame at which two recordings differ, or null. */
function difference(a: DirectorHashFile, b: DirectorHashFile): string | null {
  for (const [id, x] of Object.entries(a.fixtures)) {
    const y = b.fixtures[id];
    if (!y) return `${id}: missing from the second recording`;
    const frame = x.frame.findIndex((hash, k) => hash !== y.frame[k]);
    if (frame >= 0 || x.frames !== y.frames) return `${id}: frame ${frame}`;
    if (x.calls !== y.calls) return `${id}: calls`;
  }
  return null;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: { check: { type: 'boolean' } },
    allowPositionals: true,
  });
  const output = positionals[0] ?? 'tests/engine/director-parity.json';
  await loadCoreForNode();
  const file = record();
  if (values.check) {
    const again = record();
    const differs = difference(file, again);
    if (differs !== null) {
      console.error(`the two recordings differ: ${differs}`);
      return 1;
    }
    console.log('both recordings are identical');
  }
  await writeHashFile(output, file);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
