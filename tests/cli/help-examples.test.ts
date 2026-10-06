import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VOICE_PRESETS } from '@/viewer/voice-chain';

const MAIN = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

describe('CLI help examples', () => {
  it('only name voice presets that exist', async () => {
    const source = await readFile(MAIN, 'utf8');
    const named = [...source.matchAll(/yarn ctl voice ([a-z][\w-]*)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const id of named) expect(Object.keys(VOICE_PRESETS)).toContain(id);
  });
});
