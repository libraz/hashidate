import { parseArgs } from 'node:util';
import { bgmCommandSchema } from '../../protocol';
import { build, type Handler, toNumber } from '../args';
import { fail } from '../client';
import { show } from '../output';

/**
 * Background music. One verb with a subcommand of its own, because the
 * transport is a small language rather than a flag.
 */

/**
 * BGM transport and mix convenience commands.
 *
 * `bgm play` also accepts `--volume`, `--loop`, `--fade-in` and `--fade-out`
 * so a selected track can be started in one command. DSP flags stay on the
 * MCP/panel surfaces: tone, compression, width and reverb are mix decisions
 * that need to be judged against the rendered broadcast, not guessed from a
 * terminal.
 */
export const bgm: Handler = async (client, args) => {
  const action = args[0];
  if (action === undefined)
    fail(
      'bgm list|play <filename>|pause|resume|stop|volume <0..1>|loop on|off|fade <inSeconds> <outSeconds>',
    );

  if (action === 'list') {
    const extra = args.slice(1);
    if (extra.length > 0) fail(`bgm list takes no arguments: ${extra.join(' ')}`);
    const tracks = await client.bgmTracks();
    if (tracks.length === 0) {
      console.log('no BGM tracks (put an .mp3 or .flac file in show/bgm/)');
      return;
    }
    for (const track of tracks) {
      console.log(`  ${track.id.padEnd(32)} ${track.mime.padEnd(12)} ${track.bytes} bytes`);
    }
    return;
  }

  if (action === 'play') {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      options: {
        volume: { type: 'string' },
        loop: { type: 'string' },
        'fade-in': { type: 'string' },
        'fade-out': { type: 'string' },
      },
      allowPositionals: true,
    });
    const track = positionals[0];
    if (track === undefined || track === '')
      fail('bgm play needs the exact filename from bgm list');
    if (positionals.length > 1)
      fail(`bgm play takes one filename: ${positionals.slice(1).join(' ')}`);
    const volume = values.volume === undefined ? undefined : bgmVolume(values.volume);
    const loop = values.loop === undefined ? undefined : bgmLoop(values.loop);
    const fadeIn =
      values['fade-in'] === undefined
        ? undefined
        : bgmFadeSeconds(values['fade-in'], 'bgm --fade-in');
    const fadeOut =
      values['fade-out'] === undefined
        ? undefined
        : bgmFadeSeconds(values['fade-out'], 'bgm --fade-out');
    const fade =
      fadeIn === undefined && fadeOut === undefined
        ? undefined
        : {
            ...(fadeIn === undefined ? {} : { inSeconds: fadeIn }),
            ...(fadeOut === undefined ? {} : { outSeconds: fadeOut }),
          };
    show(
      await client.command(
        build(bgmCommandSchema, {
          cmd: 'bgm',
          action: 'play',
          track,
          ...(volume === undefined ? {} : { volume }),
          ...(loop === undefined ? {} : { loop }),
          ...(fade === undefined ? {} : { fade }),
        }),
      ),
    );
    return;
  }

  if (action === 'pause' || action === 'resume' || action === 'stop') {
    if (args.length !== 1) fail(`bgm ${action} takes no arguments`);
    show(
      await client.command(
        build(bgmCommandSchema, {
          cmd: 'bgm',
          action: action === 'resume' ? 'play' : action,
        }),
      ),
    );
    return;
  }

  if (action === 'volume') {
    if (args.length !== 2) fail('bgm volume needs a value from 0..1');
    const volume = bgmVolume(args[1]);
    show(await client.command(build(bgmCommandSchema, { cmd: 'bgm', volume })));
    return;
  }

  if (action === 'loop') {
    if (args.length !== 2) fail('bgm loop needs on or off');
    const loop = bgmLoop(args[1]);
    show(await client.command(build(bgmCommandSchema, { cmd: 'bgm', loop })));
    return;
  }

  if (action === 'fade') {
    if (args.length !== 3) fail('bgm fade needs fade-in and fade-out seconds, each from 0..10');
    const inSeconds = bgmFadeSeconds(args[1], 'bgm fade-in');
    const outSeconds = bgmFadeSeconds(args[2], 'bgm fade-out');
    show(
      await client.command(
        build(bgmCommandSchema, {
          cmd: 'bgm',
          fade: { inSeconds, outSeconds },
        }),
      ),
    );
    return;
  }

  fail(
    `bgm list|play <filename>|pause|resume|stop|volume <0..1>|loop on|off|fade <inSeconds> <outSeconds>: ${action}`,
  );
};

export function bgmVolume(raw: string | undefined): number {
  const volume = toNumber(raw, 0, 'bgm volume');
  if (volume < 0 || volume > 1) fail(`bgm volume takes 0..1: ${raw}`);
  return volume;
}

export function bgmLoop(raw: string | undefined): boolean {
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  fail(`bgm loop takes on or off: ${raw}`);
}

export function bgmFadeSeconds(raw: string | undefined, label: string): number {
  const seconds = toNumber(raw, 0, label);
  if (seconds < 0 || seconds > 10) fail(`${label} takes 0..10 seconds: ${raw}`);
  return seconds;
}
