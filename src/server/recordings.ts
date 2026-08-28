import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import type { Recording } from '../protocol';

/**
 * The recording being written, and the directory it lands in.
 *
 * ## The bytes come from the renderer, and the file lives here
 *
 * The composed frame only exists in the browser — the slide layer, the
 * character over it and the voice are three things the browser puts together
 * and nothing else can see. So the renderer encodes, and posts what it encodes
 * a second at a time to `POST /api/record/chunk`, and this appends it. The
 * split is the same one the rest of the runtime makes: the process with a
 * filesystem owns the file, and the process with a canvas owns the picture.
 *
 * That is also why this, rather than the renderer, is what the panel reads. A
 * recorder that believes it is recording and a file that is not growing look
 * identical from the page doing the recording; `bytes` here is what actually
 * landed on disk, and is the only figure that can tell those two apart.
 *
 * ## The file is opened by the first chunk, not by `open`
 *
 * Two reasons, and the second is the one that matters. The extension is decided
 * by the container the renderer's encoder actually chose — mp4 where there is
 * an H.264 encoder, WebM where there is not — and that is not known until it
 * says so. And a start that no renderer acted on, because every attached one is
 * a muted monitor, should leave nothing behind: an empty file with a timestamp
 * in its name is indistinguishable from a take that went wrong.
 *
 * ## One at a time
 *
 * A second `open` while one is running is refused rather than queued. There is
 * one composed frame and one voice, so a second recording would be a second
 * copy of the first — and the operator asking for it has almost always
 * forgotten that the first is running, which is what the refusal tells them.
 */

/** What a container's media type means for the name on disk. */
const EXTENSIONS: Array<{ match: string; extension: string }> = [
  { match: 'video/mp4', extension: '.mp4' },
  { match: 'video/webm', extension: '.webm' },
  { match: 'video/x-matroska', extension: '.mkv' },
];

/**
 * The extension for a media type, or `.bin` for one nothing here recognises.
 *
 * Unreachable in practice — the renderer picks from a fixed list of candidates
 * — and deliberately not defaulted to `.webm`: a file that will not open is
 * better named as the unknown thing it is than mislabelled as a format it is
 * not, because the second costs an hour before anybody thinks to run `file` on
 * it.
 */
export function extensionFor(mime: string): string {
  const type = mime.split(';')[0].trim().toLowerCase();
  return EXTENSIONS.find((entry) => entry.match === type)?.extension ?? '.bin';
}

/** What may not be in the name a recording is asked to take. */
const FORBIDDEN_IN_NAME = /[^\p{L}\p{N}._-]/gu;

/** Long enough to carry a script's name, short enough to stay a filename. */
const MAX_NAME_LENGTH = 64;

/**
 * A filename stem from whatever the caller offered.
 *
 * Usually a script id, which is already a filename and survives this untouched.
 * Anything else is reduced to what a filename may hold rather than refused: a
 * recording that would not start because its suggested name had a slash in it
 * is a recording lost to a detail nobody was thinking about.
 */
export function stem(name: string | undefined, fallback = 'take'): string {
  const cleaned = (name ?? '')
    .normalize('NFC')
    .replace(FORBIDDEN_IN_NAME, '-')
    .replace(/^[.-]+/, '')
    .slice(0, MAX_NAME_LENGTH);
  return cleaned === '' ? fallback : cleaned;
}

/**
 * `20260829-142530`, in local time.
 *
 * Local rather than UTC because the only thing this has to do is sort the
 * evening's takes in the order they were made, in a file manager, for the
 * person who made them.
 */
export function timestamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}

/**
 * What the hub needs of a recording store.
 *
 * Named separately for the reason `DeckSource` and `SpeechSource` are: this is
 * the one thing in the take path that touches the filesystem, and the hub's
 * part of a recording — releasing a hold on the first chunk, ending it at the
 * end of the script — is worth testing without one.
 */
export interface RecordingStore {
  readonly current: Recording | null;
  open(options: OpenOptions): Recording | null;
  append(session: string, mime: string, chunk: Buffer): boolean;
  close(session?: string): Promise<Recording | null>;
}

export interface OpenOptions {
  /** What to call it. A script id, usually. See `stem`. */
  name?: string;
  width: number;
  height: number;
  fps: number;
  /** Whether the end of the queue ends the recording. */
  autoStop: boolean;
}

