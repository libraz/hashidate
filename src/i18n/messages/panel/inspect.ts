/**
 * The inspect tab — what is actually true right now, as the renderer last
 * reported it.
 */

export const inspectEn = {
  'panel.inspect.link': 'Connection',
  'panel.inspect.link.none': 'Not connected',
  'panel.inspect.link.note1':
    'How many renderers are attached. The preview in this panel counts as one of them.',
  'panel.inspect.link.note2':
    '“Not connected” means either nobody is there or the reports stopped a few seconds ago. Closing the viewer tab looks like this.',
  'panel.inspect.viewers': 'Viewers',
  'panel.inspect.avatar': 'Avatar',
  'panel.inspect.loadable': 'Can be loaded',
  'panel.inspect.queue': 'Queue',
  'panel.inspect.seq': 'Event sequence',
  'panel.inspect.strain': 'Joint strain',
  'panel.inspect.strain.note1':
    'How hard the arm worked on the last point. 0 is a comfortable range; past 1 it is reaching for something out of reach.',
  'panel.inspect.strain.note2':
    'A command past the joint limits does not fail — the arm stops where it can reach. This number is the only thing that says whether the pose asked for was the pose taken.',
  'panel.inspect.strain.note3':
    'The per-joint breakdown is in the renderer’s own console — it is re-measured many times a second and does not belong on this wire.',
  'panel.inspect.rightArm': 'Right arm',
  'panel.inspect.leftArm': 'Left arm',
  'panel.inspect.voice': 'Voice',
  'panel.inspect.voice.bypass': 'Straight through',
  'panel.inspect.voice.note1':
    'Measured over the last line. Loudness is against the broadcast target; true peak distorts above 0.',
  'panel.inspect.voice.note2':
    '“Blocked” means the browser has not let the audio device start yet, and nothing here can fix it — the viewer window has to be clicked once.',
  'panel.inspect.chain': 'Chain',
  'panel.inspect.room': 'Room',
  'panel.inspect.dry': 'Dry',
  'panel.inspect.loudness': 'Loudness',
  'panel.inspect.truePeak': 'True peak',
  'panel.inspect.blocked': 'Blocked',
  'panel.inspect.yes': 'Yes',
  'panel.inspect.no': 'No',
  'panel.inspect.voice.empty': 'No viewer with a voice has reported yet.',
  'panel.inspect.events': 'Events',
  'panel.inspect.events.note':
    'The turn boundaries the renderer reports. This is what an orchestrator waits on before sending the next line, and it is what the control API hands out.',
  'panel.inspect.events.empty': 'Nothing has happened yet.',
  'panel.inspect.vocabulary': 'Vocabulary',
  'panel.inspect.vocabulary.note1':
    'Everything this avatar can be asked for. Discovered rather than declared: the expressions come from the model’s own shape keys and the wardrobe from its meshes, so swapping the avatar changes the list.',
  'panel.inspect.vocabulary.note2': 'This is the object to paste into an LLM’s system prompt.',
} as const;

export const inspectJa: Record<keyof typeof inspectEn, string> = {
  'panel.inspect.link': '接続',
  'panel.inspect.link.none': '未接続',
  'panel.inspect.link.note1':
    'レンダラーが何面つながっているか。パネルのプレビューも一面として数える。',
  'panel.inspect.link.note2':
    '「未接続」は誰もいないか、報告が途絶えて数秒たった状態。ビューアのタブを閉じるとこうなる。',
  'panel.inspect.viewers': 'ビューア',
  'panel.inspect.avatar': 'アバター',
  'panel.inspect.loadable': '読み込める',
  'panel.inspect.queue': '待ち行列',
  'panel.inspect.seq': 'イベント通番',
  'panel.inspect.strain': '関節の負担',
  'panel.inspect.strain.note1':
    '直近の指さしで腕がどれだけ無理をしたか。0 は楽な範囲、1 を超えると届かないところへ手を伸ばしている。',
  'panel.inspect.strain.note2':
    '可動域を超える指示は失敗せず、届く範囲で止まる。この数字だけが、要求どおりの姿勢になったかどうかを教える。',
  'panel.inspect.strain.note3':
    '関節ごとの内訳はレンダラー側のコンソールにある — 毎秒何度も測り直すもので、この線に載せるものではない。',
  'panel.inspect.rightArm': '右腕',
  'panel.inspect.leftArm': '左腕',
  'panel.inspect.voice': '音声',
  'panel.inspect.voice.bypass': '素通し',
  'panel.inspect.voice.note1':
    '直近の一行の測定値。ラウドネスは配信の基準に対して、真のピークは 0 を超えると歪む。',
  'panel.inspect.voice.note2':
    '「ブロック」はブラウザがまだ音声デバイスを許していない状態で、ここからは直せない — ビューアの画面を一度クリックする必要がある。',
  'panel.inspect.chain': 'チェイン',
  'panel.inspect.room': '部屋',
  'panel.inspect.dry': 'ドライ',
  'panel.inspect.loudness': 'ラウドネス',
  'panel.inspect.truePeak': '真のピーク',
  'panel.inspect.blocked': 'ブロック',
  'panel.inspect.yes': 'あり',
  'panel.inspect.no': 'なし',
  'panel.inspect.voice.empty': '声を持つビューアがまだ報告していない。',
  'panel.inspect.events': 'イベント',
  'panel.inspect.events.note':
    'レンダラーが返すターン境界。オーケストレータが次の行を送るのを待つのもこれで、外部の制御 API が受け取るのと同じもの。',
  'panel.inspect.events.empty': 'まだ何も起きていない。',
  'panel.inspect.vocabulary': '語彙',
  'panel.inspect.vocabulary.note1':
    'このアバターに何を頼めるかの一覧。宣言ではなく発見されたもので、表情はモデル自身のシェイプ群から、衣装はメッシュから引いている。差し替えると中身が変わる。',
  'panel.inspect.vocabulary.note2': 'LLM のシステムプロンプトに貼るのはこのオブジェクト。',
};
