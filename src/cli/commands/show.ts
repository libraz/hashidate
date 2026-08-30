import { parseArgs } from 'node:util';
import { loadScript, outline, ScriptError } from '../../script';
import { runScript } from '../../script/run';
import type { Handler } from '../args';
import { fail } from '../client';
import { localized, show } from '../output';

/**
 * What is on disk in `show/`: the scripts a segment is run from, and the
 * motions a renderer can load.
 */

/**
 * Run a script: the setup once, then its lines onto the queue.
 *
 * The lines go on the server's queue rather than out as `say` commands, and
 * that is the whole reason this is worth having over a shell script. The queue
 * survives a viewer reload, is editable from the panel while it plays, and is
 * deep enough for the renderer to prepare the next line's audio during the
 * current one — sending a script a line at a time costs about a second of
 * silence between every pair of them.
 *
 * `--check` reads and validates without a server, which is what an author wants
 * between edits. It is also the only subcommand here that works with nothing
 * running.
 *
 * `--hold` loads the run without starting it, so the shot can be framed against
 * a queue that is already being synthesised. Off by default here, and on by
 * default in the panel's recording tab: this is the live path, and a `play`
 * that stopped playing would be a different command.
 */
export const play: Handler = async (client, args) => {
  const { positionals, values } = parseArgs({
    args,
    options: {
      check: { type: 'boolean' },
      replace: { type: 'boolean' },
      hold: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const name = positionals[0];
  if (name === undefined) fail('play needs a script: a name in show/scripts/, or a path to one');

  const loaded = await loadScript(name).catch((error: unknown) =>
    fail(error instanceof ScriptError ? error.message : String(error)),
  );
  const { id, path, script } = loaded;

  if (values.check) {
    console.log(`${script.title ?? id}  —  ${path}`);
    if (script.note) console.log(script.note);
    if (script.setup?.length) console.log(`setup   ${script.setup.map((c) => c.cmd).join(', ')}`);
    console.log(`lines   ${script.lines.length}`);
    for (const line of outline(script)) console.log(line);
    return;
  }

  const result = await runScript(client, loaded, {
    replace: values.replace,
    hold: values.hold,
  });
  if (result.setup !== undefined) {
    show(result.setup);
    // The two halves have different fates when no renderer is attached: the
    // lines wait on the server's queue and play when one arrives, the setup was
    // a live command and is simply gone. Said out loud, because the difference
    // is invisible in a run that otherwise looks like it worked.
    if (
      typeof result.setup === 'object' &&
      result.setup !== null &&
      (result.setup as { ok?: unknown }).ok === false
    ) {
      console.error('setup was not delivered: no viewer is connected');
      console.error(
        'the lines still queue, but they will play against whatever state a renderer comes up in',
      );
    }
  }
  // Stamped with the script's own name. A queue holding a scripted segment, a
  // comment somebody answered and a line typed by hand is only legible if each
  // row says which it is.
  console.log(
    `${script.lines.length} queued from ${id}: ${result.queue.queue.length} pending, ${result.queue.viewers} viewer(s)`,
  );
  // Said out loud for the same reason the setup failure above is: a held queue
  // and a queue nothing is attached to look identical from a prompt.
  if (values.hold) console.log('held — `yarn ctl resume` starts it');
};

/**
 * The motions the server can see. Not avatar data and not in the vocabulary;
 * see `Motions` — this is a directory, and only the process with a filesystem
 * can answer what is in it.
 */
export const motions: Handler = async (client) => {
  const { motions: found, errors } = await client.motions();
  if (found.length === 0 && errors.length === 0) {
    console.log('no motions (put a YAML file in show/motions/)');
    return;
  }
  for (const item of found) {
    const held = item.sustain ? ' *' : '';
    const runs = item.loop ? ' loop' : '';
    console.log(
      `  ${item.id.padEnd(16)} ${localized(item.label).padEnd(16)} [${item.group}] ${item.frames.length}f${runs}${held}`,
    );
  }
  // Beside the ones that worked rather than instead of them: a file that will
  // not parse has to be visible, or it reads as a filename typed wrong.
  for (const { id, error } of errors) console.log(`  ${id.padEnd(16)} ${error}`);
};
