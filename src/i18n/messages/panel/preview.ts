/**
 * The preview beside the controls — the renderer this panel embeds, the shot an
 * operator drags on it, and the line being said under it.
 */

export const previewEn = {
  'panel.preview.title': 'Preview',
  'panel.preview.readout': 'Debug readout',
  'panel.preview.readout.title':
    'Print breathing, gaze, frame rate and the document state on every viewer attached, including the one going to air',
  'panel.preview.hide': 'Stop',
  'panel.preview.show': 'Show',
  'panel.preview.hideTitle': 'Stop the preview and give the GPU back',
  'panel.preview.showTitle': 'Show the preview',
  'panel.preview.frameTitle': 'Avatar preview',
  'panel.preview.empty.offline': 'Waiting for the control server',
  'panel.preview.empty.noAvatar':
    'No avatar here yet. Put a descriptor in avatars/ and its model in public/models/.',
  'panel.preview.empty.loading': 'Loading the avatar…',
  'panel.preview.empty.failed': 'The avatar did not load: {error}',
  'panel.preview.stopped':
    'Preview stopped. No second WebGL context is open, so the renderer going to air has more to work with.',
  'panel.preview.blocked':
    'Audio is blocked. Click the viewer window once and the next line will be heard.',
  'panel.preview.speaking': 'On air',
  'panel.preview.speaking.standingBy': 'Standing by',
  'panel.preview.speaking.idle': 'Idle',
  'panel.preview.avatarAria': 'Avatar',
  'panel.preview.cameraAria': 'Camera',
  'panel.preview.backdropAria': 'Backdrop',
  'panel.preview.backdropNone': 'None',
  'panel.preview.backdropNone.title': 'The plain background',
  'panel.preview.straightOn': 'Straight on',
  'panel.preview.straightOnFrom': 'Straight on  {offset}',
  'panel.preview.straightOn.title':
    'Keep the framing and put the camera back to the front at its reference distance',
  'panel.preview.shot.right': 'R',
  'panel.preview.shot.left': 'L',
  'panel.preview.shot.up': 'U',
  'panel.preview.shot.down': 'D',
  'panel.preview.idle': 'Autopilot (idle)',
  'panel.preview.hideAvatar': 'Hide avatar',
  'panel.preview.hideAvatar.title':
    'Stop drawing the character on every viewer attached. It keeps speaking and moving out of sight.',
  'panel.preview.source.feed': 'Stage feed',
  'panel.preview.source.feed.title':
    'The picture the stage window is drawing, sent across. Nothing is rendered in this panel.',
  'panel.preview.source.own': 'Drawn here',
  'panel.preview.source.own.title':
    'No stage window is sending its picture, so this panel renders its own. Blinks and small movements will differ from the stage.',
} as const;

export const previewJa: Record<keyof typeof previewEn, string> = {
  'panel.preview.title': 'プレビュー',
  'panel.preview.readout': 'デバッグ表示（計測）',
  'panel.preview.readout.title':
    '呼吸・視線・フレームレート・資料の状態を、接続中のすべてのビューアに表示する（配信に出る画面にも出ます）',
  'panel.preview.hide': '停止',
  'panel.preview.show': '表示',
  'panel.preview.hideTitle': 'プレビューを止めて GPU を返す',
  'panel.preview.showTitle': 'プレビューを表示する',
  'panel.preview.frameTitle': 'アバターのプレビュー',
  'panel.preview.empty.offline': '制御サーバーの応答待ち',
  'panel.preview.empty.noAvatar':
    'アバターがまだありません。avatars/ に記述子を、public/models/ にモデルを置いてください。',
  'panel.preview.empty.loading': 'アバターを読み込み中…',
  'panel.preview.empty.failed': 'アバターを読み込めませんでした：{error}',
  'panel.preview.stopped':
    'プレビュー停止中。二つ目の WebGL コンテキストを開かないので、配信側の描画が軽くなります。',
  'panel.preview.blocked':
    '音声ブロック中。ビューアの画面を一度クリックすると次の行から声が出ます。',
  'panel.preview.speaking': '発話中',
  'panel.preview.speaking.standingBy': '待機',
  'panel.preview.speaking.idle': 'アイドル中',
  'panel.preview.avatarAria': 'アバター',
  'panel.preview.cameraAria': 'カメラ',
  'panel.preview.backdropAria': '背景',
  'panel.preview.backdropNone': 'なし',
  'panel.preview.backdropNone.title': '素の背景',
  'panel.preview.straightOn': '正面',
  'panel.preview.straightOnFrom': '正面へ  {offset}',
  'panel.preview.straightOn.title': '画角はそのままに、カメラを正面・基準距離へ戻す',
  'panel.preview.shot.right': '右',
  'panel.preview.shot.left': '左',
  'panel.preview.shot.up': '上',
  'panel.preview.shot.down': '下',
  'panel.preview.idle': '自動モード（アイドル）',
  'panel.preview.hideAvatar': 'アバターを隠す',
  'panel.preview.hideAvatar.title':
    '接続中のすべてのビューアでキャラクターを描かない（配信に出る画面も）。見えないまま喋り、動き続けます',
  'panel.preview.source.feed': 'ステージの映像',
  'panel.preview.source.feed.title':
    'ステージのウィンドウが描いている絵をそのまま映しています。このパネルでは描画していません',
  'panel.preview.source.own': 'このパネルで描画',
  'panel.preview.source.own.title':
    '映像を送っているステージがないので、このパネルで描いています。瞬きや細かな動きはステージと揃いません',
};
