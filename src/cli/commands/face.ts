import { parseArgs } from 'node:util';
import {
  emotionCommandSchema,
  expressionCommandSchema,
  overlayCommandSchema,
} from '../../protocol';
import { build, type Handler, parseVec, toNumber } from '../args';
import { fail } from '../client';
import { show } from '../output';

/**
 * The face: the mood underneath it, the drawn expression over that, and the
 * effects over both.
 */

export const emotion: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  if (positionals.length === 0) fail('emotion needs pairs such as joy=0.8');
  show(
    await client.command(
      build(emotionCommandSchema, {
        cmd: 'emotion',
        vec: parseVec(positionals),
      }),
    ),
  );
};

export const expression: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  show(
    await client.command(
      build(expressionCommandSchema, {
        cmd: 'expression',
        id: positionals[0],
      }),
    ),
  );
};

/**
 * Drawn effects layer over whatever face is showing, so unlike `expression`
 * several can be up at once and each is cleared by name.
 */
export const overlay: Handler = async (client, args) => {
  const { values, positionals } = parseArgs({
    args,
    options: { weight: { type: 'string' }, off: { type: 'boolean' } },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (id === undefined) fail('overlay needs the id of an effect');
  show(
    await client.command(
      build(overlayCommandSchema, {
        cmd: 'overlay',
        id,
        weight: values.off ? 0.0 : toNumber(values.weight, 1.0, '--weight'),
      }),
    ),
  );
};
