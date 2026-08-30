import { type Handler, takeBase } from './args';
import { ControlClient, fail } from './client';
import { bgm } from './commands/bgm';
import { gesture, hop, idle, look, perform, point } from './commands/body';
import { emotion, expression, overlay } from './commands/face';
import { state, vocab, watch } from './commands/inspect';
import { avatar, debug, tune, wear } from './commands/renderer';
import { motions, play } from './commands/show';
import { backdrop, camera, deck, decks, place, room, slide } from './commands/staging';
import { bare, hold, resume, say } from './commands/turn';
import { voice } from './commands/voice';

/**
 * Command-line client for the hashidate control API.
 *
 * For driving the avatar by hand and for checking the API without writing a
 * client. An orchestrator would post the same JSON directly.
 *
 *     yarn ctl vocab
 *     yarn ctl state
 *     yarn ctl idle on
 *     yarn ctl perform happy
 *     yarn ctl say "こんばんは" --perform hello --wait
 *     yarn ctl say "こんばんは" --emotion joy=0.8 --gesture wave --wait
 *     yarn ctl gesture peace --side L
 *     yarn ctl say "[hello]こんばんは。[explain]今日はこの話をします。"
 *     yarn ctl say "8月27日だよ" --reading "はちがつにじゅうしちにちだよ"
 *     yarn ctl say "これが、ホール。" --camera full --room hall
 *     yarn ctl expression F_NIKONIKO
 *     yarn ctl overlay option_guruguru
 *     yarn ctl hop bounce
 *     yarn ctl point 40 25 --extent 0.9
 *     yarn ctl reset
 *     yarn ctl interrupt
 *     yarn ctl camera bust
 *     yarn ctl backdrop dusk
 *     yarn ctl wear --preset stream
 *     yarn ctl voice stream
 *     yarn ctl voice --bypass
 *     yarn ctl bgm play opening.mp3 --fade-in 1.5 --fade-out 0.75
 *     yarn ctl bgm fade 1.5 0.75
 *     yarn ctl play demo
 *     yarn ctl watch
 *
 * Every command is built through the protocol schemas before it goes on the
 * wire, so a line this client accepts is a line the viewer understands: the CLI
 * drifting from the renderer is the failure this design is meant to remove.
 *
 * This file is only the table and the dispatch. The subcommands themselves are
 * in `commands/`, grouped the way the wire vocabulary is — a turn, the face,
 * the body, the staging, the music, the renderer, what is on disk, and what can
 * only be read. `args.ts` holds the argv shims they share and `output.ts` the
 * two ways this client prints.
 */

const HANDLERS: Record<string, Handler> = {
  say,
  emotion,
  expression,
  overlay,
  perform,
  gesture,
  hop,
  point,
  camera,
  room,
  backdrop,
  deck,
  slide,
  place,
  decks,
  bgm,
  play,
  motions,
  wear,
  voice,
  avatar,
  tune,
  idle,
  look,
  debug,
  hold,
  resume,
  reset: bare('reset'),
  interrupt: bare('interrupt'),
  clear: bare('clear'),
  vocab,
  state,
  watch,
};

function usage(): never {
  fail(
    [
      'usage: yarn ctl [--base URL] <command> [args...]',
      `commands: ${Object.keys(HANDLERS).join(', ')}`,
      '',
      '  yarn ctl perform happy',
      '  yarn ctl say "こんばんは" --perform hello --wait',
      '  yarn ctl say "[hello]こんばんは。[explain]今日はこの話をします。"',
      '  yarn ctl say "コメント3件ありがとう" --reading "コメントさんけんありがとう"',
      '  yarn ctl gesture peace --side L',
      '  yarn ctl point 40 25 --extent 0.9',
      '  yarn ctl idle on',
      '  yarn ctl debug        # overlay the measurements on every viewer (off clears them)',
      '  yarn ctl avatar manuka',
      '  yarn ctl tune sway.stiffness=2 idle.breathDepth=1.2',
      '  yarn ctl voice stream     # choose a voice preset',
      '  yarn ctl voice --bypass   # play the synthesiser output unprocessed',
      '  yarn ctl deck intro --page 3',
      '  yarn ctl bgm list && yarn ctl bgm play opening.mp3 --volume 0.2 --fade-in 1 --fade-out 1',
      '  yarn ctl bgm fade 1 1',
      '  yarn ctl slide next',
      '  yarn ctl play demo --check   # read show/scripts/demo.yaml without a server',
      '  yarn ctl play demo --replace # drop what is pending and run it',
      '  yarn ctl place avatar --anchor bottom-right --width 0.32 --height 0.6 --margin 0.02',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const { base, rest } = takeBase(process.argv.slice(2));
  const action = rest[0];
  if (action === undefined || !Object.hasOwn(HANDLERS, action)) usage();
  await HANDLERS[action](new ControlClient(base), rest.slice(1));
}

// The message alone, not the class in front of it: a transport failure here is
// something the operator reads and acts on ("start the server"), and prefixing
// it with `Error:` says nothing they did not already know from it being printed.
main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
