/**
 * The perform tab — the live surface. Faces, movements, and the two continuous
 * aims.
 */

export const performEn = {
  'panel.perform.presets': 'Presets',
  'panel.perform.presets.note1':
    'A face and a movement kept as one. Emotion and Gestures below are its parts, for combinations that have no name.',
  'panel.perform.presets.note2':
    'The mood outlives a performance. Clear here resets the mood, expression and overlays to neutral, and releases anything held — a stance or lowered eyes.',
  'panel.perform.faceOnly': 'face only',
  'panel.perform.release': 'Clear',
  'panel.perform.releaseAll': 'Clear all',
  'panel.perform.emotion': 'Emotion',
  'panel.perform.emotion.note1':
    'These are continuous, so mixing several gives a face between them. A chip sets one on its own; Blend opens the proportions.',
  'panel.perform.emotion.note2': 'It outlives the line — a mood does not end when a sentence does.',
  'panel.perform.mix': 'Blend',
  'panel.perform.expressions': 'Drawn expressions',
  'panel.perform.expressions.note1':
    'Finished faces that ship with the model. They hold eye and mouth shapes that blending cannot make, so they are kept apart from the emotions.',
  'panel.perform.expressions.note2':
    'A filled chip is the operator’s own choice; an outlined one was chosen by the emotion channel or the autopilot, and cannot be cleared from here.',
  'panel.perform.overlays': 'Overlays',
  'panel.perform.overlays.note':
    'These lie over the face rather than replacing it, so several can be up at once.',
  'panel.perform.gestures': 'Gestures',
  'panel.perform.gestures.note1':
    'The body’s own vocabulary, with no face attached. Speed, amplitude and side vary from play to play, and one crossfades into the next.',
  'panel.perform.gestures.note2':
    'A pose is held until it is cleared; everything else ends on its own. A hop runs apart from the arms, so it can play at the same time.',
  'panel.perform.hops': 'Hops',
  'panel.perform.stop': 'Stop',
  'panel.perform.pointing': 'Pointing',
  'panel.perform.strain': 'Strain {value}',
  'panel.perform.pointing.note':
    'A command past the joint limits does not fail — the arm reaches as far as it can and stops. How hard it worked shows up as Strain.',
  'panel.perform.hand': 'Hand',
  'panel.perform.hand.aria': 'Which hand',
  'panel.perform.side.right': 'Right hand',
  'panel.perform.side.left': 'Left hand',
  'panel.perform.finger': 'Finger',
  'panel.perform.finger.aria': 'Which finger',
  'panel.perform.finger.thumb': 'Thumb',
  'panel.perform.finger.index': 'Index',
  'panel.perform.finger.middle': 'Middle',
  'panel.perform.finger.ring': 'Ring',
  'panel.perform.finger.little': 'Little',
  'panel.perform.azimuth': 'Azimuth',
  'panel.perform.elevation': 'Elevation',
  'panel.perform.extent': 'Reach',
  'panel.perform.point': 'Point',
  'panel.perform.lookAt': 'Eye contact',
  'panel.perform.lookAt.note':
    'How much the gaze follows the camera. 0 keeps facing front, 1 looks into the lens all the time.',
} as const;

export const performJa: Record<keyof typeof performEn, string> = {
  'panel.perform.presets': 'プリセット',
  'panel.perform.presets.note1':
    '表情とモーションをひと組にしたもの。下の「感情」「ジェスチャ」はその部品で、名前のない組み合わせを作るときに使う。',
  'panel.perform.presets.note2':
    '演技の気分は残る。この画面の「解除」は気分・表情・重ねる効果を平常に戻し、姿勢や伏し目のように保持されたものも解放する。',
  'panel.perform.faceOnly': '表情のみ',
  'panel.perform.release': '解除',
  'panel.perform.releaseAll': '全解除',
  'panel.perform.emotion': '感情',
  'panel.perform.emotion.note1':
    '連続値なので複数を混ぜると中間表情になる。チップは単独指定、「配合」を開くと比率を作れる。',
  'panel.perform.emotion.note2': '台詞が終わっても残る — 気分は文の長さでは終わらない。',
  'panel.perform.mix': '配合',
  'panel.perform.expressions': '描き起こし表情',
  'panel.perform.expressions.note1':
    'モデル同梱の完成形の表情。合成では作れない目や口の形が入るため、感情とは別系統で持つ。',
  'panel.perform.expressions.note2':
    '塗りつぶしが操作者の選択、枠線だけのものは感情か自動モードが選んだもの。後者は解除できない。',
  'panel.perform.overlays': '重ねる効果',
  'panel.perform.overlays.note': '表情を置き換えず上に重なるので、複数を同時に出せる。',
  'panel.perform.gestures': 'ジェスチャ',
  'panel.perform.gestures.note1':
    '表情を伴わない体だけの語彙。再生ごとに速さ・振幅・左右が変わり、切り替えはクロスフェードで送る。',
  'panel.perform.gestures.note2':
    'ポーズ群は解除するまで保持する。それ以外は自分で終わる。跳躍は腕とは別に走るので同時に出せる。',
  'panel.perform.hops': '跳躍',
  'panel.perform.stop': '停止',
  'panel.perform.pointing': '指さし',
  'panel.perform.strain': '負担 {value}',
  'panel.perform.pointing.note':
    '可動域を超える指示は失敗せず、届く範囲まで伸ばして止まる。どれだけ無理をしたかは「負担」に出る。',
  'panel.perform.hand': '手',
  'panel.perform.hand.aria': 'どちらの手',
  'panel.perform.side.right': '右手',
  'panel.perform.side.left': '左手',
  'panel.perform.finger': '指',
  'panel.perform.finger.aria': 'どの指',
  'panel.perform.finger.thumb': '親',
  'panel.perform.finger.index': '人差',
  'panel.perform.finger.middle': '中',
  'panel.perform.finger.ring': '薬',
  'panel.perform.finger.little': '小',
  'panel.perform.azimuth': '方位  azimuth',
  'panel.perform.elevation': '仰角  elevation',
  'panel.perform.extent': '伸ばし  extent',
  'panel.perform.point': '指す',
  'panel.perform.lookAt': 'カメラ目線',
  'panel.perform.lookAt.note':
    '視線がカメラを追う度合い。0 は正面を向いたまま、1 は常にレンズを見る。',
};
