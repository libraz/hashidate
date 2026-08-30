/**
 * The voice tab: the chain the voice is put through, and what the last line
 * measured on the meters beside it.
 */

export const voiceEn = {
  'panel.voice.room': 'Room',
  'panel.voice.dry': 'Dry',
  'panel.voice.room.note1':
    'The synthesised voice carries no reverb at all. The recordings it was trained on had theirs taken out, which is right for the material and sounds like a voice in a vacuum if it goes out untouched.',
  'panel.voice.room.note2':
    'What is chosen here is a room, not a decay time. An impulse response is built from its dimensions and its wall absorption, and convolved with the take. It sits after the whole chain, so the mouth follows the voice rather than the reverb.',
  'panel.voice.changer': 'Voice changer',
  'panel.voice.bypass': 'Bypass',
  'panel.voice.changer.note1':
    'The knobs below ride on the preset as a delta. The panel holds no complete configuration: it sends the one field it moved, the renderer merges it onto the preset, and the values shown are that result read back.',
  'panel.voice.changer.note2':
    'Pitch and formant move independently. Pitch on its own sounds sped up; move the formant with it and it becomes a different person.',
  'panel.voice.changer.note3':
    'Bypass is no processing at all: the synthesised take plays as it is, and the knob deltas are dropped.',
  'panel.voice.bypassed': 'Playing unprocessed. Choose a preset to use the knobs.',
  'panel.voice.tone': 'Tone',
  'panel.voice.pitch': 'Pitch',
  'panel.voice.semitones': 'st',
  'panel.voice.pitchAmount': 'Pitch amount',
  'panel.voice.formant': 'Formant',
  'panel.voice.formantAmount': 'Formant amount',
  'panel.voice.thickness': 'Thickness',
  'panel.voice.brightness': 'Brightness',
  'panel.voice.nasal': 'Nasality',
  'panel.voice.eq': 'Equaliser',
  'panel.voice.highpass': 'Low cut',
  'panel.voice.eqBody': 'Body',
  'panel.voice.presence': 'Presence',
  'panel.voice.air': 'Air',
  'panel.voice.gate': 'Gate',
  'panel.voice.gate.note':
    'There is no room noise in a synthesised take, so this is for cutting breaths and the tail of a phrase. Raise the threshold too far and word endings go with it.',
  'panel.voice.threshold': 'Threshold',
  'panel.voice.release': 'Release',
  'panel.voice.range': 'Range',
  'panel.voice.compressor': 'Compressor',
  'panel.voice.compressor.note':
    'Holds the level steady from line to line. A viewer’s volume control stays where they put it, so 6 dB between two lines makes them reach for it.',
  'panel.voice.ratio': 'Ratio',
  'panel.voice.attack': 'Attack',
  'panel.voice.makeup': 'Make-up gain',
  'panel.voice.deesser': 'De-esser',
  'panel.voice.frequency': 'Frequency',
  'panel.voice.reverb': 'Chain reverb',
  'panel.voice.reverb.meta': 'not with the room above',
  'panel.voice.reverb.note':
    'This adds reverb to the voice itself and is not the room above. The room is built from a physical shape and sounds better, so this normally stays at 0. Raise both and it sounds like two rooms.',
  'panel.voice.reverbMix': 'Amount',
  'panel.voice.reverbTime': 'Length',
  'panel.voice.damping': 'Damping',
  'panel.voice.output': 'Output',
  'panel.voice.output.note':
    'The limiter is the last thing between the voice and the stream. The true-peak ceiling sits at −1 dBTP because a platform’s lossy re-encode lifts the peaks between samples; at 0 it clips there.',
  'panel.voice.outputGain': 'Output gain',
  'panel.voice.wet': 'Processed amount',
  'panel.voice.ceiling': 'Limiter ceiling',
  'panel.meters.loudness': 'Loudness',
  'panel.meters.target': 'Target {value} LUFS',
  'panel.meters.truePeak': 'True peak',
  'panel.meters.ceiling': 'Ceiling {value} dBTP',
} as const;

