/**
 * The viewer's operator console.
 *
 * Separate from the panel's catalogue even where the wording matches, because
 * the two surfaces are driven at different moments — the console is what is
 * reached for while looking at the render, the panel while looking at the
 * script — and a shared key would tie the two together for no reason beyond
 * their currently reading alike.
 */
export const consoleEn = {
  'console.documentTitle': 'hashidate',

  'console.tabs.aria': 'Console',
  'console.tabs.perform': 'Perform',
  'console.tabs.dress': 'Dress',
  'console.tabs.tune': 'Tune',
  'console.tabs.inspect': 'Inspect',

  'console.link.online': 'Control linked',
  'console.link.offline': 'Control not linked',
  'console.link.rejected': 'rejected {count}',

  'console.avatar.aria': 'Avatar',
  'console.header.shapes': 'shapes',

  'console.camera.aria': 'Camera',
  'console.backdrop.aria': 'Backdrop',
  'console.backdrop.none': 'None',
  'console.backdrop.none.title': 'The bare background',
  'console.backdrop.transparent': 'Something behind this (transparent)',
  'console.backdrop.note.transparent':
    'For laying the character over gameplay or another capture. Add this page to OBS as a browser source and put the capture underneath.',
  'console.backdrop.note.url':
    'The set goes into ?backdrop= in the URL, so an OBS source can use this address as it stands.',

  'console.idle.auto': 'Automatic (idle)',

  'console.load.avatar': 'Loading {name}…',
  'console.load.loading': 'Loading…',
  'console.load.failedHint': 'Pick another avatar, or export it again with make glb.',

  // What the loader could not resolve in a model, printed above the tabs. The
  // runtime builds these while a model is coming up, so they are worded as
  // findings rather than as instructions: every one of them names a feature
  // that is quietly dropped rather than a failure that stopped the load.
  'console.problem.load': 'Could not load the GLB ({url}): {reason}',
  'console.problem.profile': 'Profile unresolved: {names}',
  'console.problem.wardrobe': 'Wardrobe unresolved: {names}',
  'console.problem.sway': 'Sway chains unresolved: {names}',
  'console.problem.tail': 'Tail drive unresolved: {names}',

  // The document layer answers with a reason rather than throwing, so these are
  // read off the telemetry while a broadcast is running.
  'console.slides.empty': 'The document has no pages',
  'console.slides.openFailed': 'Could not open the document ({url}): {reason}',
  'console.slides.drawFailed': 'Could not draw page {page}: {reason}',

  'console.speech.aria': 'Line to speak',
  'console.speech.placeholder': 'Line to speak — [hello] drops a cue in mid-line',
  'console.speech.badCue': 'A bracket is left open, or what is inside [] is not an id',
  'console.speech.cueInReading': 'The reading takes no cues. Brackets belong in the line itself',
  'console.speech.queued': 'Waiting {count}',
  'console.speech.say': 'Say',
  'console.speech.stop': 'Cut',
  'console.reading.label': 'Reading (kana, optional)',

  'console.none': 'None',
  'console.stop': 'Stop',
  'console.release': 'Release',
  'console.releaseAll': 'Release all',

  'console.demo.start': 'Self-test',
  'console.demo.stop': 'Abort',
  'console.demo.note': 'Runs through the whole vocabulary once',
  // What the bar says it is doing. The name in each one is the avatar's own
  // label for the thing, already resolved against this page's locale.
  'console.demo.step.camera': 'Camera {name}',
  'console.demo.step.cameraBack': 'Camera back',
  'console.demo.step.emotion': 'Emotion {name}',
  'console.demo.step.emotionBack': 'Emotion back',
  'console.demo.step.expression': 'Expression {name}',
  'console.demo.step.expressionOff': 'Expression released',
  'console.demo.step.overlay': 'Overlay {name}',
  'console.demo.step.overlayDown': 'Overlay {name} down',
  'console.demo.step.performance': 'Performance {name}',
  'console.demo.step.performanceOff': 'Performance released',
  'console.demo.step.gesture': 'Gesture {name}',
  'console.demo.step.gestureStop': 'Gesture stopped',
  'console.demo.step.hop': 'Hop {name}',
  'console.demo.step.point': 'Point {side} {azimuth}°',
  'console.demo.step.armsDown': 'Arms down',
  'console.demo.step.line': 'A line',
  'console.demo.step.lineWithReading': 'A line with a reading',
  'console.demo.step.cueInLine': 'A cue inside a line',
  'console.demo.step.room': 'Room {name}',
  'console.demo.step.roomDry': 'Room off',
  'console.demo.step.outfit': 'Outfit {name}',
  'console.demo.step.end': 'End',

  'console.perform.presets': 'Presets',
  'console.perform.presets.note.parts':
    'A face and a motion held as one thing. Emotion and Gestures below are its parts, and are what a combination no preset has a name for is built from.',
  'console.perform.presets.note.line':
    'A preset attached to a line lets go of itself when the line ends, but the mood stays — a mood does not finish with a sentence. Release here is a different thing: it puts the face back to rest, mood and overlays included.',
  'console.perform.presets.note.held':
    'A * marks the ones that never end by themselves. A pose, lowered lids and a held gaze stay until the next preset is pressed or the release is.',
  'console.perform.presets.note.auto':
    'Automatic mode picks from this same table, so what can be pressed here and what comes up on its own are one vocabulary.',
  'console.perform.faceOnly': 'face only',

  'console.perform.emotion': 'Emotion',
  'console.perform.emotion.note.mix':
    'Emotions are continuous, and mixing several gives a face between them. A chip sets one on its own; the faders blend.',
  'console.perform.emotion.note.arkit':
    'Muscle-level shapes are added together, so two emotions never fight over the same vertices.',
  'console.perform.emotion.note.custom':
    "This model has no ARKit shapes. The same emotion vocabulary is blended through a table written against the model's own shape names. They are still part-level shapes, so the blend behaves the same way.",
  'console.perform.emotion.note.vrm':
    'This model has no ARKit shapes and no table of its own yet. It falls back to sending the single strongest emotion to a VRM preset.',
  'console.perform.emotion.blend': 'Blend',
  'console.perform.channel.arkit': 'ARKit 52 blend',
  'console.perform.channel.custom': 'Model shape blend',
  'console.perform.channel.vrm': 'VRM presets',

  'console.perform.expressions': 'Drawn expressions',
  'console.perform.expressions.note.source':
    'Finished faces that ship with the model. They carry eye and mouth shapes ARKit blending cannot build, so they are a channel of their own; while one is chosen the blended side pulls back in proportion.',
  'console.perform.expressions.note.state':
    'Filled means the operator chose it, outlined means an emotion or automatic mode did. The second cannot be released — nothing that was not chosen can be taken off.',

  'console.perform.overlays': 'Overlays',
  'console.perform.overlays.note':
    'Drawn shapes blending cannot build — heart eyes, spiral eyes, a blush, tears. They sit on top of the face rather than replacing it, so several can be up at once.',

  'console.perform.gestures': 'Gestures',
  'console.perform.gestures.note.body':
    'Body only, with no face attached. Normally called from the preset side.',
  'console.perform.gestures.note.variation':
    'Speed, amplitude and side vary from one playback to the next. Switching cross-fades the previous motion out.',
  'console.perform.gestures.note.hold':
    'The poses hold until released. Everything else ends by itself.',
  'console.perform.gestures.note.hop':
    'A hop moves the whole skeleton, so it runs alongside an arm gesture.',
  'console.perform.hops': 'Hops',

  'console.perform.point': 'Pointing',
  'console.perform.point.note.solve':
    'Give the fingertip an azimuth, an elevation and an extent, and the shoulder, elbow and wrist are solved backwards from it. The elbow can travel a full circle around the line from shoulder to wrist, so its place is searched for: the one that costs the joints least.',
  'console.perform.point.note.limits':
    'Well off centre, the torso turns with the arm. A request past the range of motion does not fail — the arm reaches as far as it goes and stops there, and how hard it was pushed shows in the joint table under Inspect.',
  'console.perform.point.hand': 'Hand',
  'console.perform.point.hand.aria': 'Which hand',
  'console.perform.point.finger': 'Finger',
  'console.perform.point.finger.aria': 'Which finger',
  'console.perform.point.azimuth': 'Azimuth',
  'console.perform.point.elevation': 'Elevation',
  'console.perform.point.extent': 'Extent',
  'console.perform.point.aim': 'Point',
  'console.perform.side.right': 'Right hand',
  'console.perform.side.left': 'Left hand',
  'console.perform.finger.thumb': 'Thumb',
  'console.perform.finger.index': 'Index',
  'console.perform.finger.middle': 'Middle',
  'console.perform.finger.ring': 'Ring',
  'console.perform.finger.little': 'Little',
  'console.perform.strain': 'Strain {value}',

  'console.perform.script': 'Demo script',
  'console.perform.script.turns': '{count} turns',
  'console.perform.script.note':
    'The script is queued one turn per line. There is no timing — each turn starts once the mouth before it has finished. This is the shape the control API takes as well.',
  'console.perform.script.play': 'Play the script',

  'console.dress.title': 'Wardrobe',
  'console.dress.empty': 'This avatar has nothing to change into.',
  'console.dress.presets': 'Outfits',
  'console.dress.parts': 'Parts',
  'console.dress.slots': '{count} slots',
  'console.dress.hides': 'Hide shapes in effect',
  'console.dress.hides.note':
    'The shapes under a covered part are raised so a garment does not push through the body. VRChat-style models collapse the vertices with a *Hide shape, other authors thin the limbs with Shrink_* — the same job under a different name and mechanism.',

  'console.tune.idle': 'Idle',
  'console.tune.idle.note.breath':
    'Breathing and weight shift do not stop during a gesture. A character whose breathing stops the moment an arm goes up reads as a doll.',
  'console.tune.idle.note.blink':
    'Blinks are pulled towards gaze movement. The eyes are held to the range that keeps the whites out of the corners, and they only approach that limit rather than reaching it — turning to look is almost entirely the job of the head.',
  'console.tune.breathDepth': 'Breath depth',
  'console.tune.breathPeriod': 'Breath period',
  'console.tune.headMicro': 'Head micro-movement',
  'console.tune.weightShift': 'Weight shift',
  'console.tune.lookAt': 'Look at the camera',
  'console.tune.gazeDrift': 'Gaze drift',
  'console.tune.eyeLimit': 'Eye travel limit',
  'console.tune.blink': 'Automatic blinking',

  'console.tune.sway': 'Sway',
  'console.tune.sway.meta': '{groups} chains, {joints} joints',
  'console.tune.sway.note.solver':
    'Hair, clothing, ribbons — bones nothing drives, which only trail behind their parent. Solved on a fixed 1/60 s step, so the amount of movement does not change with the frame rate.',
  'console.tune.sway.note.scale':
    'The scale faders act on the figures written into the model. Chains: {chains}',
  'console.tune.sway.note.missing': 'Unresolved: {names}',
  'console.tune.sway.enabled': 'Enable sway',
  'console.tune.sway.stiffness': 'Stiffness',
  'console.tune.sway.inertia': 'How long it keeps swaying',
  'console.tune.sway.gravity': 'Gravity',
  'console.tune.sway.settle': 'Settle it',

  'console.tune.hop': 'Hop',
  'console.tune.hop.note.why':
    'Here to show whether the sway is tuned. Breathing moves the chest a few millimetres, which says a chain is alive but not that it is set well; the instant of landing is what decides that.',
  'console.tune.hop.note.arc':
    'Height and gravity alone fix the arc (v₀=√(2gh), airtime=2v₀/g). Mass cancels in free flight, so there is none to set. Lower the gravity and the same height hangs longer at the top.',
  'console.tune.hop.note.repeat':
    'Hopping repeatedly, the crouch on landing is the crouch for the next take-off — both end fully compressed and at rest, so the velocity never breaks. That is why there is no interval to set.',
  'console.tune.hop.note.legs':
    'The legs are not in the rig, so the feet sink through the floor on the crouch and hang in the air at the top. Watch it framed at bust or upper body.',
  'console.tune.hop.height': 'Hop height',
  'console.tune.hop.gravity': 'Gravity',
  'console.tune.hop.once': 'At this height',
  'console.tune.hop.once.title': 'One hop at the height set above',

  'console.tune.tail': 'Tail',
  'console.tune.tail.note.drive':
    'A tail only hangs off the hips, so left to the sway layer it has no input and looks stopped. The speed, width and height of the swing come from the emotion vector and drive the root; everything past it trails behind on the sway layer.',
  'console.tune.tail.note.mood':
    'Joy swings fast and wide, sadness drops and nearly stops, surprise stands it up without a swing.',
  'console.tune.tail.amount': 'Swing amount',

  'console.tune.render': 'Rendering',
  'console.tune.render.note.toon':
    'With toon off, the materials are whatever the GLB brought with it. Double-sided rendering and alpha are corrected by the same rules on either path.',
  'console.tune.render.note.arkit':
    'With ARKit blending off, the face falls back to VRM presets. A preset sculpts the whole face, so only one can be up at a time and mixing them breaks it — this is for seeing what the fallback looks like.',
  'console.tune.toon': 'Toon shading',
  'console.tune.arkit': 'Drive the face with ARKit blending',

  'console.inspect.strain': 'Joint strain',
  'console.inspect.strain.note.zones':
    'The measured angle at each joint and how it reads. Green is the range everyday movement uses, amber is reachable but strained, red is pinned against the anatomical limit.',
  'console.inspect.strain.note.limits':
    'A joint that reaches its limit stops there, so the pose is not the one that was asked for. A dash means the pose does not determine that figure — the plane of elevation of a lowered arm, or the rotation of a fully straight one.',
  'console.inspect.strain.note.penetration':
    'Body penetration is a fraction of the torso radius rather than an angle: how far the arm is inside its own chest or head. It is the one figure here that is not about range of motion.',
  'console.inspect.strain.unmeasurable': 'Cannot measure — the torso frame is unresolved',
  'console.inspect.side.aria': 'Which arm',
  'console.inspect.side.right': 'Right arm',
  'console.inspect.side.left': 'Left arm',

  'console.inspect.profile': 'Profile',
  'console.inspect.profile.complete': 'Complete',
  'console.inspect.profile.unresolved': 'Unresolved {count}',
  'console.inspect.profile.note.discovered':
    'What the engine found in this model as it loaded. Bone names and shape names differ from one author to the next, so every mapping onto a canonical slot is resolved here.',
  'console.inspect.profile.note.partial':
    'It runs with entries unresolved — whatever could not be resolved drops that one feature quietly, rather than failing.',
  'console.inspect.fact.viseme': 'Visemes',
  'console.inspect.fact.fingerBones': 'Finger bones',
  'console.inspect.fact.faceMeshes': 'Face meshes',
  'console.inspect.fact.shapeGroups': 'Shape groups',
  'console.inspect.fact.unresolved': 'Unresolved',
  'console.inspect.fact.chains': '{count} chains',

  'console.inspect.events': 'Events',
  'console.inspect.events.note':
    'The turn boundaries the session emits. The same ones the control API delivers, which an orchestrator waits on before sending the next line.',
  'console.inspect.events.empty': 'Nothing has happened yet.',

  'console.inspect.vocabulary': 'Vocabulary',
  'console.inspect.vocabulary.note.discovered':
    "What this avatar can be asked for. Discovered rather than declared: the expressions come from the model's own shape groups and the wardrobe from its meshes, so swapping the avatar changes what is here.",
  'console.inspect.vocabulary.note.prompt': "This object is what goes into an LLM's system prompt.",

  'console.hud.sway': 'sway',
  'console.hud.breath': 'breath',
  'console.hud.blink': 'blink',
  'console.hud.gaze': 'gaze',
  'console.hud.idle': 'IDLE',
  'console.hud.auto': 'auto',
  'console.hud.voiceBlocked': 'Audio blocked — click this page',
  'console.hud.voiceBlocked.title':
    'The browser will not play audio until this page has been clicked',
  // Shorter than the wording under Perform, because the HUD prints this beside
  // the frame rate on one line over the character's face.
  'console.hud.channel.custom': 'Model shape blend',
  'console.hud.channel.vrm': 'VRM presets',

  // The shell readout. It says the same thing as the HUD flag above and says it
  // in fewer characters, because this one is printed in fixed columns over a
  // live frame rather than in a box that can grow.
  'console.telemetry.voiceBlocked': 'Audio blocked — click the page',
} as const;

