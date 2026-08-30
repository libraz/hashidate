import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Writable } from 'node:stream';
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
  append(session: string, owner: string, mime: string, chunk: Buffer): Promise<AppendResult>;
  close(session?: string): Promise<Recording | null>;
}

/** A sink factory, injectable so write failure paths can be tested directly. */
export type RecordingSink = (path: string) => Writable;

/** The outcome of one renderer's attempt to append a chunk. */
export type AppendStatus = 'accepted' | 'stale' | 'conflict' | 'failed';

/**
 * A serialized append result.
 *
 * `first` means the first non-empty chunk that the sink accepted. It is the
 * only safe evidence for releasing a recording hold: opening a stream or
 * accepting a request says nothing about whether bytes reached disk.
 */
export interface AppendResult {
  status: AppendStatus;
  first: boolean;
  recording: Recording | null;
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
  /** Pinned synchronously by the first append attempt. */
  owner: string | null;
  base: string;
  mime: string | null;
  extension: string | null;
  since: number;
  bytes: number;
  autoStop: boolean;
  width: number;
  height: number;
  fps: number;
  stream: Writable | null;
  /** Bounded error retained for the snapshot and the next append response. */
  error: string | null;
  /** Serialises the writes so chunks land in the order they arrived. */
  writing: Promise<void>;
}

/** Keep a bad filesystem error useful without letting it grow a report. */
const MAX_ERROR_LENGTH = 1024;

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH) || 'recording sink failed';
}

const now = (): number => Date.now() / 1000;

export class Recordings implements RecordingStore {
  private readonly root: string;
  private live: Live | null = null;
  private counter = 0;

  constructor(
    root: string,
    private readonly sink: RecordingSink = (path) => createWriteStream(path, { flags: 'wx' }),
  ) {
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
      owner: null,
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
      error: null,
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
  append(session: string, owner: string, mime: string, chunk: Buffer): Promise<AppendResult> {
    const live = this.live;
    if (live === null || live.session !== session) {
      return Promise.resolve({
        status: 'stale',
        first: false,
        recording: live === null ? null : report(live),
      });
    }
    // This assignment must happen before the first await. Two renderers can
    // post at the same time, and whichever call reaches this synchronous line
    // first owns the take even if its sink subsequently fails.
    if (live.owner === null) live.owner = owner;
    if (live.owner !== owner) {
      return Promise.resolve({
        status: 'conflict',
        first: false,
        recording: report(live),
      });
    }

    const write = live.writing
      .then(async () => {
        if (live.error !== null) return { accepted: false, first: false };
        if (chunk.byteLength === 0) return { accepted: true, first: false };

        // The value is read inside the serialized operation, not when the
        // request is queued. A second chunk may arrive before the first sink
        // callback; only the one that actually completes first is `first`.
        const firstSuccessful = live.mime === null;

        let stream = live.stream;
        if (stream === null) {
          stream = this.begin(live, mime);
          if (stream === null) return { accepted: false, first: false };
          live.stream = stream;
        }
        try {
          await writeChunk(stream, chunk);
        } catch (error) {
          live.error = errorText(error);
          return { accepted: false, first: false };
        }
        // These fields describe bytes accepted by the sink, not a request that
        // merely arrived. A failed open/write therefore leaves bytes and mime
        // unchanged and cannot release a hold upstream.
        live.bytes += chunk.byteLength;
        if (live.mime === null) {
          live.mime = mime;
          live.extension = extensionFor(mime);
        }
        return { accepted: true, first: firstSuccessful };
      })
      .catch((error: unknown) => {
        live.error = errorText(error);
        return { accepted: false, first: false };
      });
    live.writing = write.then(() => undefined);
    return write.then(({ accepted, first: firstSuccessful }) => ({
      status: accepted ? ('accepted' as const) : ('failed' as const),
      first: firstSuccessful,
      recording: report(live),
    }));
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
    if (stream !== null) {
      if (live.error !== null) {
        // An errored stream may never invoke an `end` callback. It is already
        // unusable, and destroying it is the bounded terminal action that lets
        // a later recording start.
        stream.destroy();
      } else {
        await new Promise<void>((done) => stream.end(done));
      }
    }
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
  private begin(live: Live, mime: string): Writable | null {
    // Synchronously, and before the stream: this runs on the first chunk of a
    // take that is already rolling, and a directory made a tick later is a
    // directory made after the open that needed it failed.
    try {
      mkdirSync(this.root, { recursive: true });
    } catch (error) {
      live.error = errorText(error);
      return null;
    }
    const path = `${live.base}${extensionFor(mime)}`;
    // `wx` rather than `w`: two takes started inside one second would otherwise
    // have the same name, and the second would overwrite the first silently.
    let stream: Writable;
    try {
      stream = this.sink(path);
    } catch (error) {
      live.error = errorText(error);
      return null;
    }
    stream.on('error', (error) => {
      live.error = errorText(error);
      console.error(`recording ${path}: ${live.error}`);
    });
    return stream;
  }
}

/** Wait for the sink's callback or its error event, whichever comes first. */
function writeChunk(stream: Writable, chunk: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      stream.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => finish(error);
    stream.once('error', onError);
    try {
      stream.write(chunk, (error?: Error | null) => finish(error));
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
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
    error: live.error,
  };
}
