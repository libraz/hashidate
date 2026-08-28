import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extensionFor, Recordings, stem, timestamp } from '@/server/recordings';

/**
 * The take being written, and the directory it lands in.
 *
 * Real files, because what is being tested is what is on disk afterwards: which
 * name it took, whether it was opened at all, and whether two takes started a
 * second apart can overwrite each other.
 */

let root: string;
let recordings: Recordings;

const AT = new Date(2026, 7, 29, 14, 25, 30);
const OPEN = { width: 1920, height: 1080, fps: 30, autoStop: true };
const MP4 = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hashidate-takes-'));
  recordings = new Recordings(root);
});

afterEach(async () => {
  await recordings.close();
  await rm(root, { recursive: true, force: true });
});

describe('extensionFor', () => {
  it('names the file after the container the encoder actually chose', () => {
    expect(extensionFor(MP4)).toBe('.mp4');
    expect(extensionFor('video/webm;codecs=vp9,opus')).toBe('.webm');
    expect(extensionFor('VIDEO/WEBM')).toBe('.webm');
    expect(extensionFor('video/x-matroska;codecs=avc1')).toBe('.mkv');
  });

  it('calls an unrecognised container what it is rather than guessing', () => {
    // Mislabelling a stream as `.webm` costs an hour before anybody thinks to
    // run `file` on it. `.bin` costs a second.
    expect(extensionFor('video/quicktime')).toBe('.bin');
  });
});

describe('stem', () => {
  it('leaves a script id alone, since one is already a filename', () => {
    expect(stem('opening')).toBe('opening');
    expect(stem('台本ダ')).toBe('台本ダ'.normalize('NFC'));
  });

  it('reduces anything else rather than refusing it', () => {
    expect(stem('a/b c')).toBe('a-b-c');
    expect(stem('../etc/passwd')).toBe('etc-passwd');
    expect(stem(undefined)).toBe('take');
    expect(stem('')).toBe('take');
    expect(stem('///')).toBe('take');
  });
});

describe('timestamp', () => {
  it('sorts the evening in the order the takes were made', () => {
    expect(timestamp(AT)).toBe('20260829-142530');
  });
});

describe('Recordings', () => {
  it('has nothing open until one is asked for', () => {
    expect(recordings.current).toBeNull();
  });

  it('opens a take without writing anything yet', async () => {
    const take = recordings.open({ name: 'opening', ...OPEN }, AT);
    expect(take?.mime).toBeNull();
    expect(take?.bytes).toBe(0);
    // No name is taken and no file exists: a start that no renderer acted on —
    // every attached one being a muted monitor — must leave nothing behind.
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses a second take rather than queueing it', () => {
    expect(recordings.open(OPEN, AT)).not.toBeNull();
    expect(recordings.open(OPEN, AT)).toBeNull();
  });

  it('names the file from the first chunk and appends the rest in order', async () => {
    const take = recordings.open({ name: 'opening', ...OPEN }, AT);
    if (take === null) throw new Error('the take did not open');
    expect(recordings.append(take.session, MP4, Buffer.from('one'))).toBe(true);
    expect(recordings.append(take.session, MP4, Buffer.from('two'))).toBe(true);
    const closed = await recordings.close(take.session);

    expect(closed?.mime).toBe(MP4);
    expect(closed?.bytes).toBe(6);
    expect(closed?.file).toBe(join(root, 'opening-20260829-142530.mp4'));
    expect(await readFile(join(root, 'opening-20260829-142530.mp4'), 'utf8')).toBe('onetwo');
  });

  it('drops a chunk that belongs to a take which is no longer the one running', async () => {
    // A renderer still flushing when the next take started. Written, it would
    // splice the end of one recording into the front of another.
    const first = recordings.open(OPEN, AT);
    if (first === null) throw new Error('the take did not open');
    await recordings.close(first.session);
    const second = recordings.open(OPEN, AT);
    expect(recordings.append(first.session, MP4, Buffer.from('stale'))).toBe(false);
    expect(second?.session).not.toBe(first.session);
  });

  it('closes a take that never received a chunk without leaving a file', async () => {
    const take = recordings.open(OPEN, AT);
    if (take === null) throw new Error('the take did not open');
    const closed = await recordings.close(take.session);
    // Still answered — the panel asked for a take and is owed the news that
    // there was nothing in it.
    expect(closed?.bytes).toBe(0);
    expect(closed?.mime).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it('answers null for a stop that names a take which is not the live one', async () => {
    const take = recordings.open(OPEN, AT);
    if (take === null) throw new Error('the take did not open');
    expect(await recordings.close('some-other-session')).toBeNull();
    expect(recordings.current?.session).toBe(take.session);
  });

  it('reports what has landed on disk, which is the only honest progress figure', async () => {
    const take = recordings.open(OPEN, AT);
    if (take === null) throw new Error('the take did not open');
    recordings.append(take.session, MP4, Buffer.alloc(2048));
    expect(recordings.current?.bytes).toBe(2048);
    expect(recordings.current?.width).toBe(1920);
    expect(recordings.current?.autoStop).toBe(true);
  });

  it('makes the directory when the configured one is not there', async () => {
    const nested = new Recordings(join(root, 'takes'));
    const take = nested.open(OPEN, AT);
    if (take === null) throw new Error('the take did not open');
    nested.append(take.session, MP4, Buffer.from('x'));
    await nested.close(take.session);
    expect(await readdir(join(root, 'takes'))).toHaveLength(1);
  });
});