/** A recording in flight, as this module holds it. */
interface Live {
  session: string;
  base: string;
  mime: string | null;
  extension: string | null;
  since: number;
  bytes: number;
  autoStop: boolean;
  width: number;
  height: number;
  fps: number;
  stream: WriteStream | null;
  /** Serialises the writes so chunks land in the order they arrived. */
  writing: Promise<void>;
}

const now = (): number => Date.now() / 1000;

export class Recordings implements RecordingStore {
  private readonly root: string;
  private live: Live | null = null;
  private counter = 0;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Where the takes land, for a launcher that opens the directory. */
  get directory(): string {
    return this.root;
  }

  /** The recording in flight, as the snapshot reports it. */
  get current(): Recording | null {
    return this.live === null ? null : report(this.live);
  }

  /**
   * Start one, or answer null because one is already running.
   *
   * Nothing is written and no name is taken until the first chunk. See the
   * module docstring.
   */
  open(options: OpenOptions, at: Date = new Date()): Recording | null {
    if (this.live !== null) return null;
    this.counter += 1;
    this.live = {
      session: `r${Date.now().toString(36)}-${this.counter.toString(36)}`,
      base: resolve(this.root, `${stem(options.name)}-${timestamp(at)}`),
      mime: null,
      extension: null,
      since: now(),
      bytes: 0,
      autoStop: options.autoStop,
      width: options.width,
      height: options.height,
      fps: options.fps,
      stream: null,
      writing: Promise.resolve(),
    };
    return report(this.live);
  }

  /**
   * Append a chunk, and answer whether it belonged to the recording in flight.
   *
   * A chunk for a session that is not the live one is dropped rather than
   * written. That is the ordinary outcome of a renderer that was still
   * flushing when a take was stopped and the next one started, and writing it
   * would splice the end of one recording into the front of another.
   *
   * The first chunk is what names the file. See `extensionFor`.
   */
  append(session: string, mime: string, chunk: Buffer): boolean {
    const live = this.live;
    if (live === null || live.session !== session) return false;
    if (chunk.byteLength === 0) return true;
    if (live.stream === null) {
      live.mime = mime;
      live.extension = extensionFor(mime);
      live.stream = this.begin(live);
    }
    const stream = live.stream;
    live.bytes += chunk.byteLength;
    // Chained rather than awaited by the caller: the route answers as soon as
    // the bytes are ours, and the writes still land in order.
    live.writing = live.writing.then(
      () =>
        new Promise<void>((done) => {
          stream.write(chunk, () => done());
        }),
    );
    return true;
  }

  /**
   * Close the recording, and answer it as it ended.
   *
   * Null for a session that is not the live one, which is what a stop arriving
   * twice looks like. A recording that never received a chunk closes with no
   * file — see the module docstring — and is still answered, because the panel
   * asked for a take and is owed the news that there was nothing in it.
   */
  async close(session?: string): Promise<Recording | null> {
    const live = this.live;
    if (live === null) return null;
    if (session !== undefined && live.session !== session) return null;
    this.live = null;
    await live.writing;
    const stream = live.stream;
    if (stream !== null) await new Promise<void>((done) => stream.end(done));
    return report(live);
  }

  /**
   * Open the file for a recording that has started producing bytes.
   *
   * The directory is made if it is not there. A checkout ships one, but the
   * output path is a command-line argument and the first take of the evening
   * failing because a directory was renamed is not a useful thing to be strict
   * about.
   */
  private begin(live: Live): WriteStream {
    // Synchronously, and before the stream: this runs on the first chunk of a
    // take that is already rolling, and a directory made a tick later is a
    // directory made after the open that needed it failed.
    try {
      mkdirSync(this.root, { recursive: true });
    } catch {
      // Left to the stream's own error, which names the file rather than the
      // directory and is the line worth printing.
    }
    const path = `${live.base}${live.extension ?? ''}`;
    // `wx` rather than `w`: two takes started inside one second would otherwise
    // have the same name, and the second would overwrite the first silently.
    const stream = createWriteStream(path, { flags: 'wx' });
    stream.on('error', (error) => {
      console.error(`recording ${path}: ${error.message}`);
    });
    return stream;
  }
}

function report(live: Live): Recording {
  return {
    session: live.session,
    file: `${live.base}${live.extension ?? ''}`,
    mime: live.mime,
    since: live.since,
    bytes: live.bytes,
    autoStop: live.autoStop,
    width: live.width,
    height: live.height,
    fps: live.fps,
  };
}
