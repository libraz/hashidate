import { parseArgs } from 'node:util';
import {
  gestureCommandSchema,
  hopCommandSchema,
  idleCommandSchema,
  lookCommandSchema,
  performCommandSchema,
  pointCommandSchema,
} from '../../protocol';
import { build, extractNumbers, type Handler, toNumber } from '../args';
import { fail } from '../client';
import { show } from '../output';

/**
 * What the body does: a whole performance, its parts, and the aims that are
 * continuous rather than named — a fingertip, and the gaze.
 */

/**
 * A face and a movement together, which is what most callers actually want.
 * With no id it releases the one that is up, like `gesture`.
 */
export const perform: Handler = async (client, args) => {
  const { values, positionals } = parseArgs({
    args,
    options: { side: { type: 'string' } },
    allowPositionals: true,
  });
  show(
    await client.command(
      build(performCommandSchema, {
        cmd: 'perform',
        id: positionals[0],
        side: values.side,
      }),
    ),
  );
};

/**
 * One movement. `--side L` pins the hand a one-handed gesture acts with, which
 * is otherwise a fresh draw on every playback.
 */
export const gesture: Handler = async (client, args) => {
  const { values, positionals } = parseArgs({
    args,
    options: { side: { type: 'string' } },
    allowPositionals: true,
  });
  show(
    await client.command(
      build(gestureCommandSchema, {
        cmd: 'gesture',
        id: positionals[0],
        side: values.side,
      }),
    ),
  );
};

export const hop: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  show(
    await client.command(
      build(hopCommandSchema, {
        cmd: 'hop',
        hop: positionals[0],
      }),
    ),
  );
};

/**
 * Angular, not a pose name: the arm is back-solved from where the fingertip has
 * to be. `point` with no arguments releases, like `gesture` with no id.
 */
export const point: Handler = async (client, args) => {
  const { numbers, rest } = extractNumbers(args, ['--extent', '--side', '--finger']);
  const { values } = parseArgs({
    args: rest,
    options: {
      extent: { type: 'string' },
      side: { type: 'string' },
      finger: { type: 'string' },
    },
    allowPositionals: true,
  });
  if (numbers.length === 0) {
    show(await client.command(build(pointCommandSchema, { cmd: 'point' })));
    return;
  }
  // Degrees on the wire: 0 azimuth is straight ahead and positive is toward the
  // character's right, 0 elevation is shoulder height and positive is up.
  show(
    await client.command(
      build(pointCommandSchema, {
        cmd: 'point',
        azimuth: toNumber(numbers[0], 0.0, 'azimuth'),
        elevation: toNumber(numbers[1], 0.0, 'elevation'),
        extent: toNumber(values.extent, 0.8, '--extent'),
        side: values.side ?? 'R',
        finger: values.finger ?? 'index',
      }),
    ),
  );
};

export const idle: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const on = positionals[0];
  if (on !== 'on' && on !== 'off') fail('idle on|off');
  show(await client.command(build(idleCommandSchema, { cmd: 'idle', on: on === 'on' })));
};

export const look: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  if (positionals[0] === undefined) fail('look needs an amount in 0..1');
  show(
    await client.command(
      build(lookCommandSchema, {
        cmd: 'look',
        amount: toNumber(positionals[0], 1.0, 'amount'),
      }),
    ),
  );
};
