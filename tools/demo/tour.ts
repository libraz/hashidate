/**
 * The narrated tour: the avatar explaining what is driving it.
 *
 * `src/viewer/demo.ts` is the other kind of demo and answers a different
 * question. It walks the vocabulary — every camera, every performance, every
 * room — to establish that a freshly exported rig actually works, and it is
 * built from the vocabulary itself so it can never go stale. What it is not is
 * watchable: it is forty poses in a row with no reason for any of them.
 *
 * This is a written script, and being written is the point. It is what the
 * project looks like when something is actually being said — lines with cues in
 * them, a camera that moves because the subject changed, a room that changes
 * when the subject is rooms.
 *
 * ## It drives the control API, not the session
 *
 * Every beat below goes out as JSON over `/api/command`, which is the same path
 * an orchestrator would use. That makes the tour a test of the wire as well as a
 * presentation: a command that a language model could not have expressed is one
 * this script cannot send either.
 *
 * Each beat is posted with `?wait=1`, so the next one is sent when the line has
 * finished rather than after a guessed number of seconds. A tour on a timer
 * would drift the moment a line synthesised slowly, and the whole thing is meant
 * to be watched.
 *
 * ## Staging travels with the line it belongs to
 *
 * A beat is one batch: the camera, backdrop and room changes first, then the
 * line. They arrive together and are applied in order, so the shot is already
 * framed when the character starts speaking. Splitting them into two requests
 * would put a visible frame or two of the old framing under the new line.
 *
 * usage: yarn tsx tools/demo/tour.ts [--base http://127.0.0.1:8765]
 */

const DEFAULT_BASE = 'http://127.0.0.1:8765';

/** One command, loosely typed: the schemas live in `src/protocol` and validate server-side. */
type Command = Record<string, unknown>;

interface Beat {
  /** Applied before the line, in order. Camera, backdrop, room, pointing. */
  stage?: Command[];
  /** The line. Cue markup in `text` is what moves the character mid-sentence. */
  say?: Command;
  /** Seconds to sit still afterwards, for a beat with nothing to wait on. */
  hold?: number;
}

const say = (text: string, extra: Command = {}): Command => ({ cmd: 'say', text, ...extra });

/**
 * The script.
 *
 * Ordered the way an explanation is rather than the way the code is: what the
 * thing is, then the parts, then the two parts worth dwelling on — the voice and
 * the cues — and the numbers last, because that one is about how the project was
 * made rather than what it does.
 */
