import { z } from 'zod';

/** Camera framings shared by the camera command and inline camera cues. */
export const cameraFrameSchema = z.enum(['face', 'bust', 'upper', 'full']);

/** The transport verbs that can be scheduled from inside a spoken line. */
export const bgmActionSchema = z.enum(['play', 'pause', 'stop']);
export type BgmCueAction = z.infer<typeof bgmActionSchema>;

/**
 * A single id in cue syntax. The legacy shorthand is deliberately narrower
 * than typed ids; loaded gestures and avatar expressions may use Unicode and
 * spaces, but a bracketed shorthand remains the old ASCII performance form
 * for compatibility. Brackets are the only printable characters unavailable
 * to typed ids because they delimit the cue itself.
 */
const typedIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => !(value.includes('[') || value.includes(']') || /\p{Cc}/u.test(value)),
    'cue ids may not contain brackets or control characters',
  );
const legacyIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/);

/** BGM filenames are flat, direct-directory ids, just like the BGM endpoint. */
export const bgmTrackIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => {
    if (value.startsWith('.') || /[/\\[\]]/u.test(value)) return false;
    return !/\p{Cc}/u.test(value);
  }, 'invalid BGM filename')
  .regex(/\.(?:mp3|flac)$/iu, 'BGM tracks must be .mp3 or .flac');

/**
 * The action carried by a typed inline cue.
 *
 * `kind` is the discriminant so the engine can apply visual actions locally.
 * BGM has a second `action` verb because the server owns its transport. The
 * union keeps `track` legal only for `play`; malformed combinations are
 * rejected at the protocol boundary instead of being silently ignored.
 */
export const inlineCueActionSchema = z.union([
  z.object({ kind: z.literal('perform'), id: typedIdSchema }).strict(),
  z.object({ kind: z.literal('expression'), id: typedIdSchema }).strict(),
  z.object({ kind: z.literal('gesture'), id: typedIdSchema }).strict(),
  z.object({ kind: z.literal('hop'), id: typedIdSchema }).strict(),
  z.object({ kind: z.literal('camera'), frame: cameraFrameSchema }).strict(),
  z.object({ kind: z.literal('slide'), page: z.number().int().min(1) }).strict(),
  z
    .object({
      kind: z.literal('bgm'),
      action: z.literal('play'),
      track: bgmTrackIdSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('bgm'), action: z.enum(['pause', 'stop']) }).strict(),
]);

export type InlineCueAction = z.infer<typeof inlineCueActionSchema>;

const OPEN = '[';
const CLOSE = ']';

/** Whether a line contains reserved cue brackets. */
export const hasCueMarkup = (source: string): boolean =>
  source.includes(OPEN) || source.includes(CLOSE);

/**
 * Whether every bracketed section is a valid legacy or typed cue.
 *
 * This lives with the wire grammar so protocol validation does not depend on
 * the renderer's viseme implementation. The engine imports the same function
 * and keeps a total stripper for in-process callers.
 */
export const isWellFormed = (source: string): boolean => {
  for (let i = 0; i < source.length; ) {
    const ch = source[i];
    if (ch === CLOSE) return false;
    if (ch !== OPEN) {
      i += 1;
      continue;
    }
    const close = source.indexOf(CLOSE, i + 1);
    if (close === -1 || parseInlineCue(source.slice(i + 1, close)) === null) return false;
    i = close + 1;
  }
  return true;
};

/** The old `[performanceId]` shorthand remains available to the parser. */
export function parseInlineCue(source: string): InlineCueAction | null {
  const legacy = legacyIdSchema.safeParse(source);
  if (legacy.success) return { kind: 'perform', id: legacy.data };

  if (!source.startsWith('@')) return null;
  const body = source.slice(1).trim();
  const [verb] = body.split(/\s+/u);
  if (verb === undefined) return null;
  const remainder = body.slice(verb.length).trim();
  const rest = remainder === '' ? [] : remainder.split(/\s+/u);

  let candidate: unknown;
  switch (verb) {
    case 'perform':
    case 'expression':
    case 'gesture':
    case 'hop': {
      if (remainder === '') return null;
      // Like a BGM filename, a dynamic id is the whole remainder. Motions are
      // named from files on disk and their valid ids include spaces.
      candidate = { kind: verb, id: remainder };
      break;
    }
    case 'camera': {
      if (rest.length !== 1) return null;
      candidate = { kind: 'camera', frame: rest[0] };
      break;
    }
    case 'slide': {
      if (rest.length !== 1 || !/^[1-9]\d*$/u.test(rest[0] ?? '')) return null;
      const page = Number(rest[0]);
      if (!Number.isSafeInteger(page)) return null;
      candidate = { kind: 'slide', page };
      break;
    }
    case 'bgm': {
      const separator = remainder.search(/\s/u);
      const action = separator === -1 ? remainder : remainder.slice(0, separator);
      if (action === '') return null;
      if (action === 'play') {
        // The trimmed remainder is the filename, not a list of words. Keeping
        // its internal whitespace is what lets a cue name the exact id returned
        // by the BGM library, including filenames with consecutive spaces.
        const track = separator === -1 ? '' : remainder.slice(separator).trim();
        candidate = { kind: 'bgm', action, ...(track ? { track } : {}) };
      } else if (action === 'pause' || action === 'stop') {
        if (separator !== -1) return null;
        candidate = { kind: 'bgm', action };
      } else {
        return null;
      }
      break;
    }
    default:
      return null;
  }

  const parsed = inlineCueActionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Alias for callers that describe the operation as parsing a cue action. */
export const parseCueAction = parseInlineCue;
