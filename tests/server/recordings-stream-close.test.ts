import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Recordings } from '@/server/recordings';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hashidate-recording-close-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

for (const phase of ['write', 'final'] as const) {
  it(`settles and reports a sink that closes during ${phase}`, async () => {
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        if (phase === 'write') this.destroy();
        else callback();
      },
      final() {
        this.destroy();
      },
    });
    const recordings = new Recordings(root, () => sink);
    const take = recordings.open({
      width: 1920,
      height: 1080,
      fps: 30,
      autoStop: true,
      lead: 0,
      tail: 1.2,
    });
    if (take === null) throw new Error('the take did not open');

    const appended = await recordings.append(
      take.session,
      'renderer',
      'video/mp4',
      Buffer.from('frame'),
    );
    expect(appended.status).toBe(phase === 'write' ? 'failed' : 'accepted');
    expect(appended.recording?.bytes).toBe(phase === 'write' ? 0 : 5);

    const closed = await recordings.close(take.session);
    expect(closed?.error).toBeTruthy();
    expect(recordings.current).toBeNull();
    expect(
      recordings.open({ width: 1920, height: 1080, fps: 30, autoStop: true, lead: 0, tail: 1.2 }),
    ).not.toBeNull();
    await recordings.close();
  }, 1000);
}
