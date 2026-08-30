import { parseArgs } from 'node:util';
import { commandSchema, pauseCommandSchema, sayCommandSchema } from '../../protocol';
import { build, expandGreedy, type Handler, normaliseWait, parseVec } from '../args';
import { fail } from '../client';
import { show } from '../output';

/**
 * A line, and what can be done to the run of them: say it, hold the queue,
 * let it go again, and the three that take nothing at all.
 */

export const say: Handler = async (client, args) => {
  const { values, positionals } = parseArgs({
    args: expandGreedy(normaliseWait(args), '--emotion'),
    options: {
      reading: { type: 'string' },
      emotion: { type: 'string', multiple: true },
      expression: { type: 'string' },
      gesture: { type: 'string' },
      perform: { type: 'string' },
      side: { type: 'string' },
      hold: { type: 'boolean' },
      camera: { type: 'string' },
      backdrop: { type: 'string' },
      room: { type: 'string' },
      deck: { type: 'string' },
      slide: { type: 'string' },
      wait: { type: 'string' },
    },
    allowPositionals: true,
  });
  const text = positionals[0];
  if (text === undefined) fail('say needs the text to be read out');
  // The shot, if any of it was named. Built as a whole or not at all, because
  // an empty object is a staging instruction that stages nothing — harmless,
  // but it would put a `stage: {}` on every line the wire ever carried.
  //
  // An empty string is how a shell says null here: `--room ''` is dry, `--room`
  // left off leaves the room where it is. The standalone commands make that
  // distinction by having an argument or not, which a flag cannot do.
  const empty = (v: string | undefined): string | null | undefined =>
    v === undefined ? undefined : v === '' ? null : v;
  // `--deck ''` takes the document down, matching `--room ''` beside it and
  // deliberately unlike the standalone `deck`, whose word for that is `none`.
  // There the id is a required positional and a bare command would far more
  // often be a name that went missing than an instruction to clear the screen;
  // a flag left off already says "leave it", so the empty value is free.
  //
  // A layout is not here. It is four numbers and an anchor, which is a page of
  // flags for the one thing this client is worst at — an operator moving the
  // character by hand runs `place` and watches it. A line carrying one is a
  // script, and a script has room to write it out; see `src/script`.
  const staged = ['camera', 'backdrop', 'room', 'deck', 'slide'] as const;
  const stage = staged.every((key) => values[key] === undefined)
    ? undefined
    : {
        camera: values.camera,
        backdrop: empty(values.backdrop),
        room: empty(values.room),
        deck: empty(values.deck),
        slide: values.slide === undefined ? undefined : Number(values.slide),
      };
  const command = build(sayCommandSchema, {
    cmd: 'say',
    text,
    reading: values.reading,
    emotion: parseVec(values.emotion),
    expression: values.expression,
    gesture: values.gesture,
    perform: values.perform,
    side: values.side,
    hold: values.hold ? true : undefined,
    stage,
  });
  show(await client.command(command, values.wait));
};

/**
 * Hold the queue, and let it go again.
 *
 * Two names rather than `hold on|off`, because these are the two ends of one
 * movement and each is typed in a hurry. Neither touches the line being spoken:
 * that finishes, and nothing is discarded — `interrupt` cuts and `clear` drops.
 */
export const hold: Handler = async (client) => {
  show(await client.command(build(pauseCommandSchema, { cmd: 'pause', on: true })));
};

export const resume: Handler = async (client) => {
  show(await client.command(build(pauseCommandSchema, { cmd: 'pause', on: false })));
};

/**
 * The three that take nothing at all. Validated against the union, which is the
 * same schema by another name.
 */
export function bare(cmd: 'reset' | 'interrupt' | 'clear'): Handler {
  return async (client) => {
    show(await client.command(build(commandSchema, { cmd })));
  };
}
