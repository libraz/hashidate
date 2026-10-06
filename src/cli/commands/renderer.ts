import { parseArgs } from 'node:util';
import {
  avatarCommandSchema,
  debugCommandSchema,
  tuneCommandSchema,
  wearCommandSchema,
} from '../../protocol';
import { build, type Handler, NUMBER, splitOnce } from '../args';
import { fail } from '../client';
import { show } from '../output';

/**
 * The renderer and the character it has loaded: which avatar, what it is
 * wearing, how the set-once layer is set, and whether it prints its own
 * measurements over the frame.
 */

/**
 * `wear --slot outer coat`, or `--item coat`; `none` takes the slot's garment
 * off. An item that would not reach a slot is refused rather than dropped.
 */
export const wear: Handler = async (client, args) => {
  const { values, positionals } = parseArgs({
    args,
    options: {
      slot: { type: 'string' },
      item: { type: 'string' },
      preset: { type: 'string' },
    },
    allowPositionals: true,
  });
  if (positionals.length > 1 || (positionals.length > 0 && values.item !== undefined)) {
    fail(`wear takes one item, after the slot or as --item: ${positionals.join(' ')}`);
  }
  const named = values.item ?? positionals[0];
  if (named !== undefined && values.slot === undefined) {
    fail(`wear needs --slot to put ${named} in`);
  }
  show(
    await client.command(
      build(wearCommandSchema, {
        cmd: 'wear',
        slot: values.slot,
        item: named === 'none' ? null : named,
        preset: values.preset,
      }),
    ),
  );
};

/** One positional, and no default: there is no such thing as no avatar. */
export const avatar: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  show(await client.command(build(avatarCommandSchema, { cmd: 'avatar', id: positionals[0] })));
};

/**
 * The set-once layer, as dotted assignments: `yarn ctl tune sway.stiffness=2`.
 *
 * Fourteen numbers in five groups, so a flag apiece would be a page of options
 * for a command that is almost always used to move one of them. The path is the
 * field's own path in `tuneCommandSchema`, which means there is nothing to
 * remember and nothing here that has to be kept in step with it — an unknown
 * one is refused by the schema rather than by a table in this file.
 */
export const tune: Handler = async (client, args) => {
  const { positionals, values } = parseArgs({
    args,
    options: { settle: { type: 'boolean' } },
    allowPositionals: true,
  });

  const patch: Record<string, Record<string, unknown>> = {};
  for (const assignment of positionals) {
    const [path, raw] = splitOnce(assignment, '=');
    const [group, field] = splitOnce(path, '.');
    if (raw === null || field === null)
      fail(`a tuning is written group.field=value: ${assignment}`);
    // Numbers stay numbers and the two words stay booleans; anything else is
    // left as written so the schema can say what is wrong with it. Only a whole
    // number counts: `Number('')` is 0, which would send an empty value as one.
    const value =
      raw === 'true' ? true : raw === 'false' ? false : NUMBER.test(raw) ? Number(raw) : raw;
    patch[group] = { ...patch[group], [field]: value };
  }

  show(
    await client.command(
      build(tuneCommandSchema, {
        cmd: 'tune',
        ...patch,
        ...(values.settle ? { settle: true } : {}),
      }),
    ),
  );
};

/**
 * The measurements over the frame, on every renderer attached.
 *
 * A bare `debug` turns it on, which is the way round it is nearly always
 * wanted — the question arrives, the readout goes up, and `debug off` puts it
 * away. Nothing remembers it, so a renderer that reloads comes back clean.
 */
export const debug: Handler = async (client, args) => {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  const on = positionals[0] ?? 'on';
  if (on !== 'on' && on !== 'off') fail('debug [on|off]');
  show(await client.command(build(debugCommandSchema, { cmd: 'debug', on: on === 'on' })));
};