export const consoleJa: Record<keyof typeof consoleEn, string> = {
  'console.documentTitle': 'hashidate',

  'console.tabs.aria': '操作の種類',
  'console.tabs.perform': '演じる',
  'console.tabs.dress': '装う',
  'console.tabs.tune': '調律',
  'console.tabs.inspect': '診る',

  'console.link.online': '制御接続',
  'console.link.offline': '制御未接続',
  'console.link.rejected': '不正 {count}',

  'console.avatar.aria': 'アバター',
  'console.header.shapes': 'シェイプ',

  'console.camera.aria': 'カメラ',
  'console.backdrop.aria': '背景',
  'console.backdrop.none': 'なし',
  'console.backdrop.none.title': '素の背景',
  'console.backdrop.transparent': '下に何かある（透過）',
  'console.backdrop.note.transparent':
    'ゲーム画面などの上に重ねる用。OBS でこのページをブラウザソースにして、下にキャプチャを置く。',
  'console.backdrop.note.url':
    'URL の ?backdrop= に入る。OBS のソースはこのアドレスをそのまま使える。',

  'console.idle.auto': '自動モード（アイドル）',

  'console.load.avatar': '{name} を読み込み中…',
  'console.load.loading': '読み込み中…',
  'console.load.failedHint': '別のアバターを選ぶか、make glb で書き出し直す。',

  'console.problem.load': 'GLB の読み込みに失敗 ({url}): {reason}',
  'console.problem.profile': 'プロファイル未解決: {names}',
  'console.problem.wardrobe': '衣装未解決: {names}',
  'console.problem.sway': '揺れもの未解決: {names}',
  'console.problem.tail': '尻尾の駆動未解決: {names}',

  'console.slides.empty': 'ページがありません',
  'console.slides.openFailed': '資料を開けませんでした ({url}): {reason}',
  'console.slides.drawFailed': '{page} ページを描画できませんでした: {reason}',

  'console.speech.aria': 'しゃべらせたい文章',
  'console.speech.placeholder': 'しゃべらせたい文章（[hello] のように演出を挟める）',
  'console.speech.badCue': '角括弧が閉じていないか、[] の中身が id ではない',
  'console.speech.cueInReading': '読みに演出は書けない。角括弧は文章のほうへ',
  'console.speech.queued': '待ち {count}',
  'console.speech.say': '話す',
  'console.speech.stop': '止める',
  'console.reading.label': '読み（かな・任意）',

  'console.none': 'なし',
  'console.stop': '停止',
  'console.release': '解除',
  'console.releaseAll': '全解除',

  'console.demo.start': '自動デモ',
  'console.demo.stop': '中止',
  'console.demo.note': '語彙を一通り実演します',
  'console.demo.step.camera': 'カメラ {name}',
  'console.demo.step.cameraBack': 'カメラを戻す',
  'console.demo.step.emotion': '感情 {name}',
  'console.demo.step.emotionBack': '感情を戻す',
  'console.demo.step.expression': '表情 {name}',
  'console.demo.step.expressionOff': '表情を解除',
  'console.demo.step.overlay': '効果 {name}',
  'console.demo.step.overlayDown': '効果 {name} を下げる',
  'console.demo.step.performance': '演技 {name}',
  'console.demo.step.performanceOff': '演技を解除',
  'console.demo.step.gesture': '動作 {name}',
  'console.demo.step.gestureStop': '動作を停止',
  'console.demo.step.hop': '跳躍 {name}',
  'console.demo.step.point': '指差し {side} {azimuth}°',
  'console.demo.step.armsDown': '腕を下ろす',
  'console.demo.step.line': '台詞',
  'console.demo.step.lineWithReading': '読み付きの台詞',
  'console.demo.step.cueInLine': '行中のキュー',
  'console.demo.step.room': '部屋 {name}',
  'console.demo.step.roomDry': '部屋をドライに',
  'console.demo.step.outfit': '衣装 {name}',
  'console.demo.step.end': 'おわり',

  'console.perform.presets': 'プリセット',
  'console.perform.presets.note.parts':
    '表情とモーションをひと組にしたもの。ここから下の「感情」「ジェスチャ」はその部品で、プリセットに名前のない組み合わせを作るときに使う。',
  'console.perform.presets.note.line':
    '台詞に添えたプリセットは行の終わりで自分から抜けるが、気分だけは残る — 気分は台詞と一緒には終わらない。ここの「解除」はそれとは別で、気分も重ねた効果も含めて素の顔に戻す。',
  'console.perform.presets.note.held':
    '* 印は自分では終わらないもの。姿勢・伏し目・視線は、次のプリセットを押すか解除するまで保持する。',
  'console.perform.presets.note.auto':
    '自動モードもこの表から選ぶので、パネルで押せるものと自動で出るものは同じ語彙になる。',
  'console.perform.faceOnly': '表情のみ',

  'console.perform.emotion': '感情',
  'console.perform.emotion.note.mix':
    '感情は連続値で、複数を混ぜると中間表情になる。チップは単独指定、スライダーは配合。',
  'console.perform.emotion.note.arkit':
    '筋肉レベルのシェイプを加算しているので、感情どうしが同じ頂点を奪い合わない。',
  'console.perform.emotion.note.custom':
    'このモデルは ARKit 非対応。同じ感情語彙を、モデル自身のシェイプ名で書いた対応表から合成している。部品単位のシェイプなので合成の性質は変わらない。',
  'console.perform.emotion.note.vrm':
    'このモデルは ARKit 非対応で、固有の対応表も未作成。優勢な感情ひとつを VRM プリセットに流すだけの縮退動作になっている。',
  'console.perform.emotion.blend': '配合',
  'console.perform.channel.arkit': 'ARKit 52 合成',
  'console.perform.channel.custom': 'モデル固有シェイプ合成',
  'console.perform.channel.vrm': 'VRM プリセット',

  'console.perform.expressions': '描き起こし表情',
  'console.perform.expressions.note.source':
    'モデル同梱の完成形の表情。ARKit 合成では作れない目や口の形が含まれるため、合成とは別系統として持つ。選択中は合成側が比例して引く。',
  'console.perform.expressions.note.state':
    '塗りつぶしが操作者の選択、枠線だけのものは感情または自動モードが選んだもの。後者は解除できない — 選んでいないものは外せない。',

  'console.perform.overlays': '重ねる効果',
  'console.perform.overlays.note':
    'ハート目・ぐるぐる目・頬染め・涙といった、合成では作れない描き起こし。表情を置き換えるのではなく上に重なるため、複数を同時に出せる。',

  'console.perform.gestures': 'ジェスチャ',
  'console.perform.gestures.note.body':
    '表情を伴わない、体だけの語彙。ふだんはプリセット側から呼ばれる。',
  'console.perform.gestures.note.variation':
    '再生ごとに速さ・振幅・左右が変わる。切り替えは前の動作をクロスフェードで送る。',
  'console.perform.gestures.note.hold': 'ポーズ群は解除するまで保持する。それ以外は自分で終わる。',
  'console.perform.gestures.note.hop': '跳躍は骨格全体を動かすので、腕のジェスチャと同時に走る。',
  'console.perform.hops': '跳躍',

  'console.perform.point': '指さし',
  'console.perform.point.note.solve':
    '指先の方位・仰角・伸ばしを与えると、肩・肘・手首を逆算する。肘は肩と手首を結ぶ線のまわりを一周できてしまうため、可動域の負担が最小になる位置を探索して決める。',
  'console.perform.point.note.limits':
    '正面から大きく外れた方位では体幹も一緒に向きを変える。可動域を超える指示は失敗せず、届く範囲まで伸ばして止まる — どれだけ無理をしたかは「診る」の関節表に出る。',
  'console.perform.point.hand': '手',
  'console.perform.point.hand.aria': 'どちらの手',
  'console.perform.point.finger': '指',
  'console.perform.point.finger.aria': 'どの指',
  'console.perform.point.azimuth': '方位  azimuth',
  'console.perform.point.elevation': '仰角  elevation',
  'console.perform.point.extent': '伸ばし  extent',
  'console.perform.point.aim': '指す',
  'console.perform.side.right': '右手',
  'console.perform.side.left': '左手',
  'console.perform.finger.thumb': '親',
  'console.perform.finger.index': '人差',
  'console.perform.finger.middle': '中',
  'console.perform.finger.ring': '薬',
  'console.perform.finger.little': '小',
  'console.perform.strain': '負担 {value}',

  'console.perform.script': 'デモ台本',
  'console.perform.script.turns': '{count} ターン',
  'console.perform.script.note':
    '台本を 1 行 1 ターンとしてキューに積む。時刻指定はない — 各ターンは前の口パクが終わってから始まる。外部制御 API が受け取るのもこの形。',
  'console.perform.script.play': '台本を再生',

  'console.dress.title': '衣装',
  'console.dress.empty': 'このアバターは着せ替えを持たない。',
  'console.dress.presets': '組み合わせ',
  'console.dress.parts': 'パーツ',
  'console.dress.slots': '{count} スロット',
  'console.dress.hides': '適用中の隠しシェイプ',
  'console.dress.hides.note':
    '衣装が素体を貫通しないように、覆われる部分のシェイプを上げている。VRChat 系は頂点を潰す *Hide、別の作者は手足を細める Shrink_* を使う — 役割は同じで呼び名と仕組みが違う。',

  'console.tune.idle': 'アイドル',
  'console.tune.idle.note.breath':
    '呼吸と重心移動はジェスチャ中も止まらない。手を上げた瞬間に呼吸が止まる character は人形に見える。',
  'console.tune.idle.note.blink':
    'まばたきは視線移動に引き寄せられる。目の可動域は白目が出ない範囲に絞ってあり、限界へは漸近するだけで到達しない — 向きを変えるのはほぼ頭の仕事になる。',
  'console.tune.breathDepth': '呼吸の深さ',
  'console.tune.breathPeriod': '呼吸の周期',
  'console.tune.headMicro': '頭のマイクロムーブ',
  'console.tune.weightShift': '重心移動',
  'console.tune.lookAt': 'カメラ目線',
  'console.tune.gazeDrift': '視線のゆらぎ',
  'console.tune.eyeLimit': '目の可動限界',
  'console.tune.blink': '自動まばたき',

  'console.tune.sway': '揺れもの',
  'console.tune.sway.meta': '{groups}系統 {joints}ジョイント',
  'console.tune.sway.note.solver':
    '髪・衣装・リボンなど、駆動されず親に遅れて揺れるだけのボーン。1/60 秒固定ステップで解いているので、フレームレートが変わっても揺れ幅は変わらない。',
  'console.tune.sway.note.scale':
    '倍率のスライダーはモデルに書かれた値に対するもの。系統: {chains}',
  'console.tune.sway.note.missing': '未解決: {names}',
  'console.tune.sway.enabled': '揺れを有効にする',
  'console.tune.sway.stiffness': '硬さ',
  'console.tune.sway.inertia': '揺れの持続',
  'console.tune.sway.gravity': '重力',
  'console.tune.sway.settle': '静止させる',

  'console.tune.hop': '跳躍',
  'console.tune.hop.note.why':
    '揺れものが正しく調整されているかを見るための機能。呼吸は胸を数ミリ動かすだけで、チェーンが生きているかは分かっても、よく調整されているかは分からない。着地の一瞬がそれを決める。',
  'console.tune.hop.note.arc':
    '高さと重力だけで弧が決まる（v₀=√(2gh)、滞空=2v₀/g）。質量は自由飛行では打ち消し合うので要らない。重力を下げると同じ高さのまま頂点で浮く。',
  'console.tune.hop.note.repeat':
    '連続で跳ぶときは着地の沈み込みがそのまま次の踏み切りの沈み込みになる — どちらも「沈みきって静止」で終わるので、速度が途切れない。間隔という設定値がないのはそのため。',
  'console.tune.hop.note.legs':
    '脚はリグに含まれないので、沈み込みで足が床に潜り滞空中は浮く。バストアップか上半身の画角で見ること。',
  'console.tune.hop.height': '跳ぶ高さ',
  'console.tune.hop.gravity': '重力',
  'console.tune.hop.once': 'この高さで',
  'console.tune.hop.once.title': '上のスライダーの高さで 1 回',

  'console.tune.tail': '尻尾',
  'console.tune.tail.note.drive':
    '尻尾は腰にぶら下がっているだけなので、揺れもの層に任せると入力がなく止まって見える。感情ベクトルから振りの速さ・幅・高さを決めて根元を能動的に振り、その先は揺れもの層が遅れて追う。',
  'console.tune.tail.note.mood': '喜びは速く広く、悲しみは下がってほぼ止まり、驚きは振らずに立つ。',
  'console.tune.tail.amount': '振りの大きさ',

  'console.tune.render': '描画',
  'console.tune.render.note.toon':
    'トゥーンを切ると、GLB が持ってきたマテリアルそのままになる。両面描画とアルファの扱いはどちらの経路でも同じ規則で直している。',
  'console.tune.render.note.arkit':
    'ARKit 合成を切ると VRM プリセットに落ちる。プリセットは顔全体の彫刻なので同時にひとつしか出せず、混ぜると崩れる — 縮退動作がどう見えるかの確認用。',
  'console.tune.toon': 'トゥーン表示',
  'console.tune.arkit': '表情を ARKit 合成で駆動',

  'console.inspect.strain': '関節の負担',
  'console.inspect.strain.note.zones':
    '各関節の実測値と判定。緑は日常の動作が使う範囲、黄はやればできるが無理のある範囲、赤は解剖学的な限界に張り付いている。',
  'console.inspect.strain.note.limits':
    '限界に達した関節はそこで止まるので、要求どおりの姿勢にはならない。「—」は姿勢からその量が決まらないもの — 下ろした腕の挙上面や、伸びきった腕の回旋がそれにあたる。',
  'console.inspect.strain.note.penetration':
    '身体貫通は角度ではなく体幹半径に対する割合。腕が自分の胸や頭にめり込んでいる量で、これだけは可動域とは別の話。',
  'console.inspect.strain.unmeasurable': '体幹フレーム未解決のため計測不可',
  'console.inspect.side.aria': 'どちらの腕',
  'console.inspect.side.right': '右腕',
  'console.inspect.side.left': '左腕',

  'console.inspect.profile': 'プロファイル',
  'console.inspect.profile.complete': '完全',
  'console.inspect.profile.unresolved': '未解決 {count}',
  'console.inspect.profile.note.discovered':
    'エンジンが読み込み時にこのモデルから見つけたもの。ボーン名もシェイプ名も作者ごとに違うので、正規スロットへの対応付けはすべてここで解決している。',
  'console.inspect.profile.note.partial':
    '未解決があっても動く — 解決できなかったものはその機能が黙って落ちるだけで、失敗にはならない。',
  'console.inspect.fact.viseme': 'ビセーム',
  'console.inspect.fact.fingerBones': '指ボーン',
  'console.inspect.fact.faceMeshes': '表情メッシュ',
  'console.inspect.fact.shapeGroups': 'シェイプ群',
  'console.inspect.fact.unresolved': '未解決',
  'console.inspect.fact.chains': '{count} 系統',

  'console.inspect.events': 'イベント',
  'console.inspect.events.note':
    'セッションが出すターン境界。外部の制御 API が受け取るのと同じもので、オーケストレータはこれを待って次の行を送る。',
  'console.inspect.events.empty': 'まだ何も起きていない。',

  'console.inspect.vocabulary': '語彙',
  'console.inspect.vocabulary.note.discovered':
    'このアバターに何を頼めるかの一覧。宣言ではなく発見されたもので、表情はモデル自身のシェイプ群から、衣装はメッシュから引いている。アバターを差し替えると中身が変わる。',
  'console.inspect.vocabulary.note.prompt': 'LLM のシステムプロンプトに貼るのはこのオブジェクト。',

  'console.hud.sway': '揺れ',
  'console.hud.breath': '呼吸',
  'console.hud.blink': '瞬き',
  'console.hud.gaze': '視線',
  'console.hud.idle': '待機',
  'console.hud.auto': '自動',
  'console.hud.voiceBlocked': '音声ブロック中 — この画面をクリック',
  'console.hud.voiceBlocked.title': 'ブラウザが操作されるまで音声を再生できません',
  'console.hud.channel.custom': '固有シェイプ合成',
  'console.hud.channel.vrm': 'VRM プリセット',

  'console.telemetry.voiceBlocked': '音声ブロック中 — 画面をクリック',
};
