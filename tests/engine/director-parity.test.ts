import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Director } from '@/engine/director';
import type { DirectorHashFile } from '../../tools/parity/hash';
import { withCoreMath } from '../helpers/core-math';
import {
  DIRECTOR_FIXTURES,
  type DirectorFixture,
  type DirectorRun,
  prepareFixture,
  runDirectorFixture,
  splitmix64,
} from '../helpers/director-fixtures';
import { must } from '../helpers/must';

/**
 * The director, and the rig under it, against the hashes recorded from the TypeScript rig.
 *
 * Each fixture runs under `withCoreMath`; every frame's state is hashed after the full update
 * and `Skeleton.update`, and every call across the rig's facade boundary is folded into one
 * hash per fixture (see `tests/helpers/director-fixtures.ts`). Both must equal
 * `director-parity.json` exactly.
 *
 * Regenerate with `yarn tsx tools/record-director-parity.ts --check`, and only for a deliberate
 * change of behaviour: the file is the definition of what the rig produces.
 */

const recorded = JSON.parse(
  readFileSync(new URL('./director-parity.json', import.meta.url), 'utf8'),
) as DirectorHashFile;

/** Where a run first leaves the recording, or null when it matches throughout. */
function firstDifference(
  fixture: DirectorFixture,
  run: Pick<DirectorRun, 'frames' | 'calls'>,
  file: DirectorHashFile = recorded,
): string | null {
  const expected = must(file.fixtures[fixture.id], fixture.id);
  if (run.frames.length !== expected.frames) {
    return `${run.frames.length} frames against ${expected.frames}`;
  }
  const frame = run.frames.findIndex((hash, k) => hash !== expected.frame[k]);
  if (frame >= 0) return `frame ${frame}`;
  return run.calls === expected.calls ? null : 'calls';
}

const fixture = (id: string) =>
  must(
    DIRECTOR_FIXTURES.find((f) => f.id === id),
    id,
  );

describe('Director against the recorded hashes', () => {
  it('records every fixture', () => {
    expect(Object.keys(recorded.fixtures)).toEqual(DIRECTOR_FIXTURES.map((f) => f.id));
  });

  it('gives the base avatar a live sway group and a constrained arm solver', () => {
    const { profile } = prepareFixture(fixture('c switches steady'));
    const director = withCoreMath(() => new Director(profile, undefined, { random: splitmix64() }));
    try {
      expect(director.spring.groups.map((g) => g.id)).toEqual(['hair']);
      expect(director.spring.missing).toEqual([]);
      expect(director.rig.armSolverOff).toEqual([]);
    } finally {
      director.spring.dispose();
    }
  });

  for (const f of DIRECTOR_FIXTURES) {
    it(`matches frame for frame and call for call: ${f.id}`, () => {
      const run = runDirectorFixture(f, { calls: true });
      expect(firstDifference(f, run)).toBeNull();
      // Not vacuous: the fixture reached the core's transcendentals, and the boundary.
      expect(run.coreCalls).toBeGreaterThan(0);
      expect(run.counts.size).toBeGreaterThan(0);
      // The core does not allocate during a frame.
      expect(run.bufferSwaps).toBe(0);
    });
  }

  it('fails when one bit of a bone is flipped', () => {
    const f = fixture('a heartHands');
    const bits = new Float64Array(1);
    const word = new BigUint64Array(bits.buffer);
    const run = runDirectorFixture(f, {
      tamper: (director, frame) => {
        if (frame !== 60) return;
        const bone = must(director.p.bones['lowerArm.R'], 'lowerArm.R');
        bits[0] = bone.quaternion.x;
        word[0] ^= 1n;
        bone.quaternion.x = bits[0];
      },
    });
    expect(firstDifference(f, { frames: run.frames, calls: null })).toBe('frame 60');
  });

  it('fails when one recorded hash is corrupted', () => {
    const f = fixture('a heartHands');
    const run = runDirectorFixture(f, { calls: true });
    const entry = must(recorded.fixtures[f.id], f.id);
    const flip = (hash: string) => `${hash.slice(0, 15)}${hash[15] === '0' ? '1' : '0'}`;
    const corrupt = (change: Partial<typeof entry>): DirectorHashFile => ({
      ...recorded,
      fixtures: { ...recorded.fixtures, [f.id]: { ...entry, ...change } },
    });
    const frame = [...entry.frame];
    frame[37] = flip(must(frame[37], 'frame 37'));
    expect(firstDifference(f, run)).toBeNull();
    expect(firstDifference(f, run, corrupt({ frame }))).toBe('frame 37');
    expect(firstDifference(f, run, corrupt({ calls: flip(entry.calls) }))).toBe('calls');
  });
});