const TOUR: Beat[] = [
  // --- who and what ---------------------------------------------------------
  {
    stage: [
      { cmd: 'camera', frame: 'bust' },
      { cmd: 'backdrop', id: 'dusk' },
      { cmd: 'room', id: 'room' },
      { cmd: 'idle', on: true },
    ],
    say: say(
      '[hello]こんばんは。旅枕ヨカです。[explain]きょうは、わたし自身を動かしている仕組みを、ひととおり説明します。',
    ),
  },
  {
    say: say(
      '[present]これは、エーアイブイチューバーのためのアバターランタイムです。[explain]配信で動かすことだけを考えて作られていて、それ以外のことはあまりできません。',
    ),
  },

  // --- the shape of it ------------------------------------------------------
  {
    stage: [{ cmd: 'camera', frame: 'upper' }],
    say: say(
      '[explain]中身は、大きく五つに分かれています。エンジン、ビューア、制御サーバ、命令を出すクライアント、それに音声のサイドカーです。',
    ),
  },
  {
    say: say(
      '[ponder]エンジンは、顔と体をどう動かすかだけを知っています。[explain]描画もしないし、通信もしません。だから、画面がなくても試せます。',
    ),
  },
  {
    say: say(
      '[notice]命令の語彙は、一か所にしか書かれていません。[explain]ビューアも、制御サーバも、コマンドラインも、同じ定義を読んでいます。増やすときは、まずそこに書きます。',
      { expression: 'F_FUMUFUMU' },
    ),
  },

  // --- the face -------------------------------------------------------------
  {
    stage: [{ cmd: 'camera', frame: 'face' }],
    say: say('[explain]まず、顔の話をします。顔は、三つの層が重なってできています。'),
  },
  {
    say: say(
      '[wonder]一つめは、感情のベクトル。よろこび、おどろき、思案。[curious]どれか一つを選ぶのではなくて、混ぜられます。だから、微妙な顔ができます。',
    ),
  },
  {
    say: say(
      '[startled]二つめは、描かれた表情。[giggle]これは絵として用意されているもので、感情の上に貼りつきます。',
      { expression: 'F_KIRAKIRA' },
    ),
  },
  {
    say: say(
      '[explain]三つめが、口です。台詞の読みから母音の並びを作って、それで動かしています。いま動いているのも、それです。',
    ),
  },

  // --- the body -------------------------------------------------------------
  {
    stage: [{ cmd: 'camera', frame: 'upper' }],
    say: say(
      '[explain]体のほうは、演技という単位で呼びます。顔と動きが必ずセットになっていて、無表情のまま手だけ振る、ということが起きないようにしてあります。',
    ),
  },
  {
    say: say('[happy]たとえば、これがうれしい。[applause]これが拍手。[love]これが、すき。'),
  },
  {
    say: say('[doublePeace]決めポーズもあります。[bang]ばーん。[shy]……ちょっと恥ずかしいですね。'),
  },
  {
    stage: [
      { cmd: 'camera', frame: 'full' },
      { cmd: 'point', side: 'R', azimuth: 55, elevation: 20, extent: 0.9 },
    ],
    say: say(
      '指差しだけは、決められた形ではなくて、角度で指定します。画面のどこかを指すのに、名前のついた姿勢を選ばせるのは無理があるからです。',
    ),
  },
  {
    stage: [{ cmd: 'point', side: 'R', azimuth: -50, elevation: -10, extent: 0.85 }],
    say: say(
      'こう指定すると、こう。腕が届かないところを指されたら、届く範囲で伸ばして、どれだけ無理をしたかを返します。',
    ),
  },
  { stage: [{ cmd: 'gesture' }], hold: 0.8 },

  // --- staging --------------------------------------------------------------
  {
    stage: [{ cmd: 'camera', frame: 'bust' }],
    say: say(
      '[explain]カメラの寄りは四段階です。顔、バスト、上半身、全身。いまはバストに戻したところです。',
    ),
  },
  {
    stage: [{ cmd: 'backdrop', id: 'night' }],
    say: say('[present]背景も切り替えられます。これが深夜。'),
  },
  {
    stage: [{ cmd: 'backdrop', id: 'rain' }],
    say: say(
      '[wonder]これが雨。[explain]背景は、声の響きとは別に選びます。部屋を移ったわけではないので、音は変わりません。',
    ),
  },

  // --- the voice ------------------------------------------------------------
  {
    stage: [{ cmd: 'backdrop', id: 'morning' }],
    say: say(
      '[explain]声は、別のプロセスが作っています。参照する録音から声の特徴を取り出しておいて、そこに文章を通しています。',
    ),
  },
  {
    say: say(
      '[ponder]その録音には、もともと部屋の音が乗っていました。エアコンとか、機材の音です。[explain]特徴に変える前にそれを取っているので、生成される声は最初から静かです。',
    ),
  },
  {
    stage: [{ cmd: 'room', id: 'booth' }],
    say: say('[present]そのかわり、響きはあとから足します。これが、ブース。'),
  },
  {
    stage: [{ cmd: 'room', id: 'hall' }],
    say: say('[notice]これが、ホール。同じ声です。部屋だけが違います。'),
  },
  {
    stage: [{ cmd: 'room', id: 'room' }],
    say: say(
      '[explain]部屋の広さと、壁がどれだけ音を吸うかから、その部屋のインパルス応答を作って、声に畳み込んでいます。残響の長さを直接指定しているわけではありません。',
    ),
  },
  {
    say: say(
      '[agree]それから、作った音声には、合成であることがわかる印を必ず入れています。[explain]外す設定はありません。声のもとになった人がいるので、そこは選べないようにしてあります。',
      { expression: 'F_FUMUFUMU' },
    ),
  },

  // --- the cues -------------------------------------------------------------
  {
    say: say(
      '[curious]ところで、いま何度か、台詞の途中で表情が変わったのに気づきましたか。[notice]あれは、台詞の中に合図を書き込んでいます。',
    ),
  },
  {
    say: say(
      '[explain]文を切らずに、言い終わるのを待たずに、途中で切り替わります。[happy]文を二つに割ると、まん中に息継ぎが入ってしまうので。',
    ),
  },

  // --- how it was made ------------------------------------------------------
  {
    stage: [{ cmd: 'camera', frame: 'upper' }],
    say: say(
      '[ponder]最後にひとつ。エンジンの中の数字は、ほとんど目で見て決めたものです。計算で出したものではありません。',
    ),
  },
  {
    say: say(
      '[explain]腕が二つの姿勢の間で飛ぶとか、髪が頭より先に動くとか、顔が面に見えるとか。そういう失敗を一つずつ潰した結果が、そのまま残っています。',
    ),
  },
  {
    say: say(
      '[agree]なので、数字のとなりには、たいてい、何を防ぐためにその値なのかが書いてあります。[explain]コードより、そっちのほうが大事です。',
    ),
  },

  // --- out ------------------------------------------------------------------
  {
    stage: [
      { cmd: 'camera', frame: 'bust' },
      { cmd: 'backdrop', id: 'dusk' },
    ],
    say: say('[thanks]説明は、以上です。[hello]見てくれて、ありがとう。'),
  },
  { stage: [{ cmd: 'reset' }, { cmd: 'perform' }] },
];

async function post(base: string, body: unknown, wait: boolean): Promise<void> {
  const url = `${base}/api/command${wait ? '?wait=1' : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await res.json()) as { error?: string; viewers?: number; completed?: boolean };
  if (!res.ok) throw new Error(`${res.status} ${payload.error ?? ''} — ビューアは開いていますか`);
  // A line that timed out rather than ending is worth saying out loud: the tour
  // carries on, but the reason the next beat looks early is this one.
  if (wait && payload.completed === false) console.warn('  (この行は待ちきれませんでした)');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf('--base');
  const base = flag >= 0 ? argv[flag + 1] : DEFAULT_BASE;

  console.log(`${TOUR.length} ビート、${base} へ送ります`);
  for (const [index, beat] of TOUR.entries()) {
    const label =
      typeof beat.say?.text === 'string'
        ? beat.say.text.replace(/\[[^\]]*\]/g, '')
        : '（配置のみ）';
    console.log(`\n[${index + 1}/${TOUR.length}] ${label.slice(0, 46)}`);

    const commands = [...(beat.stage ?? []), ...(beat.say ? [beat.say] : [])];
    if (commands.length) await post(base, { batch: commands }, beat.say !== undefined);
    if (beat.hold) await new Promise((done) => setTimeout(done, beat.hold * 1000));
  }
  console.log('\nおわり');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
