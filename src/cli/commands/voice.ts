import { parseArgs } from 'node:util';
import { voiceCommandSchema } from '../../protocol';
import { build, type Handler } from '../args';
import { fail } from '../client';
import { show } from '../output';

/** The persistent voice chain: a named base preset, or explicitly bypassed. */

export interface VoiceArguments {
  preset: string | null;
}

/** Parse the two intentionally exclusive ways to choose the voice chain. */
export function parseVoiceArgs(args: string[]): VoiceArguments {
  const { values, positionals } = parseArgs({
    args,
    options: { bypass: { type: 'boolean' } },
    allowPositionals: true,
  });

  if (values.bypass && positionals.length > 0)
    fail(`voice takes either a preset or --bypass: ${positionals.join(' ')}`);
  if (positionals.length > 1) fail(`voice takes one preset: ${positionals.slice(1).join(' ')}`);
  if (!values.bypass && positionals.length === 0) fail('voice needs a preset or --bypass');

  return { preset: values.bypass ? null : positionals[0] };
}

export const voice: Handler = async (client, args) => {
  const { preset } = parseVoiceArgs(args);
  show(await client.command(build(voiceCommandSchema, { cmd: 'voice', preset })));
};
