/**
 * The tune tab — the set-once layer: breath, sway, hop, tail, shading.
 */

export const tuneEn = {
  'panel.tune.title': 'Tuning',
  'panel.tune.empty':
    'The renderer has not reported anything yet. Open a viewer and the values arrive.',
  'panel.tune.idle': 'Idle',
  'panel.tune.idle.note1':
    'Breathing and weight shift keep running through a gesture. A character whose breathing stops the moment a hand goes up reads as a doll.',
  'panel.tune.idle.note2':
    'Blinks are drawn toward gaze changes. The eyes are held to the range that keeps the whites out of sight, which leaves most of the turning to the head.',
  'panel.tune.breathDepth': 'Breath depth',
  'panel.tune.breathPeriod': 'Breath period',
  'panel.tune.idleAmount': 'Head micro-movement',
  'panel.tune.weightShift': 'Weight shift',
  'panel.tune.gazeAmount': 'Gaze drift',
  'panel.tune.eyeLimit': 'Eye range limit',
  'panel.tune.blink': 'Automatic blinking',
  'panel.tune.sway': 'Sway',
  'panel.tune.sway.note1':
    'Hair, clothing, ribbons — bones that are not driven and only trail their parent. The multipliers are against the values written into the model.',
  'panel.tune.sway.note2':
    'Solved on a fixed step, so how far things swing does not change with the frame rate.',
  'panel.tune.swayEnabled': 'Enable sway',
  'panel.tune.stiffness': 'Stiffness',
  'panel.tune.inertia': 'Sway duration',
  'panel.tune.gravity': 'Gravity',
  'panel.tune.settle': 'Settle',
  'panel.tune.hop': 'Hop',
  'panel.tune.hop.note1':
    'A movement for checking whether the sway is tuned. The landing shows in an instant what breathing never will.',
  'panel.tune.hop.note2':
    'Height and gravity decide the arc between them. Lower the gravity and the same height floats at the top.',
  'panel.tune.hop.note3':
    'The legs are not in the rig, so watch this framed at the bust or the upper body.',
  'panel.tune.hopHeight': 'Hop height',
  'panel.tune.tail': 'Tail',
  'panel.tune.tail.note':
    'A tail only hangs from the hips, so left to the sway layer it looks dead. The swing is taken from the emotion and driven at the root; everything past it follows on the sway layer.',
  'panel.tune.tailAmount': 'Swing amount',
  'panel.tune.render': 'Render',
  'panel.tune.render.note1':
    'Turn toon off and the materials the GLB arrived with are used as they are. For telling a bad model apart from a bad shader.',
  'panel.tune.render.note2':
    'Turn ARKit blending off and the face falls back to the VRM presets. A preset sculpts the whole face, so only one can be up at a time — for checking the degraded path.',
  'panel.tune.toon': 'Toon shading',
  'panel.tune.arkit': 'Drive the face with ARKit blending',
} as const;

export const tuneJa: Record<keyof typeof tuneEn, string> = {
  'panel.tune.title': '調律',
  'panel.tune.empty': 'レンダラーがまだ何も報告していない。ビューアを開くと値が入る。',
  'panel.tune.idle': 'アイドル',
  'panel.tune.idle.note1':
    '呼吸と重心移動はジェスチャ中も止まらない。手を上げた瞬間に呼吸が止まるキャラクターは人形に見える。',
  'panel.tune.idle.note2':
    'まばたきは視線移動に引き寄せられる。目の可動域は白目が出ない範囲に絞ってあり、向きを変えるのはほぼ頭の仕事になる。',
  'panel.tune.breathDepth': '呼吸の深さ',
  'panel.tune.breathPeriod': '呼吸の周期',
  'panel.tune.idleAmount': '頭のマイクロムーブ',
  'panel.tune.weightShift': '重心移動',
  'panel.tune.gazeAmount': '視線のゆらぎ',
  'panel.tune.eyeLimit': '目の可動限界',
  'panel.tune.blink': '自動まばたき',
  'panel.tune.sway': '揺れもの',
  'panel.tune.sway.note1':
    '髪・衣装・リボンなど、駆動されず親に遅れて揺れるだけのボーン。倍率はモデルに書かれた値に対するもの。',
  'panel.tune.sway.note2':
    '固定ステップで解いているので、フレームレートが変わっても揺れ幅は変わらない。',
  'panel.tune.swayEnabled': '揺れを有効にする',
  'panel.tune.stiffness': '硬さ',
  'panel.tune.inertia': '揺れの持続',
  'panel.tune.gravity': '重力',
  'panel.tune.settle': '静止させる',
  'panel.tune.hop': '跳躍',
  'panel.tune.hop.note1':
    '揺れものが正しく調整されているか見るための動き。呼吸では分からないことが着地の一瞬で分かる。',
  'panel.tune.hop.note2': '高さと重力だけで弧が決まる。重力を下げると同じ高さのまま頂点で浮く。',
  'panel.tune.hop.note3': '脚はリグに含まれないので、バストアップか上半身の画角で見ること。',
  'panel.tune.hopHeight': '跳ぶ高さ',
  'panel.tune.tail': '尻尾',
  'panel.tune.tail.note':
    '尻尾は腰にぶら下がっているだけなので、揺れもの層に任せると止まって見える。感情から振りを決めて根元を能動的に振り、その先は揺れもの層が追う。',
  'panel.tune.tailAmount': '振りの大きさ',
  'panel.tune.render': '描画',
  'panel.tune.render.note1':
    'トゥーンを切ると、GLB が持ってきたマテリアルそのままになる。モデルがおかしいのかシェーダーがおかしいのかを切り分けるためのもの。',
  'panel.tune.render.note2':
    'ARKit 合成を切ると VRM プリセットに落ちる。プリセットは顔全体の彫刻なので同時にひとつしか出せない — 縮退動作の確認用。',
  'panel.tune.toon': 'トゥーン表示',
  'panel.tune.arkit': '表情を ARKit 合成で駆動',
};
