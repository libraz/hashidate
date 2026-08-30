import { parseArgs } from 'node:util';
import {
  backdropCommandSchema,
  cameraCommandSchema,
  deckCommandSchema,
  placeCommandSchema,
  roomCommandSchema,
  slideCommandSchema,
} from '../../protocol';
import { build, type Handler, NUMBER } from '../args';
import { fail } from '../client';
import { localized, show } from '../output';

/**
 * Where the line is delivered: the camera, the acoustic, the set, the document
 * behind the character, and where all of it sits in the frame.
 */

/**
 * `yarn ctl camera full --yaw 25 --zoom 1.3`, and any subset of that.
 *
 * The framing is a positional because it is what is nearly always meant; the
 * three offsets are flags because they are the rarer half and because leaving
 * one out has to mean "leave it alone" rather than "zero". See `Shot`.
 */
export const camera: Handler = async (client, args) => {
  const { positionals, values } = parseArgs({
    args,
    options: { yaw: { type: 'string' }, pitch: { type: 'string' }, zoom: { type: 'string' } },
    allowPositionals: true,
  });
  const degrees = (raw: string | undefined) => (raw === undefined ? undefined : Number(raw));
  show(
    await client.command(
      build(cameraCommandSchema, {
        cmd: 'camera',
        frame: positionals[0],
        yaw: degrees(values.yaw),
        pitch: degrees(values.pitch),
        zoom: degrees(values.zoom),
      }),
    ),
  );
};

/** No id is dry, matching `perform` and `gesture` rather than needing a word for it. */
export const room: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  show(
    await client.command(
      build(roomCommandSchema, {
        cmd: 'room',
        id: positionals[0] ?? null,
      }),
    ),
  );
};

/** Same shape as `room` beside it, and the same rule: no id is the bare stage. */
export const backdrop: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  show(
    await client.command(
      build(backdropCommandSchema, {
        cmd: 'backdrop',
        id: positionals[0] ?? null,
      }),
    ),
  );
};

/**
 * Which document is behind the character.
 *
 * The id is required and taking one down is the word `none`, which is where
 * this differs from `room` and `backdrop` above. Those have an empty value that
 * is also their resting state, so a bare command reads as "back to nothing". A
 * document is put up deliberately and taken down deliberately in the middle of
 * a segment, and a bare `deck` is far more likely to be a typed id that went
 * missing than an instruction to clear the screen.
 */
export const deck: Handler = async (client, args) => {
  const { positionals, values } = parseArgs({
    args,
    options: { page: { type: 'string' } },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (id === undefined) fail('deck needs the id of a document (to take one down, deck none)');
  show(
    await client.command(
      build(deckCommandSchema, {
        cmd: 'deck',
        id: id === 'none' ? null : id,
        page: values.page === undefined ? undefined : Number(values.page),
      }),
    ),
  );
};

/**
 * Turn a page: `next`, `prev`, or the page to go to.
 *
 * Bare is next, which is what the wire means by a `slide` with neither field —
 * stated as `by: 1` here anyway, so the JSON that gets printed says what was
 * actually done rather than leaving the reader to know the default.
 */
export const slide: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const where = positionals[0];
  show(await client.command(build(slideCommandSchema, { cmd: 'slide', ...move(where) })));
};

export function move(where: string | undefined): { page?: number; by?: number } {
  if (where === undefined || where === 'next') return { by: 1 };
  if (where === 'prev') return { by: -1 };
  if (NUMBER.test(where)) return { page: Number.parseInt(where, 10) };
  fail(`slide takes next / prev / a page number: ${where}`);
}

/**
 * Where the two layers sit in the broadcast frame.
 *
 * The layer is a positional and defaults to the character, which is the one
 * that gets moved: a document is usually left filling the frame and the
 * character is slid into a corner of it. Every field is optional and an absent
 * one is left alone, so this moves what it names and nothing else.
 */
export const place: Handler = async (client, args) => {
  const { positionals, values } = parseArgs({
    args,
    options: {
      anchor: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      margin: { type: 'string' },
      fit: { type: 'string' },
    },
    allowPositionals: true,
  });
  const layer = positionals[0] ?? 'avatar';
  if (layer !== 'avatar' && layer !== 'slide') fail(`place takes avatar or slide: ${layer}`);
  // `fit` is how a picture fills its rectangle, which the character's does not
  // have — it is a render of a scene rather than an image with edges.
  if (layer === 'avatar' && values.fit !== undefined) fail('--fit can only be given for slide');
  const number = (raw: string | undefined) => (raw === undefined ? undefined : Number(raw));
  const placement = {
    anchor: values.anchor,
    width: number(values.width),
    height: number(values.height),
    margin: number(values.margin),
    ...(layer === 'slide' ? { fit: values.fit } : {}),
  };
  show(await client.command(build(placeCommandSchema, { cmd: 'place', [layer]: placement })));
};

/** What the server can see in the document directory. Not avatar data; see `deckSchema`. */
export const decks: Handler = async (client) => {
  const { decks: found } = await client.decks();
  if (found.length === 0) {
    console.log('no documents (put a PDF in slides/)');
    return;
  }
  for (const item of found) {
    console.log(
      `  ${item.id.padEnd(16)} ${String(item.pages).padStart(3)}p  ${localized(item.label)}`,
    );
  }
};