export const voiceJa: Record<keyof typeof voiceEn, string> = {
  'panel.voice.room': '部屋',
  'panel.voice.dry': 'ドライ',
  'panel.voice.room.note1':
    '合成された声には残響がまったく乗っていません。学習に使った録音から残響を取り除いてあるためで、素材としては正しく、そのまま流すと真空の中の声に聞こえます。',
  'panel.voice.room.note2':
    'ここで選ぶのは減衰時間ではなく部屋そのものです。寸法と壁の吸音率からインパルス応答を作り、畳み込みで鳴らします。チェーン全体より後段にあるので、口の動きは残響ではなく声そのものに追従します。',
  'panel.voice.changer': 'ボイスチェンジャー',
  'panel.voice.bypass': 'バイパス',
  'panel.voice.changer.note1':
    'プリセットを土台に、下のつまみが差分として乗ります。パネルは完全な設定を持たず、ずらした一項目だけを送り、レンダラー側でプリセットに重ねます。表示されている値はその合成結果の読み戻しです。',
  'panel.voice.changer.note2':
    'ピッチとフォルマントは独立に動きます。ピッチだけ上げると早回しに聞こえ、フォルマントを一緒に動かすと別人の声になります。',
  'panel.voice.changer.note3':
    '「バイパス」は加工なし。合成された音をそのまま再生し、つまみの差分も破棄します。',
  'panel.voice.bypassed': '加工なしで再生しています。つまみを使うにはプリセットを選んでください。',
  'panel.voice.tone': '声質',
  'panel.voice.pitch': 'ピッチ',
  'panel.voice.semitones': '半音',
  'panel.voice.pitchAmount': 'ピッチ適用量',
  'panel.voice.formant': 'フォルマント',
  'panel.voice.formantAmount': 'フォルマント適用量',
  'panel.voice.thickness': '太さ',
  'panel.voice.brightness': '明るさ',
  'panel.voice.nasal': '鼻にかかり',
  'panel.voice.eq': 'イコライザ',
  'panel.voice.highpass': 'ローカット',
  'panel.voice.eqBody': 'ボディ',
  'panel.voice.presence': 'プレゼンス',
  'panel.voice.air': 'エア',
  'panel.voice.gate': 'ゲート',
  'panel.voice.gate.note':
    '合成音には環境ノイズがないので、ここは息継ぎや語尾の余韻を切るためのものです。しきい値を上げすぎると語尾が欠けます。',
  'panel.voice.threshold': 'しきい値',
  'panel.voice.release': 'リリース',
  'panel.voice.range': '減衰量',
  'panel.voice.compressor': 'コンプレッサー',
  'panel.voice.compressor.note':
    '行ごとに音量が揺れるのを抑えます。配信では視聴者の音量つまみが固定なので、行間で 6 dB 動くと聞き手が操作を強いられます。',
  'panel.voice.ratio': 'レシオ',
  'panel.voice.attack': 'アタック',
  'panel.voice.makeup': 'メイクアップ',
  'panel.voice.deesser': 'ディエッサー',
  'panel.voice.frequency': '周波数',
  'panel.voice.reverb': 'チェーンの残響',
  'panel.voice.reverb.meta': '上の「部屋」と併用しない',
  'panel.voice.reverb.note':
    'これは声そのものに足す残響で、上の「部屋」とは別物です。部屋のほうが物理形状から作られていて質が良いので、通常はこちらを 0 のままにします。両方上げると部屋が二つあるように聞こえます。',
  'panel.voice.reverbMix': '量',
  'panel.voice.reverbTime': '長さ',
  'panel.voice.damping': '減衰',
  'panel.voice.output': '出力',
  'panel.voice.output.note':
    'リミッターは配信に出る最後の砦です。true peak の天井を −1 dBTP に置くのは、配信プラットフォーム側のロッシー変換でサンプル間ピークが持ち上がるためで、0 に置くとそこで割れます。',
  'panel.voice.outputGain': '出力ゲイン',
  'panel.voice.wet': '加工量',
  'panel.voice.ceiling': 'リミッター天井',
  'panel.meters.loudness': 'ラウドネス',
  'panel.meters.target': '目安 {value} LUFS',
  'panel.meters.truePeak': 'トゥルーピーク',
  'panel.meters.ceiling': '天井 {value} dBTP',
};
